import { z } from 'zod';
import { ChatGroq } from '@langchain/groq';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import { KaizenState } from '../state';
import { langfuseTracer } from '../tools/langfuseTracer';

dotenv.config();

export const IntentSchema = z.object({
  intent: z.enum(['GENERATE_CODE', 'DEBUG_ERROR', 'EXPLAIN_CODE', 'REFACTOR', 'RUN_EXISTING_TESTS', 'GENERAL_QUERY', 'MCP_GIT', 'MCP_TERMINAL', 'DELETE_FILES'])
    .describe("The classified intent of the user request"),
  targetFiles: z.array(z.string()).optional()
    .describe("All target source file paths identified or implied for the task (e.g., ['src/sandbox/utils.ts', 'src/sandbox/main.ts'])"),
  target_files: z.array(z.string()).optional()
    .describe("All target source file paths identified or implied for the task"),
  gitActions: z.array(z.enum(['status', 'diff', 'commit', 'push', 'log'])).optional()
    .describe("Git operations requested (e.g. ['status', 'diff'])")
});

export function extractRawUserPrompt(input: string): string {
  if (input.includes('USER REQUEST:\n==============\n')) {
    return input.split('USER REQUEST:\n==============\n')[1].split('\n---\n')[0].trim();
  }
  if (input.includes('USER REQUEST:\n')) {
    return input.split('USER REQUEST:\n')[1].trim();
  }
  return input.trim();
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
  const rawPrompt = extractRawUserPrompt(input).toLowerCase();
  return /\b(terminal|command|exec|shell|rm|rm -rf|del|dir|ls|sudo|chmod|npm run|npm test|node -v|cat|pwd|mkdir|touch)\b/i.test(rawPrompt);
}

