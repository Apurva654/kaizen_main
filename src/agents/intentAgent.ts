import { z } from 'zod';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { KaizenState } from '../state';
import { langfuseTracer } from '../tools/langfuseTracer';

dotenv.config();

export const IntentSchema = z.object({
  intent: z.enum(['GENERATE_CODE', 'DEBUG_ERROR', 'EXPLAIN_CODE', 'REFACTOR', 'RUN_EXISTING_TESTS', 'GENERAL_QUERY', 'MCP_GIT', 'MCP_TERMINAL', 'DELETE_FILES', 'MEMORY_WRITE', 'MEMORY_READ'])
    .describe("The classified intent of the user request"),
  targetFiles: z.array(z.string()).optional()
    .describe("All target source file paths identified or implied for the task (e.g., ['src/sandbox/utils.ts', 'src/sandbox/main.ts'])"),
  target_files: z.array(z.string()).optional()
    .describe("All target source file paths identified or implied for the task"),
  gitActions: z.array(z.enum(['status', 'diff', 'commit', 'push', 'log'])).optional()
    .describe("Git operations requested (e.g. ['status', 'diff'])")
});

export function extractRawUserPrompt(input: string): string {
  let cleaned = input;

  if (cleaned.includes('USER REQUEST:\n==============\n')) {
    cleaned = cleaned.split('USER REQUEST:\n==============\n')[1].split('\n---\n')[0];
  } else if (cleaned.includes('USER REQUEST:\n')) {
    cleaned = cleaned.split('USER REQUEST:\n')[1];
  }

  // Strip injected background execution logs / metadata lines to prevent heuristic false-positives
  cleaned = cleaned
    .replace(/^🌐\s*Browser Inspection:.*$/gm, '')
    .replace(/^MCP Server:.*$/gm, '')
    .replace(/^Browser Action Executed:.*$/gm, '')
    .replace(/^Mode:\s*Read-Only Inspection.*$/gm, '')
    .replace(/^\[automated test.*?\]/gm, '')
    .trim();

  return cleaned;
}

export function isGitQuery(input: string): boolean {
  const rawPrompt = extractRawUserPrompt(input).toLowerCase().trim();

  const hasDomainCodeTerm = /\b(model|enum|property|field|http|code|payment|order|user|event|database|table|column|api|rest)\b/i.test(rawPrompt);
  const hasExplicitGitMarker = /\b(git|github|repository|repo)\b/i.test(rawPrompt);

  // Non-Git domain requests (e.g. "Order model/status", "payment status") without explicit git markers must not route to Git MCP
  if (hasDomainCodeTerm && !hasExplicitGitMarker) {
    return false;
  }

  // 1. Direct git command (e.g. "git status", "git diff", "git commit", "git push", "git log", "git branch", etc.)
  if (/\bgit\s+(status|diff|commit|push|pull|log|branch|checkout|merge|rebase|stash)\b/i.test(rawPrompt)) {
    return true;
  }
4
  // 2. Explicit repository / version-control intent queries
  const gitIntentPatterns = [
    /\b(show|check|view|display|get)\s+.*?\b(status|diff|log|history|branches|branch)\b/i,
    /\b(check|show|view|display|get)\s+(repository|repo|workspace)\s+(status|diff|log|history|branches|branch)\b/i,
    /\b(repository|repo|workspace)\s+(status|diff|log|history|branches|branch)\b/i,
    /\b(commit|push)\s+(these|the|my|all|current)?\s*(changes|code|branch|repo|repository|commits?)\b/i,
    /\b(switch|change|create)\s+(git\s+)?(branch)\b/i
  ];

  for (const pattern of gitIntentPatterns) {
    if (pattern.test(rawPrompt)) {
      return true;
    }
  }

  // 3. Explicit git/repo marker + Git action verb
  if (hasExplicitGitMarker) {
    if (/\b(status|diff|commit|push|pull|log|branch|checkout|merge|rebase|stash)\b/i.test(rawPrompt)) {
      return true;
    }
  }

  return false;
}

