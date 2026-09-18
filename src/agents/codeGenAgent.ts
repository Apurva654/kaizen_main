import { z } from 'zod';
import { ChatGroq } from '@langchain/groq';
import * as dotenv from 'dotenv';
import { KaizenState, PlanStep } from '../state';
import { langfuseTracer } from '../tools/langfuseTracer';

dotenv.config();

export function getLanguageFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'py': return 'Python';
    case 'ts':
    case 'tsx': return 'TypeScript';
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs': return 'JavaScript';
    case 'json': return 'JSON';
    case 'cpp':
    case 'cc':
    case 'h':
    case 'hpp': return 'C++';
    case 'html': return 'HTML';
    case 'css': return 'CSS';
    default: return 'Source Code';
  }
}

export const FilePatchSchema = z.object({
  filePath: z.string().optional().describe("Target source file path to modify or create (e.g., 'src/sandbox/hello.py' or 'src/sandbox/utils.ts')"),
  path: z.string().optional().describe("Target source file path to modify or create"),
  code: z.string().optional().describe("Complete, precise raw source code content matching the file's programming language and extension (NO markdown code blocks)"),
  content: z.string().optional().describe("Complete, precise raw source code content matching the file's programming language and extension"),
  imports: z.array(z.string()).optional().describe("List of relative or standard module imports required by this code")
});

export const CodeGenSchema = z.object({
  files: z.array(FilePatchSchema).describe("List of file modifications required for the multi-file task"),
  explanations: z.string().describe("Technical explanation of code implementation choices and import resolution")
});

const PROTECTED_PATTERNS = [
  /\.env($|\.)/, 
  /package-lock\.json$/, 
  /\.git\//, 
  /\.vscode\//, 
  /node_modules\//,
  /src\/index\.ts$/,
  /src\/state\.ts$/,
  /src\/agents\//,
  /src\/graph\//,
  /src\/tools\//
];

export function isProtectedFile(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, '/');
  // All generated/modified files MUST reside inside src/sandbox/
  if (!norm.startsWith('src/sandbox/')) {
    return true;
  }
  return PROTECTED_PATTERNS.some((pattern) => pattern.test(norm));
}

export interface GeneratedFilePatch {
  filePath: string;
  code: string;
  imports?: string[];
}

