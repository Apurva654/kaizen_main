import * as fs from 'fs';
import * as path from 'path';
import { ASTParserTool, ExtractedSymbol, ExtractedSymbolParameter } from './astParser';

export interface SymbolFact {
  name: string;
  type: string;
  filePath: string;
  isExported: boolean;
  language?: string;
  text?: string;
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

export interface GraphifyNode {
  id: string;
  label: string;
  type: 'file' | 'symbol' | 'external' | 'unresolved';
  path?: string;
  language?: string;
  status?: 'generated' | 'modified' | 'test' | 'dependency' | 'active' | 'normal';
  statusExplanation?: string;
  symbolsCount?: number;
  symbolType?: string;
  declaredIn?: string;
  isExported?: boolean;
  importedBy?: string[];
  importsCount?: number;
  contentSnippet?: string;

  // Rich Symbol Metadata
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
  callers?: Array<{ id: string; name: string; file: string; line?: number }>;
  callees?: Array<{ id: string; name: string; file: string; line?: number }>;

  // Rich File Metadata
  importCount?: number;
  internalDependencyCount?: number;
  externalDependencyCount?: number;
  containedSymbols?: Array<{ id: string; name: string; type: string; startLine?: number }>;
  relatedTests?: Array<{ id: string; name: string; path: string; isTestFile: boolean; startLine?: number }>;
  taskRelevance?: {
    isRelevant: boolean;
    reasons: string[];
  };
}

export interface GraphifyEdge {
  id: string;
  source: string;
  target: string;
  type: 'IMPORTS' | 'IMPORTED_BY' | 'DEFINES' | 'EXPORTS' | 'DEPENDS_ON' | 'CALLS' | 'USES' | 'INHERITS' | 'IMPLEMENTS' | 'TESTS';
  label?: string;
  symbols?: string[];
}

export interface GraphifyGraphPayload {
  nodes: GraphifyNode[];
  edges: GraphifyEdge[];
  metadata: {
    files: number;
    symbols: number;
    dependencies: number;
    edges: number;
    externalDependencies: number;
    unresolved: number;
    generatedFiles: number;
    activeFile?: string;
    scope: string;
  };
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
  '.md',
  '.html',
  '.css'
]);

const PYTHON_STD_LIB = new Set([
  'abc', 'argparse', 'array', 'ast', 'asyncio', 'atexit', 'base64', 'bisect',
  'builtins', 'bz2', 'calendar', 'cgi', 'cgitb', 'chunk', 'cmath', 'cmd',
  'code', 'codecs', 'codeop', 'collections', 'colorsys', 'compileall',
  'concurrent', 'configparser', 'contextlib', 'contextvars', 'copy', 'copyreg',
  'cProfile', 'crypt', 'csv', 'ctypes', 'curses', 'dataclasses', 'datetime',
  'dbm', 'decimal', 'difflib', 'dis', 'distutils', 'doctest', 'email',
  'encodings', 'enum', 'errno', 'faulthandler', 'fcntl', 'filecmp', 'fileinput',
  'fnmatch', 'fractions', 'ftplib', 'functools', 'gc', 'getpass', 'getopt',
  'gettext', 'glob', 'graphlib', 'grp', 'gzip', 'hashlib', 'heapq', 'hmac',
  'html', 'http', 'imaplib', 'imghdr', 'imp', 'importlib', 'inspect', 'io',
  'ipaddress', 'itertools', 'json', 'keyword', 'linecache', 'locale', 'logging',
  'lzma', 'mailbox', 'mailcap', 'marshal', 'math', 'mimetypes', 'mmap',
  'modulefinder', 'msilib', 'msvcrt', 'multiprocessing', 'netrc', 'nntplib',
  'numbers', 'operator', 'optparse', 'os', 'pathlib', 'pdb', 'pickle',
  'pickletools', 'pkgutil', 'platform', 'plistlib', 'poplib', 'posix',
  'pprint', 'profile', 'pstats', 'pty', 'pwd', 'py_compile', 'pyclbr',
  'pydoc', 'queue', 'quopri', 'random', 're', 'readline', 'reprlib',
  'resource', 'rlcompleter', 'runpy', 'sched', 'secrets', 'select', 'selectors',
  'shelve', 'shutil', 'signal', 'site', 'smtpd', 'smtplib', 'sndhdr',
  'socket', 'socketserver', 'spwd', 'sqlite3', 'ssl', 'stat', 'statistics',
  'string', 'stringprep', 'struct', 'subprocess', 'sunau', 'symtable',
  'sys', 'sysconfig', 'syslog', 'tabnanny', 'tarfile', 'telnetlib', 'tempfile',
  'termios', 'textwrap', 'threading', 'time', 'timeit', 'tkinter', 'token',
  'tokenize', 'tomllib', 'trace', 'traceback', 'tracemalloc', 'tty', 'types',
  'typing', 'unicodedata', 'unittest', 'urllib', 'uu', 'uuid', 'venv',
  'warnings', 'wave', 'weakref', 'webbrowser', 'winreg', 'winsound', 'wsgiref',
  'xdrlib', 'xml', 'xmlrpc', 'zipapp', 'zipfile', 'zipimport', 'zlib', '_thread'
]);

