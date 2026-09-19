import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, relative, dirname, basename } from 'path';
import { execSync } from 'child_process';

/**
 * File tree metadata node representation
 */
export interface FileTree {
  [key: string]: {
    type: 'file' | 'directory';
    size?: number;
    lastModified?: Date;
    lines?: number;
  };
}

/**
 * Project context metadata model
 */
export interface ProjectContext {
  projectRoot: string;
  projectName: string;
  language: string;
  framework?: string;
  filesStructure: FileTree;
  recentFiles: string[];
  gitLog: string[];
  lastModified: Date;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Agent state persisted between requests
 */
export interface AgentState {
  conversationId: string;
  currentTask: string;
  completedSteps: string[];
  generatedFiles: Map<string, string>;
  errors: string[];
  conversationHistory?: ChatMessage[];
  userFacts?: Record<string, string>;
  timestamp: Date;
}

let memoryEnabled = true;
const stateFile = resolve('dist/agent-state.json');

/**
 * Detect project primary programming language from project root manifests.
 */
function detectLanguage(): string {
  if (existsSync('package.json')) return 'JavaScript/TypeScript';
  if (existsSync('requirements.txt') || existsSync('pyproject.toml')) return 'Python';
  if (existsSync('go.mod')) return 'Go';
  if (existsSync('Cargo.toml')) return 'Rust';
  if (existsSync('pom.xml') || existsSync('build.gradle')) return 'Java';
  if (existsSync('composer.json')) return 'PHP';
  if (existsSync('CMakeLists.txt')) return 'C/C++';
  return 'unknown';
}

/**
 * Count total number of lines in a text file.
 */
function countLines(filePath: string): number {
  try {
    const content = readFileSync(filePath, 'utf-8');
    return content.split('\n').length;
  } catch {
    return 0;
  }
}

/**
 * Recursively build file structure tree up to given depth limit.
 * 
 * @param dir - Relative directory path to scan
 * @param depth - Maximum recursion depth
 */
async function buildFileTree(dir: string, depth: number): Promise<FileTree> {
  if (depth === 0 || !existsSync(dir)) return {};
  
  const tree: FileTree = {};
  try {
    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'coverage') {
        continue;
      }

      const pathStr = `${dir}/${entry.name}`;
      try {
        const stat = statSync(pathStr);

        if (entry.isDirectory()) {
          tree[pathStr] = {
            type: 'directory',
            lastModified: stat.mtime,
          };
          if (depth > 1) {
            const subTree = await buildFileTree(pathStr, depth - 1);
            Object.assign(tree, subTree);
          }
        } else {
          tree[pathStr] = {
            type: 'file',
            size: stat.size,
            lastModified: stat.mtime,
            lines: countLines(pathStr),
          };
        }
      } catch {
        // Skip unreadable files/links
      }
    }
  } catch {
    // Return empty object on read directory error
  }

  return tree;
}

/**
 * Retrieve list of recently modified git files.
 */
