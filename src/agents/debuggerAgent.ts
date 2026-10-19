import { z } from 'zod';
import { runStructured } from '../tools/llmRunner';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { KaizenState } from '../state';
import { langfuseTracer } from '../tools/langfuseTracer';
import { normalizeSandboxPath, isProtectedFile, isTestFile } from '../tools/sandboxPathUtils';
import { permissionGate } from '../tools/permissionGate';
import { FilePatchSchema, getLanguageFromPath, sanitizeCodePatch } from './codeGenAgent';

dotenv.config();

export const DebuggerSchema = z.object({
  rootCause: z.string().optional(),
  root_cause: z.string().optional(),
  root_cause_analysis: z.string().optional(),
  analysis: z.string().optional(),
  fixExplanation: z.string().optional(),
  fix_explanation: z.string().optional(),
  files: z.array(z.union([FilePatchSchema, z.object({
    filePath: z.string().optional(),
    file_path: z.string().optional(),
    code: z.string().optional(),
    imports: z.array(z.string()).optional()
  })])).optional(),
  patches: z.array(z.union([FilePatchSchema, z.object({
    filePath: z.string().optional(),
    file_path: z.string().optional(),
    code: z.string().optional(),
    imports: z.array(z.string()).optional()
  })])).optional()
});

export interface DebuggerResult {
  rootCause: string;
  fixExplanation: string;
  filePatches: Array<{ filePath: string; code: string; imports?: string[] }>;
  status: string;
  failureReason?: 'NO_TARGET' | 'LLM_UNAVAILABLE' | 'NO_SAFE_PATCH' | 'LLM_ERROR';
}

/**
 * Re-export single source of truth isTestFile from sandboxPathUtils
 */
export { isTestFile };


/**
 * Resolves target implementation files and test candidates strictly using reliable
 * conventions and verified mappings without arbitrary sandbox file selection.
 */
