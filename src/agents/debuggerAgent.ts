import { z } from 'zod';
import { runStructured } from '../tools/llmRunner';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { KaizenState } from '../state';
import { langfuseTracer } from '../tools/langfuseTracer';
import { normalizeSandboxPath, isProtectedFile } from '../tools/sandboxPathUtils';
import { FilePatchSchema, getLanguageFromPath, sanitizeCodePatch } from './codeGenAgent';
import { workspaceManager } from '../tools/workspaceManager';

const existsInWorkspace = (p: string): boolean => fs.existsSync(workspaceManager.resolvePath(p));
const readInWorkspace = (p: string): string => existsInWorkspace(p) ? fs.readFileSync(workspaceManager.resolvePath(p), 'utf-8') : '';

dotenv.config();

export const DebuggerSchema = z.object({
  rootCause: z.string().optional(),
  root_cause: z.string().optional(),
  root_cause_analysis: z.string().optional(),
  analysis: z.string().optional(),
  fixExplanation: z.string().optional(),
  fix_explanation: z.string().optional(),
  files: z.array(FilePatchSchema).optional(),
  patches: z.array(FilePatchSchema).optional()
});

export interface DebuggerResult {
  rootCause: string;
  fixExplanation: string;
  filePatches: Array<{ filePath: string; code: string; imports?: string[] }>;
  status: string;
  failureReason?: 'NO_TARGET' | 'LLM_UNAVAILABLE' | 'NO_SAFE_PATCH' | 'LLM_ERROR';
}

