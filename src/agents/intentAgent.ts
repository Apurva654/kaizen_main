import { z } from 'zod';
import { ChatGroq } from '@langchain/groq';
import * as dotenv from 'dotenv';
import { KaizenState } from '../state';
import { langfuseTracer } from '../tools/langfuseTracer';

dotenv.config();

export const IntentSchema = z.object({
  intent: z.enum(['GENERATE_CODE', 'DEBUG_ERROR', 'EXPLAIN_CODE', 'REFACTOR'])
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

=== SANDBOX PLAYGROUND & FILE ISOLATION RULES ===
1. All target files MUST be located inside the 'src/sandbox/' folder (e.g., 'src/sandbox/studentAverage.ts', 'src/sandbox/utils.ts').
2. FILE ISOLATION: If the prompt explicitly mentions a file (e.g. "in main.ts" or "in utils.ts"), set targetFiles to that file path inside 'src/sandbox/'.
3. NEW FEATURE ISOLATION: If the user request is a new query/feature and does NOT explicitly specify an existing file, generate a NEW, dedicated file path inside 'src/sandbox/' named after the feature (e.g., 'src/sandbox/studentAverage.ts' or 'src/sandbox/calculator.ts') so existing query files in 'src/sandbox/' are preserved and not interrupted.`;

        const startTime = Date.now();
        const result = await structuredModel.invoke([
          { role: 'system', content: systemPrompt },
          { role: 'user', content: state.userInput }
        ]);
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

  if (input.includes('fix') || input.includes('bug') || input.includes('error')) {
    intent = 'DEBUG_ERROR';
  } 
  else if (input.includes('explain') || input.includes('how') || input.includes('samjha')) {
    intent = 'EXPLAIN_CODE';
  } 
  else if (input.includes('refactor') || input.includes('clean')) {
    intent = 'REFACTOR';
  }

  const detectedFiles: string[] = [];
  if (input.includes('utils.ts') || input.includes('utils')) {
    detectedFiles.push('src/sandbox/utils.ts');
  }
  if (input.includes('main.ts') || input.includes('main')) {
    detectedFiles.push('src/sandbox/main.ts');
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