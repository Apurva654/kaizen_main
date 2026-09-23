import { LongTermMemoryManager } from './longTermMemory';
import { EpisodicMemoryManager } from './episodicMemory';
import { ShortTermMemoryManager } from './shortTermMemory';
import { LongTermCategory } from './memoryTypes';

export class MemoryConsolidator {
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
   * Consolidate user conversation turn: extract explicit preferences/facts into Long-Term memory.
   */
  public consolidateTurn(userPrompt: string, assistantResponse: string, workspaceId: string = 'default'): void {
    // 1. Check for explicit name/user preference statements
    const nameMatch = userPrompt.match(/(?:my name is|my name|i am|i'm|call me|name:)\s+([a-zA-Z0-9_-]+)/i);
    if (nameMatch && nameMatch[1]) {
      const rawName = nameMatch[1].trim();
      const stopWords = ['is', 'a', 'the', 'an', 'not', 'here', 'testing', 'going', 'building'];
      if (!stopWords.includes(rawName.toLowerCase())) {
        const nameVal = rawName.charAt(0).toUpperCase() + rawName.slice(1);
        this.longTermMgr.addFact('user_preference', 'User Name', nameVal, 'explicit_user_input', 0.95, workspaceId, ['user', 'name']);
      }
    }

    // 2. Check for explicit framework / language preferences
    const frameworkMatch = userPrompt.match(/(?:we use|our framework is|always use|prefer)\s+(react|vue|angular|express|fastapi|django|nextjs|nest|tailwind|typescript)/i);
    if (frameworkMatch && frameworkMatch[1]) {
      const fw = frameworkMatch[1].trim().toLowerCase();
      this.longTermMgr.addFact('framework_preference' as LongTermCategory, 'Preferred Framework', fw, 'explicit_user_input', 0.9, workspaceId, ['framework', 'convention']);
    }

    // 3. Check for explicit coding conventions
    if (userPrompt.toLowerCase().includes('strict mode') || userPrompt.toLowerCase().includes('use typescript strict')) {
      this.longTermMgr.addFact('coding_convention', 'TypeScript Strict Mode', 'Enabled', 'explicit_instruction', 0.95, workspaceId, ['typescript', 'strict']);
    }
  }

  /**
   * Consolidate a completed or debugged task into Episodic Experience memory.
   */
  public consolidateTaskOutcome(
    taskData: {
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
    }
  ): void {
    // Save episode if task resulted in clean solution or useful debugging experience
    if (taskData.solution && taskData.solution.length > 5) {
      this.episodicMgr.addEpisode({
        task: taskData.task,
        intent: taskData.intent,
        affectedFiles: taskData.affectedFiles,
        actions: taskData.actions,
        errors: taskData.errors,
        solution: taskData.solution,
        outcome: taskData.outcome,
        testsPassed: taskData.testsPassed,
        lessons: taskData.lessons,
        workspaceId: taskData.workspaceId || 'default',
        tags: ['consolidated_task', taskData.outcome]
      });

      // Log event into ShortTerm memory
      this.shortTermMgr.addEvent({
        eventKind: 'AGENT_COMPLETED',
        role: 'system',
        content: `Consolidated episode for task "${taskData.task.slice(0, 50)}..." (Outcome: ${taskData.outcome})`,
        workspaceId: taskData.workspaceId || 'default'
      });
    }
  }
}
