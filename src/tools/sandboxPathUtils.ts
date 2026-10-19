import * as path from 'path';

/**
 * Shared sandbox path utilities and security boundary definitions.
 * Serves as the single source of truth for:
 *   - Protected file patterns
 *   - Sandbox relative path normalization
 *   - File write protection validation
 */

export const PROTECTED_PATTERNS: RegExp[] = [
  /\.env($|\.)/,
  /package\.json$/,
  /package-lock\.json$/,
  /tsconfig\.json$/,
  /\.git(\/|\\|$)/,
  /\.vscode(\/|\\|$)/,
  /node_modules(\/|\\|$)/,
  /src\/index\.ts$/,
  /src\/server\.ts$/,
  /src\/state\.ts$/,
  /src\/extension\.ts$/,
  /src\/webviewProvider\.ts$/,
  /src\/agents(\/|\\)/,
  /src\/graph(\/|\\)/,
  /src\/tools(\/|\\)/,
  /src\/context(\/|\\)/,
  /src\/mcp(\/|\\)/,
  /src\/memory(\/|\\)/,
  /src\/client(\/|\\)/
];

/**
 * Normalise a raw file path into a canonical `src/sandbox/...` relative path.
 * Returns '' for invalid/escaped paths; callers treat '' as invalid.
 */
export function normalizeSandboxPath(pathStr: string): string {
  if (!pathStr || typeof pathStr !== 'string') return '';
  let norm = pathStr.replace(/\\/g, '/').trim();
  norm = norm.replace(/^(\.\/)+/, '');
  norm = norm.replace(/^\/+/, '');
  if (norm.split('/').includes('..')) return '';

  norm = path.posix.normalize(norm);
  if (!norm || norm === '.') return '';

  if (!norm.startsWith('src/sandbox/')) {
    if (norm.startsWith('sandbox/')) {
      norm = `src/${norm}`;
    } else if (norm.startsWith('src/')) {
      norm = norm.replace(/^src\//, 'src/sandbox/');
    } else {
      norm = `src/sandbox/${norm}`;
    }
  }

  // Traversal guard
  if (norm.includes('..')) return '';
  return norm;
}

/**
 * Returns true when a file path must not be written or deleted by the agent.
 */
export function isProtectedFile(filePath: string): boolean {
  if (!filePath || typeof filePath !== 'string') return true;
  const norm = filePath.replace(/\\/g, '/').trim();
  if (!norm.startsWith('src/sandbox/')) return true;
  return PROTECTED_PATTERNS.some((pattern) => pattern.test(norm));
}

/**
 * Identify test files based on standard naming conventions and folder locations.
 * Union of test patterns across testRunner, debuggerAgent, and server:
 * (.test., .spec., test_, test., _test.py, _test.ts, _test.js, /test/, /tests/, /__tests__/)
 */
export function isTestFile(filePath: string): boolean {
  if (!filePath || typeof filePath !== 'string') return false;
  const norm = filePath.replace(/\\/g, '/').toLowerCase();
  const baseName = path.basename(norm);
  return (
    norm.includes('.test.') ||
    norm.includes('.spec.') ||
    norm.includes('/test/') ||
    norm.includes('/tests/') ||
    norm.includes('/__tests__/') ||
    norm.startsWith('test/') ||
    norm.startsWith('tests/') ||
    norm.startsWith('__tests__/') ||
    baseName.startsWith('test_') ||
    baseName.startsWith('test.') ||
    baseName.endsWith('_test.py') ||
    baseName.endsWith('_test.ts') ||
    baseName.endsWith('_test.js') ||
    baseName.endsWith('.test.ts') ||
    baseName.endsWith('.spec.ts') ||
    baseName.endsWith('.test.js') ||
    baseName.endsWith('.spec.js')
  );
}

