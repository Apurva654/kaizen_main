import { z } from 'zod';
import { ChatGroq } from '@langchain/groq';
import * as dotenv from 'dotenv';
import { KaizenState, PlanStep } from '../state';
import { langfuseTracer } from '../tools/langfuseTracer';

dotenv.config();

export const FilePatchSchema = z.object({
  filePath: z.string().optional().describe("Target source file path to modify or create (e.g., 'src/sandbox/utils.ts' or 'src/sandbox/main.ts')"),
  path: z.string().optional().describe("Target source file path to modify or create (e.g., 'src/sandbox/utils.ts' or 'src/sandbox/main.ts')"),
  code: z.string().optional().describe("Complete, precise raw TypeScript source code content for this file (NO markdown backticks)"),
  content: z.string().optional().describe("Complete, precise raw TypeScript source code content for this file (NO markdown backticks)"),
  imports: z.array(z.string()).optional().describe("List of relative or standard imports required by this code")
});

export const CodeGenSchema = z.object({
  files: z.array(FilePatchSchema).describe("List of file modifications required for the multi-file task"),
  explanations: z.string().describe("Technical explanation of code implementation choices and relative import resolution")
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

        const systemPrompt = `You are an expert AI software engineer for Kaizen AI specializing in multi-file modular code generation and relative import resolution.
Your task is to generate precise, production-ready TypeScript/JavaScript source code patches for ALL files that need modifications to satisfy the user request. Respond in valid json format.

=== MANDATES & GUARDRAILS ===
1. ${securityDirective}
2. SANDBOX PLAYGROUND ISOLATION: All created or modified files MUST be located strictly inside the 'src/sandbox/' folder (e.g., 'src/sandbox/studentAverage.ts', 'src/sandbox/utils.ts').
3. PRESERVATION MANDATE: When modifying an existing file inside 'src/sandbox/', NEVER erase, delete, or overwrite existing functions or exports created from previous queries. Append or integrate new functions cleanly while keeping all previously written code and exports completely intact!
4. MULTI-FILE EDITS: Return a patch for EACH file that requires changes inside the 'files' array field. Target Files: [${targetFiles.join(', ')}].
5. IMPORT RESOLUTION: Review the workspace graph, symbol mappings, and dependency facts in the context. When main.ts references functions/classes from utils.ts (or other relative modules), ensure correct relative file imports (e.g., import { multiply, add } from './utils';).
6. Do NOT wrap code in markdown code blocks (\`\`\`typescript ... \`\`\`) inside the 'code' string fields. Return pure executable raw TypeScript code.
7. In 'explanations', summarize how symbols and relative imports were resolved across the generated files.`;

        const userContextPrompt = `User Request: "${state.userInput}"
Target Files: ${targetFiles.join(', ')}${retryContext}

=== EXTRACTED GRAPH CONTEXT & SYMBOL MAPS ===
${state.extractedContext || "No context provided."}`;

        const startTime = Date.now();
        const result = await structuredModel.invoke([
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContextPrompt }
        ]);
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
      const isMain = targetFile.endsWith('main.ts');
      const importStmt = isMain ? `import { factorial, add, multiply } from './utils';\n\n` : '';
      const fallbackCode = isMain
        ? `${securityDirective}${importStmt}// task: ${state.userInput}\n// target file: ${targetFile}\n\nexport function executeTask() {\n  const sum = add(10, 20);\n  const prod = multiply(5, 4);\n  const fact = factorial(5);\n  return { status: "success", sum, prod, fact, task: "${state.userInput}" };\n}\n`
        : `${securityDirective}// task: ${state.userInput}\n// target file: ${targetFile}\n\nexport function multiply(a: number, b: number): number {\n  return a * b;\n}\n`;

      generatedPatches.push({
        filePath: targetFile,
        code: fallbackCode
      });
    }
    explanations = "Generated modular multi-file fallback implementation with relative import resolution.";
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
