import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, relative, dirname, basename } from 'path';
import { execSync } from 'child_process';
import { MemoryEngine, memoryEngine } from './memory/memoryEngine';
import { LongTermCategory, ShortTermEvent, LongTermMemoryRecord, EpisodicMemoryRecord } from './memory/memoryTypes';
import { KaizenStateType } from '../state';

export interface FileTree {
  [key: string]: {
    type: 'file' | 'directory';
    size?: number;
    lastModified?: Date;
    lines?: number;
  };
}

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

export class ContextManager {
  private memoryEngine: MemoryEngine;
  private memoryEnabled: boolean = true;

  constructor(engine: MemoryEngine = memoryEngine) {
    this.memoryEngine = engine;
  }

  public getMemoryEngine(): MemoryEngine {
    return this.memoryEngine;
  }

  public toggleMemory(enable?: boolean): boolean {
    if (enable !== undefined) {
      this.memoryEnabled = enable;
    } else {
      this.memoryEnabled = !this.memoryEnabled;
    }
    return this.memoryEnabled;
  }

  public isMemoryEnabled(): boolean {
    return this.memoryEnabled;
  }

  /**
   * Detect project primary programming language.
   */
  public detectLanguage(): string {
    if (existsSync('package.json')) return 'JavaScript/TypeScript';
    if (existsSync('requirements.txt') || existsSync('pyproject.toml')) return 'Python';
    if (existsSync('go.mod')) return 'Go';
    if (existsSync('Cargo.toml')) return 'Rust';
    if (existsSync('pom.xml') || existsSync('build.gradle')) return 'Java';
    if (existsSync('CMakeLists.txt')) return 'C/C++';
    return 'unknown';
  }

