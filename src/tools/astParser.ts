import * as Parser from 'web-tree-sitter';

export interface ExtractedSymbol {
  type: string;
  name: string;
  text: string;
  language?: string;
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
          symbols.push({
            type: node.type,
            name: node.childForFieldName('name')?.text || 'anonymous',
            text: node.text,
            language: lang
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
      if (language === 'python') {
        const lines = sourceCode.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('#')) continue;

          const classMatch = trimmed.match(/^class\s+([a-zA-Z0-9_$]+)/);
          if (classMatch) {
            symbols.push({ type: 'class_definition', name: classMatch[1], text: trimmed, language: 'python' });
            continue;
          }

          const defMatch = trimmed.match(/^def\s+([a-zA-Z0-9_$]+)/);
          if (defMatch) {
            symbols.push({ type: 'function_definition', name: defMatch[1], text: trimmed, language: 'python' });
            continue;
          }
        }
      } else if (language === 'cpp' || language === 'c++') {
        const cppMatches = sourceCode.matchAll(/(?:class|struct|void|int|double|float|bool|auto)\s+([a-zA-Z0-9_$]+)\s*\(/g);
        for (const m of cppMatches) {
          symbols.push({ type: 'function_declaration', name: m[1], text: m[0], language: 'cpp' });
        }
      } else if (language === 'typescript' || language === 'javascript') {
        const tsMatches = sourceCode.matchAll(/(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var)\s+([a-zA-Z0-9_$]+)/g);
        for (const m of tsMatches) {
          const type = m[0].includes('class') ? 'class_declaration' : (m[0].includes('function') ? 'function_declaration' : 'declaration');
          symbols.push({ type, name: m[1], text: m[0], language });
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