export async function debuggerAgentNode(state: typeof KaizenState.State): Promise<DebuggerResult> {
  const isTestFile = (filePath: string) => {
    const norm = filePath.replace(/\\/g, '/');
    const baseName = path.basename(norm);
    return norm.includes('/tests/') || baseName.startsWith('test_') || baseName.endsWith('_test.py') || baseName.endsWith('.test.ts');
  };

  let targetFiles = state.targetFiles.length > 0 ? [...state.targetFiles] : ['src/sandbox/main.ts'];

  // Resolve target implementation file if only a test file is passed in targetFiles
  const resolvedTargets: string[] = [];
  let testFileCandidate = '';

  for (const tf of targetFiles) {
    const norm = tf.replace(/\\/g, '/');
    if (isTestFile(norm)) {
      testFileCandidate = norm;
      const baseName = path.basename(norm);
      const implName = baseName.replace('test_', '').replace('_test.py', '.py').replace('.test.ts', '.ts');
      const possibleImplPath = `src/sandbox/${implName}`;
      if (existsInWorkspace(possibleImplPath)) {
        resolvedTargets.push(possibleImplPath);
      }
    } else {
      resolvedTargets.push(norm);
    }
  }

  // Fallback scan of src/sandbox for impl file if only test file existed
  if (resolvedTargets.length === 0 && testFileCandidate) {
    const sandboxDir = workspaceManager.getSandboxDir();
    if (fs.existsSync(sandboxDir)) {
      const impls = fs.readdirSync(sandboxDir).filter(f => !f.startsWith('test_') && !f.includes('_test.'));
      if (impls.length > 0) {
        resolvedTargets.push(`src/sandbox/${impls[0]}`);
      }
    }
  }

  const primaryTarget = resolvedTargets[0] || 'src/sandbox/buggy_divide.py';
  const targetLang = getLanguageFromPath(primaryTarget);

  if (!testFileCandidate) {
    const norm = primaryTarget.replace(/\\/g, '/');
    const baseName = path.basename(norm);
    const possibleTestPath = `src/sandbox/test_${baseName}`;
    if (existsInWorkspace(possibleTestPath)) {
      testFileCandidate = possibleTestPath;
    }
  }

  const targetCode = readInWorkspace(primaryTarget);
  const testCode = testFileCandidate ? readInWorkspace(testFileCandidate) : '';

  // Retrieve latest structured failure object & compiler errors
  const failures = (state as any).structuredFailures || [];
  const lastFailure = failures.length > 0 ? failures[failures.length - 1] : undefined;
  const compilerError = (state as any).compilerError || '';

  const failureDetails = [
    lastFailure ? `Exit Code: ${lastFailure.exitCode}\nSummary: ${lastFailure.summary || lastFailure.message || 'Test assertion failure'}` : '',
    lastFailure && (lastFailure.stderr || lastFailure.stdout) ? `Test Logs:\n${(lastFailure.stderr || lastFailure.stdout).slice(-2000)}` : '',
    compilerError ? `Compiler Error:\n${compilerError.slice(-2000)}` : '',
    state.testLogs ? `Automated Test Logs:\n${state.testLogs}` : (state.extractedContext ? `Diagnostic Context:\n${state.extractedContext.slice(-2000)}` : '')
  ].filter(Boolean).join('\n\n');

  const geminiApiKey = process.env.GEMINI_API_KEY;

  console.log("\n-> Running Debugger Agent (debuggerAgent.ts)...");
  console.log(`Target Implementation File: "${primaryTarget}" (Language: ${targetLang})`);
  console.log(`Test File: "${testFileCandidate || 'None'}"`);

  if (geminiApiKey && geminiApiKey !== 'your_gemini_api_key_here') {
    try {
      const systemPrompt = `You are an expert AI Debugger Agent for Kaizen AI. Respond in valid json format.
Your task is to analyze failing test reports, compiler errors, and stack traces, diagnose the root cause, and generate complete, corrected code patches for the target implementation file.
Do NOT modify test files unless explicitly requested. Fix the implementation to satisfy the test assertions.

=== TARGET FILE ===
Path: ${primaryTarget}
Language: ${targetLang}
Current Source Code:
\`\`\`
${targetCode || '(File does not exist yet / empty)'}
\`\`\`

=== TEST FILE ===
Path: ${testFileCandidate || 'N/A'}
Test Source Code:
\`\`\`
${testCode || '(No test file)'}
\`\`\`

=== DIAGNOSTIC & FAILURE LOGS ===
${failureDetails || '(No diagnostic logs available)'}`;

      const userPrompt = `USER REQUEST: ${state.originalUserRequest || state.userInput}\n\nPlease analyze the above failure logs and fix ${primaryTarget} so all tests and compiler checks pass.`;

      const { result: rawResult } = await runStructured({
        agent: 'DebuggerAgent',
        schema: DebuggerSchema,
        system: systemPrompt,
        user: userPrompt,
        temperature: 0
      });

      if (rawResult) {
        const filePatches: Array<{ filePath: string; code: string; imports?: string[] }> = [];
        const rawPatches = rawResult.files || rawResult.patches || [];

        for (const item of rawPatches) {
          const rawItem = item as any;
          const rawPath = rawItem.filePath || rawItem.file_path || primaryTarget;
          const normPath = normalizeSandboxPath(rawPath);
          // Protect test files and protected files from debugger alteration
          if (normPath && !isProtectedFile(normPath) && !isTestFile(normPath) && rawItem.code) {
            filePatches.push({
              filePath: normPath,
              code: sanitizeCodePatch(rawItem.code),
              imports: rawItem.imports || []
            });
          }
        }

        if (filePatches.length > 0) {
          return {
            rootCause: rawResult.rootCause || rawResult.root_cause || rawResult.analysis || 'Analyzed test failure logs.',
            fixExplanation: rawResult.fixExplanation || rawResult.fix_explanation || 'Generated corrective code patch.',
            filePatches,
            status: 'DEBUG_FIX_GENERATED'
          };
        }
      }
    } catch (err: any) {
      console.warn('[DebuggerAgent] Structured LLM debugging failed, falling back to heuristic:', err?.message || err);
    }
  }

  // Grounded deterministic fallback bug resolution
  console.log("[DebuggerAgent] Operating in grounded deterministic fallback bug resolution mode...");
  
  // No LLM available: never overwrite user code with a guessed patch.

  return {
    rootCause: `Diagnosed test failure or compilation issue in ${primaryTarget}.`,
    fixExplanation: `Automated patch generation was unable to verify a clean fix without LLM guidance.`,
    filePatches: [],
    status: "DEBUG_FAILED"
  };
}
