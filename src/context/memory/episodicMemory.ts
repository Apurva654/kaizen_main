import { EpisodicMemoryRecord, sanitizeSecretInfo } from './memoryTypes';
import { persistenceEngine } from '../../tools/persistenceEngine';

export class EpisodicMemoryManager {
  private episodes: Map<string, EpisodicMemoryRecord> = new Map();

  constructor() {
    this.loadFromPersistence();
  }

  public addEpisode(
    episodeData: {
      task: string;
      intent: string;
      affectedFiles: string[];
      actions: string[];
      errors: string[];
      solution: string;
      outcome: 'success' | 'failure' | 'partial';
      testsPassed: boolean;
      lessons: string[];
      workspaceId?: string;
      tags?: string[];
    }
  ): EpisodicMemoryRecord {
    const episodeId = `ep_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const sanitizedTask = sanitizeSecretInfo(episodeData.task);
    const sanitizedSolution = sanitizeSecretInfo(episodeData.solution);
    const sanitizedErrors = episodeData.errors.map(e => sanitizeSecretInfo(e));
    const sanitizedLessons = episodeData.lessons.map(l => sanitizeSecretInfo(l));

    const record: EpisodicMemoryRecord = {
      id: episodeId,
      episodeId,
      type: 'episodic',
      workspaceId: episodeData.workspaceId || 'default',
      timestamp: new Date().toISOString(),
      task: sanitizedTask,
      intent: episodeData.intent,
      affectedFiles: episodeData.affectedFiles.map(f => f.replace(/\\/g, '/')),
      actions: episodeData.actions,
      errors: sanitizedErrors,
      solution: sanitizedSolution,
      outcome: episodeData.outcome,
      testsPassed: episodeData.testsPassed,
      lessons: sanitizedLessons,
      importance: episodeData.outcome === 'success' ? 0.9 : 0.6,
      confidence: episodeData.testsPassed ? 1.0 : 0.8,
      tags: episodeData.tags || ['episode', episodeData.intent.toLowerCase(), episodeData.outcome]
    };

    this.episodes.set(episodeId, record);
    this.saveToPersistence();
    return record;
  }

  public getEpisode(episodeId: string): EpisodicMemoryRecord | null {
    return this.episodes.get(episodeId) || null;
  }

  public getAllEpisodes(workspaceId?: string): EpisodicMemoryRecord[] {
    const list = Array.from(this.episodes.values());
    if (!workspaceId || workspaceId === 'default' || workspaceId === 'global') return list;
    return list.filter(ep => ep.workspaceId === workspaceId || ep.workspaceId === 'global' || ep.workspaceId === 'default');
  }

  public searchEpisodes(query: string, workspaceId: string = 'default', limit: number = 5): EpisodicMemoryRecord[] {
    const cleanQuery = query.toLowerCase().replace(/[^a-z0-9_\-\.\/]/gi, ' ');
    const list = this.getAllEpisodes(workspaceId);

    const scored = list.map(ep => {
      let score = 0;
      if (ep.task.toLowerCase().includes(cleanQuery)) score += 5;
      if (ep.solution.toLowerCase().includes(cleanQuery)) score += 4;
      if (ep.errors.some(e => e.toLowerCase().includes(cleanQuery))) score += 3;
      if (ep.lessons.some(l => l.toLowerCase().includes(cleanQuery))) score += 2;
      if (ep.tags?.some(t => t.toLowerCase().includes(cleanQuery))) score += 2;
      return { ep, score };
    });

    return scored
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .map(item => item.ep)
      .slice(0, limit);
  }

  public findSimilarEpisodes(taskQuery: string, affectedFiles: string[] = [], workspaceId: string = 'default'): EpisodicMemoryRecord[] {
    const cleanQuery = taskQuery.toLowerCase().replace(/[^a-z0-9_\-\.\/]/gi, ' ');
    const stopWords = new Set(['what', 'which', 'that', 'this', 'with', 'from', 'have', 'does', 'were', 'been', 'your', 'when', 'where', 'how', 'about', 'they', 'them', 'their']);
    const terms = cleanQuery.split(/\s+/).filter(t => t.length >= 2 && !stopWords.has(t));
    const normalizedFiles = affectedFiles.map(f => f.replace(/\\/g, '/').toLowerCase());
    const list = this.getAllEpisodes(workspaceId);

    const scored = list.map(ep => {
      let score = 0;
      
      const epTaskLower = ep.task.toLowerCase();
      const epSolutionLower = ep.solution.toLowerCase();
      const epErrorsLower = ep.errors.map(e => e.toLowerCase()).join(' ');
      const epLessonsLower = ep.lessons.map(l => l.toLowerCase()).join(' ');
      const epActionsLower = ep.actions.map(a => a.toLowerCase()).join(' ');
      const epTagsLower = (ep.tags || []).map(t => t.toLowerCase()).join(' ');
      const epFilesLower = ep.affectedFiles.map(f => f.toLowerCase()).join(' ');

      for (const term of terms) {
        if (epTaskLower.includes(term)) score += 3;
        if (epSolutionLower.includes(term)) score += 3;
        if (epFilesLower.includes(term)) score += 4;
        if (epErrorsLower.includes(term)) score += 2;
        if (epLessonsLower.includes(term)) score += 2;
        if (epActionsLower.includes(term)) score += 2;
        if (epTagsLower.includes(term)) score += 2;
      }

      // Check for explicit episodic query indicators (previous, task, coding, experience, outcome, divide, self-healing, etc.)
      const isEpisodicQuery = /\b(previous|prior|past|task|experience|outcome|happened|solution|fixed|resolved|divide|self-healing|episode)\b/i.test(taskQuery);
      if (isEpisodicQuery && list.length > 0) {
        score += 1;
      }

      // File overlap match
      for (const file of normalizedFiles) {
        if (ep.affectedFiles.some(f => f.toLowerCase().includes(file) || file.includes(f.toLowerCase()))) {
          score += 5;
        }
      }

      if (ep.outcome === 'success') score += 1;
      if (ep.testsPassed) score += 1;

      return { ep, score };
    });

    return scored
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .map(item => item.ep);
  }


  public loadFromPersistence(): void {
    const data = persistenceEngine.readMemoryJson<EpisodicMemoryRecord[]>('episodic.json');
    if (data && Array.isArray(data)) {
      this.episodes.clear();
      for (const ep of data) {
        this.episodes.set(ep.episodeId || ep.id, ep);
      }
    }
  }

  public saveToPersistence(): void {
    const list = Array.from(this.episodes.values());
    persistenceEngine.writeMemoryJson('episodic.json', list);
  }

  public formatForPrompt(episodes: EpisodicMemoryRecord[]): string {
    if (episodes.length === 0) {
      return 'EPISODIC MEMORY: (No past experience episodes match current task context)';
    }

    const items = episodes.map(ep => {
      const errorStr = ep.errors.length > 0 ? `\n  - Error Encountered: ${ep.errors[0]}` : '';
      const lessonStr = ep.lessons.length > 0 ? `\n  - Lesson: ${ep.lessons.join('; ')}` : '';
      return `[EPISODE] ${ep.task} (Outcome: ${ep.outcome.toUpperCase()}, Tests Passed: ${ep.testsPassed})
  - Target Files: ${ep.affectedFiles.join(', ') || 'N/A'}${errorStr}
  - Applied Fix/Solution: ${ep.solution}${lessonStr}`;
    });

    return `
EPISODIC MEMORY (Past Tasks & Self-Healing Experiences):
==========================================================
${items.join('\n\n')}
`;
  }
}
