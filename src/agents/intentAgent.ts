import { z } from 'zod';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { KaizenState } from '../state';
import { langfuseTracer } from '../tools/langfuseTracer';
import { normalizeSandboxPath } from '../tools/sandboxPathUtils';

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

export function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Detects whether the input prompt contains concrete error evidence:
 * - JS/Python error class names (TypeError, ReferenceError, SyntaxError, RangeError, Traceback, Exception, AssertionError, NullPointerException)
 * - Stack-frame patterns (`at fn (file:line:col)`, `at file:line:col`, `file.ext:line`)
 * - TS\d{4} (TypeScript compiler error codes)
 * - ENOENT / MODULE_NOT_FOUND system error codes
 * - "failing test", "assertion", "exit code"
 */
export function hasErrorEvidence(prompt: string): boolean {
  if (!prompt || typeof prompt !== 'string') return false;
  const p = prompt;
  const hasErrorClass = /\b(TypeError|ReferenceError|SyntaxError|RangeError|URIError|AssertionError|Traceback|Exception|NullPointerException)\b/i.test(p);
  const hasStackFrame = /\bat\s+(?:[a-zA-Z0-9_$<>.]+\s+\()?[a-zA-Z0-9_\-\.\/\\:]+:\d+(?::\d+)?\)?/i.test(p) ||
                        /\b[a-zA-Z0-9_\-]+\.(?:ts|js|py|html|css|json|cpp|c|java):\d+\b/i.test(p);
  const hasTsCode = /\bTS\d{4}\b/i.test(p);
  const hasSysError = /\b(ENOENT|MODULE_NOT_FOUND|EACCES|ECONNREFUSED)\b/i.test(p);
  const hasTestFailure = /\b(failing\s+test|test\s+fail(ed|ures?)|assertions?|exit\s+code\s+\d+)\b/i.test(p);

  return hasErrorClass || hasStackFrame || hasTsCode || hasSysError || hasTestFailure;
}

/**
 * Detects whether the input prompt contains enhancement / upgrade / feature addition intent:
 * upgrade|enhance|improve|extend|overhaul|revamp|redesign|polish|rewrite|add (feature|support)|implement|build|make it better.
 */
export function hasEnhancementIntent(prompt: string): boolean {
  if (!prompt || typeof prompt !== 'string') return false;
  return /\b(upgrade|enhance|improve|extend|overhaul|revamp|redesign|polish|rewrite|add\s+(feature|support)|implement|build|make\s+it\s+better)\b/i.test(prompt);
}

function logReconciledIntent(from: string, to: string, reason: string) {
  console.log('[KAIZEN][INTENT] RECONCILED', JSON.stringify({ from, to, reason }));
}

/**
 * Reconciles the classified intent against concrete evidence and enhancement wording:
 * - DEBUG_ERROR or RUN_EXISTING_TESTS with !hasErrorEvidence && hasEnhancementIntent
 *   -> GENERATE_CODE (or REFACTOR if prompt says refactor/clean up/restructure and does not ask for new behaviour)
 * - DEBUG_ERROR with !hasErrorEvidence && no "fix|bug|broken|not working|crash" wording
 *   -> GENERATE_CODE
 */
export function reconcileIntent(intent: string, prompt: string): string {
  const p = prompt || '';
  const hasEvidence = hasErrorEvidence(p);
  const hasEnhance = hasEnhancementIntent(p);
  const isRefactorPrompt = /\b(refactor|clean\s+up|restructure|optimize|simplify|into\s+modules|reorganize)\b/i.test(p);
  const asksNewBehavior = /\b(add\s+(feature|support)|new\s+feature|build|implement|upgrade|extend)\b/i.test(p);

  if ((intent === 'DEBUG_ERROR' || intent === 'RUN_EXISTING_TESTS') && !hasEvidence && (hasEnhance || isRefactorPrompt)) {
    if (isRefactorPrompt && !asksNewBehavior) {
      logReconciledIntent(intent, 'REFACTOR', 'Refactor request without error evidence');
      return 'REFACTOR';
    }
    logReconciledIntent(intent, 'GENERATE_CODE', 'Enhancement wording present without error evidence');
    return 'GENERATE_CODE';
  }

  if (intent === 'DEBUG_ERROR' && !hasEvidence && !/\b(fix|bug|broken|not\s+working|crash)\b/i.test(p)) {
    if (isRefactorPrompt && !asksNewBehavior) {
      logReconciledIntent(intent, 'REFACTOR', 'Refactor request without error evidence');
      return 'REFACTOR';
    }
    logReconciledIntent(intent, 'GENERATE_CODE', 'DEBUG_ERROR without error evidence or fix/bug keywords');
    return 'GENERATE_CODE';
  }

  return intent;
}

