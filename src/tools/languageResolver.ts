import * as path from 'path';
import * as fs from 'fs';

export interface LanguageResolutionResult {
  requestedLanguage: string; // 'python', 'typescript', 'javascript', 'html', 'css', 'java', 'cpp', 'c', 'rust', 'go', 'json'
  source: 'explicit_user_request' | 'target_file_extension' | 'existing_file' | 'project_default';
  confidence: 'high' | 'medium' | 'low';
  recommendedExtension: string; // '.py', '.ts', '.js', '.html', '.css', '.java', '.cpp', '.c', '.rs', '.go', '.json'
}

/**
 * Reusable Language Resolver
 * Priority:
 * 1. Explicit user-requested language in prompt (e.g., "in Python", "using python", "Python program", "in TypeScript")
 * 2. Explicit target file extension (e.g., "add.py" -> python)
 * 3. Existing file language when modifying an existing file
 * 4. Project convention only when language is unspecified
 * 5. Never silently default to TypeScript if another language was requested
 */
export function resolveLanguage(prompt: string, targetFiles: string[] = []): LanguageResolutionResult {
  const promptLower = (prompt || '').toLowerCase();

  // Priority 1: Explicit user-requested language in prompt
  if (/\b(python|py|pytest)\b/i.test(promptLower)) {
    return { requestedLanguage: 'python', source: 'explicit_user_request', confidence: 'high', recommendedExtension: '.py' };
  }
  if (/\b(typescript|ts|tsx)\b/i.test(promptLower)) {
    return { requestedLanguage: 'typescript', source: 'explicit_user_request', confidence: 'high', recommendedExtension: '.ts' };
  }
  if (/\b(javascript|js|jsx|node)\b/i.test(promptLower)) {
    return { requestedLanguage: 'javascript', source: 'explicit_user_request', confidence: 'high', recommendedExtension: '.js' };
  }
  if (/\b(html|webpage|landing\s+page|website|html5)\b/i.test(promptLower)) {
    return { requestedLanguage: 'html', source: 'explicit_user_request', confidence: 'high', recommendedExtension: '.html' };
  }
  if (/\b(css|css3|styling|styles)\b/i.test(promptLower)) {
    return { requestedLanguage: 'css', source: 'explicit_user_request', confidence: 'high', recommendedExtension: '.css' };
  }
  if (/\b(java)\b/i.test(promptLower) && !/\bjavascript\b/i.test(promptLower)) {
    return { requestedLanguage: 'java', source: 'explicit_user_request', confidence: 'high', recommendedExtension: '.java' };
  }
  if (/\b(c\+\+|cpp|cplusplus)\b/i.test(promptLower)) {
    return { requestedLanguage: 'cpp', source: 'explicit_user_request', confidence: 'high', recommendedExtension: '.cpp' };
  }
  if (/\b(c)\b/i.test(promptLower) && !/\b(c\+\+|cpp|csharp|css)\b/i.test(promptLower) && /\b(in c|c program|c function|c code)\b/i.test(promptLower)) {
    return { requestedLanguage: 'c', source: 'explicit_user_request', confidence: 'high', recommendedExtension: '.c' };
  }
  if (/\b(rust|rs)\b/i.test(promptLower)) {
    return { requestedLanguage: 'rust', source: 'explicit_user_request', confidence: 'high', recommendedExtension: '.rs' };
  }
  if (/\b(golang|go)\b/i.test(promptLower)) {
    return { requestedLanguage: 'go', source: 'explicit_user_request', confidence: 'high', recommendedExtension: '.go' };
  }
  if (/\b(json)\b/i.test(promptLower)) {
    return { requestedLanguage: 'json', source: 'explicit_user_request', confidence: 'high', recommendedExtension: '.json' };
  }

  // Priority 2 & 3: Target File Extension / Existing File
  if (targetFiles && targetFiles.length > 0) {
    const ext = targetFiles[0].split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'py': return { requestedLanguage: 'python', source: 'target_file_extension', confidence: 'high', recommendedExtension: '.py' };
      case 'ts':
      case 'tsx': return { requestedLanguage: 'typescript', source: 'target_file_extension', confidence: 'high', recommendedExtension: '.ts' };
      case 'js':
      case 'jsx': return { requestedLanguage: 'javascript', source: 'target_file_extension', confidence: 'high', recommendedExtension: '.js' };
      case 'html': return { requestedLanguage: 'html', source: 'target_file_extension', confidence: 'high', recommendedExtension: '.html' };
      case 'css': return { requestedLanguage: 'css', source: 'target_file_extension', confidence: 'high', recommendedExtension: '.css' };
      case 'java': return { requestedLanguage: 'java', source: 'target_file_extension', confidence: 'high', recommendedExtension: '.java' };
      case 'cpp':
      case 'cc': return { requestedLanguage: 'cpp', source: 'target_file_extension', confidence: 'high', recommendedExtension: '.cpp' };
      case 'c': return { requestedLanguage: 'c', source: 'target_file_extension', confidence: 'high', recommendedExtension: '.c' };
      case 'rs': return { requestedLanguage: 'rust', source: 'target_file_extension', confidence: 'high', recommendedExtension: '.rs' };
      case 'go': return { requestedLanguage: 'go', source: 'target_file_extension', confidence: 'high', recommendedExtension: '.go' };
      case 'json': return { requestedLanguage: 'json', source: 'target_file_extension', confidence: 'high', recommendedExtension: '.json' };
    }
  }

  // Priority 4 & 5: Project Default Fallback (TypeScript) when language is completely unspecified
  return { requestedLanguage: 'typescript', source: 'project_default', confidence: 'low', recommendedExtension: '.ts' };
}

