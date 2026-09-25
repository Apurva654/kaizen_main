import { ShortTermEvent, LongTermMemoryRecord, EpisodicMemoryRecord } from './memoryTypes';
import { ShortTermMemoryManager } from './shortTermMemory';
import { LongTermMemoryManager } from './longTermMemory';
import { EpisodicMemoryManager } from './episodicMemory';

export interface RetrievalQuery {
  prompt: string;
  workspaceId?: string;
  targetFiles?: string[];
  topKShortTerm?: number;
  topKLongTerm?: number;
  topKEpisodic?: number;
}

export class MemoryRetriever {
  private shortTermMgr: ShortTermMemoryManager;
  private longTermMgr: LongTermMemoryManager;
  private episodicMgr: EpisodicMemoryManager;

  constructor(
    shortTermMgr: ShortTermMemoryManager,
    longTermMgr: LongTermMemoryManager,
    episodicMgr: EpisodicMemoryManager
  ) {
    this.shortTermMgr = shortTermMgr;
    this.longTermMgr = longTermMgr;
    this.episodicMgr = episodicMgr;
  }

  /**
   * Calculate relevance score for a string against query search terms.
   */
  private scoreTextMatch(text: string, queryTerms: string[]): number {
    if (!text || queryTerms.length === 0) return 0;
    const lowerText = text.toLowerCase();
    let hits = 0;
    for (const term of queryTerms) {
      if (lowerText.includes(term)) {
        hits++;
      }
    }
    return hits / queryTerms.length;
  }

  /**
   * Retrieve ranked top-K short term events relevant to prompt.
   */
  public retrieveShortTerm(query: RetrievalQuery): ShortTermEvent[] {
    const limit = query.topKShortTerm || 10;
    const allEvents = this.shortTermMgr.getEvents();
    if (allEvents.length === 0) return [];

    const terms = query.prompt.toLowerCase().split(/\s+/).filter(t => t.length > 2);
    if (terms.length === 0) {
      return allEvents.slice(-limit);
    }

    const scored = allEvents.map((event, index) => {
      const matchScore = this.scoreTextMatch(event.content, terms);
      const recencyScore = index / allEvents.length; // Normalized 0..1
      const importanceScore = event.importance || 0.5;

      const totalScore = (matchScore * 0.5) + (recencyScore * 0.3) + (importanceScore * 0.2);
      return { event, totalScore };
    });

    return scored
      .sort((a, b) => b.totalScore - a.totalScore)
      .slice(0, limit)
      .map(s => s.event);
  }

  /**
   * Retrieve ranked top-K long term facts relevant to prompt & workspace.
   */
  public retrieveLongTerm(query: RetrievalQuery): LongTermMemoryRecord[] {
    const limit = query.topKLongTerm || 5;
    const workspaceId = query.workspaceId || 'default';
    const facts = this.longTermMgr.getAllFacts(workspaceId);
    if (facts.length === 0) return [];

    const cleanQuery = query.prompt.toLowerCase().replace(/[^a-z0-9_\-\.\/]/gi, ' ');
    const stopWords = new Set(['what', 'which', 'that', 'this', 'with', 'from', 'have', 'does', 'were', 'been', 'your', 'when', 'where', 'how', 'about', 'they', 'them', 'their']);
    const terms = cleanQuery.split(/\s+/).filter(t => t.length > 2 && !stopWords.has(t));
    if (terms.length === 0) {
      return facts.slice(0, limit);
    }

    const scored = facts.map(fact => {
      const keyMatch = this.scoreTextMatch(fact.key, terms);
      const valMatch = this.scoreTextMatch(fact.value, terms);
      const categoryMatch = this.scoreTextMatch(fact.category, terms);
      const workspaceScore = (fact.workspaceId === workspaceId || fact.workspaceId === 'default' || workspaceId === 'default') ? 1.0 : 0.5;
      const confidence = fact.confidence || 0.8;

      const matchScore = Math.max(keyMatch * 1.5, valMatch, categoryMatch * 0.8);
      const totalScore = matchScore > 0 
        ? (matchScore * 0.6) + (workspaceScore * 0.2) + (confidence * 0.2)
        : (workspaceScore * 0.05) + (confidence * 0.05);

      return { fact, totalScore, matchScore };
    });

    return scored
      .filter(s => s.matchScore > 0 || (terms.length === 0 && s.totalScore > 0.1))
      .sort((a, b) => b.totalScore - a.totalScore)
      .slice(0, limit)
      .map(s => s.fact);
  }


  /**
   * Retrieve ranked top-K episodic memories relevant to task, prompt & target files.
   */
  public retrieveEpisodic(query: RetrievalQuery): EpisodicMemoryRecord[] {
    const limit = query.topKEpisodic || 3;
    const workspaceId = query.workspaceId || 'default';
    const targetFiles = query.targetFiles || [];

    const matches = this.episodicMgr.findSimilarEpisodes(query.prompt, targetFiles, workspaceId);
    return matches.slice(0, limit);
  }
}