export function isCommandInquiryOrExplanation(rawPrompt: string): boolean {
  const p = rawPrompt.toLowerCase().trim();

  // If asking to explain or describe a codebase source file, it's code explanation, NOT command inquiry
  if (/\b(src\/|[a-zA-Z0-9_\-\/]+\.(ts|js|py|cpp|c|java|html|css|json)|architecture|codebase|algorithm)\b/i.test(p)) {
    return false;
  }

  // Inquiry specifically about shell / git commands or asking for command suggestions
  const isCommandTarget = /\b(git|status|diff|commit|push|pull|log|branch|terminal|command|cmd|shell|pytest|pip|npm|node|npx|tsc|rm|del|dir|ls|cat|pwd|mkdir|docker|cargo)\b/i.test(p);

  return isCommandTarget && (
    /^(what\s+does|explain\s+(what\s+)?|how\s+does|how\s+to\s+use|tell\s+me\s+about|give\s+me\s+(a\s+)?command|suggest\s+(a\s+)?command|write\s+(a\s+)?command|show\s+me\s+(how\s+to|the\s+command)|help\s+with)\b/i.test(p) ||
    /\b(what\s+does\s+.*?\s+do|explanation\s+of|meaning\s+of|syntax\s+for|documentation\s+for|how\s+it\s+works)\b/i.test(p)
  );
}

