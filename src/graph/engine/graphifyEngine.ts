import * as fs from 'fs';
import * as path from 'path';
import { ASTParserTool, ExtractedSymbol } from '../../tools/astParser';

export interface SymbolFact {
  name: string;
  type: string;
  filePath: string;
  isExported: boolean;
  text?: string;
}

export interface ImportFact {
  importedSymbols: string[];
  moduleSpecifier: string;
  resolvedPath?: string;
}

export interface FileNodeFacts {
  filePath: string;
  symbols: SymbolFact[];
  imports: ImportFact[];
  content: string;
}

export class GraphifyEngine {
  private astParser: ASTParserTool;
  private fileFactsMap: Map<string, FileNodeFacts> = new Map();
  private symbolToFilesMap: Map<string, SymbolFact[]> = new Map();

  constructor() {
    this.astParser = new ASTParserTool();
  }

  public normalizePath(p: string): string {
    return p.replace(/\\/g, '/').replace(/^\.\//, '');
  }

  public async scanDirectory(dirPath: string): Promise<void> {
    if (!fs.existsSync(dirPath)) {
      return;
    }

    const files = this.getAllFiles(dirPath);
    for (const filePath of files) {
      await this.processFile(filePath);
    }

    this.resolveImports();
  }

  private getAllFiles(dirPath: string): string[] {
    const results: string[] = [];
    const list = fs.readdirSync(dirPath);
    for (const file of list) {
      const fullPath = path.join(dirPath, file);
      const stat = fs.statSync(fullPath);
      if (stat && stat.isDirectory()) {
        if (!file.startsWith('.') && file !== 'node_modules' && file !== 'dist') {
          results.push(...this.getAllFiles(fullPath));
        }
      } else if (/\.(ts|js|tsx|jsx)$/.test(file) && !file.endsWith('.d.ts')) {
        results.push(fullPath);
      }
    }
    return results;
  }

  private async processFile(filePath: string): Promise<void> {
    const normPath = this.normalizePath(filePath);
    let content = '';
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      return;
    }

    const extracted = this.astParser.extractTopLevelSymbols(content);
    const symbols: SymbolFact[] = extracted.map((s: ExtractedSymbol) => {
      const isExported = content.includes(`export ` + s.name) || content.includes(`export function ` + s.name) || content.includes(`export class ` + s.name) || content.includes(`export const ` + s.name);
      return {
        name: s.name,
        type: s.type,
        filePath: normPath,
        isExported,
        text: s.text
      };
    });

    for (const sym of symbols) {
      if (!this.symbolToFilesMap.has(sym.name)) {
        this.symbolToFilesMap.set(sym.name, []);
      }
      this.symbolToFilesMap.get(sym.name)!.push(sym);
    }

    const imports = this.parseImports(content);

    this.fileFactsMap.set(normPath, {
      filePath: normPath,
      symbols,
      imports,
      content
    });
  }

  private parseImports(content: string): ImportFact[] {
    const imports: ImportFact[] = [];
    const importRegex = /import\s+({[^}]+}|\*\s+as\s+\w+|\w+)\s+from\s+['"]([^'"]+)['"]/g;
    let match: RegExpExecArray | null;

    while ((match = importRegex.exec(content)) !== null) {
      const specifier = match[1].trim();
      const moduleSpecifier = match[2].trim();
      let importedSymbols: string[] = [];

      if (specifier.startsWith('{')) {
        importedSymbols = specifier
          .replace(/[{}]/g, '')
          .split(',')
          .map(s => s.trim().split(/\s+as\s+/)[0])
          .filter(Boolean);
      } else if (specifier.startsWith('* as ')) {
        importedSymbols = [specifier.replace('* as ', '').trim()];
      } else {
        importedSymbols = [specifier];
      }

      imports.push({
        importedSymbols,
        moduleSpecifier
      });
    }

