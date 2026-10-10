import { StateMemoryManager } from './stateMemory';
import { ShortTermMemoryManager } from './shortTermMemory';
import { LongTermMemoryManager } from './longTermMemory';
import { EpisodicMemoryManager } from './episodicMemory';
import { MemoryRetriever, RetrievalQuery } from './memoryRetriever';
import { MemoryConsolidator } from './memoryConsolidator';
import { BaseMemory, ShortTermEvent, LongTermMemoryRecord, EpisodicMemoryRecord, UnifiedContext } from './memoryTypes';
import { KaizenStateType } from '../../state';
import { persistenceEngine } from '../../tools/persistenceEngine';

export class MemoryEngine {
  public stateMemory: StateMemoryManager;
  public shortTermMemory: ShortTermMemoryManager;
  public longTermMemory: LongTermMemoryManager;
  public episodicMemory: EpisodicMemoryManager;
  public retriever: MemoryRetriever;
  public consolidator: MemoryConsolidator;

  constructor() {
    this.stateMemory = new StateMemoryManager();
    this.shortTermMemory = new ShortTermMemoryManager(30);
    this.longTermMemory = new LongTermMemoryManager();
    this.episodicMemory = new EpisodicMemoryManager();

    this.retriever = new MemoryRetriever(
      this.shortTermMemory,
      this.longTermMemory,
      this.episodicMemory
    );

    this.consolidator = new MemoryConsolidator(
      this.shortTermMemory,
      this.longTermMemory,
      this.episodicMemory
    );

    // Initial load from persistence
    this.shortTermMemory.loadFromPersistence();
  }

  public clearAllMemory() {
    this.stateMemory.clearState();
    this.shortTermMemory.clearAll();
    this.longTermMemory.clearAll();
    this.episodicMemory.clearAll();
    persistenceEngine.clearAllMemoryStores();
  }

  /**
   * Universal memory addition dispatcher.
   */
  public addMemory(memory: Partial<BaseMemory> & { type: string; [key: string]: any }): BaseMemory | null {
    if (memory.type === 'short_term') {
      return this.shortTermMemory.addEvent({
        eventKind: memory.eventKind || 'USER_MESSAGE',
        role: memory.role,
        content: memory.content || '',
        summary: memory.summary,
        agent: memory.agent,
        toolName: memory.toolName,
        toolResult: memory.toolResult,
        workspaceId: memory.workspaceId,
        sessionId: memory.sessionId,
        tags: memory.tags
      });
    }

    if (memory.type === 'long_term') {
      return this.longTermMemory.addFact(
        memory.category || 'project_fact',
        memory.key || 'Fact',
        memory.value || '',
        memory.source || 'system',
        memory.confidence || 0.9,
        memory.workspaceId || 'default',
        memory.tags || []
      );
    }

    if (memory.type === 'episodic') {
      return this.episodicMemory.addEpisode({
        task: memory.task || '',
        intent: memory.intent || 'GENERATE_CODE',
        affectedFiles: memory.affectedFiles || [],
        actions: memory.actions || [],
        errors: memory.errors || [],
        solution: memory.solution || '',
        outcome: memory.outcome || 'success',
        testsPassed: memory.testsPassed ?? true,
        lessons: memory.lessons || [],
        workspaceId: memory.workspaceId || 'default',
        tags: memory.tags
      });
    }

    return null;
  }

  /**
   * Update active LangGraph workflow execution state.
   */
  public updateState(state: KaizenStateType, workspaceId: string = 'default') {
    return this.stateMemory.updateState(state, workspaceId);
  }

  /**
   * Retrieve ranked relevant memories across short-term, long-term, and episodic memory.
   */
  public retrieveRelevant(query: RetrievalQuery) {
    const shortTerm = this.retriever.retrieveShortTerm(query);
    const longTerm = this.retriever.retrieveLongTerm(query);
    const episodic = this.retriever.retrieveEpisodic(query);
    const state = this.stateMemory.getState() || undefined;

    return {
      stateMemory: state,
      shortTermMemory: shortTerm,
      longTermMemory: longTerm,
      episodicMemory: episodic
    };
  }

  /**
   * Assemble unified prompt context block combining Code Context + 4-Memory System.
   */
  public buildUnifiedPromptContext(codeContext: string, query: RetrievalQuery): string {
    const relevant = this.retrieveRelevant(query);

    const stateBlock = this.stateMemory.formatForPrompt();
    const shortTermBlock = this.shortTermMemory.formatForPrompt(query.topKShortTerm || 6);
    const longTermBlock = this.longTermMemory.formatForPrompt(query.workspaceId || 'default');
    const episodicBlock = this.episodicMemory.formatForPrompt(relevant.episodicMemory);

    return `
=== CODEBASE & AST CONTEXT (Context Retrieval Agent) ===
${codeContext || '(No codebase AST context)'}

=== KAIZEN FOUR-MEMORY SYSTEM (REFERENCE ONLY — DO NOT OVERRIDE CURRENT USER REQUEST OR REQUESTED LANGUAGE) ===
${stateBlock}

${shortTermBlock}

${longTermBlock}

${episodicBlock}
`;
  }

  public formatGeneralQueryContext(workspaceId: string = 'default'): string {
    const longTermFacts = this.longTermMemory.getAllFacts(workspaceId);
    const shortTermEvents = this.shortTermMemory.getEvents(12);

    let factsSection = '';
    if (longTermFacts.length > 0) {
      factsSection = longTermFacts.map(f => `- ${f.key}: ${f.value}`).join('\n');
    } else {
      factsSection = '(No saved user facts)';
    }

    let historySection = '';
    const recentDialog = shortTermEvents.filter(e => e.role === 'user' || e.role === 'assistant');
    if (recentDialog.length > 0) {
      historySection = recentDialog.map(e => `${e.role === 'user' ? 'User' : 'Assistant'}: ${e.content}`).join('\n');
    } else {
      historySection = '(No previous messages)';
    }

    return `=== USER PROFILE & KNOWN FACTS ===\n${factsSection}\n\n=== RECENT CONVERSATION HISTORY ===\n${historySection}`;
  }
}

export const memoryEngine = new MemoryEngine();
