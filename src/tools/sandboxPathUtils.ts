/**
 * Shared sandbox path utilities extracted to break the circular dependency:
 *   plannerAgent.ts <-> codeGenAgent.ts
 * Both agents import from here instead of from each other.
 */

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

/**
 * Normalise a raw file path into a canonical `src/sandbox/...` relative path.
 * Returns '' for invalid/escaped paths; callers treat '' as invalid.
 */
export function normalizeSandboxPath(pathStr: string): string {
  if (!pathStr || typeof pathStr !== 'string') return '';
  // Strip leading slashes / backslashes
  let clean = pathStr.replace(/\\/g, '/').replace(/^\/+/, '').trim();
  // Reject path-traversal
  if (clean.includes('..')) return '';
  // Prefix if missing
  if (!clean.startsWith('src/sandbox/')) {
    clean = `src/sandbox/${clean.replace(/^src\/sandbox\//, '')}`;
  }
  // Final traversal guard
  if (clean.includes('..')) return '';
  return clean;
}

/**
 * Returns true when a file path must not be written by the coder agent.
 */
export function isProtectedFile(filePath: string): boolean {
  if (!filePath) return true;
  const norm = filePath.replace(/\\/g, '/');
  if (!norm.startsWith('src/sandbox/')) return true;
  return PROTECTED_PATTERNS.some((pattern) => pattern.test(norm));
}
