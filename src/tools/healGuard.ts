import * as crypto from 'crypto';
import { TestExecutionResult } from './testRunner';

/**
 * Normalizes an error line:
 * - Strips Windows drive paths (e.g. C:\path\to\file.js -> file.js)
 * - Strips Unix absolute paths (e.g. /home/user/file.js -> file.js)
 * - Strips timestamps (e.g. 2026-10-19T14:50:00.000Z or [14:50:00])
 * - Trims whitespace
 */
export function normalizeErrorLine(line: string): string {
  if (!line || typeof line !== 'string') return '';
  let norm = line.trim();
  // Strip timestamps
  norm = norm.replace(/\b\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, '[timestamp]');
  norm = norm.replace(/\[\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?\]/gi, '[timestamp]');
  // Strip Windows absolute path prefixes: C:\...\file.ext -> file.ext
  norm = norm.replace(/[a-zA-Z]:\\[^:\s\r\n]+\\([a-zA-Z0-9_\-\.]+\.[a-zA-Z0-9]+)/g, '$1');
  // Strip Unix absolute path prefixes: /.../file.ext -> file.ext
  norm = norm.replace(/(?:\/[a-zA-Z0-9_\-\.]+)+\/([a-zA-Z0-9_\-\.]+\.[a-zA-Z0-9]+)/g, '$1');
  return norm.trim();
}

/**
 * Computes a deterministic failure signature from a TestExecutionResult:
 * hash of structuredFailure.errorType + sourceFile + first error line of stderr normalized.
 */
export function failureSignature(testResult: TestExecutionResult): string {
  const sf = testResult?.structuredFailure;
  const errorType = sf?.errorType || testResult?.failureType || 'Error';
  const sourceFile = sf?.sourceFile || (testResult?.testedFiles && testResult.testedFiles[0]) || '';

  const stderr = testResult?.stderr || testResult?.stdout || testResult?.summary || '';
  const lines = stderr.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  const firstErrorLine = lines.find(l => /error|fail|exception|assert/i.test(l)) || lines[0] || 'UnknownError';
  const normalizedLine = normalizeErrorLine(firstErrorLine);

  const raw = `${errorType}::${sourceFile}::${normalizedLine}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

/**
 * Computes a hash of the patch set:
 * hash of sorted filePath + code.
 */
export function patchHash(patches: Array<{ filePath: string; code: string }>): string {
  if (!patches || patches.length === 0) return '';
  const sorted = [...patches].sort((a, b) => a.filePath.localeCompare(b.filePath));
  const raw = sorted.map(p => `${p.filePath}::${p.code.trim()}`).join('\n---PATCH---\n');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

export interface HealGuardTracker {
  seenSignatures: Set<string>;
  appliedPatchHashes: Set<string>;
  zeroPatchStreak: number;
}

export function createHealGuardTracker(): HealGuardTracker {
  return {
    seenSignatures: new Set<string>(),
    appliedPatchHashes: new Set<string>(),
    zeroPatchStreak: 0
  };
}