function getRecentFiles(limit: number): string[] {
  try {
    const output = execSync(`git log --name-only --pretty=format: -n ${limit}`, { encoding: 'utf-8' });
    const files = output.split('\n').map(f => f.trim()).filter(f => f.length > 0);
    return Array.from(new Set(files)).slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * Retrieve list of recent git commit messages.
 */
function getGitLog(limit: number): string[] {
  try {
    const output = execSync(`git log --oneline -n ${limit}`, { encoding: 'utf-8' });
    return output.split('\n').map(f => f.trim()).filter(f => f.length > 0);
  } catch {
    return [];
  }
}

/**
 * Automatically load current project context metadata.
 */
export async function loadProjectContext(): Promise<ProjectContext> {
  console.log('📚 Loading project context...');

  const projectRoot = process.cwd();
  let packageJson: any = null;
  if (existsSync('package.json')) {
    try {
      packageJson = JSON.parse(readFileSync('package.json', 'utf-8'));
    } catch {
      packageJson = null;
    }
  }

  const context: ProjectContext = {
    projectRoot,
    projectName: packageJson?.name || basename(projectRoot) || 'unknown-project',
    language: detectLanguage(),
    framework: packageJson?.dependencies ? Object.keys(packageJson.dependencies)[0] : undefined,
    filesStructure: await buildFileTree('src', 3),
    recentFiles: getRecentFiles(10),
    gitLog: getGitLog(5),
    lastModified: new Date(),
  };

  console.log(`✓ Project context loaded: ${context.projectName} (${context.language})`);
  return context;
}

/**
 * Format project context object into human-readable prompt string block.
 */
export function formatContextForPrompt(context: ProjectContext): string {
  const fileEntries = Object.entries(context.filesStructure)
    .filter(([, meta]) => meta.type === 'file' && meta.lines !== undefined && meta.lines > 0)
    .slice(0, 10);

  return `
PROJECT CONTEXT:
================
Project: ${context.projectName}
Language: ${context.language}
Framework: ${context.framework || 'N/A'}
Root: ${context.projectRoot}

RECENT CHANGES:
===============
${context.gitLog.length > 0 ? context.gitLog.map(line => '  ' + line).join('\n') : '  (No git history available)'}

KEY SOURCE FILES:
=================
${fileEntries.length > 0 ? fileEntries.map(([pathStr, meta]) => `  ${pathStr} (${meta.lines} lines, ${meta.size} bytes)`).join('\n') : '  (No source files found)'}

RECENT MODIFICATIONS:
=====================
${context.recentFiles.length > 0 ? context.recentFiles.slice(0, 10).map(f => '  ' + f).join('\n') : '  (No recent modifications)'}
`;
}

/**
 * Wrap raw prompt with project context and instructions.
 */
export async function wrapPromptWithContext(userPrompt: string): Promise<string> {
  const context = await loadProjectContext();
  const contextStr = formatContextForPrompt(context);

  return `
${contextStr}

---

USER REQUEST:
==============
${userPrompt}

---

INSTRUCTIONS:
- You are working on the project described above
- All file paths are relative to the project root
- Refer to recent git commits for context
- Use the file structure to understand project layout
- If generating code, match the project's language/framework
`;
}

/**
 * List all tracked project files grouped by directory for @files command.
 */
export async function listAllProjectFiles(): Promise<string> {
  try {
    const gitFiles = execSync('git ls-files', { encoding: 'utf-8' })
      .split('\n')
      .map(f => f.trim())
      .filter(f => f.length > 0);
    
    if (gitFiles.length === 0) {
      return '📁 PROJECT FILES:\n\n(No tracked files found)';
    }

    const grouped: Record<string, string[]> = {};
    gitFiles.forEach(file => {
      const dir = dirname(file) || 'root';
      if (!grouped[dir]) grouped[dir] = [];
      grouped[dir].push(file);
    });

    let output = '📁 PROJECT FILES:\n\n';
    Object.entries(grouped).forEach(([dir, files]) => {
      output += `${dir}\n`;
      files.forEach(file => {
        output += `  ├─ ${basename(file)}\n`;
      });
      output += '\n';
    });

    return output;
  } catch (error: any) {
    return '❌ Error listing files: ' + (error?.message || String(error));
  }
}

/**
 * Save current agent state to persistent storage.
 */
export function saveAgentState(state: AgentState): void {
  try {
    const dir = dirname(stateFile);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const serializableState = {
      ...state,
      generatedFiles: Array.from(state.generatedFiles.entries()),
      timestamp: state.timestamp.toISOString()
    };

    writeFileSync(stateFile, JSON.stringify(serializableState, null, 2), 'utf-8');
    console.log('✓ Agent state saved');
  } catch (error: any) {
    console.error('❌ Failed to save agent state:', error?.message);
  }
}

/**
 * Load agent state from persistent storage if available.
 */
export function loadAgentState(): AgentState | null {
  try {
    if (!existsSync(stateFile)) return null;
    const content = readFileSync(stateFile, 'utf-8');
    const raw = JSON.parse(content);
    return {
      conversationId: raw.conversationId,
      currentTask: raw.currentTask,
      completedSteps: raw.completedSteps || [],
      generatedFiles: new Map(raw.generatedFiles || []),
      errors: raw.errors || [],
      conversationHistory: raw.conversationHistory || [],
      userFacts: raw.userFacts || {},
      timestamp: new Date(raw.timestamp)
    };
  } catch {
    return null;
  }
}

/**
 * Record a single conversation turn (user prompt + assistant response) and extract user facts.
 */
export function recordConversationTurn(userText: string, assistantText: string): void {
  const state = loadAgentState() || {
    conversationId: `conv_${Date.now()}`,
    currentTask: userText,
    completedSteps: [],
    generatedFiles: new Map<string, string>(),
    errors: [],
    conversationHistory: [] as ChatMessage[],
    userFacts: {} as Record<string, string>,
    timestamp: new Date()
  };

  const history: ChatMessage[] = state.conversationHistory || [];
  const facts: Record<string, string> = state.userFacts || {};

  // Fact extraction rule: "my name is X", "my name X", "i am X", "i'm X", "call me X"
  const nameMatch = userText.match(/(?:my name is|my name|i am|i'm|call me|name:)\s+([a-zA-Z0-9_-]+)/i);
  if (nameMatch && nameMatch[1]) {
    const rawName = nameMatch[1].trim();
    // Exclude common non-name words
    const stopWords = ['is', 'a', 'the', 'an', 'not', 'here', 'testing', 'going'];
    if (!stopWords.includes(rawName.toLowerCase())) {
      facts['Name'] = rawName.charAt(0).toUpperCase() + rawName.slice(1);
    }
  }

  // Push turn to history
  history.push({ role: 'user', content: userText });
  history.push({ role: 'assistant', content: assistantText });

  // Keep last 20 messages
  state.conversationHistory = history.length > 20 ? history.slice(-20) : history;
  state.userFacts = facts;
  state.timestamp = new Date();

  saveAgentState(state);
}

/**
 * Format agent state object into prompt block string.
 */
export function formatStateForPrompt(state: AgentState): string {
  let factsStr = '';
  if (state.userFacts && Object.keys(state.userFacts).length > 0) {
    factsStr = `
USER PROFILE & KNOWN FACTS:
===========================
${Object.entries(state.userFacts).map(([k, v]) => `  - ${k}: ${v}`).join('\n')}
`;
  }

  let historyStr = '';
  if (state.conversationHistory && state.conversationHistory.length > 0) {
    const recentTurns = state.conversationHistory.slice(-6);
    historyStr = `
RECENT CONVERSATION HISTORY:
============================
${recentTurns.map(msg => `  ${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content.substring(0, 150)}`).join('\n')}
`;
  }

  return `
AGENT STATE (from previous request):
====================================
Task: ${state.currentTask}
Steps Completed: ${state.completedSteps.length}
${state.completedSteps.length > 0 ? state.completedSteps.map(s => '  ✓ ' + s).join('\n') : '  (None)'}

Generated Files: ${state.generatedFiles.size}
${state.generatedFiles.size > 0 ? Array.from(state.generatedFiles.keys()).map(f => '  ✓ ' + f).join('\n') : '  (None)'}

Errors Encountered: ${state.errors.length}
${state.errors.length > 0 ? state.errors.map(e => '  ✗ ' + e).join('\n') : '  (None)'}
${factsStr}${historyStr}
Current Status: IN PROGRESS
`;
}

/**
 * Toggle agent memory context persistence on or off.
 */
export function toggleMemory(enable?: boolean): boolean {
  if (enable !== undefined) {
    memoryEnabled = enable;
  } else {
    memoryEnabled = !memoryEnabled;
  }
  console.log(`🧠 Agent Memory Context: ${memoryEnabled ? 'ENABLED' : 'DISABLED'}`);
  return memoryEnabled;
}

/**
 * Handle special user commands (@context, @files, @state, @history, @memory).
 */
export async function handleContextCommand(command: string): Promise<string> {
  const cmd = command.toLowerCase().trim();

  if (cmd === '@context') {
    const context = await loadProjectContext();
    return formatContextForPrompt(context);
  }

  if (cmd === '@files') {
    return await listAllProjectFiles();
  }

  if (cmd === '@state') {
    const state = loadAgentState();
    return state ? formatStateForPrompt(state) : 'No previous state';
  }

  if (cmd === '@history') {
    const logs = getGitLog(10);
    return `GIT HISTORY:\n` + (logs.length > 0 ? logs.join('\n') : '(No git commits)');
  }

  if (cmd === '@memory') {
    const status = toggleMemory();
    return `Memory toggled: ${status ? 'ENABLED' : 'DISABLED'}`;
  }

  return 'Unknown command. Use: @context, @files, @state, @history, @memory';
}

export async function handleSpecialCommand(command: string): Promise<string | null> {
  if (!command.trim().startsWith('@')) return null;
  return await handleContextCommand(command);
}

/**
 * Preprocess user prompt with auto-loaded project context and persisted agent state.
 */
export async function preprocessUserRequest(rawPrompt: string): Promise<{ enhancedPrompt: string; isCommand: boolean; commandResult?: string }> {
  // Check if prompt is a special command
  const commandResult = await handleSpecialCommand(rawPrompt);
  if (commandResult !== null) {
    return {
      enhancedPrompt: rawPrompt,
      isCommand: true,
      commandResult
    };
  }

  // 1. Load project context
  const projectContext = await loadProjectContext();
  
  // 2. Load agent state
  const agentState = memoryEnabled ? loadAgentState() : null;
  
  // 3. Build enhanced prompt
  let enhancedPrompt = formatContextForPrompt(projectContext);
  
  if (agentState) {
    enhancedPrompt += '\n\n' + formatStateForPrompt(agentState);
  }
  
  enhancedPrompt += '\n\nUSER REQUEST:\n' + rawPrompt;

  return { enhancedPrompt, isCommand: false };
}

// Self-run verification when executed directly via Node / ts-node
if (require.main === module || (process.argv[1] && process.argv[1].endsWith('context-manager.ts'))) {
  (async () => {
    const ctx = await loadProjectContext();
    console.log(formatContextForPrompt(ctx));
  })();
}
