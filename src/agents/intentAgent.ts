import { z } from 'zod';
import { ChatGroq } from '@langchain/groq';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import { KaizenState } from '../state';
import { langfuseTracer } from '../tools/langfuseTracer';

dotenv.config();

export const IntentSchema = z.object({
  intent: z.enum(['GENERATE_CODE', 'DEBUG_ERROR', 'EXPLAIN_CODE', 'REFACTOR', 'RUN_EXISTING_TESTS'])
    .describe("The classified intent of the user request"),
  targetFiles: z.array(z.string()).optional()
    .describe("All target source file paths identified or implied for the task (e.g., ['src/sandbox/utils.ts', 'src/sandbox/main.ts'])"),
  target_files: z.array(z.string()).optional()
    .describe("All target source file paths identified or implied for the task")
});

export async function intentAgentNode(state: typeof KaizenState.State): Promise<{ status: string; targetFiles: string[] }> {
  const apiKey = process.env.GROQ_API_KEY;

  if (apiKey && apiKey !== 'your_groq_api_key_here') {
    const modelCandidates = [
      'openai/gpt-oss-120b',
      'groq/compound-mini',
      'qwen/qwen3.8-27b',
      'openai/gpt-oss-20b'
    ];

    for (const modelName of modelCandidates) {
      try {
        const model = new ChatGroq({
          apiKey: apiKey,
          model: modelName,
          temperature: 0
        });

        const structuredModel = model.withStructuredOutput(IntentSchema, { method: 'jsonMode' });

        const systemPrompt = `You are an intent classification and target file selector agent for Kaizen AI. Respond in valid json format.
Analyze the user's prompt (which may be in English, Hinglish, slang, or natural developer phrasing) and classify their intent into one of:
- GENERATE_CODE: Creating new features, boilerplate, or implementing requested functionality.
- DEBUG_ERROR: Fixing bugs, addressing runtime errors, broken builds, or troubleshooting code.
- EXPLAIN_CODE: Explaining how code works, answering architecture/codebase questions.
- REFACTOR: Cleaning up code, optimizing performance, renaming, or restructuring existing code.
- RUN_EXISTING_TESTS: Executing existing test suite, identifying test failures, and fixing implementation if tests fail.

=== SANDBOX PLAYGROUND & FILE ISOLATION RULES ===
1. All target files MUST be located inside the 'src/sandbox/' folder (e.g., 'src/sandbox/studentAverage.ts', 'src/sandbox/utils.ts').
2. FILE ISOLATION: If the prompt explicitly mentions a file (e.g. "in main.ts" or "in utils.ts"), set targetFiles to that file path inside 'src/sandbox/'.
3. EXISTING APP/FEATURE TARGETING: If the user request relates to an existing application in the workspace (e.g. To-Do application, CLI, task service, persistence, test suite), set targetFiles to the relevant existing workspace files (e.g., ['src/sandbox/cli.py', 'src/sandbox/service.py', 'src/sandbox/task.py', 'src/sandbox/tests/test_task.py']).
4. NEW ISOLATED SCRIPT: Only generate a brand new file path inside 'src/sandbox/' (e.g., 'src/sandbox/studentAverage.ts') if the prompt is for a completely novel, standalone feature unrelated to existing workspace code.`;

        const startTime = Date.now();
        const invokePromise = structuredModel.invoke([
          { role: 'system', content: systemPrompt },
          { role: 'user', content: state.userInput }
        ]);
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error(`ChatGroq model '${modelName}' execution timed out after 6000ms`)), 6000);
        });

        const result = await Promise.race([invokePromise, timeoutPromise]);
        const latencyMs = Date.now() - startTime;

        await langfuseTracer.recordGeneration(
          'IntentAgent',
          modelName,
          state.userInput,
          JSON.stringify(result),
          latencyMs,
          60,
          80
        );

        const intent = result.intent || 'GENERATE_CODE';
        const rawFiles = result.targetFiles || result.target_files;
        let extractedFiles: string[] = (rawFiles && rawFiles.length > 0)
          ? (rawFiles as string[])
          : (state.targetFiles.length > 0 ? state.targetFiles : ['src/sandbox/main.ts']);

        // Ensure proper paths
        extractedFiles = extractedFiles.map((f: string) => {
          if (!f.includes('/') && !f.includes('\\')) {
            return `src/sandbox/${f}`;
          }
          return f.replace(/\\/g, '/');
        });

        return {
          status: `ROUTED_${intent}`,
          targetFiles: Array.from(new Set<string>(extractedFiles))
        };
      } 
      catch (error: any) {
        console.warn(`ChatGroq intent model '${modelName}' execution failed:`, error?.message || error);
      }
    }
  }

  const input = state.userInput.toLowerCase();
  let intent: z.infer<typeof IntentSchema>['intent'] = 'GENERATE_CODE';

  if (input.includes('run the existing test') || input.includes('run existing test') || input.includes('test suite') || input.includes('rerun the existing test')) {
    intent = 'RUN_EXISTING_TESTS';
  }
  else if (input.includes('fix') || input.includes('bug') || input.includes('error') || input.includes('failing')) {
    intent = 'DEBUG_ERROR';
  } 
  else if (input.includes('explain') || input.includes('how') || input.includes('inspect') || input.includes('analyze') || input.includes('determine') || input.includes('samjha')) {
    intent = 'EXPLAIN_CODE';
  } 
  else if (input.includes('refactor') || input.includes('clean')) {
    intent = 'REFACTOR';
  }

  const detectedFiles: string[] = [];
  if (input.includes('string_utils.py') || input.includes('string_utils') || input.includes('reverse_string')) {
    detectedFiles.push('src/sandbox/string_utils.py');
    if (fs.existsSync('src/sandbox/tests/test_string_utils.py')) {
      detectedFiles.push('src/sandbox/tests/test_string_utils.py');
    }
  }
  if (input.includes('cli.py') || input.includes('cli')) {
    detectedFiles.push('src/sandbox/cli.py');
  }
  if (input.includes('service.py') || input.includes('service')) {
    detectedFiles.push('src/sandbox/service.py');
  }
  if (input.includes('task.py') || input.includes('task')) {
    detectedFiles.push('src/sandbox/task.py');
  }
  if (input.includes('tests') || input.includes('test')) {
    if (fs.existsSync('src/sandbox/tests/test_string_utils.py')) {
      detectedFiles.push('src/sandbox/tests/test_string_utils.py');
    }
    if (fs.existsSync('src/sandbox/tests/test_task.py')) {
      detectedFiles.push('src/sandbox/tests/test_task.py');
    }
  }
  if (input.includes('utils.ts') || input.includes('utils')) {
    if (!detectedFiles.includes('src/sandbox/string_utils.py')) {
      detectedFiles.push('src/sandbox/utils.ts');
    }
  }
  if (input.includes('main.ts') || input.includes('main')) {
    detectedFiles.push('src/sandbox/main.ts');
  }
  if (input.includes('to-do') || input.includes('todo') || input.includes('persist') || input.includes('persistence')) {
    if (fs.existsSync('src/sandbox/cli.py') && !detectedFiles.includes('src/sandbox/cli.py')) detectedFiles.push('src/sandbox/cli.py');
    if (fs.existsSync('src/sandbox/service.py') && !detectedFiles.includes('src/sandbox/service.py')) detectedFiles.push('src/sandbox/service.py');
    if (fs.existsSync('src/sandbox/task.py') && !detectedFiles.includes('src/sandbox/task.py')) detectedFiles.push('src/sandbox/task.py');
    if (fs.existsSync('src/sandbox/tests/test_task.py') && !detectedFiles.includes('src/sandbox/tests/test_task.py')) detectedFiles.push('src/sandbox/tests/test_task.py');
  }

  let finalTargets: string[];
  if (detectedFiles.length > 0) {
    finalTargets = detectedFiles;
  } else if (state.targetFiles.length > 0) {
    finalTargets = state.targetFiles;
  } else {
    const slug = state.userInput
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 20) || 'task';
    finalTargets = [`src/sandbox/${slug}.ts`];
  }

  return {
    status: `ROUTED_${intent}`,
    targetFiles: Array.from(new Set<string>(finalTargets))
  };
}