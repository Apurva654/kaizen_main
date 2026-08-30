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
    } catch {
      return this.regexFallbackExtract(sourceCode, lang);
    }
  }

  private regexFallbackExtract(sourceCode: string, language: string): ExtractedSymbol[] {
    const symbols: ExtractedSymbol[] = [];

    if (language === 'python') {
      const pyMatches = sourceCode.matchAll(/(?:def|class)\s+([a-zA-Z0-9_$]+)/g);
      for (const m of pyMatches) {
        symbols.push({ type: m[0].startsWith('class') ? 'class_definition' : 'function_definition', name: m[1], text: m[0], language: 'python' });
      }
    } else if (language === 'cpp' || language === 'c++') {
      const cppMatches = sourceCode.matchAll(/(?:class|struct|void|int|double|float|bool|auto)\s+([a-zA-Z0-9_$]+)\s*\(/g);
      for (const m of cppMatches) {
        symbols.push({ type: 'function_declaration', name: m[1], text: m[0], language: 'cpp' });
      }
    } else {
      const tsMatches = sourceCode.matchAll(/(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([a-zA-Z0-9_$]+)/g);
      for (const m of tsMatches) {
        symbols.push({ type: 'declaration', name: m[1], text: m[0], language: 'typescript' });
      }
    }

    return symbols;
  }
}