export function extractTerminalCommand(input: string): string {
  const raw = extractRawUserPrompt(input).trim();
  
  // 1. If quoted with `...`, "...", or '...', extract inside quote
  const matchQuote = raw.match(/[`'"]([^`'"]+)[`'"]/);
  if (matchQuote && matchQuote[1]) {
    return matchQuote[1].trim();
  }

  // 2. Check for explicit shell command syntax like rm -rf <path>, del <path>, npm <cmd>, git <cmd>, etc.
  const explicitCmdMatch = raw.match(/\b(rm\s+-[a-zA-Z]+\s+[^\s,;]+|rm\s+[^\s,;]+|del\s+[^\s,;]+|rmdir\s+[^\s,;]+|npm\s+[^\s,;]+|node\s+[^\s,;]+|dir\b|ls\b|cat\s+[^\s,;]+|pwd\b|mkdir\s+[^\s,;]+)\b/i);
  if (explicitCmdMatch) {
    return explicitCmdMatch[0].trim();
  }

  // 3. Match natural language deletion / command intent patterns:
  // e.g. "deletion of src/sandbox/fake_test_directory", "delete src/sandbox/fake_test_directory", "remove src/sandbox/fake_test_directory"
  const deletionMatch = raw.match(/\b(deletion|delete|remove|cleanup|rm)\s+(of\s+)?([^\s,;]+)/i);
  if (deletionMatch && deletionMatch[3]) {
    const targetPath = deletionMatch[3].trim();
    return `rm -rf ${targetPath}`;
  }

  // 4. Strip common conversational prefixes: "use terminal to run dir", "run command rm -rf src/temp", "execute dir"
  let clean = raw.replace(/^(please\s+)?(use|run|execute|test|simulate)(\s+the)?(\s+terminal|\s+shell|\s+cmd)?(\s+command)?(\s+to\s+run|\s+to\s+execute|\s+to|\s*:)?\s*/i, '');
  clean = clean.replace(/^(terminal|shell|cmd)\s+(exec|run|command)?\s*/i, '');

  // Strip trailing sentence junk (e.g. "for Permission Gate testing...", "Do not create...")
  clean = clean.split(/(\bfor\b|\bdo not\b|\bplease\b|\bto test\b|\bwith\b|\band\b)/i)[0].trim();
  
  return clean || raw;
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
    'terminal', 'command', 'shell', 'rm', 'del', 'sudo', 'chmod'
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

  // 3. Short prompts without any coding keywords (e.g., "who is nole?", "my name is carlitos")
  if (trimmed.length < 150) return true;

  return false;
}

export function isBrowserQuery(input: string): boolean {
  const rawPrompt = extractRawUserPrompt(input).toLowerCase().trim();

  // 1. Contains a URL or localhost port
  const hasUrl = /\b(https?:\/\/[^\s]+|localhost:\d+)\b/i.test(rawPrompt);

  // 2. Contains browser UI / inspection keywords
  const hasBrowserAction = /\b(open|inspect|navigate|visit|browse|login|page|screenshot|snapshot|view\s+page|check\s+page|ui)\b/i.test(rawPrompt);
  const hasBrowserKeyword = /\b(browser|playwright|chrome|chromium|page|webpage)\b/i.test(rawPrompt);

  if (hasUrl && (hasBrowserAction || hasBrowserKeyword)) {
    return true;
  }

  if (hasBrowserKeyword && (hasBrowserAction || /\b(open|navigate|visit|goto|inspect)\b/i.test(rawPrompt))) {
    return true;
  }

  if (/\b(open|inspect|navigate|goto)\s+https?:\/\/[^\s]+/i.test(rawPrompt)) {
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

  // Guard: Code element edits inside a file (e.g., "remove std::", "remove comments", "remove unused imports", "remove function", "remove line")
  const isCodeEdit = /\b(std::|std|comment|comments|import|imports|function|method|class|variable|line|code|prefix|namespace|log|print|unused)\b/i.test(rawPrompt);
  const isInsideFileRefactor = /\b(from|inside|in)\s+.*\b(file|files|code|class|cpp|ts|py|js)\b/i.test(rawPrompt);

  if (isCodeEdit && (isInsideFileRefactor || /\b(remove|delete)\s+(std|comment|comments|import|function|line|log|print|unused|prefix|namespace)\b/i.test(rawPrompt))) {
    return false;
  }

  // Explicit File / Directory Deletion intent (including "both files", "these files", "2 files")
  const explicitFileDelete = /\b(delete|delte|delt|deleate|remove|clear|wipe|erase|unlink|destroy)\s+(the\s+)?(both|these|those|two|selected|\d+\s+)?(file|files|folder|directory|sandbox|workspace|everything|all)\b/i;
  const explicitPathDelete = /\b(delete|remove|unlink|rm)\s+[a-zA-Z0-9_\-\/]+\.(cpp|py|ts|js|json|html|css|txt)\b/i;
  const deleteAllPattern = /\b(delete|remove|clear|wipe)\s+(both|all|everything)\b/i;

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
  const match = raw.match(/\b(https?:\/\/[^\s]+|localhost:\d+)\b/i);
  if (match) {
    let url = match[0];
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = `http://${url}`;
    }
    return url;
  }
  return 'http://localhost:3000';
}

export async function intentAgentNode(state: typeof KaizenState.State): Promise<{ status: string; targetFiles: string[] }> {
  // Fast-track heuristic for File Deletion queries
  if (isDeleteQuery(state.userInput)) {
    return {
      status: 'ROUTED_DELETE_FILES',
      targetFiles: []
    };
  }

  // Fast-track heuristic for MCP Browser operations
  if (isBrowserQuery(state.userInput)) {
    return {
      status: 'ROUTED_MCP_BROWSER',
      targetFiles: []
    };
  }

  // Fast-track heuristic for MCP Git operations
  if (isGitQuery(state.userInput)) {
    return {
      status: 'ROUTED_MCP_GIT',
      targetFiles: []
    };
  }

  // Fast-track heuristic for MCP Terminal operations
  if (isTerminalQuery(state.userInput)) {
    return {
      status: 'ROUTED_MCP_TERMINAL',
      targetFiles: []
    };
  }

  // Fast-track heuristic for ambiguous prompts -> route to general query for conversational clarification
  if (isAmbiguousQuery(state.userInput)) {
    return {
      status: 'ROUTED_GENERAL_QUERY',
      targetFiles: []
    };
  }

  // Fast-track heuristic for general greetings and general knowledge questions BEFORE LLM call
  if (isGeneralQuery(state.userInput)) {
    return {
      status: 'ROUTED_GENERAL_QUERY',
      targetFiles: []
    };
  }

  const apiKey = process.env.GROQ_API_KEY;

  if (apiKey && apiKey !== 'your_groq_api_key_here') {
    const modelCandidates = [
      'openai/gpt-oss-120b',
      'openai/gpt-oss-20b',
      'qwen/qwen3.8-27b',
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant'
    ];

    for (const modelName of modelCandidates) {
      try {
        const model = new ChatGroq({
          apiKey: apiKey,
          model: modelName,
          temperature: 0
        });

        const structuredModel = model.withStructuredOutput(IntentSchema, { method: 'jsonMode' });

        const systemPrompt = `You are an intent classification and target file selector agent. Respond in valid json format.
Analyze the user's prompt and classify their intent into one of:
- GENERAL_QUERY: General knowledge, greetings, chit-chat, or questions unrelated to code implementation or editing (e.g. "hello", "who is nole?", "who is roger federer?", "what is the capital of France?").
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
          setTimeout(() => reject(new Error(`ChatGroq model '${modelName}' execution timed out after 6000ms`)), 6000);
        });

        const result = await Promise.race([invokePromise, timeoutPromise]);
        const latencyMs = Date.now() - startTime;

        await langfuseTracer.recordGeneration(
          'IntentAgent',
          modelName,
          state.userInput,
          JSON.stringify(result),
          latencyMs,
          60,
          80
        );

        const intent = result.intent || 'GENERATE_CODE';
        if (intent === 'GENERAL_QUERY') {
          return {
            status: 'ROUTED_GENERAL_QUERY',
            targetFiles: []
          };
        }

        const rawFiles = result.targetFiles || result.target_files;
        let extractedFiles: string[] = (rawFiles && rawFiles.length > 0)
          ? (rawFiles as string[])
          : (state.targetFiles.length > 0 ? state.targetFiles : ['src/sandbox/main.ts']);

        extractedFiles = extractedFiles.map((f: string) => {
          if (!f.includes('/') && !f.includes('\\')) {
            return `src/sandbox/${f}`;
          }
          return f.replace(/\\/g, '/');
        });

        return {
          status: `ROUTED_${intent}`,
          targetFiles: Array.from(new Set<string>(extractedFiles))
        };
      } 
      catch (error: any) {
        console.warn(`ChatGroq intent model '${modelName}' execution failed:`, error?.message || error);
      }
    }
  }

  const input = state.userInput.toLowerCase();
  let intent: z.infer<typeof IntentSchema>['intent'] = 'GENERATE_CODE';

  if (isGeneralQuery(state.userInput)) {
    return {
      status: 'ROUTED_GENERAL_QUERY',
      targetFiles: []
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

  const detectedFiles: string[] = [];
  if (input.includes('utils.ts') || input.includes('utils')) {
    detectedFiles.push('src/sandbox/utils.ts');
  }
  if (input.includes('main.ts') || input.includes('main')) {
    detectedFiles.push('src/sandbox/main.ts');
  }

  let finalTargets: string[];
  if (detectedFiles.length > 0) {
    finalTargets = detectedFiles;
  } else if (state.targetFiles.length > 0) {
    finalTargets = state.targetFiles;
  } else {
    const slug = state.userInput
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
    const ext = detectRequestedLanguageExtension(state.userInput);
    finalTargets = [`src/sandbox/${slug}${ext}`];
  }

  return {
    status: `ROUTED_${intent}`,
    targetFiles: Array.from(new Set<string>(finalTargets))
  };
}