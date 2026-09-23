import { ShortTermEvent, sanitizeSecretInfo } from './memoryTypes';
import { persistenceEngine } from '../../tools/persistenceEngine';

export class ShortTermMemoryManager {
  private events: ShortTermEvent[] = [];
  private maxWindowSize: number;

  constructor(maxWindowSize: number = 30) {
    this.maxWindowSize = maxWindowSize;
  }

  public addEvent(
    eventData: {
      eventKind: ShortTermEvent['eventKind'];
      role?: 'user' | 'assistant' | 'system';
      content: string;
      summary?: string;
      agent?: string;
      toolName?: string;
      toolResult?: string;
      workspaceId?: string;
      sessionId?: string;
      tags?: string[];
    }
  ): ShortTermEvent {
    const sanitizedContent = sanitizeSecretInfo(eventData.content);
    const sanitizedToolResult = eventData.toolResult ? sanitizeSecretInfo(eventData.toolResult) : undefined;
    const sanitizedSummary = eventData.summary ? sanitizeSecretInfo(eventData.summary) : undefined;

    const event: ShortTermEvent = {
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      type: 'short_term',
      workspaceId: eventData.workspaceId || 'default',
      sessionId: eventData.sessionId,
      timestamp: new Date().toISOString(),
      eventKind: eventData.eventKind,
      role: eventData.role,
      content: sanitizedContent,
      summary: sanitizedSummary,
      agent: eventData.agent,
      toolName: eventData.toolName,
      toolResult: sanitizedToolResult,
      importance: 0.5,
      confidence: 1.0,
      tags: eventData.tags || [eventData.eventKind.toLowerCase()]
    };

    this.events.push(event);

    // Persist event to JSONL
    persistenceEngine.appendMemoryJsonl('short-term.jsonl', event);

    if (this.events.length > this.maxWindowSize) {
      this.compact();
    }

    return event;
  }

  public compact(): void {
    if (this.events.length <= this.maxWindowSize) return;

    // Retain most recent events within window minus 1 for summary
    const targetRecentCount = this.maxWindowSize - 1;
    const overflowCount = this.events.length - targetRecentCount;
    const olderEvents = this.events.slice(0, overflowCount);
    const recentEvents = this.events.slice(overflowCount);

    // Create a compact summary event of older events if applicable
    const userPrompts = olderEvents.filter(e => e.eventKind === 'USER_MESSAGE').map(e => e.content.slice(0, 50));
    const summaryContent = userPrompts.length > 0
      ? `Compacted ${overflowCount} older interaction events. Key themes: ${userPrompts.join('; ')}`
      : `Compacted ${overflowCount} older timeline events.`;

    const summaryEvent: ShortTermEvent = {
      id: `evt_compact_${Date.now()}`,
      type: 'short_term',
      workspaceId: recentEvents[0]?.workspaceId || 'default',
      sessionId: recentEvents[0]?.sessionId,
      timestamp: new Date().toISOString(),
      eventKind: 'ASSISTANT_RESPONSE',
      role: 'system',
      content: summaryContent,
      summary: summaryContent,
      importance: 0.3,
      confidence: 0.9,
      tags: ['compacted_summary']
    };

    this.events = [summaryEvent, ...recentEvents];
  }

  public getEvents(limit?: number): ShortTermEvent[] {
    if (limit && limit > 0) {
      return this.events.slice(-limit);
    }
    return [...this.events];
  }

  public loadFromPersistence(): void {
    const loaded = persistenceEngine.readMemoryJsonl<ShortTermEvent>('short-term.jsonl');
    if (loaded && loaded.length > 0) {
      this.events = loaded.slice(-this.maxWindowSize);
    }
  }

  public clear(): void {
    this.events = [];
  }

  public formatForPrompt(limit: number = 10): string {
    const recent = this.getEvents(limit);
    if (recent.length === 0) {
      return 'SHORT-TERM MEMORY: (No recent interaction events)';
    }

    const items = recent.map(e => {
      const timeStr = e.timestamp ? e.timestamp.substring(11, 19) : '';
      if (e.eventKind === 'USER_MESSAGE') {
        return `  [${timeStr}] User: ${e.content.substring(0, 160)}`;
      }
      if (e.eventKind === 'ASSISTANT_RESPONSE') {
        return `  [${timeStr}] Assistant: ${e.content.substring(0, 160)}`;
      }
      if (e.eventKind === 'TOOL_CALLED' || e.eventKind === 'TOOL_RESULT') {
        return `  [${timeStr}] Tool (${e.toolName || 'MCP'}): ${e.content.substring(0, 120)}`;
      }
      if (e.eventKind === 'TEST_FAILED' || e.eventKind === 'TEST_PASSED') {
        return `  [${timeStr}] Test [${e.eventKind}]: ${e.content.substring(0, 140)}`;
      }
      return `  [${timeStr}] Event [${e.eventKind}] (${e.agent || 'system'}): ${e.content.substring(0, 140)}`;
    });

    return `
SHORT-TERM MEMORY (Recent Events & Window):
============================================
${items.join('\n')}
`;
  }
}
