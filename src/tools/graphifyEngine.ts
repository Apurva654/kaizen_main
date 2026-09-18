import * as fs from 'fs';
import * as path from 'path';
import { ASTParserTool, ExtractedSymbol } from './astParser';

export interface SymbolFact {
  name: string;
  type: string;
  filePath: string;
  isExported: boolean;
  language?: string;
  text?: string;
}

export interface ImportFact {
  importedSymbols: string[];
  moduleSpecifier: string;
  resolvedPath?: string;
  type: 'internal' | 'external' | 'unresolved';
  language?: string;
}

export interface FileNodeFacts {
  filePath: string;
  language: string;
  symbols: SymbolFact[];
  imports: ImportFact[];
  content: string;
}

export interface DependencyEdge {
  source: string;
  import: string;
  resolved_path?: string;
  type: 'internal' | 'external' | 'unresolved';
}

const IGNORED_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  '__pycache__',
  '.venv',
  'venv',
  '.vscode',
  '.idea',
  '.next',
  'build',
  'coverage'
]);

const ALLOWED_EXTENSIONS = new Set([
  '.py',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.json',
  '.md'
]);

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

  public clearCache(): void {
    this.fileFactsMap.clear();
    this.symbolToFilesMap.clear();
  }

  public async scanDirectory(dirPath: string): Promise<void> {
    const normDir = this.normalizePath(dirPath);
    console.log(`[CONTEXT] START`);
    console.log(`[CONTEXT] Workspace root: ${normDir}`);

    if (!fs.existsSync(dirPath)) {
      console.warn(`[CONTEXT][WARN] Directory does not exist: ${dirPath}`);
      console.log(`[CONTEXT] Discovered files: 0`);
      console.log(`[CONTEXT] END`);
      return;
    }

    const files = this.getAllFiles(dirPath);

    let pyCount = 0;
    let tsCount = 0;
    let otherCount = 0;

    for (const f of files) {
      const lang = this.astParser.getLanguageFromPath(f);
      if (lang === 'python') pyCount++;
      else if (lang === 'typescript' || lang === 'javascript') tsCount++;
      else otherCount++;
    }

    console.log(`[CONTEXT] Discovered files: ${files.length} (Python: ${pyCount}, TypeScript/JS: ${tsCount}, Other: ${otherCount})`);

    console.log(`[CONTEXT] AST parsing started`);
    for (const filePath of files) {
      await this.processFile(filePath);
    }
    console.log(`[CONTEXT] AST parsing completed`);

    console.log(`[CONTEXT] Graphify dependency analysis started`);
    this.resolveImports();

    let internalEdges = 0;
    let externalEdges = 0;
    let unresolvedEdges = 0;

    for (const node of this.fileFactsMap.values()) {
      for (const imp of node.imports) {
        if (imp.type === 'internal') internalEdges++;
        else if (imp.type === 'external') externalEdges++;
        else unresolvedEdges++;
      }
    }
    console.log(`[CONTEXT] Graphify completed. Resolved Edges -> Internal: ${internalEdges}, External: ${externalEdges}, Unresolved: ${unresolvedEdges}`);
    console.log(`[CONTEXT] END`);
  }

  private getAllFiles(dirPath: string): string[] {
    const results: string[] = [];
    try {
      const list = fs.readdirSync(dirPath);
      for (const file of list) {
        if (file.startsWith('.') && file !== '.env') continue;
        if (IGNORED_DIRS.has(file)) continue;

        const fullPath = path.join(dirPath, file);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            results.push(...this.getAllFiles(fullPath));
          } else {
            const ext = path.extname(file).toLowerCase();
            if (ALLOWED_EXTENSIONS.has(ext) && !file.endsWith('.d.ts')) {
              results.push(fullPath);
            }
          }
        } catch (err: any) {
          console.warn(`[CONTEXT][WARN] Failed to stat path '${fullPath}':`, err?.message || err);
        }
      }
    } catch (err: any) {
      console.warn(`[CONTEXT][WARN] Failed to read directory '${dirPath}':`, err?.message || err);
    }
    return results;
  }

  private async processFile(filePath: string): Promise<void> {
    const normPath = this.normalizePath(filePath);
    let content = '';
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch (err: any) {
      console.warn(`[CONTEXT][WARN] Could not read file '${filePath}':`, err?.message || err);
      return;
    }

    const language = this.astParser.getLanguageFromPath(filePath);
    let symbols: SymbolFact[] = [];

    if (language !== 'unsupported_language') {
      try {
        const extracted = this.astParser.extractTopLevelSymbols(content, language);
        symbols = extracted.map((s: ExtractedSymbol) => {
          const isExported = language === 'python'
            ? !s.name.startsWith('_')
            : (content.includes(`export ` + s.name) || content.includes(`export function ` + s.name) || content.includes(`export class ` + s.name) || content.includes(`export const ` + s.name));
          return {
            name: s.name,
            type: s.type,
            filePath: normPath,
            isExported,
            language,
            text: s.text
          };
        });
      } catch (err: any) {
        console.warn(`[CONTEXT][WARN] AST symbol extraction failed for '${normPath}':`, err?.message || err);
      }
    }

    for (const sym of symbols) {
      if (!this.symbolToFilesMap.has(sym.name)) {
        this.symbolToFilesMap.set(sym.name, []);
      }
      this.symbolToFilesMap.get(sym.name)!.push(sym);
    }

    const imports = this.parseImports(content, language);

    this.fileFactsMap.set(normPath, {
      filePath: normPath,
      language,
      symbols,
      imports,
      content
    });
  }

  private parseImports(content: string, language: string): ImportFact[] {
    const imports: ImportFact[] = [];
    if (!content) return imports;

    try {
      if (language === 'typescript' || language === 'javascript') {
        const importRegex = /(?:import\s+({[^}]+}|\*\s+as\s+\w+|\w+)\s+from\s+['"]([^'"]+)['"]|require\(['"]([^'"]+)['"]\))/g;
        let match: RegExpExecArray | null;

        while ((match = importRegex.exec(content)) !== null) {
          const specifier = match[1] ? match[1].trim() : '';
          const moduleSpecifier = (match[2] || match[3] || '').trim();
          if (!moduleSpecifier) continue;

          let importedSymbols: string[] = [];

          if (specifier.startsWith('{')) {
            importedSymbols = specifier
              .replace(/[{}]/g, '')
              .split(',')
              .map(s => s.trim().split(/\s+as\s+/)[0])
              .filter(Boolean);
          } else if (specifier.startsWith('* as ')) {
            importedSymbols = [specifier.replace('* as ', '').trim()];
          } else if (specifier) {
            importedSymbols = [specifier];
          }

          imports.push({
            importedSymbols,
            moduleSpecifier,
            type: 'unresolved',
            language
          });
        }
      } else if (language === 'python') {
        const lines = content.split('\n');
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (line.startsWith('#')) continue;

          // e.g. from service import TaskService or from .service import TaskService
          const fromMatch = line.match(/^from\s+([\w.]+)\s+import\s+([\w.,\s*()]+)/);
          if (fromMatch) {
            const moduleSpecifier = fromMatch[1].trim();
            const rawSymbols = fromMatch[2].replace(/[()]/g, '').trim();
            const importedSymbols = rawSymbols === '*'
              ? ['*']
              : rawSymbols.split(',').map(s => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);

            imports.push({
              importedSymbols,
              moduleSpecifier,
              type: 'unresolved',
              language: 'python'
            });
            continue;
          }

          // e.g. import service or import task as t
          const importMatch = line.match(/^import\s+([\w.,\s]+)/);
          if (importMatch) {
            const modules = importMatch[1].split(',').map(m => m.trim().split(/\s+as\s+/)[0]);
            for (const mod of modules) {
              if (mod) {
                imports.push({
                  importedSymbols: [mod],
                  moduleSpecifier: mod,
                  type: 'unresolved',
                  language: 'python'
                });
              }
            }
          }
        }
      }
    } catch (err: any) {
      console.warn(`[CONTEXT][WARN] Import parsing error for ${language}:`, err?.message || err);
    }

    return imports;
  }

  public findMatchingKey(targetPath: string): string | undefined {
    const norm = this.normalizePath(targetPath);
    if (this.fileFactsMap.has(norm)) return norm;
    for (const key of this.fileFactsMap.keys()) {
      if (key.endsWith('/' + norm) || norm.endsWith('/' + key) || key === norm) {
        return key;
      }
    }
    return undefined;
  }

  private resolveImports(): void {
    for (const [filePath, fileNode] of this.fileFactsMap.entries()) {
      const fileDir = path.dirname(filePath);

      for (const imp of fileNode.imports) {
        if (fileNode.language === 'python') {
          const dotMatch = imp.moduleSpecifier.match(/^(\.+)/);
          const dots = dotMatch ? dotMatch[1].length : 0;
          const modName = imp.moduleSpecifier.replace(/^\.+/, '');

          let candidates: string[] = [];

          if (dots > 0) {
            // Python relative import (.service, ..service, ...module)
            let targetDir = fileDir;
            for (let i = 1; i < dots; i++) {
              targetDir = path.dirname(targetDir);
            }

            if (modName) {
              candidates = [
                path.join(targetDir, `${modName}.py`),
                path.join(targetDir, modName, '__init__.py'),
                `${targetDir}/${modName}.py`,
                `${modName}.py`
              ];
            } else {
              candidates = [
                path.join(targetDir, '__init__.py'),
                `${targetDir}/__init__.py`
              ];
            }
          } else {
            // Python non-relative import (e.g., service, task, sys, argparse)
            candidates = [
              path.join(fileDir, `${modName}.py`),
              path.join(fileDir, modName, '__init__.py'),
              `src/sandbox/${modName}.py`,
              `src/sandbox/${modName}/__init__.py`,
              `${modName}.py`
            ];
          }

          let matchedKey: string | undefined = undefined;
          for (const cand of candidates) {
            matchedKey = this.findMatchingKey(cand);
            if (matchedKey) break;
          }

          if (matchedKey) {
            imp.resolvedPath = matchedKey;
            imp.type = 'internal';
          } else if (dots > 0) {
            imp.type = 'unresolved'; // Relative import that couldn't be resolved
          } else {
            imp.type = 'external'; // Non-relative import not in workspace = standard library / external
          }
        } else {
          // JS/TS import resolution
          if (imp.moduleSpecifier.startsWith('.')) {
            const resolvedBase = this.normalizePath(path.resolve(fileDir, imp.moduleSpecifier));
            const possibleExts = ['', '.ts', '.js', '.tsx', '.jsx', '/index.ts', '/index.js'];
            let matchedKey: string | undefined = undefined;

            for (const ext of possibleExts) {
              const candidate = resolvedBase + ext;
              matchedKey = this.findMatchingKey(candidate);
              if (matchedKey) break;
            }

            if (matchedKey) {
              imp.resolvedPath = matchedKey;
              imp.type = 'internal';
            } else {
              imp.type = 'unresolved';
            }
          } else {
            imp.type = 'external';
          }
        }
      }
    }
  }

  public getSymbolMap(): Map<string, SymbolFact[]> {
    return this.symbolToFilesMap;
  }

  public getDependencyEdges(): DependencyEdge[] {
    const edges: DependencyEdge[] = [];
    for (const [filePath, node] of this.fileFactsMap.entries()) {
      for (const imp of node.imports) {
        edges.push({
          source: filePath,
          import: imp.moduleSpecifier,
          resolved_path: imp.resolvedPath,
          type: imp.type
        });
      }
    }
    return edges;
  }

  public getDependencyTree(): Map<string, string[]> {
    const tree = new Map<string, string[]>();
    const MAX_DEPTH = 10;

    for (const [filePath, node] of this.fileFactsMap.entries()) {
      const visited = new Set<string>();
      const deps: string[] = [];

      const traverse = (currFile: string, depth: number) => {
        if (depth > MAX_DEPTH) {
          console.warn(`[CONTEXT][WARN] Graph traversal depth limit (${MAX_DEPTH}) exceeded for '${currFile}'`);
          return;
        }
        if (visited.has(currFile)) {
          // Cycle detected - stop branch traversal safely
          return;
        }
        visited.add(currFile);

        const currNode = this.fileFactsMap.get(currFile);
        if (!currNode) return;

        for (const imp of currNode.imports) {
          if (imp.type === 'internal' && imp.resolvedPath) {
            deps.push(imp.resolvedPath);
            traverse(imp.resolvedPath, depth + 1);
          }
        }
      };

      traverse(filePath, 1);
      tree.set(filePath, Array.from(new Set(deps)));
    }
    return tree;
  }

  public expandTargetFiles(rawTargets: string[]): string[] {
    const expanded: string[] = [];

    for (const target of rawTargets) {
      const norm = this.normalizePath(target);
      if (fs.existsSync(target) || fs.existsSync(norm)) {
        try {
          const stat = fs.statSync(target);
          if (stat.isDirectory()) {
            const files = this.getAllFiles(target);
            for (const f of files) {
              expanded.push(this.normalizePath(f));
            }
            continue;
          }
        } catch {
          // Fall through
        }
      }
      expanded.push(norm);
    }

    return Array.from(new Set(expanded));
  }

  public buildContextSummary(targetFiles: string[]): string {
    console.log(`[CONTEXT] Context assembly started`);
    const factsList: string[] = [];

    const expandedTargets = this.expandTargetFiles(targetFiles);

    factsList.push("=== MULTI-FILE WORKSPACE GRAPH FACTS ===");
    factsList.push(`Scanned Workspace Files (${this.fileFactsMap.size}):`);
    for (const [filePath, node] of this.fileFactsMap.entries()) {
      const exports = node.symbols.filter(s => s.isExported).map(s => `${s.type} ${s.name}`);
      factsList.push(`- ${filePath} [Lang: ${node.language}] [Exports: ${exports.length > 0 ? exports.join(', ') : 'none'}]`);
    }

    factsList.push("\n=== SYMBOL-TO-FILE MAPPINGS ===");
    for (const [symbolName, facts] of this.symbolToFilesMap.entries()) {
      const locations = facts.map(f => `${f.filePath} (${f.language}, ${f.isExported ? 'exported' : 'internal'})`).join(', ');
      factsList.push(`- Symbol '${symbolName}': ${locations}`);
    }

    factsList.push("\n=== DEPENDENCY TREE & IMPORTS CLASSIFICATION ===");
    for (const [filePath, node] of this.fileFactsMap.entries()) {
      if (node.imports.length > 0) {
        factsList.push(`- ${filePath} imports:`);
        for (const imp of node.imports) {
          const symStr = imp.importedSymbols.length > 0 ? ` -> symbols: [${imp.importedSymbols.join(', ')}]` : '';
          if (imp.type === 'internal') {
            factsList.push(`    * [internal] from '${imp.moduleSpecifier}' (Resolved: ${imp.resolvedPath})${symStr}`);
          } else if (imp.type === 'external') {
            factsList.push(`    * [external] from '${imp.moduleSpecifier}' (External library)${symStr}`);
          } else {
            factsList.push(`    * [unresolved] from '${imp.moduleSpecifier}' (Internal / unresolved)${symStr}`);
          }
        }
      }
    }

    factsList.push("\n=== RESOLVED INTERNAL DEPENDENCY GRAPH ===");
    for (const [filePath, node] of this.fileFactsMap.entries()) {
      const internalImports = node.imports.filter(i => i.type === 'internal' && i.resolvedPath);
      if (internalImports.length > 0) {
        factsList.push(`${filePath}`);
        internalImports.forEach((imp, idx) => {
          const isLast = idx === internalImports.length - 1;
          const prefix = isLast ? '    └──' : '    ├──';
          factsList.push(`${prefix} imports → ${imp.resolvedPath} [internal]`);
        });
      }
    }

    factsList.push("\n=== TARGET & RELATED FILE CONTENTS ===");
    const processedFiles = new Set<string>();

    for (const rawTarget of expandedTargets) {
      const matchedKey = this.findMatchingKey(rawTarget);
      if (matchedKey && this.fileFactsMap.has(matchedKey)) {
        processedFiles.add(matchedKey);
        const node = this.fileFactsMap.get(matchedKey)!;
        factsList.push(`\n--- TARGET FILE: ${node.filePath} ---`);
        factsList.push(node.content);

        for (const imp of node.imports) {
          if (imp.type === 'internal' && imp.resolvedPath && this.fileFactsMap.has(imp.resolvedPath) && !processedFiles.has(imp.resolvedPath)) {
            processedFiles.add(imp.resolvedPath);
            const depNode = this.fileFactsMap.get(imp.resolvedPath)!;
            factsList.push(`\n--- IMPORTED RELATIVE FILE: ${depNode.filePath} (imported via '${imp.moduleSpecifier}') ---`);
            factsList.push(depNode.content);
          }
        }
      } else {
        if (fs.existsSync(rawTarget)) {
          try {
            const stat = fs.statSync(rawTarget);
            if (stat.isDirectory()) {
              factsList.push(`\n--- TARGET DIRECTORY: ${rawTarget} (Directory expanded to contents) ---`);
            } else {
              const raw = fs.readFileSync(rawTarget, 'utf-8');
              factsList.push(`\n--- TARGET FILE: ${rawTarget} ---`);
              factsList.push(raw);
            }
          } catch (err: any) {
            factsList.push(`\n--- TARGET FILE: ${rawTarget} (Could not read file: ${err?.message || err}) ---`);
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

    console.log(`[CONTEXT] Context assembly completed`);
    return factsList.join('\n');
  }
}
