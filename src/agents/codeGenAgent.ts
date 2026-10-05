import { z } from 'zod';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { KaizenState } from '../state';
import { normalizeSandboxPath } from './plannerAgent';
import { validateCodeSyntax } from '../tools/languageResolver';
import { runStructured } from '../tools/llmRunner';

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
    case 'go': return 'Go';
    case 'rs': return 'Rust';
    case 'java': return 'Java';
    case 'cs': return 'C#';
    case 'cpp':
    case 'cc':
    case 'h':
    case 'hpp': return 'C++';
    case 'c': return 'C';
    case 'php': return 'PHP';
    case 'json': return 'JSON';
    case 'html': return 'HTML';
    case 'css': return 'CSS';
    default: return 'Source Code';
  }
}

export const FilePatchSchema = z.object({
  filePath: z.string().describe("Target source file path under src/sandbox/..."),
  code: z.string().describe("Complete, executable raw source code content matching the file extension")
});

export const CodeGenSchema = z.object({
  files: z.array(FilePatchSchema).min(1).describe("List of file modifications matching target files"),
  explanations: z.string().describe("Technical explanation of implementation choices")
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
  if (!filePath) return true;
  const norm = filePath.replace(/\\/g, '/');
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

export function verifyFileWasWritten(filePath: string): boolean {
  try {
    if (!fs.existsSync(filePath)) {
      console.error(`[FileVerification] File does not exist: ${filePath}`);
      return false;
    }
    const stat = fs.statSync(filePath);
    if (stat.size === 0) {
      console.warn(`[FileVerification] File is empty: ${filePath}`);
      return false;
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    if (content.includes('// File not found:') || content.includes('# File not found:')) {
      console.error(`[FileVerification] File contains error marker: ${filePath}`);
      return false;
    }
    return true;
  } catch (err: any) {
    console.error(`[FileVerification] Error checking file ${filePath}:`, err?.message || err);
    return false;
  }
}

export function sanitizeCodePatch(code: string, _filePath?: string): string {
  if (!code) return '\n';
  let clean = code.trim();
  clean = clean.replace(/^```[a-zA-Z0-9_-]*\r?\n/, '');
  clean = clean.replace(/\r?\n```$/, '');
  clean = clean.trim();
  return clean + '\n';
}

export function saveFilePatchesToServerDiskWithVerification(
  patches: GeneratedFilePatch[],
  emitSSE?: (eventType: string, data: any) => void
): { successCount: number; failedFiles: string[]; verifiedPaths: string[] } {
  const failedFiles: string[] = [];
  const verifiedPaths: string[] = [];
  let successCount = 0;

  for (const patch of patches) {
    if (isProtectedFile(patch.filePath)) {
      console.warn(`[CodeGen] Skipping protected file: ${patch.filePath}`);
      failedFiles.push(patch.filePath);
      continue;
    }

    try {
      const fullPath = path.resolve(process.cwd(), patch.filePath);
      const dir = path.dirname(fullPath);
      
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(fullPath, patch.code, 'utf-8');

      if (verifyFileWasWritten(fullPath)) {
        successCount++;
        verifiedPaths.push(patch.filePath);
        if (emitSSE) {
          emitSSE('file_written', { filePath: patch.filePath });
        }
      } else {
        failedFiles.push(patch.filePath);
      }
    } catch (err: any) {
      console.error(`[CodeGen] Failed to write file ${patch.filePath}:`, err?.message || err);
      failedFiles.push(patch.filePath);
    }
  }

  return { successCount, failedFiles, verifiedPaths };
}

export async function codeGenAgentNode(state: typeof KaizenState.State) {
  const cleanUserQuery = state.originalUserRequest || state.userInput || "";
  const planSteps = state.plan || [];

  const rawTargetFiles = new Set<string>();
  (state.targetFiles || []).forEach(f => {
    const norm = normalizeSandboxPath(f);
    if (norm) rawTargetFiles.add(norm);
  });
  planSteps.forEach(step => {
    if (step.targetFile) {
      const norm = normalizeSandboxPath(step.targetFile);
      if (norm) rawTargetFiles.add(norm);
    }
  });

  const targetFiles = Array.from(rawTargetFiles);
  if (targetFiles.length === 0) {
    return {
      status: 'CODE_GEN_FAILED',
      generationFailureReason: 'The approved plan has no target files.'
    };
  }

  for (const tf of targetFiles) {
    if (isProtectedFile(tf)) {
      return {
        status: 'PREFLIGHT_SECURITY_BLOCKED',
        generationFailureReason: `Protected file access blocked: ${tf}`
      };
    }
  }

  const fileContexts: string[] = [];
  for (const tf of targetFiles) {
    const fullPath = path.resolve(process.cwd(), tf);
    if (fs.existsSync(fullPath)) {
      try {
        const content = fs.readFileSync(fullPath, 'utf-8').slice(0, 12000);
        fileContexts.push(`EXISTING FILE: ${tf}\n${content}`);
      } catch {
        fileContexts.push(`EXISTING FILE: ${tf} (unreadable)`);
      }
    } else {
      fileContexts.push(`NEW FILE: ${tf} (does not exist yet)`);
    }
  }

  const systemPrompt = `You are Kaizen's Principal Software Engineer.
Your job is to generate production-ready code for ALL requested target files.

STRICT CODE GENERATION RULES:
1. Return complete, fully-functional code for EVERY file in targetFiles. Do NOT omit any file.
2. Maintain existing interfaces, imports, and functions unless the plan explicitly requests modifying them.
3. Output clean code without markdown backtick wrappers inside the json code property.
4. Ensure code passes syntax validation for each file's specific programming language.`;

  const approvedPlanSummary = planSteps
    .map(s => `Step ${s.id} [${s.targetFile}]: (${s.action}) ${s.description}`)
    .join('\n');

  const userPromptBaseParts = [
    `USER REQUEST:\n${cleanUserQuery}`,
    `APPROVED PLAN:\n${approvedPlanSummary || 'None specified'}`,
    `TARGET FILES TO GENERATE/UPDATE:\n${targetFiles.join(', ')}`,
    `TARGET FILES CURRENT CONTENT:\n${fileContexts.join('\n\n')}`,
    `RETRIEVED CONTEXT:\n${(state.extractedContext || '').slice(-3000)}`
  ];

  if (state.retryCount && state.retryCount > 0) {
    userPromptBaseParts.push(`NOTE: This is retry attempt #${state.retryCount}. Fix any previous syntax or logic errors.`);
  }

  const userPromptBase = userPromptBaseParts.join('\n\n');

  let lastError = "";
  let finalResult: z.infer<typeof CodeGenSchema> | null = null;

  for (let pass = 1; pass <= 2; pass++) {
    let currentPrompt = userPromptBase;
    if (pass === 2 && lastError) {
      currentPrompt += `\n\nPREVIOUS ATTEMPT WAS REJECTED:\n${lastError}\nPlease fix all reported issues and return complete code for ALL target files.`;
    }

    try {
      const { result } = await runStructured({
        agent: 'CodeGenAgent',
        schema: CodeGenSchema,
        system: systemPrompt,
        user: currentPrompt,
        temperature: 0.2,
        timeoutMs: 60000,
        validate: (res) => {
          if (!res.files || res.files.length === 0) {
            return "CodeGen response returned no files.";
          }

          const returnedPaths = res.files.map(f => normalizeSandboxPath(f.filePath));

          for (const tf of targetFiles) {
            if (!returnedPaths.includes(tf)) {
              return `Target file '${tf}' was missing from the generated response files.`;
            }
          }

          for (const patch of res.files) {
            const normPath = normalizeSandboxPath(patch.filePath);
            if (!targetFiles.includes(normPath)) {
              return `Generated file '${normPath}' was not in the target files list [${targetFiles.join(', ')}].`;
            }
            if (isProtectedFile(normPath)) {
              return `Generated file '${normPath}' is a protected file.`;
            }

            if (!patch.code || patch.code.trim().length === 0) {
              return `Generated code for file '${normPath}' is empty.`;
            }

            const ext = normPath.split('.').pop()?.toLowerCase() || '';
            const syntaxCheck = validateCodeSyntax(patch.code, ext, normPath);
            if (!syntaxCheck.isValid) {
              return `Syntax validation failed for '${normPath}': ${syntaxCheck.error}`;
            }
          }

          return null;
        }
      });

      finalResult = result;
      break;
    } catch (err: any) {
      lastError = err?.message || 'Failed to generate code via LLM.';
    }
  }

  if (!finalResult) {
    return {
      status: 'CODE_GEN_FAILED',
      generationFailureReason: lastError || 'Code generation failed after 2 passes.'
    };
  }

  const filePatches: GeneratedFilePatch[] = finalResult.files.map(f => {
    const normPath = normalizeSandboxPath(f.filePath);
    const sanitizedCode = sanitizeCodePatch(f.code, normPath);
    return {
      filePath: normPath,
      code: sanitizedCode
    };
  });

  saveFilePatchesToServerDiskWithVerification(filePatches);

  const generatedFilePaths = new Set(filePatches.map(f => f.filePath));
  const updatedPlan = planSteps.map(step => {
    if (step.targetFile && generatedFilePaths.has(normalizeSandboxPath(step.targetFile))) {
      return { ...step, status: 'completed' as const };
    }
    return step;
  });

  return {
    filePatches,
    generatedPatch: filePatches[0]?.code || '',
    generationSource: 'llm',
    extractedContext: `${state.extractedContext || ''}\n\nGenerated files:\n${filePatches.map(f => `[${f.filePath}]: ${f.code.slice(0, 150)}...`).join('\n')}`,
    plan: updatedPlan,
    status: 'CODE_GENERATED'
  };
}