    return imports;
  }

  private resolveImports(): void {
    for (const [filePath, fileNode] of this.fileFactsMap.entries()) {
      const fileDir = path.dirname(filePath);
      for (const imp of fileNode.imports) {
        if (imp.moduleSpecifier.startsWith('.')) {
          const resolvedBase = this.normalizePath(path.resolve(fileDir, imp.moduleSpecifier));
          const possibleExts = ['', '.ts', '.js', '.tsx', '.jsx', '/index.ts', '/index.js'];
          for (const ext of possibleExts) {
            const candidate = resolvedBase + ext;
            if (this.fileFactsMap.has(candidate)) {
              imp.resolvedPath = candidate;
              break;
            }
          }
        }
      }
    }
  }

  public findMatchingKey(targetPath: string): string | undefined {
    const norm = this.normalizePath(targetPath);
    if (this.fileFactsMap.has(norm)) return norm;
    for (const key of this.fileFactsMap.keys()) {
      if (key.endsWith(norm) || norm.endsWith(key)) return key;
    }
    return undefined;
  }

  public getSymbolMap(): Map<string, SymbolFact[]> {
    return this.symbolToFilesMap;
  }

  public getDependencyTree(): Map<string, string[]> {
    const tree = new Map<string, string[]>();
    for (const [filePath, node] of this.fileFactsMap.entries()) {
      const deps = node.imports
        .map(i => i.resolvedPath || i.moduleSpecifier)
        .filter(Boolean);
      tree.set(filePath, deps);
    }
    return tree;
  }

  public buildContextSummary(targetFiles: string[]): string {
    const factsList: string[] = [];

    factsList.push("=== MULTI-FILE WORKSPACE GRAPH FACTS ===");
    factsList.push(`Scanned Workspace Files (${this.fileFactsMap.size}):`);
    for (const [filePath, node] of this.fileFactsMap.entries()) {
      const exports = node.symbols.filter(s => s.isExported).map(s => `${s.type} ${s.name}`);
      factsList.push(`- ${filePath} [Exports: ${exports.length > 0 ? exports.join(', ') : 'none'}]`);
    }

    factsList.push("\n=== SYMBOL-TO-FILE MAPPINGS ===");
    for (const [symbolName, facts] of this.symbolToFilesMap.entries()) {
      const locations = facts.map(f => `${f.filePath} (${f.isExported ? 'exported' : 'internal'})`).join(', ');
      factsList.push(`- Symbol '${symbolName}': ${locations}`);
    }

    factsList.push("\n=== DEPENDENCY TREE & RELATIVE IMPORTS ===");
    for (const [filePath, node] of this.fileFactsMap.entries()) {
      if (node.imports.length > 0) {
        factsList.push(`- ${filePath} imports:`);
        for (const imp of node.imports) {
          factsList.push(`    * from '${imp.moduleSpecifier}' (Resolved: ${imp.resolvedPath || 'external/unresolved'}) -> symbols: [${imp.importedSymbols.join(', ')}]`);
        }
      }
    }

    factsList.push("\n=== TARGET & RELATED FILE CONTENTS ===");
    const processedFiles = new Set<string>();

    for (const rawTarget of targetFiles) {
      const matchedKey = this.findMatchingKey(rawTarget);
      if (matchedKey && this.fileFactsMap.has(matchedKey)) {
        processedFiles.add(matchedKey);
        const node = this.fileFactsMap.get(matchedKey)!;
        factsList.push(`\n--- TARGET FILE: ${node.filePath} ---`);
        factsList.push(node.content);

        for (const imp of node.imports) {
          if (imp.resolvedPath && this.fileFactsMap.has(imp.resolvedPath) && !processedFiles.has(imp.resolvedPath)) {
            processedFiles.add(imp.resolvedPath);
            const depNode = this.fileFactsMap.get(imp.resolvedPath)!;
            factsList.push(`\n--- IMPORTED RELATIVE FILE: ${depNode.filePath} (imported via '${imp.moduleSpecifier}') ---`);
            factsList.push(depNode.content);
          }
        }
      } else {
        if (fs.existsSync(rawTarget)) {
          try {
            const raw = fs.readFileSync(rawTarget, 'utf-8');
            factsList.push(`\n--- TARGET FILE: ${rawTarget} ---`);
            factsList.push(raw);
          } catch {
            factsList.push(`\n--- TARGET FILE: ${rawTarget} (Could not read file) ---`);
          }
        } else {
          factsList.push(`\n--- TARGET FILE: ${rawTarget} (New file to be created) ---`);
        }
      }
    }

    // Include other files in workspace if not already processed
    for (const [filePath, node] of this.fileFactsMap.entries()) {
      if (!processedFiles.has(filePath)) {
        factsList.push(`\n--- AVAILABLE WORKSPACE MODULE: ${filePath} ---`);
        factsList.push(node.content);
        processedFiles.add(filePath);
      }
    }

    return factsList.join('\n');
  }
}