const PYTHON_KNOWN_THIRD_PARTY = new Set([
  'requests', 'numpy', 'pandas', 'scipy', 'matplotlib', 'seaborn', 'sklearn',
  'torch', 'tensorflow', 'keras', 'cv2', 'PIL', 'pillow', 'bs4', 'beautifulsoup4',
  'yaml', 'pyyaml', 'dotenv', 'boto3', 'botocore', 'click', 'fastapi', 'flask',
  'django', 'pytest', 'pydantic', 'sqlalchemy', 'uvicorn', 'aiohttp', 'jinja2',
  'celery', 'redis', 'psycopg2', 'pymongo', 'cryptography', 'jwt', 'jose',
  'setuptools', 'wheel', 'pip', 'scikit-learn', 'networkx', 'sympy', 'tornado',
  'twisted', 'paramiko', 'fabric', 'ansible', 'docker', 'kubernetes', 'openpyxl',
  'xlsxwriter', 'docx', 'pptx', 'pypdf', 'fitz'
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
            text: s.text,
            startLine: s.startLine,
            endLine: s.endLine,
            startColumn: s.startColumn,
            endColumn: s.endColumn,
            signature: s.signature,
            parameters: s.parameters,
            returnType: s.returnType,
            returnTypeInferred: s.returnTypeInferred,
            documentation: s.documentation,
            loc: s.loc,
            complexity: s.complexity,
            branches: s.branches,
            parameterCount: s.parameterCount,
            bodyText: s.bodyText
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
      } else if (language === 'html') {
        const linkRegex = /<link\s+[^>]*href=["']([^"']+)["']/gi;
        let match: RegExpExecArray | null;
        while ((match = linkRegex.exec(content)) !== null) {
          const href = match[1].trim();
          if (href && !href.startsWith('http://') && !href.startsWith('https://')) {
            imports.push({
              importedSymbols: [],
              moduleSpecifier: href,
              type: 'unresolved',
              language: 'html'
            });
          }
        }
        const scriptRegex = /<script\s+[^>]*src=["']([^"']+)["']/gi;
        while ((match = scriptRegex.exec(content)) !== null) {
          const src = match[1].trim();
          if (src && !src.startsWith('http://') && !src.startsWith('https://')) {
            imports.push({
              importedSymbols: [],
              moduleSpecifier: src,
              type: 'unresolved',
              language: 'html'
            });
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
          const relPath = modName.replace(/\./g, '/');

          let candidates: string[] = [];

          if (dots > 0) {
            let targetDir = fileDir;
            for (let i = 1; i < dots; i++) {
              targetDir = path.dirname(targetDir);
            }

            if (relPath) {
              candidates = [
                path.join(targetDir, `${relPath}.py`),
                path.join(targetDir, relPath, '__init__.py'),
                `${targetDir}/${relPath}.py`
              ];
            } else {
              candidates = [
                path.join(targetDir, '__init__.py'),
                `${targetDir}/__init__.py`
              ];
            }
          } else {
            const rootCandidates: string[] = [];
            let currDir = fileDir;
            while (currDir) {
              if (!rootCandidates.includes(currDir)) {
                rootCandidates.push(currDir);
              }
              const parent = path.dirname(currDir);
              if (!parent || parent === currDir || currDir === '.' || currDir === '/') break;
              currDir = parent;
            }
            if (!rootCandidates.includes('.')) {
              rootCandidates.push('.');
            }

            for (const knownPath of this.fileFactsMap.keys()) {
              const kDir = path.dirname(knownPath);
              if (!rootCandidates.includes(kDir)) {
                rootCandidates.push(kDir);
              }
            }

            for (const root of rootCandidates) {
              if (relPath) {
                candidates.push(path.join(root, `${relPath}.py`));
                candidates.push(path.join(root, relPath, '__init__.py'));
              }
            }
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
            imp.type = 'unresolved';
          } else {
            const topModule = modName.split('.')[0];
            if (PYTHON_STD_LIB.has(topModule) || PYTHON_KNOWN_THIRD_PARTY.has(topModule)) {
              imp.type = 'external';
            } else {
              imp.type = 'unresolved';
            }
          }
        } else {
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

  public exportGraphData(options?: {
    scope?: string;
    targetFiles?: string[];
    generatedFiles?: string[];
    activeFile?: string;
    edgeTypeFilter?: string;
  }): GraphifyGraphPayload {
    const scope = options?.scope || 'current-task';
    const rawTargets = options?.targetFiles || [];
    const generatedFiles = (options?.generatedFiles || []).map(f => this.normalizePath(f));
    const activeFile = options?.activeFile ? this.normalizePath(options.activeFile) : undefined;
    const edgeTypeFilter = (options?.edgeTypeFilter || 'all').toLowerCase();

    const expandedTargets = this.expandTargetFiles(rawTargets).map(f => this.normalizePath(f));

    const nodes: GraphifyNode[] = [];
    const edges: GraphifyEdge[] = [];
    const addedNodeIds = new Set<string>();

    let totalSymbolsCount = 0;
    let totalDepsCount = 0;
    let externalDepsCount = 0;
    let unresolvedCount = 0;

    const getFileStatus = (filePath: string): 'generated' | 'modified' | 'test' | 'dependency' | 'active' | 'normal' => {
      const norm = this.normalizePath(filePath);
      if (activeFile && norm === activeFile) return 'active';
      if (generatedFiles.includes(norm)) return 'generated';
      const baseName = path.basename(norm).toLowerCase();
      if (baseName.includes('test') || baseName.startsWith('test_')) return 'test';
      if (expandedTargets.includes(norm)) return 'modified';
      return 'normal';
    };

    const getStatusExplanation = (status: string): string => {
      switch (status) {
        case 'active': return 'Currently open file in code editor';
        case 'modified': return 'Target file for current task changes';
        case 'generated': return 'Generated or updated file during session';
        case 'test': return 'Automated test suite module';
        case 'dependency': return 'Workspace internal/external dependency module';
        case 'normal': return 'Standard workspace source file or symbol';
        default: return 'Workspace graph node';
      }
    };

    // Detect related test files in workspace
    const testFiles: Array<{ path: string; name: string; node: FileNodeFacts }> = [];
    for (const [fPath, fNode] of this.fileFactsMap.entries()) {
      const base = path.basename(fPath).toLowerCase();
      if (base.includes('test') || base.startsWith('test_')) {
        testFiles.push({ path: fPath, name: path.basename(fPath), node: fNode });
      }
    }

    const relevantFilePaths = new Set<string>();

    const addPathToSet = (p?: string) => {
      if (!p) return;
      const matched = this.findMatchingKey(p);
      if (matched) relevantFilePaths.add(matched);
      else {
        const norm = this.normalizePath(p);
        if (this.fileFactsMap.has(norm)) relevantFilePaths.add(norm);
      }
    };

    if (scope === 'full') {
      for (const f of this.fileFactsMap.keys()) relevantFilePaths.add(f);
    } else if (scope === 'generated') {
      for (const g of generatedFiles) addPathToSet(g);
      for (const t of expandedTargets) addPathToSet(t);
    } else if (scope === 'dependencies') {
      for (const [filePath, node] of this.fileFactsMap.entries()) {
        if (node.imports.length > 0) relevantFilePaths.add(filePath);
        for (const imp of node.imports) {
          if (imp.resolvedPath) relevantFilePaths.add(imp.resolvedPath);
        }
      }
    } else {
      for (const t of expandedTargets) addPathToSet(t);
      for (const g of generatedFiles) addPathToSet(g);
      if (activeFile) addPathToSet(activeFile);

      const initialPaths = Array.from(relevantFilePaths);
      for (const filePath of initialPaths) {
        const node = this.fileFactsMap.get(filePath);
        if (node) {
          for (const imp of node.imports) {
            if (imp.resolvedPath) relevantFilePaths.add(imp.resolvedPath);
          }
        }
      }
      for (const [filePath, node] of this.fileFactsMap.entries()) {
        for (const imp of node.imports) {
          if (imp.resolvedPath && relevantFilePaths.has(imp.resolvedPath)) {
            relevantFilePaths.add(filePath);
          }
        }
      }
    }

    if (relevantFilePaths.size === 0) {
      for (const f of this.fileFactsMap.keys()) relevantFilePaths.add(f);
    }

    // Map of symbol ID to symbol facts & nodes
    const allSymbolNodesMap = new Map<string, { fact: SymbolFact; file: string; id: string }>();

    for (const filePath of relevantFilePaths) {
      const node = this.fileFactsMap.get(filePath);
      if (!node) continue;

      const fileStatus = getFileStatus(filePath);

      // Find related tests for this file
      const fileRelatedTests: Array<{ id: string; name: string; path: string; isTestFile: boolean; startLine?: number }> = [];
      const baseName = path.basename(filePath).toLowerCase().replace(/\.[^/.]+$/, '');

      for (const tf of testFiles) {
        if (tf.path === filePath) continue;
        const tfContent = tf.node.content.toLowerCase();
        if (tf.path.toLowerCase().includes(baseName) || tfContent.includes(baseName) || tf.node.imports.some(i => i.resolvedPath === filePath)) {
          fileRelatedTests.push({
            id: tf.path,
            name: tf.name,
            path: tf.path,
            isTestFile: true
          });
        }
      }

      // Compute Task Relevance for file
      const fileReasons: string[] = [];
      if (activeFile && filePath === activeFile) fileReasons.push('Currently active file open in editor');
      if (expandedTargets.includes(filePath)) fileReasons.push('Target file specified for current task requested changes');
      if (generatedFiles.includes(filePath)) fileReasons.push('Generated or modified during current task workflow');
      if (fileRelatedTests.length > 0) fileReasons.push(`Covered by related test suite (${fileRelatedTests.map(t => t.name).join(', ')})`);
      if (node.imports.some(i => i.resolvedPath && expandedTargets.includes(i.resolvedPath))) fileReasons.push('Imports target task module');

      const fileNodeId = filePath;
      if (!addedNodeIds.has(fileNodeId)) {
        addedNodeIds.add(fileNodeId);
        nodes.push({
          id: fileNodeId,
          label: path.basename(filePath),
          type: 'file',
          path: filePath,
          language: node.language,
          status: fileStatus,
          statusExplanation: getStatusExplanation(fileStatus),
          symbolsCount: node.symbols.length,
          importsCount: node.imports.length,
          importCount: node.imports.length,
          internalDependencyCount: node.imports.filter(i => i.type === 'internal').length,
          externalDependencyCount: node.imports.filter(i => i.type === 'external').length,
          contentSnippet: node.content.slice(0, 300),
          loc: node.content.split('\n').length,
          containedSymbols: node.symbols.map(s => ({
            id: `symbol:${filePath}:${s.name}`,
            name: s.name,
            type: s.type,
            startLine: s.startLine
          })),
          relatedTests: fileRelatedTests,
          taskRelevance: {
            isRelevant: fileReasons.length > 0,
            reasons: fileReasons.length > 0 ? fileReasons : ['Workspace source file']
          }
        });
      }

      // Process tests edge
      for (const rt of fileRelatedTests) {
        edges.push({
          id: `edge:${rt.id}:tests:${fileNodeId}`,
          source: rt.id,
          target: fileNodeId,
          type: 'TESTS',
          label: 'TESTS'
        });
      }

      const shouldIncludeSymbolSubNodes = scope === 'current-task' || scope === 'generated' || fileStatus === 'active' || fileStatus === 'generated' || fileStatus === 'modified' || relevantFilePaths.size <= 8;

      for (const sym of node.symbols) {
        totalSymbolsCount++;
        const symNodeId = `symbol:${filePath}:${sym.name}`;
        allSymbolNodesMap.set(symNodeId, { fact: sym, file: filePath, id: symNodeId });

        if (shouldIncludeSymbolSubNodes) {
          if (!addedNodeIds.has(symNodeId)) {
            addedNodeIds.add(symNodeId);
            nodes.push({
              id: symNodeId,
              label: `${sym.name}()`,
              type: 'symbol',
              symbolType: sym.type,
              declaredIn: filePath,
              path: filePath,
              isExported: sym.isExported,
              status: 'normal',
              statusExplanation: 'AST symbol declaration',
              startLine: sym.startLine,
              endLine: sym.endLine,
              startColumn: sym.startColumn,
              endColumn: sym.endColumn,
              signature: sym.signature || `def ${sym.name}()`,
              parameters: sym.parameters || [],
              returnType: sym.returnType || 'Not available',
              returnTypeInferred: sym.returnTypeInferred || false,
              documentation: sym.documentation || 'No documentation available',
              loc: sym.loc || (sym.endLine && sym.startLine ? sym.endLine - sym.startLine + 1 : 1),
              complexity: sym.complexity || 1,
              branches: sym.branches || 0,
              parameterCount: sym.parameterCount || (sym.parameters ? sym.parameters.length : 0),
              callers: [],
              callees: [],
              relatedTests: fileRelatedTests
            });
          }

          edges.push({
            id: `edge:${fileNodeId}:defines:${symNodeId}`,
            source: fileNodeId,
            target: symNodeId,
            type: 'DEFINES',
            label: 'DEFINES'
          });
        }
      }

      for (const imp of node.imports) {
        if (imp.type === 'internal' && imp.resolvedPath) {
          totalDepsCount++;
          const targetFile = imp.resolvedPath;

          if (!addedNodeIds.has(targetFile)) {
            addedNodeIds.add(targetFile);
            nodes.push({
              id: targetFile,
              label: path.basename(targetFile),
              type: 'file',
              path: targetFile,
              language: this.astParser.getLanguageFromPath(targetFile),
              status: getFileStatus(targetFile),
              statusExplanation: getStatusExplanation(getFileStatus(targetFile)),
              symbolsCount: 0,
              importsCount: 0
            });
          }

          edges.push({
            id: `edge:${fileNodeId}:imports:${targetFile}`,
            source: fileNodeId,
            target: targetFile,
            type: 'IMPORTS',
            label: 'IMPORTS',
            symbols: imp.importedSymbols
          });
        } else if (imp.type === 'external') {
          externalDepsCount++;
          const extNodeId = `ext:${imp.moduleSpecifier}`;
          if (!addedNodeIds.has(extNodeId)) {
            addedNodeIds.add(extNodeId);
            nodes.push({
              id: extNodeId,
              label: imp.moduleSpecifier,
              type: 'external',
              status: 'normal',
              statusExplanation: 'External third-party module dependency'
            });
          }
          edges.push({
            id: `edge:${fileNodeId}:ext:${extNodeId}`,
            source: fileNodeId,
            target: extNodeId,
            type: 'DEPENDS_ON',
            label: 'DEPENDS_ON',
            symbols: imp.importedSymbols
          });
        } else if (imp.type === 'unresolved') {
          unresolvedCount++;
          const unresNodeId = `unres:${imp.moduleSpecifier}`;
          if (!addedNodeIds.has(unresNodeId)) {
            addedNodeIds.add(unresNodeId);
            nodes.push({
              id: unresNodeId,
              label: `${imp.moduleSpecifier} (?)`,
              type: 'unresolved',
              status: 'normal',
              statusExplanation: 'Unresolved import reference'
            });
          }
          edges.push({
            id: `edge:${fileNodeId}:unres:${unresNodeId}`,
            source: fileNodeId,
            target: unresNodeId,
            type: 'DEPENDS_ON',
            label: 'UNRESOLVED',
            symbols: imp.importedSymbols
          });
        }
      }
    }

    // Direct Call Graph Analysis (CALLS edges & Callers/Callees population)
    const nodeMapById = new Map<string, GraphifyNode>();
    for (const n of nodes) {
      nodeMapById.set(n.id, n);
    }

    for (const [symAId, symAData] of allSymbolNodesMap.entries()) {
      const symANode = nodeMapById.get(symAId);
      if (!symANode || !symAData.fact.bodyText) continue;

      const bodyText = symAData.fact.bodyText;

      for (const [symBId, symBData] of allSymbolNodesMap.entries()) {
        if (symAId === symBId) continue;
        const bName = symBData.fact.name;
        if (!bName || bName.length < 2) continue;

        // Check if symA body contains call to symB
        const callRegex = new RegExp(`\\b${bName}\\s*\\(`, 'g');
        if (callRegex.test(bodyText)) {
          // Record caller/callee
          if (!symANode.callees) symANode.callees = [];
          if (!symANode.callees.some(c => c.id === symBId)) {
            symANode.callees.push({
              id: symBId,
              name: bName,
              file: symBData.file,
              line: symBData.fact.startLine
            });
          }

          const symBNode = nodeMapById.get(symBId);
          if (symBNode) {
            if (!symBNode.callers) symBNode.callers = [];
            if (!symBNode.callers.some(c => c.id === symAId)) {
              symBNode.callers.push({
                id: symAId,
                name: symAData.fact.name,
                file: symAData.file,
                line: symAData.fact.startLine
              });
            }
          }

          // Add CALLS edge if both nodes are present in graph
          if (addedNodeIds.has(symAId) && addedNodeIds.has(symBId)) {
            const edgeId = `edge:${symAId}:calls:${symBId}`;
            if (!edges.some(e => e.id === edgeId)) {
              edges.push({
                id: edgeId,
                source: symAId,
                target: symBId,
                type: 'CALLS',
                label: 'CALLS'
              });
            }
          }
        }
      }
    }

    // Populate Symbol Task Relevance
    for (const n of nodes) {
      if (n.type === 'symbol') {
        const symReasons: string[] = [];
        if (n.declaredIn && expandedTargets.includes(n.declaredIn)) {
          symReasons.push(`Belongs to target task file (${path.basename(n.declaredIn)})`);
        }
        if (n.declaredIn && activeFile && n.declaredIn === activeFile) {
          symReasons.push(`Declared in currently active editor file`);
        }
        if (n.callers && n.callers.some(c => expandedTargets.includes(c.file))) {
          const callerNames = n.callers.filter(c => expandedTargets.includes(c.file)).map(c => c.name).join(', ');
          symReasons.push(`Directly called by target workflow (${callerNames})`);
        }
        if (n.callees && n.callees.some(c => expandedTargets.includes(c.file))) {
          const calleeNames = n.callees.filter(c => expandedTargets.includes(c.file)).map(c => c.name).join(', ');
          symReasons.push(`Directly calls target symbol (${calleeNames})`);
        }
        if (n.relatedTests && n.relatedTests.length > 0) {
          symReasons.push(`Covered by test suite (${n.relatedTests.map(t => t.name).join(', ')})`);
        }

        n.taskRelevance = {
          isRelevant: symReasons.length > 0,
          reasons: symReasons.length > 0 ? symReasons : ['Declared workspace symbol']
        };
      }
    }

    const fileNodesCount = nodes.filter(n => n.type === 'file').length;
    const symbolNodesCount = nodes.filter(n => n.type === 'symbol').length;

    const validNodeIds = new Set(nodes.map(n => n.id));
    let validEdges = edges.filter(e => validNodeIds.has(e.source) && validNodeIds.has(e.target));

    if (edgeTypeFilter && edgeTypeFilter !== 'all') {
      validEdges = validEdges.filter(e => e.type.toLowerCase() === edgeTypeFilter);
    }

    return {
      nodes,
      edges: validEdges,
      metadata: {
        files: fileNodesCount,
        symbols: symbolNodesCount,
        dependencies: totalDepsCount,
        edges: validEdges.length,
        externalDependencies: externalDepsCount,
        unresolved: unresolvedCount,
        generatedFiles: generatedFiles.length,
        activeFile,
        scope
      }
    };
  }

  public getImpactAnalysis(nodeId: string, graphPayload?: GraphifyGraphPayload): {
    nodeId: string;
    directDependenciesCount: number;
    directDependentsCount: number;
    dependencies: Array<{ id: string; label: string; type: string }>;
    dependents: Array<{ id: string; label: string; type: string }>;
  } {
    const payload = graphPayload || this.exportGraphData({ scope: 'full' });
    const targetNode = payload.nodes.find(n => n.id === nodeId || n.path === nodeId);
    if (!targetNode) {
      return {
        nodeId,
        directDependenciesCount: 0,
        directDependentsCount: 0,
        dependencies: [],
        dependents: []
      };
    }

    const effectiveId = targetNode.id;
    const outgoingEdges = payload.edges.filter(e => e.source === effectiveId);
    const incomingEdges = payload.edges.filter(e => e.target === effectiveId);

    const depNodeIds = Array.from(new Set(outgoingEdges.map(e => e.target)));
    const deptNodeIds = Array.from(new Set(incomingEdges.map(e => e.source)));

    const dependencies = payload.nodes
      .filter(n => depNodeIds.includes(n.id))
      .map(n => ({ id: n.id, label: n.label, type: n.type }));

    const dependents = payload.nodes
      .filter(n => deptNodeIds.includes(n.id))
      .map(n => ({ id: n.id, label: n.label, type: n.type }));

    return {
      nodeId: effectiveId,
      directDependenciesCount: dependencies.length,
      directDependentsCount: dependents.length,
      dependencies,
      dependents
    };
  }

  public tracePath(sourceId: string, targetId: string, graphPayload?: GraphifyGraphPayload): Array<{ id: string; label: string; type: string }> | null {
    const payload = graphPayload || this.exportGraphData({ scope: 'full' });
    const srcNode = payload.nodes.find(n => n.id === sourceId || n.path === sourceId);
    const dstNode = payload.nodes.find(n => n.id === targetId || n.path === targetId);

    if (!srcNode || !dstNode) return null;
    if (srcNode.id === dstNode.id) return [{ id: srcNode.id, label: srcNode.label, type: srcNode.type }];

    // BFS Shortest Path Traversal
    const queue: Array<{ id: string; path: string[] }> = [{ id: srcNode.id, path: [srcNode.id] }];
    const visited = new Set<string>([srcNode.id]);

    const adjacency = new Map<string, string[]>();
    for (const e of payload.edges) {
      if (!adjacency.has(e.source)) adjacency.set(e.source, []);
      adjacency.get(e.source)!.push(e.target);
    }

    while (queue.length > 0) {
      const { id, path: currentPath } = queue.shift()!;
      if (id === dstNode.id) {
        return currentPath.map(nid => {
          const n = payload.nodes.find(item => item.id === nid)!;
          return { id: n.id, label: n.label, type: n.type };
        });
      }

      const neighbors = adjacency.get(id) || [];
      for (const nextId of neighbors) {
        if (!visited.has(nextId)) {
          visited.add(nextId);
          queue.push({ id: nextId, path: [...currentPath, nextId] });
        }
      }
    }

    return null;
  }
}