  /**
   * Recursively build file structure tree up to given depth limit.
   */
  public async buildFileTree(dir: string, depth: number): Promise<FileTree> {
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
            tree[pathStr] = { type: 'directory', lastModified: stat.mtime };
            if (depth > 1) {
              const subTree = await this.buildFileTree(pathStr, depth - 1);
              Object.assign(tree, subTree);
            }
          } else {
            let lines = 0;
            try {
              lines = readFileSync(pathStr, 'utf-8').split('\n').length;
            } catch { }
            tree[pathStr] = { type: 'file', size: stat.size, lastModified: stat.mtime, lines };
          }
        } catch { }
      }
    } catch { }
    return tree;
  }

  /**
   * Automatically load current project context metadata.
   */
  public async loadProjectContext(): Promise<ProjectContext> {
    const projectRoot = process.cwd();
    let packageJson: any = null;
    if (existsSync('package.json')) {
      try {
        packageJson = JSON.parse(readFileSync('package.json', 'utf-8'));
      } catch { }
    }

    let gitLog: string[] = [];
    try {
      const gitOut = execSync('git log --oneline -n 5', { encoding: 'utf-8' });
      gitLog = gitOut.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    } catch { }

    let recentFiles: string[] = [];
    try {
      const gitOut = execSync('git log --name-only --pretty=format: -n 10', { encoding: 'utf-8' });
      recentFiles = Array.from(new Set(gitOut.split('\n').map(f => f.trim()).filter(f => f.length > 0))).slice(0, 10);
    } catch { }

    return {
      projectRoot,
      projectName: packageJson?.name || basename(projectRoot) || 'unknown-project',
      language: this.detectLanguage(),
      framework: packageJson?.dependencies ? Object.keys(packageJson.dependencies)[0] : undefined,
      filesStructure: await this.buildFileTree('src', 3),
      recentFiles,
      gitLog,
      lastModified: new Date()
    };
  }

  /**
   * Format project context object into prompt block string.
   */
  public formatContextForPrompt(context: ProjectContext): string {
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
`;
  }

  /**
   * Record conversation turn in Short-Term Memory and consolidate long term facts.
   */
  public recordConversationTurn(userText: string, assistantText: string, workspaceId: string = 'default'): void {
    if (!this.memoryEnabled) return;

    this.memoryEngine.shortTermMemory.addEvent({
      eventKind: 'USER_MESSAGE',
      role: 'user',
      content: userText,
      workspaceId
    });

    this.memoryEngine.shortTermMemory.addEvent({
      eventKind: 'ASSISTANT_RESPONSE',
      role: 'assistant',
      content: assistantText,
      workspaceId
    });

    // Run memory consolidation
    this.memoryEngine.consolidator.consolidateTurn(userText, assistantText, workspaceId);
  }

  /**
   * Record generic agent/tool/test event into Short-Term memory.
   */
  public recordEvent(
    eventKind: ShortTermEvent['eventKind'],
    content: string,
    agent?: string,
    toolName?: string,
    toolResult?: string,
    workspaceId: string = 'default'
  ): ShortTermEvent {
    return this.memoryEngine.shortTermMemory.addEvent({
      eventKind,
      content,
      agent,
      toolName,
      toolResult,
      workspaceId
    });
  }

  /**
   * Remember persistent fact or preference.
   */
  public remember(category: LongTermCategory, key: string, value: string, workspaceId: string = 'default'): LongTermMemoryRecord {
    return this.memoryEngine.longTermMemory.addFact(category, key, value, 'user_explicit', 0.95, workspaceId);
  }

  /**
   * Retrieve relevant memories for a prompt.
   */
  public retrieveRelevantMemories(prompt: string, workspaceId: string = 'default', targetFiles: string[] = []) {
    return this.memoryEngine.retrieveRelevant({
      prompt,
      workspaceId,
      targetFiles
    });
  }

  /**
   * Build complete enriched prompt context combining ProjectContext + Code Context + 4 Memory System.
   */
  public async buildEnrichedContext(rawPrompt: string, codeContext: string = '', workspaceId: string = 'default'): Promise<string> {
    const projectCtx = await this.loadProjectContext();
    const formattedProjectCtx = this.formatContextForPrompt(projectCtx);

    if (!this.memoryEnabled) {
      return `${formattedProjectCtx}\n\n=== CODEBASE CONTEXT ===\n${codeContext}`;
    }

    const memoryBlock = this.memoryEngine.buildUnifiedPromptContext(codeContext, {
      prompt: rawPrompt,
      workspaceId
    });

    return `${formattedProjectCtx}\n\n${memoryBlock}`;
  }
}

export const contextManager = new ContextManager();

export async function loadProjectContext(): Promise<ProjectContext> {
  return await contextManager.loadProjectContext();
}

export function formatContextForPrompt(context: ProjectContext): string {
  return contextManager.formatContextForPrompt(context);
}

export async function wrapPromptWithContext(userPrompt: string): Promise<string> {
  return await contextManager.buildEnrichedContext(userPrompt);
}

export function recordConversationTurn(userText: string, assistantText: string): void {
  contextManager.recordConversationTurn(userText, assistantText);
}

export function saveAgentState(state: any): void {
  if (state.userFacts) {
    for (const [k, v] of Object.entries(state.userFacts)) {
      memoryEngine.longTermMemory.addFact('user_preference', k, String(v), 'save_agent_state');
    }
  }
}

export function loadAgentState(): any {
  const facts: Record<string, string> = {};
  const longTermFacts = memoryEngine.longTermMemory.getAllFacts();
  for (const f of longTermFacts) {
    facts[f.key] = f.value;
  }

  const shortTermEvents = memoryEngine.shortTermMemory.getEvents(20);
  const history = shortTermEvents
    .filter(e => e.role === 'user' || e.role === 'assistant')
    .map(e => ({ role: e.role as 'user' | 'assistant', content: e.content }));

  return {
    conversationId: 'sess_default',
    currentTask: 'Active Task',
    completedSteps: [],
    generatedFiles: new Map(),
    errors: [],
    conversationHistory: history,
    userFacts: facts,
    status: 'IN PROGRESS',
    timestamp: new Date()
  };
}

export function formatStateForPrompt(state?: any): string {
  const stateBlock = memoryEngine.stateMemory.formatForPrompt();
  const shortTermBlock = memoryEngine.shortTermMemory.formatForPrompt(6);
  const longTermBlock = memoryEngine.longTermMemory.formatForPrompt();

  return `${stateBlock}\n${shortTermBlock}\n${longTermBlock}`;
}

export function toggleMemory(enable?: boolean): boolean {
  const status = contextManager.toggleMemory(enable);
  console.log(`🧠 Agent Memory Context: ${status ? 'ENABLED' : 'DISABLED'}`);
  return status;
}

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
    return formatStateForPrompt();
  }

  if (cmd === '@history') {
    try {
      const logs = execSync('git log --oneline -n 10', { encoding: 'utf-8' }).split('\n').filter(l => l.trim().length > 0);
      return `GIT HISTORY:\n` + (logs.length > 0 ? logs.join('\n') : '(No git commits)');
    } catch {
      return `GIT HISTORY:\n(No git commits)`;
    }
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

export async function preprocessUserRequest(rawPrompt: string): Promise<{ enhancedPrompt: string; workspaceContext: string; isCommand: boolean; commandResult?: string }> {
  const commandResult = await handleSpecialCommand(rawPrompt);
  if (commandResult !== null) {
    return {
      enhancedPrompt: rawPrompt,
      workspaceContext: '',
      isCommand: true,
      commandResult
    };
  }

  const workspaceContext = await contextManager.buildEnrichedContext(rawPrompt);

  return { enhancedPrompt: rawPrompt, workspaceContext, isCommand: false };
}