/**
 * Derives a target filename from the user prompt and language resolution without hardcoding main.ts
 * Reuses existing sandbox files or canonical main.<ext> instead of slugifying arbitrary user prompt text.
 */
export function deriveTargetFile(prompt: string, resolvedLang: LanguageResolutionResult): string {
  const ext = resolvedLang.recommendedExtension || '.ts';

  if (resolvedLang.requestedLanguage === 'html') return 'src/sandbox/index.html';
  if (resolvedLang.requestedLanguage === 'css') return 'src/sandbox/style.css';

  const canonicalPath = `src/sandbox/main${ext}`;
  const sandboxDir = path.resolve(process.cwd(), 'src/sandbox');

  if (fs.existsSync(sandboxDir)) {
    // 1. If main.<ext> already exists in src/sandbox/, reuse it!
    const canonicalAbs = path.resolve(process.cwd(), canonicalPath);
    if (fs.existsSync(canonicalAbs)) {
      return canonicalPath;
    }
    // 2. If any existing implementation file matching <ext> exists in src/sandbox/, reuse it!
    try {
      const existingFiles = fs.readdirSync(sandboxDir).filter(f => f.endsWith(ext) && !f.startsWith('test_') && !f.includes('_test.') && !f.includes('.test.'));
      if (existingFiles.length > 0) {
        return `src/sandbox/${existingFiles[0]}`;
      }
    } catch { }
  }

  // 3. Fall back to canonical main.<ext>
  return canonicalPath;
}

/**
 * Validates pre-patch source code syntax to catch syntax errors BEFORE applying patches or running code.
 */
export function validateCodeSyntax(code: string, language: string, filePath: string): { isValid: boolean; error?: string } {
  if (!code || typeof code !== 'string') {
    return { isValid: false, error: 'Empty or non-string code content' };
  }

  // Check for multiline single-quoted string syntax error: console.log('\n...')
  const unterminatedSingleQuoteMatch = code.match(/console\.log\(\s*'\s*[\r\n]+/);
  if (unterminatedSingleQuoteMatch) {
    return { isValid: false, error: "Syntax Error: Unterminated multiline single-quote string literal detected in console.log call. Use '\\n' or template literals ``." };
  }

  if (language === 'python' || filePath.endsWith('.py')) {
    // Python target must NOT contain TypeScript wrappers or Node.js imports
    if (code.includes("import * as fs from 'fs'") || code.includes("require('fs')") || code.includes("fs.writeFileSync")) {
      return { isValid: false, error: 'Language Violation: TypeScript node/fs wrapper code found inside Python target file. Target must contain pure Python code.' };
    }
    if (code.includes('export function taskHandler') || code.includes('export function executeTask')) {
      return { isValid: false, error: 'Boilerplate Violation: Generic TypeScript taskHandler boilerplate found inside Python target file.' };
    }
  }

  if (language === 'json' || filePath.endsWith('.json')) {
    try {
      JSON.parse(code);
    } catch (e: any) {
      return { isValid: false, error: `JSON Parse Error: ${e?.message || e}` };
    }
  }

  // Bug 9 Fix: Basic structural checks for TypeScript / JavaScript
  if (['typescript', 'javascript', 'ts', 'js', 'tsx', 'jsx'].includes(language) ||
      /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(filePath)) {
    // Unbalanced braces check
    let depth = 0;
    let inStr = false;
    let strChar = '';
    for (let i = 0; i < code.length; i++) {
      const ch = code[i];
      if (inStr) {
        if (ch === strChar && code[i - 1] !== '\\') inStr = false;
      } else if (ch === '"' || ch === "'" || ch === '`') {
        inStr = true; strChar = ch;
      } else if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth < 0) return { isValid: false, error: 'Syntax Error: Unexpected closing brace "}" — unmatched.' };
      }
    }
    if (depth !== 0) {
      return { isValid: false, error: `Syntax Error: ${depth} unclosed brace(s) "{" detected.` };
    }
    // Detect common placeholder / stub code that should not be committed
    if (/\/\/\s*(TODO|FIXME|PLACEHOLDER|NOT IMPLEMENTED)/i.test(code) && code.trim().split('\n').length < 5) {
      return { isValid: false, error: 'Stub Violation: File appears to be an unimplemented placeholder.' };
    }
  }

  return { isValid: true };
}