export function isGitQuery(input: string): boolean {
  const rawPrompt = extractRawUserPrompt(input).toLowerCase().trim();
  if (!rawPrompt) return false;

  // Inquiry / explanation about git commands is NOT an execution request
  if (isCommandInquiryOrExplanation(rawPrompt)) {
    return false;
  }

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

  // Inquiry / explanation about terminal commands is NOT an execution request
  if (isCommandInquiryOrExplanation(lower)) {
    return false;
  }

  // Requests that ask to fix test failures or self-heal code should use the full test & debug graph, not raw terminal
  if (/\b(and\s+fix|fix\s+(any\s+)?(failures|errors|broken|failing|bugs))\b/i.test(lower)) {
    return false;
  }

  // If prompt explicitly requests creating, writing, implementing, modifying, editing, building, refactoring files or code, it's NOT a terminal command
  const isCodeCreationOrEditing = /^\s*(create|write|implement|add|modify|edit|build|refactor)\b.*?\b(file|function|class|script|module|component|code|python|typescript|ts|py|js)\b/i.test(lower) ||
    /^\s*(create|write|implement|add|modify|edit|build|refactor)\s+(a\s+)?(python|typescript|js|ts|py|file|code)\b/i.test(lower);

  if (isCodeCreationOrEditing && !/\b(run|execute)\s+(command|terminal|shell|script|pytest|npm|python)\b/i.test(lower)) {
    return false;
  }

  // 1. Explicit terminal execution phrasing: "run command pytest...", "use terminal to run...", "execute shell..."
  const hasTerminalPhrase = /\b(run\s+command|use\s+terminal|terminal\s+command|execute\s+shell|run\s+shell|terminal\s+exec|run\s+in\s+terminal|execute\s+in\s+terminal)\b/i.test(lower);
  if (hasTerminalPhrase) return true;

  // 2. Direct command invocation starting with executable command or having explicit command syntax
  const startsWithCommand = /^\s*(pytest|pip3?\s+|python3?\s+|npm\s+|node\s+|npx\s+|tsc\s+|git\s+|rm\s+|del\s+|dir\b|ls\b|cat\s+|pwd\b|mkdir\s+|docker\s+|cargo\s+|go\s+(run|build|test|get|mod|vet|fmt|version|install|clean|env|doc)\b|bun\s+|pnpm\s+|yarn\s+|conda\s+|poetry\s+|uv\s+|pipenv\s+|gem\s+|dotnet\s+|composer\s+)/i.test(lower);
  if (startsWithCommand) return true;

  // 3. Command inside backticks or quotes ONLY with explicit execution phrasing or standalone command
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

  // If asking for explanation or advice, do not extract a command to execute
  if (isCommandInquiryOrExplanation(raw.toLowerCase())) {
    return '';
  }
  
  // 1. If quoted with `...`, "...", or '...', extract inside quote ONLY IF preceded by execution verb or standalone command
  const matchQuote = raw.match(/[`'"]([^`'"]+)[`'"]/);
  if (matchQuote && matchQuote[1]) {
    const extracted = matchQuote[1].trim();
    const hasExecContext = /\b(run|execute|use\s+terminal\s+to\s+run|terminal\s+exec)\b/i.test(raw) ||
      /^\s*[`'"][a-zA-Z0-9_\-]+/i.test(raw);
    if (hasExecContext && !/^(execution|permission gate|command result|status|error)/i.test(extracted)) {
      const firstWord = extracted.split(/\s+/)[0].toLowerCase();
      const isGoCli = firstWord === 'go' && /^\s*go\s+(run|build|test|get|mod|vet|fmt|version|install|clean|env|doc)\b/i.test(extracted);
      const validCmdPrefixes = [
        'pytest', 'pip', 'pip3', 'python', 'python3', 'conda', 'poetry', 'uv', 'pipenv',
        'npm', 'node', 'npx', 'tsc', 'bun', 'pnpm', 'yarn',
        'git', 'rm', 'del', 'dir', 'ls', 'cat', 'pwd', 'mkdir', 'cp', 'mv', 'echo', 'touch',
        'docker', 'cargo', 'gem', 'dotnet', 'composer'
      ];
      if ((validCmdPrefixes.includes(firstWord) || isGoCli) || firstWord.endsWith('.exe') || firstWord.endsWith('.bat') || firstWord.endsWith('.cmd') || firstWord.startsWith('./') || firstWord.startsWith('.\\')) {
        return extracted;
      }
    }
  }

  // 2. Check for explicit shell command syntax like pytest, pip, python, rm, del, npm, node, dir, ls, etc.
  const explicitCmdMatch = raw.match(/\b(pytest\s+[^\s,;]+|pip3?\s+install\s+[^\s,;]+|pip3?\s+[^\s,;]+|python3?\s+-[a-zA-Z0-9_\-\s"'\/\.\\]+|rm\s+-[a-zA-Z]+\s+[^\s,;]+|rm\s+[^\s,;]+|del\s+[^\s,;]+|rmdir\s+[^\s,;]+|npm\s+[^\s,;]+|node\s+[^\s,;]+|dir\b|ls\b|cat\s+[^\s,;]+|pwd\b|mkdir\s+[^\s,;]+)\b/i);
  if (explicitCmdMatch) {
    return explicitCmdMatch[0].trim();
  }

  // 3. Strip common conversational prefixes: "use terminal to run dir", "run command rm -rf src/temp", "execute dir"
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
    'docker', 'cargo', 'gem', 'dotnet', 'composer'
  ];
  const firstWord = clean.split(/\s+/)[0].toLowerCase();
  const isGoCli = firstWord === 'go' && /^\s*go\s+(run|build|test|get|mod|vet|fmt|version|install|clean|env|doc)\b/i.test(clean);
  
  if ((validCmdPrefixes.includes(firstWord) || isGoCli) || firstWord.endsWith('.exe') || firstWord.endsWith('.bat') || firstWord.endsWith('.cmd') || firstWord.startsWith('./') || firstWord.startsWith('.\\')) {
    return clean;
  }
  
  return '';
}

export function isGeneralQuery(input: string): boolean {
  const rawPrompt = extractRawUserPrompt(input);
  const trimmed = rawPrompt.toLowerCase().trim();
  if (!trimmed) return true;

  // If asking what a git/terminal command does or asking for command guidance, it's a general/explain query
  if (isCommandInquiryOrExplanation(trimmed)) {
    return true;
  }

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

  // Conceptual questions about data structures / algorithms (e.g. "what is a binary search tree")
  // should be classified as GENERAL_QUERY even if they contain keywords
  const isConceptQuestion = /^(what\s+is|what\s+are|explain|how\s+does|overview\s+of)\s+(a\s+|an\s+|the\s+)?(binary\s+search\s+tree|bst|linked\s+list|stack|queue|hash\s*table|hash\s*map|graph|heap|trie|algorithm|recursion|sorting|quick\s*sort|merge\s*sort)\b/i.test(trimmed);
  if (isConceptQuestion && !/\b(in\s+my|in\s+our|in\s+workspace|in\s+sandbox|in\s+src|file|create|write|implement|code)\b/i.test(trimmed)) {
    return true;
  }

  const hasCodingKeyword = codingKeywords.some(kw => {
    const escaped = escapeRegExp(kw);
    const reg = new RegExp(`(^|\\W)${escaped}(\\W|$)`, 'i');
    return reg.test(trimmed);
  });

  if (hasCodingKeyword) return false;

  // 1. Direct short greetings or conversational phrases
  const greetingsRegex = /^(hello|hi|hey|greetings|good morning|good afternoon|good evening|howdy|yo|sup|ping|test)(\b|[!?. ]|$)/i;
  if (greetingsRegex.test(trimmed)) return true;

  // 2. Common general knowledge / conversational starters & identity questions
  const gkStartersRegex = /^(who is|whats|what is|where is|when did|why is|how is|tell me|explain who|explain what|do you know|is it|are you|can you tell|how far|how many|who was|what was|my name|whats my name|what is my name|who am i)/i;
  if (gkStartersRegex.test(trimmed)) return true;

  // 3. Person, celebrity, sports & entity query patterns
  const personEntityPatterns = [
    /\b(who is|who was|who are|tell me about|information on|news about|stats of|details of)\b/i,
    /\b(djokovic|nole|federer|nadal|alcaraz|sinner|messi|ronaldo|lebron|curry|kobe|jordan|mbappe|haaland|kohli|rohit|dhoni)\b/i,
    /\b(is|was|are|does|can|has|will)\s+.*?\s+(strong|good|great|fast|rich|famous|tall|old|young|active|retired|playing|the goat|goat|best|worst|winning|champion|match|player|athlete)\b/i,
    /\b(weather|temperature|forecast|sports\s+score|world\s+cup|olympics|grand\s+slam)\b/i,
    /\b(what\s+(is\s+the\s+)?(time|date)|what\s+time\s+is\s+it|what\s+day\s+is\s+it|current\s+time|today's\s+date)\b/i
  ];

  for (const pattern of personEntityPatterns) {
    if (pattern.test(trimmed)) {
      return true;
    }
  }

  return false;
}

export function isBrowserQuery(input: string): boolean {
  const rawPrompt = extractRawUserPrompt(input).toLowerCase().trim();
  if (!rawPrompt) return false;

  // Do NOT classify as code mutation if prompt contains explicit read-only / execution / non-mutation directives
  const isExplicitReadOnly = /\b(do\s+not\s+modify|don't\s+modify|read[\s-]*only|without\s+modifying|just\s+inspect|only\s+inspect|inspect\s+only)\b/i.test(rawPrompt);

  const buildVerbsRegex = /\b(build|create|implement|modify|edit|add|write|make|refactor|fix|update|upgrade|improve|extend|enhance|overhaul|revamp|polish|develop)\b/i;

  // A prompt containing the word "existing" together with a build verb is ALWAYS a code mutation, NEVER a read-only browser query
  const hasExistingWithBuildVerb = /\bexisting\b/i.test(rawPrompt) && buildVerbsRegex.test(rawPrompt);
  if (hasExistingWithBuildVerb) {
    return false;
  }

  // Check for explicit code creation, editing, debugging, or testing requests
  const hasCodeMutationOrFix = !isExplicitReadOnly && (
    /\b(fix|repair|resolve|patch|modify|edit|update|upgrade|improve|extend|enhance|overhaul|revamp|polish|implement|add|write|create|build|refactor|change)\b.*?\b(code|button|bug|error|issue|feature|component|file|page|script|style|css|html|function|app|ui|game|project)\b/i.test(rawPrompt) ||
    /\b(fix|repair|resolve|patch)\s+(the\s+)?(broken|failing|error|bug|issue|button)\b/i.test(rawPrompt) ||
    /^\s*(build|create|implement|modify|edit|add|write|make|refactor|fix|update|upgrade|improve|extend|enhance|overhaul|revamp|polish)\b/i.test(rawPrompt)
  );

  const hasTestRequest = !isExplicitReadOnly && /\b(run\s+test|run\s+tests|test\s+suite|run\s+npm\s+test|run\s+pytest)\b/i.test(rawPrompt);

  // If code editing/fixing or tests are requested, code generation/debugging must take precedence over read-only browser inspection
  if (hasCodeMutationOrFix || hasTestRequest) {
    return false;
  }

  const hasExplicitUrl = /\b(https?:\/\/[^\s]+|localhost:\d+[^\s]*)\b/i.test(rawPrompt);
  const hasBrowserToolCall = /\b(browser|playwright|chrome|chromium)\b/i.test(rawPrompt);

  // Explicit browser execution verbs
  const hasBrowserActionVerb = /\b(run|open|preview|launch|show|inspect|view|browse|navigate|visit|check)\b/i.test(rawPrompt);

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
  if (!rawPrompt) return true;

  // Single or double-word ultra-vague prompts with no target file or context:
  // e.g. "fix it", "fix this", "make it work", "help", "broken", "it's broken"
  const ultraVagueActionPatterns = [
    /^(fix|debug|repair)\s+(it|this|that)$/i,
    /^(make\s+it\s+work|do\s+it|help(\s+me)?|it('s|\s+is)\s+broken|broken|not\s+working)$/i
  ];
  if (ultraVagueActionPatterns.some(p => p.test(rawPrompt))) {
    return true;
  }

  const vaguePatterns = [
    /^(make|create|write|add|generate)\s+(\d+\s+)?(code\s+)?files?\s*(in\s+[a-zA-Z0-9+#]+)?$/i,
    /^(make|create|write)\s+(a\s+)?(code|program|file|script)\s*(in\s+[a-zA-Z0-9+#]+)?$/i,
    /^(make|create|write)\s+something\s*(in\s+[a-zA-Z0-9+#]+)?$/i
  ];

  return vaguePatterns.some(p => p.test(rawPrompt));
}

export function isDeleteQuery(input: string): boolean {
  const rawPrompt = extractRawUserPrompt(input).toLowerCase().trim();

  // Guard: Code element edits inside a file (e.g., "remove all comments", "remove unused imports", "remove function", "remove line", "refactor auth.ts", "delete unused import from intentAgent.ts")
  const isCodeElement = /\b(std::|std|comment|comments|import|imports|function|method|class|variable|line|lines|code|prefix|namespace|log|print|unused|statement|console\.log|block|tag|attribute)\b/i.test(rawPrompt);
  const isInsideFileDirective = /\b(from|inside|in|within|of)\s+([a-zA-Z0-9_\-\.\/]+\.(ts|js|py|cpp|c|java|html|css|json)|file|files|class|function)\b/i.test(rawPrompt);
  const isCodeDeletePhrase = /\b(delete|remove|clear|wipe)\s+(the\s+)?(all\s+)?(inline\s+)?(unused\s+)?(import|imports|function|method|class|variable|line|lines|code|comment|comments|log|print|prefix|namespace|statement|tag|console\.log)\b/i.test(rawPrompt);

  if (isCodeElement && (isInsideFileDirective || isCodeDeletePhrase || /\brefactor\b/i.test(rawPrompt))) {
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

  const FRAMEWORK_AND_LIB_NAMES = new Set([
    'three.js', 'express.js', 'node.js', 'vue.js', 'react.js', 'next.js',
    'chart.js', 'anime.js', 'd3.js', 'day.js', 'moment.js', 'socket.io',
    'require.js', 'highlight.js', 'lodash.js', 'axios.js', 'p5.js', 'math.js'
  ]);

  const pathRegex = /\b(src\/sandbox\/[a-zA-Z0-9_\-\/]+\.[a-zA-Z0-9]+|src\/[a-zA-Z0-9_\-\/]+\.[a-zA-Z0-9]+|[a-zA-Z0-9_\-]+\/[a-zA-Z0-9_\-\/]+\.[a-zA-Z0-9]+|[a-zA-Z0-9_\-]+\.(py|ts|js|jsx|tsx|json|html|css))\b/gi;
  let match: RegExpExecArray | null;
  while ((match = pathRegex.exec(rawPrompt)) !== null) {
    const rawMatch = match[0].trim();
    const baseName = path.basename(rawMatch).toLowerCase();
    if (FRAMEWORK_AND_LIB_NAMES.has(baseName)) {
      continue;
    }
    const norm = normalizeSandboxPath(rawMatch);
    if (norm && !foundFiles.includes(norm)) {
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
      const testFile = normalizeSandboxPath(`${dirName}/test_${baseName}.py`);
      if (testFile && !foundFiles.includes(testFile)) {
        foundFiles.push(testFile);
      }
    } else if (isTs && !foundFiles.some(f => f.includes('test'))) {
      const parts = mainFile.split('/');
      const fileName = parts.pop()!;
      const dirName = parts.join('/');
      const baseName = fileName.replace(/\.(ts|js)$/, '');
      const testFile = normalizeSandboxPath(`${dirName}/tests/${baseName}.test.ts`);
      if (testFile && !foundFiles.includes(testFile)) {
        foundFiles.push(testFile);
      }
    }
  }

  return Array.from(new Set(foundFiles.map(normalizeSandboxPath).filter(Boolean)));
}

export async function intentAgentNode(state: typeof KaizenState.State): Promise<{ status: string; targetFiles: string[]; requestedLanguage: string; languageInfo: any }> {
  const { resolveLanguage, deriveTargetFile } = await import('../tools/languageResolver');
  const langRes = resolveLanguage(state.userInput, state.targetFiles);
  const requestedLanguage = langRes.requestedLanguage;
  const languageInfo = { requested: langRes.requestedLanguage, source: langRes.source, confidence: langRes.confidence };

  // Fast-track heuristic for File Deletion queries
  if (isDeleteQuery(state.userInput)) {
    const extracted = extractTargetFilesFromPrompt(state.userInput);
    return {
      status: 'ROUTED_DELETE_FILES',
      targetFiles: extracted,
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
    const geminiCandidates = [
      'gemini-3.5-flash-lite',
      'gemini-3.8-flash',
      'gemini-3.1-pro-preview',
      'gemini-2.5-pro',
      'gemini-2.5-flash'
    ];
    for (const modelName of geminiCandidates) {
      try {
        const model = new ChatGoogleGenerativeAI({
          apiKey: geminiApiKey,
          model: modelName,
          temperature: 0
        });

        const structuredModel = model.withStructuredOutput(IntentSchema);

        const systemPrompt = `You are an intent classification and target file selector agent. Respond in valid json format.
Analyze the user's prompt and classify their primary intent into one of:
- GENERAL_QUERY: General knowledge, greetings, questions about programming concepts (e.g. "what is a binary search tree"), or questions unrelated to modifying codebase files.
- GENERATE_CODE: Creating new features, boilerplate, writing new files, implementing requested functionality, or requests to upgrade, enhance, improve, extend, overhaul, revamp, or polish existing code, even if the project already exists.
- DEBUG_ERROR: DEBUG_ERROR only when the user reports a concrete failure (error message, stack trace, failing test, or specific broken behaviour). Requests to upgrade, enhance, improve or extend existing code are GENERATE_CODE, even if the project already exists.
- EXPLAIN_CODE: Explaining how codebase code works, answering architecture/codebase questions, explaining commands.
- REFACTOR: Cleaning up code, optimizing performance, renaming, removing unused imports, or restructuring existing code without changing behavior.
- RUN_EXISTING_TESTS: Executing existing test suite, verifying test pass/fail status.
- MCP_GIT: Explicit version control operations (git status, git diff, git commit, git push, git log).
- MCP_TERMINAL: Explicit terminal command execution requests (running shell commands, npm, pytest, etc.).
- DELETE_FILES: Explicit workspace file or directory deletion requests.
- MEMORY_WRITE: Saving user preferences, project conventions, or facts into persistent memory.
- MEMORY_READ: Querying or recalling remembered preferences, conventions, or past facts.

Rules:
1. For GENERAL_QUERY, MCP_GIT, MCP_TERMINAL, DELETE_FILES, MEMORY_WRITE, and MEMORY_READ, targetFiles must be an empty array [].
2. If the user asks to explain a command (e.g. "what does git status do?"), classify as EXPLAIN_CODE or GENERAL_QUERY, NOT MCP_GIT.
3. If the user asks to delete code within a file (e.g. "delete unused imports"), classify as REFACTOR, NOT DELETE_FILES.
4. DEBUG_ERROR only when the user reports a concrete failure (error message, stack trace, failing test, or specific broken behaviour). Requests to upgrade, enhance, improve or extend existing code are GENERATE_CODE, even if the project already exists.
5. Only identify real target source files mentioned or implied; do not hallucinate arbitrary filenames.`;

        const startTime = Date.now();
        let timeoutId: NodeJS.Timeout | undefined;
        const invokePromise = structuredModel.invoke([
          { role: 'system', content: systemPrompt },
          { role: 'user', content: state.userInput }
        ]);
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error(`Gemini model '${modelName}' execution timed out after 7000ms`)), 7000);
        });

        let rawResult: any;
        try {
          rawResult = await Promise.race([invokePromise, timeoutPromise]);
        } finally {
          if (timeoutId) clearTimeout(timeoutId);
        }

        const latencyMs = Date.now() - startTime;

        // Telemetry failure must never fail classification
        langfuseTracer.recordGeneration('IntentAgent', modelName, state.userInput, JSON.stringify(rawResult), latencyMs)
          .catch((err: any) => console.warn('[Langfuse] IntentAgent trace recording failed:', err?.message || err));

        // Validate structured output against IntentSchema
        const parsed = IntentSchema.safeParse(rawResult);
        if (!parsed.success) {
          console.warn(`[IntentAgent] Gemini model '${modelName}' returned invalid schema:`, parsed.error.issues);
          continue; // Try next candidate model
        }

        const result = parsed.data;
        const intent = result.intent;

        if (intent === 'GENERAL_QUERY') {
          return { status: 'ROUTED_GENERAL_QUERY', targetFiles: [], requestedLanguage, languageInfo };
        }
        if (intent === 'MEMORY_WRITE') {
          return { status: 'ROUTED_MEMORY_WRITE', targetFiles: [], requestedLanguage, languageInfo };
        }
        if (intent === 'MEMORY_READ') {
          return { status: 'ROUTED_MEMORY_READ', targetFiles: [], requestedLanguage, languageInfo };
        }
        if (intent === 'MCP_GIT') {
          return { status: 'ROUTED_MCP_GIT', targetFiles: [], requestedLanguage, languageInfo };
        }
        if (intent === 'MCP_TERMINAL') {
          return { status: 'ROUTED_MCP_TERMINAL', targetFiles: [], requestedLanguage, languageInfo };
        }
        if (intent === 'DELETE_FILES') {
          return { status: 'ROUTED_DELETE_FILES', targetFiles: promptExtracted.map(normalizeSandboxPath).filter(Boolean), requestedLanguage, languageInfo };
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

        const normalizedFiles = Array.from(new Set<string>(
          extractedFiles.map(normalizeSandboxPath).filter(Boolean)
        ));

        const reconciled = reconcileIntent(intent, state.userInput);
        return {
          status: `ROUTED_${reconciled}`,
          targetFiles: normalizedFiles,
          requestedLanguage,
          languageInfo
        };
      } catch (error: any) {
        console.warn(`Gemini intent model '${modelName}' execution failed:`, error?.message || error);
      }
    }
  }

  // --- ROBUST HEURISTIC FALLBACK (Offline / Missing API Key / Timeout) ---
  const input = state.userInput.toLowerCase().trim();

  // 1. General query or inquiry about commands
  if (isGeneralQuery(state.userInput)) {
    return {
      status: 'ROUTED_GENERAL_QUERY',
      targetFiles: [],
      requestedLanguage,
      languageInfo
    };
  }

  // 2. Ambiguous query (e.g. "fix it", "make something in python")
  if (isAmbiguousQuery(state.userInput)) {
    return {
      status: 'ROUTED_GENERAL_QUERY',
      targetFiles: [],
      requestedLanguage,
      languageInfo
    };
  }

  // 3. Test execution requests (e.g. "run the test suite", "run npm test and fix failures")
  const isTestRequest = /\b(run|execute)\s+(the\s+)?(existing\s+)?(tests?|test\s+suite|unit\s+tests?|pytest|specs?)\b/i.test(input) ||
    /\b(run\s+tests?|run\s+npm\s+test|run\s+pytest)\b/i.test(input);

  // Feature upgrade / enhancement requests (must take precedence over partial "fix" words inside feature descriptions)
  const isFeatureUpgrade = /^\s*(upgrade|improve|extend|enhance|overhaul|revamp|polish|build|create|add|implement)\b/i.test(input) ||
    /\b(upgrade|improve|extend|enhance|overhaul|revamp|polish)\s+(the\s+)?(existing\s+)?/i.test(input) ||
    hasEnhancementIntent(input);

  // 4. Debug / Bug fix requests (with negation guard and explicit error diagnostics)
  const isNegatedFix = /\b(do\s+not|don't|without)\s+(fix|debug|repair)\b/i.test(input);
  const isExplicitErrorDiagnostic = hasErrorEvidence(input);
  const isBugFix = !isNegatedFix && !isFeatureUpgrade && (
    isExplicitErrorDiagnostic ||
    (/\b(fix|debug|repair|solve|resolve|patch)\b.*?\b(bug|error|crash|exception|failing|broken)\b.*?\b([a-zA-Z0-9_\-\/]+\.(ts|js|py|html|css|json|cpp|c|java))\b/i.test(input)) ||
    (/\b(fix|debug|repair|solve|resolve|patch)\s+(the\s+)?(bug|error|crash|exception|failing)\b/i.test(input) &&
      (/\b([a-zA-Z0-9_\-\/]+\.(ts|js|py|html|css|json|cpp|c|java))\b/i.test(input) || isExplicitErrorDiagnostic)
    )
  );

  // 5. Code explanation requests
  const isExplain = /\b(explain|how\s+does|walk\s+through|overview\s+of|describe|what\s+does)\b/i.test(input);

  // 6. Refactor requests
  const isRefactor = /\b(refactor|clean\s+up|optimize|restructure|reorganize|into\s+modules|simplify|rename|remove\s+unused)\b/i.test(input);

  // 7. Explicit code creation/generation requests
  const isCodeGen = isFeatureUpgrade ||
    hasEnhancementIntent(input) ||
    /\b(create|make|write|implement|build|add|generate|develop|scaffold|code|upgrade|improve|extend|enhance|overhaul|revamp|redesign|polish|rewrite)\b.*?\b(file|function|class|script|module|component|code|calculator|app|service|endpoint|api|game|project|ui|page|feature|form|minimap|physics|system|backend|frontend)\b/i.test(input) ||
    /^\s*(create|make|write|implement|build|add|generate|develop|scaffold|upgrade|improve|extend|enhance|overhaul|revamp|redesign|polish|rewrite|update)\b/i.test(input) ||
    promptExtracted.length > 0;

  let fallbackIntent: z.infer<typeof IntentSchema>['intent'] = 'GENERATE_CODE';

  if (isTestRequest) {
    fallbackIntent = 'RUN_EXISTING_TESTS';
  } else if (isBugFix) {
    fallbackIntent = 'DEBUG_ERROR';
  } else if (isExplain) {
    fallbackIntent = 'EXPLAIN_CODE';
  } else if (isRefactor) {
    fallbackIntent = 'REFACTOR';
  } else if (isCodeGen) {
    fallbackIntent = 'GENERATE_CODE';
  } else {
    // Unfamiliar, unsupported, or non-coding prompt: DO NOT default to GENERATE_CODE!
    // Safely route to GENERAL_QUERY for conversational clarification.
    return {
      status: 'ROUTED_GENERAL_QUERY',
      targetFiles: [],
      requestedLanguage,
      languageInfo
    };
  }

  const finalReconciled = reconcileIntent(fallbackIntent, state.userInput);

  let finalTargets: string[];
  if (promptExtracted.length > 0) {
    finalTargets = promptExtracted;
  } else if (state.targetFiles && state.targetFiles.length > 0) {
    finalTargets = state.targetFiles;
  } else {
    finalTargets = [deriveTargetFile(state.userInput, langRes)];
  }

  const normalizedFinalTargets = Array.from(new Set<string>(
    finalTargets.map(normalizeSandboxPath).filter(Boolean)
  ));

  return {
    status: `ROUTED_${finalReconciled}`,
    targetFiles: normalizedFinalTargets,
    requestedLanguage,
    languageInfo
  };
}
