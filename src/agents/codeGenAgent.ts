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

// FIX #4: files that are legitimately empty
const EMPTY_ALLOWED_FILES = new Set(['__init__.py', '.gitkeep']);

function isEmptyAllowed(filePath: string): boolean {
  const base = filePath.replace(/\\/g, '/').split('/').pop() || '';
  return EMPTY_ALLOWED_FILES.has(base);
}

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
    if (stat.size === 0 && !isEmptyAllowed(filePath)) {
      console.warn(`[FileVerification] File is empty: ${filePath}`);
      return false;
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    // FIX #4: only treat it as an error placeholder if the FILE STARTS with the marker,
    // so real code containing that comment (404 handlers, fixtures) is not rejected.
    const head = content.trimStart();
    if (head.startsWith('// File not found:') || head.startsWith('# File not found:')) {
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
  clean = clean.replace(/^```[a-zA-Z0-9_+.-]*[ \t]*\r?\n/, '');
  clean = clean.replace(/\r?\n[ \t]*```$/, '');
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

export async function codeGenAgentNode(
  state: typeof KaizenState.State,
  emitSSE?: (eventType: string, data: any) => void
) {
  const cleanUserQuery = state.originalUserRequest || state.userInput || "";
  // FIX #6: always process steps in plan order
  const planSteps = [...(state.plan || [])].sort((a, b) => a.id - b.id);

  // FIX #1: the approved plan is the source of truth for target files.
  // state.targetFiles accumulates across rejected attempts (Set union reducer), so it is
  // only used as a fallback when there is no plan at all.
  const rawTargetFiles = new Set<string>();
  planSteps.forEach(step => {
    if (step.targetFile) {
      const norm = normalizeSandboxPath(step.targetFile);
      if (norm) rawTargetFiles.add(norm);
    }
  });
  if (rawTargetFiles.size === 0) {
    (state.targetFiles || []).forEach(f => {
      const norm = normalizeSandboxPath(f);
      if (norm) rawTargetFiles.add(norm);
    });
  }

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
4. Ensure code passes syntax validation for each file's specific programming language.
5. When several plan steps target the same file, apply them IN ORDER (lowest step number first) and return ONE final file that contains the combined result of all of them.`;

  const approvedPlanSummary = planSteps
    .map(s => {
      const deps = s.dependencies && s.dependencies.length > 0 ? ` depends on: ${s.dependencies.join(', ')}` : '';
      return `Step ${s.id} [${s.targetFile}]: (${s.action}) ${s.description}${deps}`;
    })
    .join('\n');

  // FIX #6: per-file ordered view so multiple steps on one file are not skipped
  const stepsPerFile = targetFiles
    .map(tf => {
      const steps = planSteps.filter(s => normalizeSandboxPath(s.targetFile || '') === tf);
      if (steps.length <= 1) return '';
      return `${tf}: apply steps ${steps.map(s => `#${s.id} (${s.action})`).join(' -> ')} in this order`;
    })
    .filter(Boolean)
    .join('\n');

  const userPromptBaseParts = [
    `USER REQUEST:\n${cleanUserQuery}`,
    `APPROVED PLAN:\n${approvedPlanSummary || 'None specified'}`,
    `TARGET FILES TO GENERATE/UPDATE:\n${targetFiles.join(', ')}`,
  ];

  if (stepsPerFile) {
    userPromptBaseParts.push(`MULTI-STEP FILES (combine into one final file each):\n${stepsPerFile}`);
  }

  userPromptBaseParts.push(
    `TARGET FILES CURRENT CONTENT:\n${fileContexts.join('\n\n')}`,
    `RETRIEVED CONTEXT:\n${(state.extractedContext || '').slice(-3000)}`
  );

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

            if ((!patch.code || patch.code.trim().length === 0) && !isEmptyAllowed(normPath)) {
              return `Generated code for file '${normPath}' is empty.`;
            }

            // FIX #3: validate the SAME sanitized text that will be written to disk,
            // so stray markdown fences don't cause false syntax failures.
            const cleanedCode = sanitizeCodePatch(patch.code, normPath);
            const ext = normPath.split('.').pop()?.toLowerCase() || '';
            const syntaxCheck = validateCodeSyntax(cleanedCode, ext, normPath);
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

  // FIX #2: actually use the write/verification result
  const writeResult = saveFilePatchesToServerDiskWithVerification(filePatches, emitSSE);

  if (writeResult.failedFiles.length > 0) {
    return {
      status: 'CODE_GEN_FAILED',
      generationFailureReason: `Failed to write or verify files on disk: ${writeResult.failedFiles.join(', ')}`
    };
  }

  // Only steps whose file was verified on disk are marked completed; others are failed
  const verifiedPaths = new Set(writeResult.verifiedPaths);
  const updatedPlan = planSteps.map(step => {
    if (step.targetFile) {
      const norm = normalizeSandboxPath(step.targetFile);
      if (verifiedPaths.has(norm)) {
        return { ...step, status: 'completed' as const };
      }
      return { ...step, status: 'failed' as const };
    }
    return step;
  });

  // FIX #5: keep every file in generatedPatch for single-patch consumers
  // (single file => raw code, same as before; multiple files => labelled sections)
  const generatedPatch = filePatches.length === 1
    ? filePatches[0].code
    : filePatches.map(f => `// ===== FILE: ${f.filePath} =====\n${f.code}`).join('\n');

  return {
    filePatches,
    generatedPatch,
    generationSource: 'llm',
    extractedContext: `${state.extractedContext || ''}\n\nGenerated files:\n${filePatches.map(f => `[${f.filePath}]: ${f.code.slice(0, 150)}...`).join('\n')}`,
    plan: updatedPlan,
    status: 'CODE_GENERATED'
  };
}