export function extractGitActions(input: string): Array<'status' | 'diff' | 'commit' | 'push' | 'log'> {
  const rawPrompt = extractRawUserPrompt(input).toLowerCase();
  const requestedActions: Array<'status' | 'diff' | 'commit' | 'push' | 'log'> = [];

  if (/\b(git\s+status|repo(sitory)?\s+status|check\s+status|show\s+status|status\s+of\s+(repo|repository|git|workspace)|changes)\b/i.test(rawPrompt)) {
    requestedActions.push('status');
  }
  if (/\b(git\s+diff|repo(sitory)?\s+diff|recent\s+diff|show\s+diff|check\s+diff)\b/i.test(rawPrompt) || /\bgit\s+diff\b/i.test(rawPrompt)) {
    requestedActions.push('diff');
  }
  if (/\b(git\s+commit|commit\s+(these|the|my|all|current)?\s*(changes|code|branch|repo|repository|commits?))\b/i.test(rawPrompt)) {
    requestedActions.push('commit');
  }
  if (/\b(git\s+push|push\s+(these|the|my|all|current)?\s*(branch|changes|remote|repo|repository))\b/i.test(rawPrompt)) {
    requestedActions.push('push');
  }
  if (/\b(git\s+log|repo(sitory)?\s+log|git\s+history|commit\s+history)\b/i.test(rawPrompt)) {
    requestedActions.push('log');
  }

  if (requestedActions.length === 0) {
    requestedActions.push('status', 'diff');
  }

  return requestedActions;
}