export async function codeGenAgentNode(state: typeof KaizenState.State) {
  const targetFiles = state.targetFiles.length > 0 ? state.targetFiles : ['src/sandbox/main.ts'];

  // Check pre-flight security for all target files
  for (const targetFile of targetFiles) {
    if (isProtectedFile(targetFile)) {
      const blockedPlan: PlanStep[] = state.plan.map((step) => ({
        ...step,
        status: 'failed',
        description: `Security Policy Violation: Write access to protected file '${targetFile}' is strictly prohibited. All code must reside inside 'src/sandbox/'.`
      }));

      return {
        plan: blockedPlan,
        status: "PREFLIGHT_SECURITY_BLOCKED"
      };
    }
  }

  const securityDirective = `// SECURITY MANDATE: Do NOT delete system files, bypass auth, or modify protected environment variables.\n`;
  const retryContext = state.retryCount > 0 ? `\n\n[RETRY ATTEMPT #${state.retryCount}]: Please fix previous feedback / errors in the context below.` : '';
  const apiKey = process.env.GROQ_API_KEY;

  const fileLangSummary = targetFiles
    .map(f => `- ${f} (Language: ${getLanguageFromPath(f)})`)
    .join('\n');

  const planSummary = state.plan && state.plan.length > 0
    ? state.plan.map(s => `- Step ${s.id} [${s.status}]: ${s.description}`).join('\n')
    : "No explicit plan steps provided.";

  let generatedPatches: GeneratedFilePatch[] = [];
  let explanations = '';

  const modelCandidates = [
    'openai/gpt-oss-120b',
    'groq/compound-mini',
    'qwen/qwen3.8-27b',
    'openai/gpt-oss-20b'
  ];

  if (apiKey && apiKey !== 'your_groq_api_key_here') {
    for (const modelName of modelCandidates) {
      try {
        const model = new ChatGroq({
          apiKey: apiKey,
          model: modelName,
          temperature: 0
        });

        const structuredModel = model.withStructuredOutput(CodeGenSchema, { method: 'jsonMode' });

        const systemPrompt = `You are an expert AI software engineer for Kaizen AI specializing in multi-file modular code generation, import resolution, and multi-language support.
Your task is to generate precise, production-ready source code patches in each target file's respective programming language to satisfy the user request and approved plan. Respond in valid json format.

=== MANDATES & GUARDRAILS ===
1. ${securityDirective}
2. SANDBOX PLAYGROUND ISOLATION: All created or modified files MUST be located strictly inside the 'src/sandbox/' folder.
3. LANGUAGE INTEGRITY: Generate code strictly in the target file's programming language as indicated by its file extension (.py -> Python, .ts -> TypeScript, .js -> JavaScript). Do NOT generate TypeScript for Python (.py) files!
4. APPROVED PLAN ADHERENCE: Strictly implement the approved implementation plan steps provided in the context below.
5. PRESERVATION MANDATE: When modifying an existing file inside 'src/sandbox/', NEVER erase or overwrite existing functions or exports unless instructed. Append or integrate new functions cleanly while keeping pre-existing code intact.
6. MULTI-FILE EDITS: Return a patch for EACH target file inside the 'files' array field. Target Files:\n${fileLangSummary}
7. CODE FORMAT: Do NOT wrap code in markdown code blocks (\`\`\`python ... \`\`\` or \`\`\`typescript ... \`\`\`) inside the 'code' string fields. Return pure executable raw source code matching the target file extension.
8. In 'explanations', summarize how functions, classes, and imports were implemented.`;

        const userContextPrompt = `User Request: "${state.userInput}"
Target Files & Languages:
${fileLangSummary}

=== APPROVED IMPLEMENTATION PLAN ===
${planSummary}${retryContext}

=== EXTRACTED GRAPH CONTEXT & SYMBOL MAPS ===
${state.extractedContext || "No context provided."}`;

        const startTime = Date.now();
        const invokePromise = structuredModel.invoke([
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContextPrompt }
        ]);
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error(`ChatGroq model '${modelName}' execution timed out after 10000ms`)), 10000);
        });

        const result = await Promise.race([invokePromise, timeoutPromise]);
        const latencyMs = Date.now() - startTime;

        await langfuseTracer.recordGeneration(
          'CoderAgent',
          modelName,
          userContextPrompt,
          JSON.stringify(result),
          latencyMs,
          250,
          450
        );

        if (result && result.files && result.files.length > 0) {
          generatedPatches = result.files.map((f: z.infer<typeof FilePatchSchema>) => {
            const rawPath = f.filePath || f.path || targetFiles[0];
            const rawCode = f.code || f.content || '';
            return {
              filePath: rawPath.replace(/\\/g, '/'),
              code: rawCode,
              imports: f.imports
            };
          });
          explanations = result.explanations;
          break;
        }
      } catch (error: any) {
        console.warn(`ChatGroq model '${modelName}' execution failed:`, error?.message || error);
      }
    }
  }

  // Fallback generation if LLM is unavailable or unparseable
  if (generatedPatches.length === 0) {
    for (const targetFile of targetFiles) {
      const lang = getLanguageFromPath(targetFile);
      let fallbackCode = "";

      if (lang === 'Python') {
        fallbackCode = `# Target File: ${targetFile}\n# User Task: ${state.userInput}\n\ndef greet(name: str) -> str:\n    """Return Hello, followed by name."""\n    return f"Hello, {name}"\n`;
      } else if (targetFile.endsWith('main.ts')) {
        fallbackCode = `${securityDirective}import { factorial, add, multiply } from './utils';\n\n// task: ${state.userInput}\nexport function executeTask() {\n  const sum = add(10, 20);\n  const prod = multiply(5, 4);\n  const fact = factorial(5);\n  return { status: "success", sum, prod, fact, task: "${state.userInput}" };\n}\n`;
      } else {
        fallbackCode = `${securityDirective}// task: ${state.userInput}\n// target file: ${targetFile}\n\nexport function taskHandler(input: string): string {\n  return "Processed task: " + input;\n}\n`;
      }

      generatedPatches.push({
        filePath: targetFile,
        code: fallbackCode
      });
    }
    explanations = "Generated language-aware fallback implementation.";
  }

  // Filter out any protected file patch outputs
  generatedPatches = generatedPatches.filter(p => !isProtectedFile(p.filePath));

  const updatedPlan: PlanStep[] = state.plan.map((step) => {
    if (step.id === 2) {
      return { ...step, status: 'completed' };
    }
    if (step.id === 3) {
      return { ...step, status: 'in_progress' };
    }
    return step;
  });

  const patchSummaries = generatedPatches
    .map(p => `--- File Patch: ${p.filePath} ---\n${p.code}`)
    .join('\n\n');

  return {
    plan: updatedPlan,
    filePatches: generatedPatches,
    generatedPatch: generatedPatches[0]?.code || "",
    extractedContext: state.extractedContext 
      ? `${state.extractedContext}\n\nGenerated Multi-File Patches:\n${patchSummaries}\nExplanations:\n${explanations}` 
      : `Generated Code:\n${patchSummaries}`,
    status: "CODE_GENERATED"
  };
}