export function resolveImplementationTarget(
  targetFiles: string[] | undefined,
  baseDir: string = process.cwd()
): { resolvedTargets: string[]; testFileCandidate: string } {
  const resolvedTargets: string[] = [];
  let testFileCandidate = '';

  const rawTargets = Array.isArray(targetFiles) ? targetFiles.filter(Boolean) : [];

  for (const tf of rawTargets) {
    const rawStr = String(tf).trim();
    if (!rawStr) continue;

    const norm = normalizeSandboxPath(rawStr);
    if (!norm) continue;

    if (isTestFile(norm)) {
      testFileCandidate = norm;
      const baseName = path.basename(norm);

      // Derive possible implementation basename from test naming conventions
      let implBase = baseName;
      if (baseName.startsWith('test_')) {
        implBase = baseName.replace(/^test_/, '');
      } else if (baseName.startsWith('test.')) {
        implBase = baseName.replace(/^test\./, '');
      } else if (baseName.endsWith('_test.py')) {
        implBase = baseName.replace(/_test\.py$/, '.py');
      } else if (baseName.endsWith('.test.ts')) {
        implBase = baseName.replace(/\.test\.ts$/, '.ts');
      } else if (baseName.endsWith('.spec.ts')) {
        implBase = baseName.replace(/\.spec\.ts$/, '.ts');
      } else if (baseName.endsWith('.test.js')) {
        implBase = baseName.replace(/\.test\.js$/, '.js');
      } else if (baseName.endsWith('.spec.js')) {
        implBase = baseName.replace(/\.spec\.js$/, '.js');
      } else if (baseName.endsWith('_test.ts')) {
        implBase = baseName.replace(/_test\.ts$/, '.ts');
      } else if (baseName.endsWith('_test.js')) {
        implBase = baseName.replace(/_test\.js$/, '.js');
      }

      // Check if derived implementation exists in sandbox
      const possibleImplPath = `src/sandbox/${implBase}`;
      const fullPossiblePath = path.resolve(baseDir, possibleImplPath);
      if (fs.existsSync(fullPossiblePath)) {
        resolvedTargets.push(possibleImplPath);
      } else {
        // Also inspect test file imports if the test file exists on disk
        const fullTestPath = path.resolve(baseDir, norm);
        if (fs.existsSync(fullTestPath)) {
          try {
            const testContent = fs.readFileSync(fullTestPath, 'utf-8');
            // Python: from <mod> import ... or import <mod>
            const pyMatches = testContent.match(/(?:from|import)\s+([a-zA-Z0-9_]+)/g);
            if (pyMatches) {
              for (const m of pyMatches) {
                const modName = m.replace(/^(from|import)\s+/, '').trim();
                const cand = `src/sandbox/${modName}.py`;
                if (fs.existsSync(path.resolve(baseDir, cand))) {
                  resolvedTargets.push(cand);
                  break;
                }
              }
            }
            // TypeScript/JavaScript: from './<mod>' or require('./<mod>')
            const tsMatches = testContent.match(/(?:from\s+['"]|require\(['"])\.\/([^'"]+)['"]/g);
            if (tsMatches && resolvedTargets.length === 0) {
              for (const m of tsMatches) {
                const sub = m.replace(/^(?:from\s+['"]|require\(['"])\.\//, '').replace(/['"]\)?$/, '').trim();
                for (const ext of ['.ts', '.js', '']) {
                  const cand = `src/sandbox/${sub}${ext}`;
                  if (fs.existsSync(path.resolve(baseDir, cand))) {
                    resolvedTargets.push(cand);
                    break;
                  }
                }
                if (resolvedTargets.length > 0) break;
              }
            }
          } catch {
            // Ignore read errors
          }
        }
      }
    } else {
      // Non-test file is an explicit implementation target
      resolvedTargets.push(norm);
    }
  }

  // Look for corresponding test file if implementation is known but testFileCandidate is not yet set
  if (resolvedTargets.length > 0 && !testFileCandidate) {
    const primary = resolvedTargets[0];
    const baseName = path.basename(primary);
    const dirName = path.dirname(primary);
    const candidates = [
      `${dirName}/test_${baseName}`,
      `${dirName}/${baseName.replace(/\.([a-zA-Z0-9]+)$/, '_test.$1')}`,
      `${dirName}/${baseName.replace(/\.ts$/, '.test.ts')}`,
      `${dirName}/${baseName.replace(/\.ts$/, '.spec.ts')}`,
      `${dirName}/${baseName.replace(/\.js$/, '.test.js')}`,
      `${dirName}/${baseName.replace(/\.js$/, '.spec.js')}`,
      `${dirName}/tests/${baseName.replace(/\.ts$/, '.test.ts')}`,
      `${dirName}/tests/${baseName.replace(/\.py$/, '_test.py')}`,
      `${dirName}/tests/test_${baseName}`
    ];

    for (const cand of candidates) {
      if (fs.existsSync(path.resolve(baseDir, cand))) {
        testFileCandidate = cand;
        break;
      }
    }
  }

  return { resolvedTargets, testFileCandidate };
}

/**
 * Extracts comprehensive failure diagnostics without discarding extractedContext or testLogs.
 */
export function extractFailureDetails(state: any): string {
  const sections: string[] = [];

  // 1. Structured failures / failureDetails
  const failures = Array.isArray(state?.structuredFailures) ? state.structuredFailures : [];
  const lastStructured = failures.length > 0 ? failures[failures.length - 1] : null;
  const directFailureDetails = state?.failureDetails;

  const failureObj = lastStructured || (directFailureDetails?.structuredFailure ? directFailureDetails.structuredFailure : directFailureDetails);

  if (failureObj && typeof failureObj === 'object') {
    const lines: string[] = [];
    if (typeof failureObj.exitCode !== 'undefined' && failureObj.exitCode !== null) {
      lines.push(`Exit Code: ${failureObj.exitCode}`);
    }
    const summary = failureObj.summary || failureObj.message;
    if (summary && typeof summary === 'string') {
      lines.push(`Summary: ${summary}`);
    }
    const stderr = failureObj.stderr;
    if (stderr && typeof stderr === 'string' && stderr.trim()) {
      lines.push(`Stderr / Trace:\n${stderr.trim().slice(-2500)}`);
    }
    const stdout = failureObj.stdout;
    if (stdout && typeof stdout === 'string' && stdout.trim() && stdout.trim() !== stderr?.trim()) {
      lines.push(`Stdout:\n${stdout.trim().slice(-2000)}`);
    }
    if (lines.length > 0) {
      sections.push(lines.join('\n'));
    }
  }

  // 2. Compiler errors
  const compilerErr = state?.compilerError || directFailureDetails?.compilerError;
  if (compilerErr && typeof compilerErr === 'string' && compilerErr.trim()) {
    sections.push(`Compiler Error:\n${compilerErr.trim().slice(-2500)}`);
  }

  // 3. Automated Test logs (prioritized, not dropped)
  const testLogs = state?.testLogs;
  if (testLogs && typeof testLogs === 'string' && testLogs.trim()) {
    sections.push(`Automated Test Logs:\n${testLogs.trim().slice(-3000)}`);
  }

  // 4. Extracted Diagnostic context (crucially preserved alongside testLogs)
  const extracted = state?.extractedContext;
  if (extracted && typeof extracted === 'string' && extracted.trim()) {
    sections.push(`Diagnostic Context:\n${extracted.trim().slice(-2500)}`);
  }

  // 5. If retry count > 0, include iteration attempt indicator
  if (typeof state?.retryCount === 'number' && state.retryCount > 0) {
    sections.push(`Self-Healing Attempt: #${state.retryCount}`);
  }

  return sections.join('\n\n');
}

/**
 * Searches failure logs for a line number associated with a target file.
 */
function findLineNumberInLogs(filePath: string, logText: string): number | null {
  if (!logText) return null;
  const base = path.basename(filePath);
  const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedFull = filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const regexColon = new RegExp(`(?:${escapedFull}|${escapedBase}):(\\d+)`, 'i');
  const matchColon = logText.match(regexColon);
  if (matchColon) {
    const num = parseInt(matchColon[1], 10);
    if (!isNaN(num) && num > 0) return num;
  }

  const regexLine = new RegExp(`(?:${escapedFull}|${escapedBase})[^\n]*?\\bline\\s+(\\d+)`, 'i');
  const matchLine = logText.match(regexLine);
  if (matchLine) {
    const num = parseInt(matchLine[1], 10);
    if (!isNaN(num) && num > 0) return num;
  }

  return null;
}

/**
 * Loads source code for a target file. Caps at ~400 lines; for larger files sends
 * +/- 40 lines around the line number found in failure logs plus the first 30 lines.
 */
function loadTargetSource(targetPath: string, failureDetails: string, baseDir: string = process.cwd()): string {
  const fullPath = path.isAbsolute(targetPath) ? targetPath : path.resolve(baseDir, targetPath);
  if (!fs.existsSync(fullPath)) return '';

  try {
    const rawContent = fs.readFileSync(fullPath, 'utf-8');
    const lines = rawContent.split(/\r?\n/);

    if (lines.length <= 400) {
      return rawContent;
    }

    const lineNum = findLineNumberInLogs(targetPath, failureDetails);
    const headerLines = lines.slice(0, 30);

    if (lineNum !== null && lineNum > 0) {
      const windowStart = Math.max(30, lineNum - 41);
      const windowEnd = Math.min(lines.length, lineNum + 40);

      if (windowStart > 30) {
        const windowLines = lines.slice(windowStart, windowEnd);
        return [
          ...headerLines,
          `// ... [lines 31 to ${windowStart} truncated] ...`,
          ...windowLines,
          windowEnd < lines.length ? `// ... [lines ${windowEnd + 1} to ${lines.length} truncated] ...` : ''
        ].filter(Boolean).join('\n');
      } else {
        const directSlice = lines.slice(0, Math.min(lines.length, Math.max(400, windowEnd)));
        return directSlice.join('\n') + `\n// ... [remaining lines truncated] ...`;
      }
    }

    return lines.slice(0, 400).join('\n') + `\n// ... [lines 401 to ${lines.length} truncated] ...`;
  } catch {
    return '';
  }
}

export async function debuggerAgentNode(
  state: typeof KaizenState.State,
  options?: { runStructuredFn?: typeof runStructured }
): Promise<DebuggerResult> {
  // Resolve target implementation file strictly using reliable conventions
  const { resolvedTargets, testFileCandidate } = resolveImplementationTarget(state.targetFiles);

  // If the implementation target cannot be identified with confidence, fail safely without guessing
  if (resolvedTargets.length === 0) {
    console.warn('[DebuggerAgent] Unable to resolve implementation target file with confidence.');
    return {
      rootCause: testFileCandidate
        ? `Could not reliably resolve implementation target corresponding to test file '${testFileCandidate}'.`
        : 'No implementation target file specified or resolvable from context.',
      fixExplanation: 'Debugging halted safely: Target implementation file could not be identified with confidence. Speculative patching was avoided.',
      filePatches: [],
      status: 'DEBUG_FAILED',
      failureReason: 'NO_TARGET'
    };
  }

  const primaryTarget = resolvedTargets[0];
  const targetLang = getLanguageFromPath(primaryTarget);

  const targetsToLoad = resolvedTargets.slice(0, 3);
  const failureDetails = extractFailureDetails(state);

  const targetSourcesBlock = targetsToLoad.map((tPath, idx) => {
    const lang = getLanguageFromPath(tPath);
    const code = loadTargetSource(tPath, failureDetails);
    const isPrimary = tPath === primaryTarget;
    return `=== TARGET IMPLEMENTATION${targetsToLoad.length > 1 ? ` [${idx + 1}/${targetsToLoad.length}]` : ''} ===
Path: ${tPath}${isPrimary && targetsToLoad.length > 1 ? ' (PRIMARY SUSPECT)' : ''}
Language: ${lang}
Source:
\`\`\`
${code || '(Missing or empty source file)'}
\`\`\``;
  }).join('\n\n');

  const testCode = (testFileCandidate && fs.existsSync(testFileCandidate)) ? fs.readFileSync(testFileCandidate, 'utf-8') : '';

  const geminiApiKey = process.env.GEMINI_API_KEY;

  console.log("\n-> Running Debugger Agent (debuggerAgent.ts)...");
  console.log(`Target Implementation Files: [${targetsToLoad.join(', ')}] (Primary Suspect: "${primaryTarget}", Language: ${targetLang})`);
  console.log(`Test File: "${testFileCandidate || 'None'}"`);

  if (!geminiApiKey || geminiApiKey === 'your_gemini_api_key_here') {
    console.warn('[DebuggerAgent] GEMINI_API_KEY is missing or unconfigured. Cannot run structured LLM debugging.');
    return {
      rootCause: `LLM service unavailable (missing GEMINI_API_KEY) to diagnose failures in ${primaryTarget}.`,
      fixExplanation: 'Automated patch generation halted safely. No speculative or hardcoded repairs were applied.',
      filePatches: [],
      status: 'DEBUG_FAILED',
      failureReason: 'LLM_UNAVAILABLE'
    };
  }

  try {
    const systemPrompt = `You are Kaizen AI's senior software debugging agent. Diagnose test failures, compiler errors, and runtime exceptions using evidence from the supplied source code, tests, and diagnostics. Generate a minimal, complete corrective patch.

${targetSourcesBlock}

=== TEST CONTEXT ===
Path: ${testFileCandidate || 'N/A'}
Source:
\`\`\`
${testCode || '(No test source available)'}
\`\`\`

=== FAILURE DIAGNOSTICS ===
${failureDetails || '(No diagnostic logs available)'}

=== REQUIRED DEBUGGING PROCESS ===

1. Diagnose before editing.
Identify the specific failing assertion, compiler error, exception, or stack-trace location. Trace it to the relevant implementation logic. Explain the root cause using evidence from the supplied context. Distinguish the actual cause from secondary errors.

2. Respect the evidence.
Use the source code, tests, and diagnostics provided. Do not invent missing functions, APIs, dependencies, test expectations, or execution results. If evidence is insufficient, explain the uncertainty and avoid speculative patches.

3. Produce a minimal, complete fix.
Correct the underlying defect rather than suppressing symptoms. Preserve existing interfaces, function signatures, exports, types, dependencies, and unrelated functionality. Handle relevant edge cases without rewriting the entire file unnecessarily.

4. Respect file boundaries.
PERMITTED FILES: [${resolvedTargets.join(', ')}]. Primary suspect: ${primaryTarget}. Do not modify files outside this list or any test file. Return patches only for relevant implementation files supported by the available evidence. Do not invent target paths or change unrelated files. Respect sandbox and protected-file restrictions.

5. Validate logically.
Check syntax, imports, types, return paths, existing contracts, and consistency with the supplied tests. Do not remove assertions, disable validation, swallow exceptions, hardcode test-specific answers, or bypass security checks to force success.

6. Handle missing information safely.
If the target source or relevant failure evidence is missing, state the limitation. Do not replace an unresolved target with an unrelated implementation. Do not claim tests or builds passed unless execution results confirm this.

7. Learn from previous attempts.
If earlier repair attempts and their new diagnostics are supplied, use them to revise the diagnosis. Do not repeat a failed patch unchanged or alternate between speculative fixes.

=== OUTPUT CONTRACT ===

Return ONLY valid JSON accepted by the existing DebuggerSchema.

Use:
- rootCause or root_cause for the evidence-based diagnosis.
- fixExplanation or fix_explanation for the proposed correction.
- files or patches for the corrected implementation patches.

Each patch must follow the existing FilePatchSchema exactly, including its required field names and types. Use the exact target path expected by the existing pipeline.

When a reliable fix cannot be established, do not fabricate one. Explain the limitation using the existing schema fields and return no speculative file patches.

Do not include Markdown fences or prose outside the JSON object.

Priority: evidence-based diagnosis, minimal correct patch, preservation of existing behaviour, and honest validation reporting.`;

    const userPrompt = `USER REQUEST: ${state.originalUserRequest || state.userInput || 'Debug and repair failure'}\n\nPlease analyze the above failure logs and fix ${primaryTarget} (permitted files: [${resolvedTargets.join(', ')}]) so all tests and compiler checks pass.`;

    const runner = options?.runStructuredFn || runStructured;
    const { result: rawResult } = await runner({
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
        if (!item || typeof item !== 'object') continue;
        const rawItem = item as any;
        const rawPath = rawItem.filePath || rawItem.file_path;

        // Reject patches with missing or empty file paths; never silently redirect
        if (!rawPath || typeof rawPath !== 'string' || !rawPath.trim()) {
          console.warn('[DebuggerAgent] Rejected patch with missing or empty filePath.');
          continue;
        }

        // Reject patches with empty or missing code
        if (typeof rawItem.code !== 'string' || !rawItem.code.trim()) {
          console.warn(`[DebuggerAgent] Rejected patch for '${rawPath}' with missing or empty code.`);
          continue;
        }

        const normPath = normalizeSandboxPath(rawPath);

        // Reject invalid, escaped, or non-sandbox paths
        if (!normPath) {
          console.warn(`[DebuggerAgent] Rejected un-normalizable sandbox path: '${rawPath}'`);
          continue;
        }

        // Reject protected files
        if (isProtectedFile(normPath)) {
          console.warn(`[DebuggerAgent] Rejected patch targeting protected file: '${normPath}'`);
          continue;
        }

        // Reject test files
        if (isTestFile(normPath)) {
          console.warn(`[DebuggerAgent] Rejected patch targeting test file: '${normPath}'`);
          continue;
        }

        // Security authorization check: ensure path is within sandbox and not protected
        if (!normPath.startsWith('src/sandbox/') || isProtectedFile(normPath)) {
          console.warn(`[DebuggerAgent] Security boundary blocked write to: '${normPath}'`);
          continue;
        }

        // Ensure patch targets an intended implementation file or existing sandbox file justified by evidence
        const isIntendedTarget = resolvedTargets.includes(normPath) || normPath === primaryTarget;
        const isExistingSandboxFile = fs.existsSync(normPath);
        if (!isIntendedTarget && !isExistingSandboxFile) {
          console.warn(`[DebuggerAgent] Rejected patch for untargeted / nonexistent file: '${normPath}'`);
          continue;
        }

        filePatches.push({
          filePath: normPath,
          code: sanitizeCodePatch(rawItem.code, normPath),
          imports: Array.isArray(rawItem.imports) ? rawItem.imports : []
        });
      }

      if (filePatches.length > 0) {
        return {
          rootCause: rawResult.rootCause || rawResult.root_cause || rawResult.root_cause_analysis || rawResult.analysis || `Diagnosed failure in ${primaryTarget}.`,
          fixExplanation: rawResult.fixExplanation || rawResult.fix_explanation || `Generated minimal corrective patch for ${primaryTarget}.`,
          filePatches,
          status: 'DEBUG_FIX_GENERATED'
        };
      } else {
        return {
          rootCause: rawResult.rootCause || rawResult.root_cause || rawResult.root_cause_analysis || rawResult.analysis || `Analyzed failure in ${primaryTarget}, but no valid patches could be produced.`,
          fixExplanation: rawResult.fixExplanation || rawResult.fix_explanation || 'No valid or safe file patches could be generated from the available diagnostics.',
          filePatches: [],
          status: 'DEBUG_FAILED',
          failureReason: 'NO_SAFE_PATCH'
        };
      }
    }
  } catch (err: any) {
    console.warn('[DebuggerAgent] Structured LLM debugging failed:', err?.message || err);
    return {
      rootCause: `Diagnostic failure during analysis of ${primaryTarget}: ${err?.message || 'Model execution error'}.`,
      fixExplanation: 'Automated debugger was unable to generate an evidence-based fix due to an execution error.',
      filePatches: [],
      status: 'DEBUG_FAILED',
      failureReason: 'LLM_ERROR'
    };
  }

  // Safe fallback if model result was empty without throwing
  console.log(`[DebuggerAgent] Structured debugging could not generate a patch for '${primaryTarget}'. Halting safely.`);
  return {
    rootCause: `Diagnosed failure or compilation issue in ${primaryTarget}.`,
    fixExplanation: 'Automated patch generation was unable to verify a clean fix without model guidance. No speculative or hardcoded repairs were applied.',
    filePatches: [],
    status: 'DEBUG_FAILED',
    failureReason: 'LLM_ERROR'
  };
}