export function isTerminalQuery(input: string): boolean {
  const rawPrompt = extractRawUserPrompt(input).trim();
  if (!rawPrompt) return false;

  // Filter out UI status strings, failure reports, and permission headers
  if (/^(permission gate|command result|execution|execution error|\[automated test|status:|result:|error:)/i.test(rawPrompt)) {
    return false;
  }

  const lower = rawPrompt.toLowerCase();

  // If prompt explicitly requests creating, writing, implementing, modifying, editing, building, refactoring files or code, it's NOT a terminal command
  const isCodeCreationOrEditing = /^\s*(create|write|implement|add|modify|edit|build|refactor)\b.*?\b(file|function|class|script|module|component|code|python|typescript|ts|py|js)\b/i.test(lower) ||
    /^\s*(create|write|implement|add|modify|edit|build|refactor)\s+(a\s+)?(python|typescript|js|ts|py|file|code)\b/i.test(lower);

  if (isCodeCreationOrEditing && !/\b(run|execute)\s+(command|terminal|shell|script|pytest|npm|python)\b/i.test(lower)) {
    return false;
  }

  // 1. Explicit terminal execution phrasing: "run command pytest...", "use terminal to run...", "execute shell..."
  const hasTerminalPhrase = /\b(run\s+command|use\s+terminal|terminal\s+command|execute\s+shell|run\s+shell|terminal\s+exec|run\s+in\s+terminal)\b/i.test(lower);
  if (hasTerminalPhrase) return true;

  // 2. Direct command invocation starting with executable command or having explicit command syntax
  const startsWithCommand = /^\s*(pytest|pip3?\s+|python3?\s+|npm\s+|node\s+|npx\s+|tsc\s+|git\s+|rm\s+|del\s+|dir\b|ls\b|cat\s+|pwd\b|mkdir\s+|docker\s+|cargo\s+|go\s+|bun\s+|pnpm\s+|yarn\s+|conda\s+|poetry\s+|uv\s+|pipenv\s+|gem\s+|dotnet\s+|composer\s+)/i.test(lower);
  if (startsWithCommand) return true;

  // 3. Command inside backticks or quotes without code creation context (e.g. `pytest src/...`)
  if (/^\s*[`'"](pytest|pip|pip3|python|python3|npm|node|npx|tsc|git|rm|del|dir|ls|cat|pwd|mkdir|docker|cargo|go|bun|pnpm|yarn|conda|poetry|uv|pipenv|gem|dotnet|composer)\b/i.test(lower)) {
    return true;
  }

  return false;
}

export function extractTerminalCommand(input: string): string {
  const raw = extractRawUserPrompt(input).trim();

  // 0. If raw matches UI headers / status messages / failure reports, it is NOT a command
  if (!raw || /^(permission gate|command result|execution|execution error|\[automated test|status:|result:|error:|[a-z]+ error)/i.test(raw)) {
    return '';
  }
  
  // 1. If quoted with `...`, "...", or '...', extract inside quote
  const matchQuote = raw.match(/[`'"]([^`'"]+)[`'"]/);
  if (matchQuote && matchQuote[1]) {
    const extracted = matchQuote[1].trim();
    if (!/^(execution|permission gate|command result|status|error)/i.test(extracted)) {
      return extracted;
    }
  }

  // 2. Check for explicit shell command syntax like pytest, pip, python, rm, del, npm, node, dir, ls, etc.
  const explicitCmdMatch = raw.match(/\b(pytest\s+[^\s,;]+|pip3?\s+install\s+[^\s,;]+|pip3?\s+[^\s,;]+|python3?\s+-[a-zA-Z0-9_\-\s"'\/\.\\]+|rm\s+-[a-zA-Z]+\s+[^\s,;]+|rm\s+[^\s,;]+|del\s+[^\s,;]+|rmdir\s+[^\s,;]+|npm\s+[^\s,;]+|node\s+[^\s,;]+|dir\b|ls\b|cat\s+[^\s,;]+|pwd\b|mkdir\s+[^\s,;]+)\b/i);
  if (explicitCmdMatch) {
    return explicitCmdMatch[0].trim();
  }

  // 3. Match natural language deletion / command intent patterns:
  const deletionMatch = raw.match(/\b(deletion|delete|remove|cleanup|rm)\s+(of\s+)?([^\s,;]+)/i);
  if (deletionMatch && deletionMatch[3]) {
    const targetPath = deletionMatch[3].trim();
    if (targetPath.includes('/') || targetPath.includes('\\') || targetPath.includes('.')) {
      return `rm -rf ${targetPath}`;
    }
  }

  // 4. Strip common conversational prefixes: "use terminal to run dir", "run command rm -rf src/temp", "execute dir"
  let clean = raw.replace(/^(please\s+)?(use|run|execute|test|simulate)(\s+the)?(\s+terminal|\s+shell|\s+cmd)?(\s+command)?(\s+to\s+run|\s+to\s+execute|\s+to|\s*:)?\s*/i, '');
  clean = clean.replace(/^(terminal|shell|cmd)\s+(exec|run|command)?\s*/i, '');

  // Strip trailing sentence junk (e.g. "for Permission Gate testing...", "Do not create...")
  clean = clean.split(/(\bfor\b|\bdo not\b|\bplease\b|\bto test\b|\bwith\b|\band\b)/i)[0].trim();

  if (/^(execution|permission gate|command result|status|error|result|blocked|simulated|denied|approved)/i.test(clean)) {
    return '';
  }

  const validCmdPrefixes = [
    'pytest', 'pip', 'pip3', 'python', 'python3', 'conda', 'poetry', 'uv', 'pipenv',
    'npm', 'node', 'npx', 'tsc', 'bun', 'pnpm', 'yarn',
    'git', 'rm', 'del', 'dir', 'ls', 'cat', 'pwd', 'mkdir', 'cp', 'mv', 'echo', 'touch',
    'docker', 'cargo', 'go', 'gem', 'dotnet', 'composer'
  ];
  const firstWord = clean.split(/\s+/)[0].toLowerCase();
  
  if (validCmdPrefixes.includes(firstWord) || firstWord.endsWith('.exe') || firstWord.endsWith('.bat') || firstWord.endsWith('.cmd') || firstWord.startsWith('./') || firstWord.startsWith('.\\')) {
    return clean;
  }
  
  return '';
}

export function isGeneralQuery(input: string): boolean {
  const rawPrompt = extractRawUserPrompt(input);
  const trimmed = rawPrompt.toLowerCase();

  if (isGitQuery(input) || isTerminalQuery(input)) return false;
  
  const codingKeywords = [
    'code', 'file', 'function', 'class', 'bug', 'error', 'repo', 'workspace', 'script',
    'app', 'build', 'html', 'css', 'javascript', 'typescript', 'ts', 'js', 'py', 'python',
    'json', 'component', 'test', 'create', 'write', 'make', 'delete', 'refactor', 'fix',
    'implement', 'add', 'modify', 'directory', 'folder', 'npm', 'node', 'run', 'execute',
    'calculator', 'utils', 'main.ts', 'solution', 'import', 'export', 'const', 'let', 'var',
    'git', 'status', 'diff', 'commit', 'push', 'branch', 'repository', 'log', 'checkout', 'stash',
    'terminal', 'command', 'shell', 'rm', 'del', 'sudo', 'chmod',
    'website', 'webpage', 'web', 'landing', 'page', 'site', 'index.html', 'style.css', 'styles.css', 'script.js', 'frontend',
    'agent', 'agents', 'llm', 'model', 'models', 'mcp', 'intent', 'pipeline', 'router', 'classification'
  ];

  const hasCodingKeyword = codingKeywords.some(kw => {
    const reg = new RegExp(`\\b${kw}\\b`, 'i');
    return reg.test(trimmed);
  });

  if (hasCodingKeyword) return false;

  // 1. Direct short greetings or conversational phrases
  const greetingsRegex = /^(hello|hi|hey|greetings|good morning|good afternoon|good evening|howdy|yo|sup|ping|test)(\b|[!?. ]|$)/i;
  if (greetingsRegex.test(trimmed)) return true;

  // 2. Common general knowledge / conversational starters & identity questions
  const gkStartersRegex = /^(who is|whats|what is|where is|when did|why is|how is|tell me|explain who|explain what|do you know|is it|are you|can you tell|how far|how many|who was|what was|my name|whats my name|what is my name|who am i)/i;
  if (gkStartersRegex.test(trimmed)) return true;

  // 3. Person, celebrity, sports & entity query patterns (e.g. "djokovic is strong", "is federer good", "nole", "messi stats", "schedule", "time")
  const personEntityPatterns = [
    /\b(who is|who was|who are|tell me about|information on|news about|stats of|details of)\b/i,
    /\b(djokovic|nole|federer|nadal|alcaraz|sinner|messi|ronaldo|lebron|curry|kobe|jordan|mbappe|haaland|kohli|rohit|dhoni)\b/i,
    /\b(is|was|are|does|can|has|will)\s+.*?\s+(strong|good|great|fast|rich|famous|tall|old|young|active|retired|playing|the goat|goat|best|worst|winning|champion|match|player|athlete)\b/i,
    /\b(weather|temperature|forecast|score|match|schedule|tournament|grand slam|world cup|olympics|championship|time|today|now)\b/i
  ];

  for (const pattern of personEntityPatterns) {
    if (pattern.test(trimmed)) {
      return true;
    }
  }

  // 4. Short prompts without any coding keywords (e.g., "who is nole?", "my name is carlitos", "djokovic is strong")
  if (trimmed.length < 150) return true;

  return false;
}

export function isBrowserQuery(input: string): boolean {
  const rawPrompt = extractRawUserPrompt(input).toLowerCase().trim();
  if (!rawPrompt) return false;

  // Do NOT classify as code mutation if prompt contains explicit read-only / execution / non-mutation directives
  const isExplicitReadOnly = /\b(do\s+not\s+modify|don't\s+modify|read[\s-]*only|existing|without\s+modifying)\b/i.test(rawPrompt);

  // Filter out explicit code creation/editing requests (e.g. "Build a landing page", "Create an HTML page", "Modify the webpage", "Edit index.html")
  const isCodeMutationRequest = !isExplicitReadOnly && (
    /^\s*(build|create|implement|modify|edit|add|write|make|refactor|fix|update)\b/i.test(rawPrompt) ||
    /\b(build|create|implement|modify|edit|add|write|make|refactor|fix|update)\s+.*?\b(webpage|website|html|page|site|code|file|component|app|style|script)\b/i.test(rawPrompt)
  );

  const hasExplicitUrl = /\b(https?:\/\/[^\s]+|localhost:\d+[^\s]*)\b/i.test(rawPrompt);
  const hasBrowserToolCall = /\b(browser|playwright|chrome|chromium)\b/i.test(rawPrompt);

  // Normal coding requests containing words like build, create, implement, modify, edit, add must NOT be classified as browser requests
  if (isCodeMutationRequest && !hasExplicitUrl && !hasBrowserToolCall) {
    return false;
  }

  // Explicit browser execution verbs
  const hasBrowserActionVerb = /\b(run|open|preview|launch|show|test|inspect|view|browse|navigate|visit|check)\b/i.test(rawPrompt);

  // Explicit web target nouns
  const hasWebTargetNoun = /\b(webpage|website|page|site|app|ui|frontend|url|index\.html)\b/i.test(rawPrompt) ||
    /\b(src\/sandbox\/[a-zA-Z0-9_\-]+\.html|[a-zA-Z0-9_\-]+\.html)\b/i.test(rawPrompt);

  // 1. Phrasal patterns for browser execution (e.g., "now run the webpage", "run src/sandbox/index.html", "open src/sandbox/index.html and inspect it")
  if (hasBrowserActionVerb && hasWebTargetNoun) {
    return true;
  }

  // 2. Direct browser tool or URL queries
  if (hasBrowserToolCall && (hasBrowserActionVerb || hasWebTargetNoun || /\b(open|navigate|visit|goto|inspect|run|preview)\b/i.test(rawPrompt))) {
    return true;
  }

  if (hasExplicitUrl && (hasBrowserActionVerb || hasWebTargetNoun || hasBrowserToolCall)) {
    return true;
  }

  if (/\b(open|inspect|navigate|goto|preview|run)\s+https?:\/\/[^\s]+/i.test(rawPrompt)) {
    return true;
  }

  return false;
}

export function isAmbiguousQuery(input: string): boolean {
  const rawPrompt = extractRawUserPrompt(input).toLowerCase().trim();
  
  const vaguePatterns = [
    /^(make|create|write|add|generate)\s+(\d+\s+)?(code\s+)?files?\s*(in\s+[a-zA-Z0-9+#]+)?$/i,
    /^(make|create|write)\s+(a\s+)?(code|program|file|script)\s*(in\s+[a-zA-Z0-9+#]+)?$/i,
    /^(make|create|write)\s+something\s*(in\s+[a-zA-Z0-9+#]+)?$/i
  ];
  
  return vaguePatterns.some(p => p.test(rawPrompt));
}

export function isDeleteQuery(input: string): boolean {
  const rawPrompt = extractRawUserPrompt(input).toLowerCase().trim();

  // Guard: Code element edits inside a file (e.g., "remove all comments", "remove unused imports", "remove function", "remove line", "refactor auth.ts")
  const isCodeEdit = /\b(std::|std|comment|comments|import|imports|function|method|class|variable|line|lines|code|prefix|namespace|log|print|unused)\b/i.test(rawPrompt);
  const isInsideFileRefactor = /\b(from|inside|in|refactor|update|edit|clean)\s+.*\b(file|files|code|class|cpp|ts|py|js|auth\.ts|main\.ts)\b/i.test(rawPrompt) || /\brefactor\b/i.test(rawPrompt);

  if (isCodeEdit && (isInsideFileRefactor || /\b(remove|delete)\s+(all\s+)?(inline\s+)?(std|comment|comments|import|imports|function|line|lines|log|print|unused|prefix|namespace)\b/i.test(rawPrompt))) {
    return false;
  }

  // Explicit File / Directory Deletion intent (including "both files", "these files", "2 files", "delete all files", "delete all work")
  const explicitFileDelete = /\b(delete|delte|delt|deleate|remove|clear|wipe|erase|unlink|destroy)\s+(the\s+)?(both|these|those|two|selected|\d+\s+)?(file|files|folder|directory|sandbox|workspace|everything|work)\b/i;
  const explicitPathDelete = /\b(delete|remove|unlink|rm)\s+(the\s+file\s+)?([a-zA-Z0-9_\-\/]+\.(cpp|py|ts|js|json|html|css|txt))\b/i;
  const deleteAllPattern = /\b(delete|remove|clear|wipe)\s+(both\s+files|all\s+files|all\s+the\s+files|all\s+work|everything)\b/i;

  if (explicitFileDelete.test(rawPrompt) || explicitPathDelete.test(rawPrompt) || deleteAllPattern.test(rawPrompt)) {
    return true;
  }

  return false;
}

export function detectRequestedLanguageExtension(input: string): string {
  const rawPrompt = extractRawUserPrompt(input).toLowerCase();
  if (/\b(c\+\+|cpp|cplusplus)\b/i.test(rawPrompt)) return '.cpp';
  if (/\b(python|py)\b/i.test(rawPrompt)) return '.py';
  if (/\b(java)\b/i.test(rawPrompt)) return '.java';
  if (/\b(rust|rs)\b/i.test(rawPrompt)) return '.rs';
  if (/\b(golang|go)\b/i.test(rawPrompt)) return '.go';
  if (/\b(c#|csharp|cs)\b/i.test(rawPrompt)) return '.cs';
  if (/\b(php)\b/i.test(rawPrompt)) return '.php';
  return '.ts';
}

export function extractBrowserUrl(input: string): string {
  const raw = extractRawUserPrompt(input);
  const match = raw.match(/\b(https?:\/\/[^\s]+|localhost:\d+[^\s]*)\b/i);
  if (match) {
    let url = match[0];
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = `http://${url}`;
    }
    return url;
  }

  // Check for explicit html filename in prompt (e.g. src/sandbox/index.html or index.html)
  const explicitMatch = raw.match(/\b(src\/sandbox\/[a-zA-Z0-9_\-]+\.html|[a-zA-Z0-9_\-]+\.html)\b/i);
  if (explicitMatch) {
    const fileName = path.basename(explicitMatch[0]);
    return `http://localhost:3000/sandbox/${fileName}`;
  }

  // Determine existing static webpage file in src/sandbox
  const rootDir = process.cwd();
  const sandboxDir = path.resolve(rootDir, 'src/sandbox');

  if (fs.existsSync(path.join(sandboxDir, 'index.html'))) {
    return 'http://localhost:3000/sandbox/index.html';
  }

  if (fs.existsSync(sandboxDir)) {
    try {
      const list = fs.readdirSync(sandboxDir);
      const firstHtml = list.find(f => f.endsWith('.html'));
      if (firstHtml) {
        return `http://localhost:3000/sandbox/${firstHtml}`;
      }
    } catch {}
  }

  // If prompt is asking for a webpage/website/landing page/html, default to static sandbox index.html
  if (/\b(webpage|website|landing|page|site|html|frontend)\b/i.test(raw)) {
    return 'http://localhost:3000/sandbox/index.html';
  }

  return 'http://localhost:3000';
}

export function isMemoryWriteQuery(input: string): boolean {
  if (isMemoryReadQuery(input)) return false;

  const rawPrompt = extractRawUserPrompt(input).trim();
  const lower = rawPrompt.toLowerCase();

  // 1. Explicit coding action verbs targeting project configuration or source code files
  const codeActionRegex = /^\s*(add|install|create|write|implement|modify|edit|fix|update|configure|delete|remove|refactor|build)\b.*?\b(file|config|tsconfig|package\.json|code|component|page|app|module|function|class|styling|service|repository)\b/i;
  if (codeActionRegex.test(lower) && !/\bdo\s+not\s+modify\s+any\s+files\b/i.test(lower)) {
    return false;
  }

  // 2. Explicit memory write intent patterns
  const writePatterns = [
    /\b(remember\s+(this|that|my|our|for|about|the)|remember\s+for\s+(this|our)\s+current\s+project)\b/i,
    /\b(keep\s+(this|our|my)\s+(preference|fact|convention)?\s*in\s+mind)\b/i,
    /\b(save|store)\s+(this|my|our)\s+(preference|convention|fact|info|information)\b/i,
    /\b(remember\s+(our|my)\s+coding\s+convention)\b/i,
    /\b(don't|do\s+not)\s+forget\s+(that|our|we)\b/i,
    /\b(remember\s*:)/i,
    /^remember\b/i
  ];

  for (const pattern of writePatterns) {
    if (pattern.test(lower)) {
      return true;
    }
  }

  // 3. Declarative project convention/preference statements without file editing actions
  const conventionPatterns = [
    /\b(our\s+convention\s+is|we\s+prefer|always\s+use)\s+.*?\b(typescript|strict|tailwind|react|vue|express|python|convention|preference|style|backend|frontend)\b/i
  ];

  for (const pattern of conventionPatterns) {
    if (pattern.test(lower) && !/\b(add|install|create|fix|update|modify|edit)\b/i.test(lower)) {
      return true;
    }
  }

  return false;
}

export function isMemoryReadQuery(input: string): boolean {
  const rawPrompt = extractRawUserPrompt(input).trim();
  const lower = rawPrompt.toLowerCase();

  const readPatterns = [
    /\b(what|which)\s+.*?\bdo\s+you\s+remember\b/i,
    /\b(what|which)\s+.*?\bhave\s+you\s+(stored|saved|remembered)\b/i,
    /\b(show|display|list|view)\s+remembered\b/i,
    /\bwhat\s+project\s+conventions\s+do\s+you\s+know\b/i,
    /\brecall\s+(the|our|my|previous|past)\s+(preferences|conventions|facts|task|info)\b/i,
    /\bwhat\s+did\s+you\s+remember\s+from\s+earlier\b/i,
    /\bwhat\s+do\s+you\s+remember\b/i
  ];

  for (const pattern of readPatterns) {
    if (pattern.test(lower)) {
      return true;
    }
  }

  return false;
}

export function extractTargetFilesFromPrompt(prompt: string): string[] {
  const rawPrompt = extractRawUserPrompt(prompt);
  const foundFiles: string[] = [];

  const normalizePath = (f: string): string => {
    if (!f) return 'src/sandbox/main.ts';
    let norm = f.replace(/\\/g, '/').trim();
    norm = norm.replace(/^\.\//, '');
    if (!norm.startsWith('src/sandbox/')) {
      if (norm.startsWith('src/')) {
        norm = norm.replace(/^src\//, 'src/sandbox/');
      } else {
        norm = `src/sandbox/${norm}`;
      }
    }
    return norm;
  };

  const pathRegex = /\b(src\/sandbox\/[a-zA-Z0-9_\-\/]+\.[a-zA-Z0-9]+|src\/[a-zA-Z0-9_\-\/]+\.[a-zA-Z0-9]+|[a-zA-Z0-9_\-]+\/[a-zA-Z0-9_\-\/]+\.[a-zA-Z0-9]+|[a-zA-Z0-9_\-]+\.(py|ts|js|jsx|tsx|json|html|css))\b/gi;
  let match: RegExpExecArray | null;
  while ((match = pathRegex.exec(rawPrompt)) !== null) {
    const norm = normalizePath(match[0].trim());
    if (!foundFiles.includes(norm)) {
      foundFiles.push(norm);
    }
  }

  const lower = rawPrompt.toLowerCase();
  const includesTestRequest = /\b(pytest|test|unit\s+test|spec)\b/i.test(lower);
  
  if (includesTestRequest && foundFiles.length > 0) {
    const mainFile = foundFiles[0];
    const isPy = mainFile.endsWith('.py');
    const isTs = mainFile.endsWith('.ts') || mainFile.endsWith('.js');
    
    if (isPy && !foundFiles.some(f => f.includes('test'))) {
      const parts = mainFile.split('/');
      const fileName = parts.pop()!;
      const dirName = parts.join('/');
      const baseName = fileName.replace(/\.py$/, '');
      const testFile = `${dirName}/test_${baseName}.py`;
      if (!foundFiles.includes(testFile)) {
        foundFiles.push(testFile);
      }
    } else if (isTs && !foundFiles.some(f => f.includes('test'))) {
      const parts = mainFile.split('/');
      const fileName = parts.pop()!;
      const dirName = parts.join('/');
      const baseName = fileName.replace(/\.(ts|js)$/, '');
      const testFile = `${dirName}/tests/${baseName}.test.ts`;
      if (!foundFiles.includes(testFile)) {
        foundFiles.push(testFile);
      }
    }
  }

  return foundFiles;
}

export async function intentAgentNode(state: typeof KaizenState.State): Promise<{ status: string; targetFiles: string[]; requestedLanguage: string; languageInfo: any }> {
  const { resolveLanguage, deriveTargetFile } = await import('../tools/languageResolver');
  const langRes = resolveLanguage(state.userInput, state.targetFiles);
  const requestedLanguage = langRes.requestedLanguage;
  const languageInfo = { requested: langRes.requestedLanguage, source: langRes.source, confidence: langRes.confidence };

  // Fast-track heuristic for File Deletion queries
  if (isDeleteQuery(state.userInput)) {
    return {
      status: 'ROUTED_DELETE_FILES',
      targetFiles: [],
      requestedLanguage,
      languageInfo
    };
  }

  // Fast-track heuristic for MCP Browser operations
  if (isBrowserQuery(state.userInput)) {
    return {
      status: 'ROUTED_MCP_BROWSER',
      targetFiles: [],
      requestedLanguage,
      languageInfo
    };
  }

  // Fast-track heuristic for MCP Git operations
  if (isGitQuery(state.userInput)) {
    return {
      status: 'ROUTED_MCP_GIT',
      targetFiles: [],
      requestedLanguage,
      languageInfo
    };
  }

  // Fast-track heuristic for MCP Terminal operations
  if (isTerminalQuery(state.userInput)) {
    return {
      status: 'ROUTED_MCP_TERMINAL',
      targetFiles: [],
      requestedLanguage,
      languageInfo
    };
  }

  // Fast-track heuristic for Memory Write operations BEFORE LLM/coding pipeline
  if (isMemoryWriteQuery(state.userInput)) {
    return {
      status: 'ROUTED_MEMORY_WRITE',
      targetFiles: [],
      requestedLanguage,
      languageInfo
    };
  }

  // Fast-track heuristic for Memory Read operations BEFORE LLM/coding pipeline
  if (isMemoryReadQuery(state.userInput)) {
    return {
      status: 'ROUTED_MEMORY_READ',
      targetFiles: [],
      requestedLanguage,
      languageInfo
    };
  }

  // Fast-track heuristic for ambiguous prompts -> route to general query for conversational clarification
  if (isAmbiguousQuery(state.userInput)) {
    return {
      status: 'ROUTED_GENERAL_QUERY',
      targetFiles: [],
      requestedLanguage,
      languageInfo
    };
  }

  // Fast-track heuristic for general greetings and general knowledge questions BEFORE LLM call
  if (isGeneralQuery(state.userInput)) {
    return {
      status: 'ROUTED_GENERAL_QUERY',
      targetFiles: [],
      requestedLanguage,
      languageInfo
    };
  }

  const promptExtracted = extractTargetFilesFromPrompt(state.userInput);
  const geminiApiKey = process.env.GEMINI_API_KEY;

  if (geminiApiKey && geminiApiKey !== 'your_gemini_api_key_here') {
    const geminiCandidates = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-3.5-flash-lite'];
    for (const modelName of geminiCandidates) {
      try {
        const model = new ChatGoogleGenerativeAI({
          apiKey: geminiApiKey,
          model: modelName,
          temperature: 0
        });

        const structuredModel = model.withStructuredOutput(IntentSchema);

        const systemPrompt = `You are an intent classification and target file selector agent. Respond in valid json format.
Analyze the user's prompt and classify their intent into one of:
- GENERAL_QUERY: General knowledge, greetings, chit-chat, or questions unrelated to code implementation or editing.
- GENERATE_CODE: Creating new features, boilerplate, or implementing requested functionality.
- DEBUG_ERROR: Fixing bugs, addressing runtime errors, broken builds, or troubleshooting code.
- EXPLAIN_CODE: Explaining how codebase code works, answering architecture/codebase questions.
- REFACTOR: Cleaning up code, optimizing performance, renaming, or restructuring existing code.
- RUN_EXISTING_TESTS: Executing existing test suite, identifying test failures.

For GENERAL_QUERY, targetFiles must be an empty array [].`;

        const startTime = Date.now();
        const invokePromise = structuredModel.invoke([
          { role: 'system', content: systemPrompt },
          { role: 'user', content: state.userInput }
        ]);
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error(`Gemini model '${modelName}' execution timed out after 6000ms`)), 6000);
        });

        const result = await Promise.race([invokePromise, timeoutPromise]);
        const latencyMs = Date.now() - startTime;

        await langfuseTracer.recordGeneration('IntentAgent', modelName, state.userInput, JSON.stringify(result), latencyMs, 60, 80);

        const intent = result.intent || 'GENERATE_CODE';
        if (intent === 'GENERAL_QUERY') {
          return { status: 'ROUTED_GENERAL_QUERY', targetFiles: [], requestedLanguage, languageInfo };
        }

        const rawFiles = result.targetFiles || result.target_files;
        let extractedFiles: string[] = [];
        if (promptExtracted.length > 0) {
          extractedFiles = [...promptExtracted];
          if (rawFiles && rawFiles.length > 0) {
            for (const rf of rawFiles as string[]) {
              if (!extractedFiles.includes(rf)) extractedFiles.push(rf);
            }
          }
        } else if (rawFiles && rawFiles.length > 0) {
          extractedFiles = rawFiles as string[];
        } else if (state.targetFiles && state.targetFiles.length > 0) {
          extractedFiles = state.targetFiles;
        } else {
          extractedFiles = [deriveTargetFile(state.userInput, langRes)];
        }

        extractedFiles = extractedFiles.map((f: string) => {
          if (!f.includes('/') && !f.includes('\\')) {
            return `src/sandbox/${f}`;
          }
          return f.replace(/\\/g, '/');
        });

        for (const pe of promptExtracted) {
          if (!extractedFiles.includes(pe)) extractedFiles.push(pe);
        }

        return {
          status: `ROUTED_${intent}`,
          targetFiles: Array.from(new Set<string>(extractedFiles)),
          requestedLanguage,
          languageInfo
        };
      } catch (error: any) {
        console.warn(`Gemini intent model '${modelName}' execution failed:`, error?.message || error);
      }
    }
  }



  const input = state.userInput.toLowerCase();
  let intent: z.infer<typeof IntentSchema>['intent'] = 'GENERATE_CODE';

  if (isGeneralQuery(state.userInput)) {
    return {
      status: 'ROUTED_GENERAL_QUERY',
      targetFiles: [],
      requestedLanguage,
      languageInfo
    };
  }

  if (input.includes('run the existing test') || input.includes('run existing test') || input.includes('test suite')) {
    intent = 'RUN_EXISTING_TESTS';
  } else if (input.includes('fix') || input.includes('bug') || input.includes('error') || input.includes('failing')) {
    intent = 'DEBUG_ERROR';
  } else if (input.includes('explain') || input.includes('how') || input.includes('inspect') || input.includes('analyze')) {
    intent = 'EXPLAIN_CODE';
  } else if (input.includes('refactor') || input.includes('clean')) {
    intent = 'REFACTOR';
  }

  let finalTargets: string[];
  if (promptExtracted.length > 0) {
    finalTargets = promptExtracted;
  } else if (state.targetFiles && state.targetFiles.length > 0) {
    finalTargets = state.targetFiles;
  } else {
    finalTargets = [deriveTargetFile(state.userInput, langRes)];
  }

  return {
    status: `ROUTED_${intent}`,
    targetFiles: Array.from(new Set<string>(finalTargets)),
    requestedLanguage,
    languageInfo
  };
}
