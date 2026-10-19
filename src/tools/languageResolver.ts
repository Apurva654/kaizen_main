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

  // Priority 1: If explicit target file extension exists, prioritize it unless user explicitly requests converting language
  if (targetFiles && targetFiles.length > 0) {
    const ext = targetFiles[0].split('.').pop()?.toLowerCase();
    const hasExplicitOverride = /\b(rewrite\s+in|convert\s+to|switch\s+to|in\s+python|in\s+typescript|in\s+javascript|in\s+go|in\s+rust|in\s+cpp|in\s+c|in\s+java)\b/i.test(promptLower);

    if (!hasExplicitOverride) {
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
  }

  // Priority 2: Explicit user-requested language in prompt (with strict word matching)
  if (/\b(python|py|pytest)\b/i.test(promptLower)) {
    return { requestedLanguage: 'python', source: 'explicit_user_request', confidence: 'high', recommendedExtension: '.py' };
  }
  if (/\b(typescript|ts|tsx)\b/i.test(promptLower)) {
    return { requestedLanguage: 'typescript', source: 'explicit_user_request', confidence: 'high', recommendedExtension: '.ts' };
  }
  if (/\b(javascript|js|jsx|nodejs|node\.js)\b/i.test(promptLower)) {
    return { requestedLanguage: 'javascript', source: 'explicit_user_request', confidence: 'high', recommendedExtension: '.js' };
  }
  if (/\b(html|webpage|landing\s+page|website|html5|frontend|ui|web\s+app|converter\s+app)\b/i.test(promptLower)) {
    return { requestedLanguage: 'html', source: 'explicit_user_request', confidence: 'high', recommendedExtension: '.html' };
  }
  if (/\b(css|css3|stylesheet|in\s+css)\b/i.test(promptLower)) {
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
  if (/\b(golang|in\s+go|using\s+go|go\s+code|go\s+program|go\s+language)\b/i.test(promptLower)) {
    return { requestedLanguage: 'go', source: 'explicit_user_request', confidence: 'high', recommendedExtension: '.go' };
  }
  if (/\b(json\s+file|in\s+json|\.json)\b/i.test(promptLower)) {
    return { requestedLanguage: 'json', source: 'explicit_user_request', confidence: 'high', recommendedExtension: '.json' };
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
  const sandboxDir = path.resolve(process.cwd(), 'src/sandbox');

  if (resolvedLang.requestedLanguage === 'html') return 'src/sandbox/index.html';
  if (resolvedLang.requestedLanguage === 'css') return 'src/sandbox/style.css';

  if (fs.existsSync(sandboxDir)) {
    const canonicalPath = `src/sandbox/main${ext}`;
    const canonicalAbs = path.resolve(process.cwd(), canonicalPath);
    if (fs.existsSync(canonicalAbs)) {
      return canonicalPath;
    }

    try {
      const files = fs.readdirSync(sandboxDir).filter(f => !f.startsWith('test_') && !f.includes('_test.') && !f.includes('.test.') && !f.endsWith('.d.ts') && !f.endsWith('.json'));
      // 1. If any file matching ext exists, reuse it
      const matchingExt = files.filter(f => f.endsWith(ext));
      if (matchingExt.length > 0) {
        return `src/sandbox/${matchingExt[0]}`;
      }

      // 2. If confidence is low / project default, check existing user files in sandbox
      if (resolvedLang.confidence === 'low' && files.length > 0) {
        const promptLower = (prompt || '').toLowerCase();
        for (const file of files) {
          const baseNoExt = file.replace(/\.[^/.]+$/, '').toLowerCase();
          if (promptLower.includes(baseNoExt)) {
            return `src/sandbox/${file}`;
          }
        }
        if (files.includes('index.html') && /\b(app|ui|page|screen|view|converter|image|photo|artwork|button|handler)\b/i.test(promptLower)) {
          return 'src/sandbox/index.html';
        }
        if (files.length === 1) {
          return `src/sandbox/${files[0]}`;
        }
      }
    } catch { }
  }

  return `src/sandbox/main${ext}`;
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

  // Structural checks for TypeScript / JavaScript (handles comments, template literals, and strings cleanly)
  if (['typescript', 'javascript', 'ts', 'js', 'tsx', 'jsx'].includes(language) ||
      /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(filePath)) {
    let depth = 0;
    type State = 'NORMAL' | 'LINE_COMMENT' | 'BLOCK_COMMENT' | 'STRING_SINGLE' | 'STRING_DOUBLE' | 'TEMPLATE';
    let parserState: State = 'NORMAL';
    const templateStack: number[] = [];

    for (let i = 0; i < code.length; i++) {
      const ch = code[i];
      const next = i + 1 < code.length ? code[i + 1] : '';

      switch (parserState) {
        case 'NORMAL':
          if (ch === '/' && next === '/') {
            parserState = 'LINE_COMMENT';
            i++;
          } else if (ch === '/' && next === '*') {
            parserState = 'BLOCK_COMMENT';
            i++;
          } else if (ch === "'") {
            parserState = 'STRING_SINGLE';
          } else if (ch === '"') {
            parserState = 'STRING_DOUBLE';
          } else if (ch === '`') {
            parserState = 'TEMPLATE';
          } else if (ch === '{') {
            depth++;
          } else if (ch === '}') {
            depth--;
            if (depth < 0) {
              return { isValid: false, error: 'Syntax Error: Unexpected closing brace "}" — unmatched.' };
            }
            if (templateStack.length > 0 && depth === templateStack[templateStack.length - 1]) {
              templateStack.pop();
              parserState = 'TEMPLATE';
            }
          }
          break;

        case 'LINE_COMMENT':
          if (ch === '\n') {
            parserState = 'NORMAL';
          }
          break;

        case 'BLOCK_COMMENT':
          if (ch === '*' && next === '/') {
            parserState = 'NORMAL';
            i++;
          }
          break;

        case 'STRING_SINGLE':
          if (ch === '\\') {
            i++;
          } else if (ch === "'") {
            parserState = 'NORMAL';
          }
          break;

        case 'STRING_DOUBLE':
          if (ch === '\\') {
            i++;
          } else if (ch === '"') {
            parserState = 'NORMAL';
          }
          break;

        case 'TEMPLATE':
          if (ch === '\\') {
            i++;
          } else if (ch === '`') {
            parserState = 'NORMAL';
          } else if (ch === '$' && next === '{') {
            i++;
            templateStack.push(depth);
            depth++;
            parserState = 'NORMAL';
          }
          break;
      }
    }

    if (depth !== 0) {
      return { isValid: false, error: `Syntax Error: ${depth} unclosed brace(s) "{" detected.` };
    }
    if (parserState === 'BLOCK_COMMENT') {
      return { isValid: false, error: 'Syntax Error: Unclosed multi-line comment /* detected.' };
    }
    // Detect common placeholder / stub code that should not be committed
    if (/\/\/\s*(TODO|FIXME|PLACEHOLDER|NOT IMPLEMENTED)/i.test(code) && code.trim().split('\n').length < 5) {
      return { isValid: false, error: 'Stub Violation: File appears to be an unimplemented placeholder.' };
    }
  }

  // Structural check for Python
  if (language === 'python' || language === 'py' || /\.py$/.test(filePath)) {
    let parenDepth = 0;
    let bracketDepth = 0;
    let braceDepth = 0;
    let inString: string | null = null;
    let inLineComment = false;

    for (let i = 0; i < code.length; i++) {
      const ch = code[i];
      const triple = code.slice(i, i + 3);

      if (inLineComment) {
        if (ch === '\n') inLineComment = false;
        continue;
      }

      if (inString) {
        if (ch === '\\') {
          i++;
        } else if (inString.length === 3 && triple === inString) {
          inString = null;
          i += 2;
        } else if (inString.length === 1 && ch === inString) {
          inString = null;
        }
        continue;
      }

      if (ch === '#') {
        inLineComment = true;
        continue;
      }

      if (triple === '"""' || triple === "'''") {
        inString = triple;
        i += 2;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inString = ch;
        continue;
      }

      if (ch === '(') parenDepth++;
      else if (ch === ')') { parenDepth--; if (parenDepth < 0) return { isValid: false, error: 'Syntax Error: Unmatched ")"' }; }
      else if (ch === '[') bracketDepth++;
      else if (ch === ']') { bracketDepth--; if (bracketDepth < 0) return { isValid: false, error: 'Syntax Error: Unmatched "]"' }; }
      else if (ch === '{') braceDepth++;
      else if (ch === '}') { braceDepth--; if (braceDepth < 0) return { isValid: false, error: 'Syntax Error: Unmatched "}"' }; }
    }

    if (parenDepth !== 0 || bracketDepth !== 0 || braceDepth !== 0) {
      return { isValid: false, error: 'Syntax Error: Unclosed bracket/brace/parenthesis detected in Python source.' };
    }
  }

  return { isValid: true };
}
