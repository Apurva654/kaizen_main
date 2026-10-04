import * as Parser from 'web-tree-sitter';

export interface ExtractedSymbolParameter {
  name: string;
  type?: string;
  isInferred?: boolean;
}

export interface ExtractedSymbol {
  type: string;
  name: string;
  text: string;
  language?: string;
  startLine?: number;
  endLine?: number;
  startColumn?: number;
  endColumn?: number;
  signature?: string;
  parameters?: ExtractedSymbolParameter[];
  returnType?: string;
  returnTypeInferred?: boolean;
  documentation?: string;
  loc?: number;
  complexity?: number;
  branches?: number;
  parameterCount?: number;
  bodyText?: string;
}

export class ASTParserTool {
  private parser: any = null;
  private currentLanguage: string = 'typescript';

  public getLanguageFromPath(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'py':
        return 'python';
      case 'ts':
      case 'tsx':
        return 'typescript';
      case 'js':
      case 'jsx':
      case 'mjs':
      case 'cjs':
        return 'javascript';
      case 'json':
        return 'json';
      case 'html':
      case 'htm':
        return 'html';
      case 'css':
        return 'css';
      default:
        return 'unsupported_language';
    }
  }

  async init(wasmPath?: string, languageWasmPath?: string, language: string = 'typescript'): Promise<void> {
    this.currentLanguage = language;
    if (wasmPath && languageWasmPath) {
      try {
        const ParserConstructor: any = (Parser as any).default || Parser;
        await ParserConstructor.init({ locateFile: () => wasmPath });
        this.parser = new ParserConstructor();
        const Lang = await ParserConstructor.Language.load(languageWasmPath);
        this.parser.setLanguage(Lang);
      } catch {
        this.parser = null;
      }
    }
  }

  public extractTopLevelSymbols(sourceCode: string, languageHint: string = 'typescript'): ExtractedSymbol[] {
    const lang = languageHint || this.currentLanguage;

    if (lang === 'unsupported_language') {
      return [];
    }

    if (!this.parser) {
      return this.regexFallbackExtract(sourceCode, lang);
    }

    try {
      const tree = this.parser.parse(sourceCode);
      const symbols: ExtractedSymbol[] = [];
      for (let i = 0; i < tree.rootNode.childCount; i++) {
        const node = tree.rootNode.child(i);
        if (node && (node.type.includes('function') || node.type.includes('class') || node.type.includes('method') || node.type.includes('def'))) {
          const startLine = node.startPosition.row + 1;
          const endLine = node.endPosition.row + 1;
          const startColumn = node.startPosition.column + 1;
          const endColumn = node.endPosition.column + 1;
          const name = node.childForFieldName('name')?.text || 'anonymous';
          const loc = endLine - startLine + 1;

          symbols.push({
            type: node.type,
            name,
            text: node.text,
            language: lang,
            startLine,
            endLine,
            startColumn,
            endColumn,
            loc,
            bodyText: node.text
          });
        }
      }
      return symbols.length > 0 ? symbols : this.regexFallbackExtract(sourceCode, lang);
    } catch (err: any) {
      console.warn(`[CONTEXT][WARN] Tree-sitter AST parse failed for ${lang}, falling back to regex:`, err?.message || err);
      return this.regexFallbackExtract(sourceCode, lang);
    }
  }

  private regexFallbackExtract(sourceCode: string, language: string): ExtractedSymbol[] {
    const symbols: ExtractedSymbol[] = [];
    if (!sourceCode) return symbols;

    try {
      const lines = sourceCode.split('\n');
      if (language === 'python') {
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const trimmed = line.trim();
          if (trimmed.startsWith('#')) continue;

          const defMatch = line.match(/^(\s*)def\s+([a-zA-Z0-9_$]+)\s*\(([^)]*)\)(?:\s*->\s*([^:]+))?:/);
          const classMatch = line.match(/^(\s*)class\s+([a-zA-Z0-9_$]+)(?:\(([^)]*)\))?:/);

          if (defMatch || classMatch) {
            const isDef = !!defMatch;
            const indentStr = isDef ? defMatch![1] : classMatch![1];
            const name = isDef ? defMatch![2] : classMatch![2];
            const rawParams = isDef ? defMatch![3] : (classMatch![3] || '');
            const declaredRetType = isDef ? (defMatch![4] ? defMatch![4].trim() : undefined) : undefined;
            const startLine = i + 1;
            const indentLen = indentStr.length;

            let endLine = startLine;
            let docstring: string | undefined = undefined;
            const bodyLines: string[] = [];

            for (let j = i + 1; j < lines.length; j++) {
              const curLine = lines[j];
              const curTrimmed = curLine.trim();

              if (!curTrimmed || curTrimmed.startsWith('#')) {
                endLine = j + 1;
                continue;
              }

              const curIndent = curLine.search(/\S/);
              if (curIndent !== -1 && curIndent <= indentLen) {
                break;
              }
              endLine = j + 1;
              bodyLines.push(curLine);
            }

            const bodyText = bodyLines.join('\n');

            // Check for docstring inside Python function body
            for (let k = 0; k < bodyLines.length; k++) {
              const bTrimmed = bodyLines[k].trim();
              if (!bTrimmed || bTrimmed.startsWith('#')) continue;
              if (bTrimmed.startsWith('"""') || bTrimmed.startsWith("'''")) {
                const quoteChar = bTrimmed.startsWith('"""') ? '"""' : "'''";
                if (bTrimmed.endsWith(quoteChar) && bTrimmed.length > 6) {
                  docstring = bTrimmed.slice(3, -3).trim();
                } else {
                  const docLines: string[] = [bTrimmed.slice(3)];
                  for (let m = k + 1; m < bodyLines.length; m++) {
                    const docL = bodyLines[m].trim();
                    if (docL.endsWith(quoteChar)) {
                      docLines.push(docL.slice(0, -3));
                      break;
                    } else {
                      docLines.push(bodyLines[m]);
                    }
                  }
                  docstring = docLines.join('\n').trim();
                }
              }
              break;
            }

            const parameters: ExtractedSymbolParameter[] = [];
            if (rawParams.trim()) {
              const paramParts = rawParams.split(',');
              for (const part of paramParts) {
                const pTrim = part.trim();
                if (!pTrim || pTrim === 'self' || pTrim === 'cls') continue;

                let pName = pTrim;
                let pType: string | undefined = undefined;

                if (pTrim.includes(':')) {
                  const [n, t] = pTrim.split(':');
                  pName = n.trim();
                  pType = t.split('=')[0].trim();
                } else if (pTrim.includes('=')) {
                  const [n, val] = pTrim.split('=');
                  pName = n.trim();
                  const valTrim = val.trim();
                  if (/^\d+$/.test(valTrim)) pType = 'int';
                  else if (/^\d+\.\d+$/.test(valTrim)) pType = 'float';
                  else if (/^['"].*['"]$/.test(valTrim)) pType = 'str';
                  else if (valTrim === 'True' || valTrim === 'False') pType = 'bool';
                }

                parameters.push({
                  name: pName,
                  type: pType || 'Not available',
                  isInferred: !pTrim.includes(':') && !!pType
                });
              }
            }

            let returnType = declaredRetType;
            let returnTypeInferred = false;
            if (!returnType && isDef) {
              if (bodyText.includes('return True') || bodyText.includes('return False') || bodyText.includes('return all(') || bodyText.includes('return any(') || bodyText.includes('isinstance(')) {
                returnType = 'bool';
                returnTypeInferred = true;
              } else if (/\breturn\s+sum\s*\(/.test(bodyText) || /\breturn\s+[a-zA-Z0-9_$]+\s*[\/*+-]/.test(bodyText)) {
                returnType = 'float';
                returnTypeInferred = true;
              } else if (/\breturn\s+[a-zA-Z0-9_$]+\s*,\s*[a-zA-Z0-9_$]+/.test(bodyText)) {
                returnType = 'tuple';
                returnTypeInferred = true;
              } else if (/\breturn\s+['"]/.test(bodyText)) {
                returnType = 'str';
                returnTypeInferred = true;
              } else if (/\breturn\s+\[/.test(bodyText)) {
                returnType = 'list';
                returnTypeInferred = true;
              } else if (/\breturn\s+\{/.test(bodyText)) {
                returnType = 'dict';
                returnTypeInferred = true;
              } else if (!/\breturn\b/.test(bodyText)) {
                returnType = 'None';
                returnTypeInferred = true;
              } else {
                returnType = 'Not available';
              }
            } else if (!returnType) {
              returnType = 'Not available';
            }

            let branchCount = 0;
            const branchMatches = bodyText.match(/\b(if|elif|for|while|except|and|or)\b/g);
            if (branchMatches) {
              branchCount = branchMatches.length;
            }
            const complexity = branchCount + 1;
            const loc = endLine - startLine + 1;

            const headerLine = line.trim();
            const signature = isDef ? (headerLine.endsWith(':') ? headerLine.slice(0, -1) : headerLine) : headerLine;

            symbols.push({
              type: isDef ? 'function_definition' : 'class_definition',
              name,
              text: line.trim(),
              language: 'python',
              startLine,
              endLine,
              startColumn: indentLen + 1,
              endColumn: line.length,
              signature,
              parameters,
              returnType,
              returnTypeInferred,
              documentation: docstring || 'No documentation available',
              loc,
              complexity,
              branches: branchCount,
              parameterCount: parameters.length,
              bodyText
            });
          }
        }
      } else if (language === 'typescript' || language === 'javascript') {
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const trimmed = line.trim();
          if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;

          const fnMatch = line.match(/(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_$]+)\s*\(([^)]*)\)(?:\s*:\s*([^;{]+))?/);
          const classMatch = line.match(/(?:export\s+)?class\s+([a-zA-Z0-9_$]+)/);

          if (fnMatch || classMatch) {
            const isFn = !!fnMatch;
            const name = isFn ? fnMatch![1] : classMatch![1];
            const rawParams = isFn ? fnMatch![2] : '';
            const declaredRetType = isFn ? (fnMatch![3] ? fnMatch![3].trim() : undefined) : undefined;
            const startLine = i + 1;

            let docstring: string | undefined = undefined;
            if (i > 0) {
              let p = i - 1;
              const docLines: string[] = [];
              while (p >= 0 && (lines[p].trim().startsWith('*') || lines[p].trim().startsWith('/*') || lines[p].trim().startsWith('/**') || lines[p].trim().endsWith('*/'))) {
                const clean = lines[p].replace(/^\/\*\*?|\*\/|^\s*\*/, '').trim();
                if (clean) docLines.unshift(clean);
                p--;
              }
              if (docLines.length > 0) {
                docstring = docLines.join('\n');
              }
            }

            let openBraces = 0;
            let foundOpen = false;
            let endLine = startLine;
            const bodyLines: string[] = [];

            for (let j = i; j < lines.length; j++) {
              const l = lines[j];
              for (const ch of l) {
                if (ch === '{') {
                  openBraces++;
                  foundOpen = true;
                } else if (ch === '}') {
                  openBraces--;
                }
              }
              bodyLines.push(l);
              endLine = j + 1;
              if (foundOpen && openBraces <= 0) {
                break;
              }
            }

            const bodyText = bodyLines.join('\n');

            const parameters: ExtractedSymbolParameter[] = [];
            if (rawParams.trim()) {
              const paramParts = rawParams.split(',');
              for (const part of paramParts) {
                const pTrim = part.trim();
                if (!pTrim) continue;
                let pName = pTrim;
                let pType: string | undefined = undefined;
                if (pTrim.includes(':')) {
                  const [n, t] = pTrim.split(':');
                  pName = n.trim();
                  pType = t.split('=')[0].trim();
                } else if (pTrim.includes('=')) {
                  const [n] = pTrim.split('=');
                  pName = n.trim();
                  pType = 'any';
                }
                parameters.push({
                  name: pName,
                  type: pType || 'Not available',
                  isInferred: !pTrim.includes(':')
                });
              }
            }

            let branchCount = 0;
            const branchMatches = bodyText.match(/\b(if|else if|for|while|catch|case|&&|\|\|)\b/g);
            if (branchMatches) {
              branchCount = branchMatches.length;
            }
            const complexity = branchCount + 1;
            const loc = endLine - startLine + 1;

            symbols.push({
              type: isFn ? 'function_declaration' : 'class_declaration',
              name,
              text: line.trim(),
              language,
              startLine,
              endLine,
              startColumn: 1,
              endColumn: line.length,
              signature: line.trim().replace(/\{$/, '').trim(),
              parameters,
              returnType: declaredRetType || 'Not available',
              returnTypeInferred: false,
              documentation: docstring || 'No documentation available',
              loc,
              complexity,
              branches: branchCount,
              parameterCount: parameters.length,
              bodyText
            });
          }
        }
      } else if (language === 'html') {
        const titleMatch = sourceCode.match(/<title>([^<]+)<\/title>/i);
        if (titleMatch) {
          symbols.push({ type: 'html_title', name: titleMatch[1].trim(), text: titleMatch[0], language: 'html' });
        }
        const idMatches = sourceCode.matchAll(/\bid=["']([^"']+)["']/g);
        for (const m of idMatches) {
          symbols.push({ type: 'element_id', name: m[1], text: m[0], language: 'html' });
        }
      } else if (language === 'css') {
        const classMatches = sourceCode.matchAll(/\.([a-zA-Z0-9_\-]+)\s*\{/g);
        for (const m of classMatches) {
          symbols.push({ type: 'css_class', name: m[1], text: m[0], language: 'css' });
        }
        const idMatches = sourceCode.matchAll(/#([a-zA-Z0-9_\-]+)\s*\{/g);
        for (const m of idMatches) {
          symbols.push({ type: 'css_id', name: m[1], text: m[0], language: 'css' });
        }
      }
    } catch (err: any) {
      console.warn(`[CONTEXT][WARN] Regex symbol extract error for ${language}:`, err?.message || err);
    }

    return symbols;
  }
}

