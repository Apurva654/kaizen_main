import * as fs from 'fs';
import * as path from 'path';

export interface ChatTurn {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  metadata?: Record<string, any>;
}

export class ConversationalMemoryStore {
  private memoryDir: string;
  private conversationHistory: Map<string, ChatTurn[]> = new Map();

  constructor(memoryDir?: string) {
    this.memoryDir = memoryDir || path.resolve(process.cwd(), '.memory/conversational');
    if (!fs.existsSync(this.memoryDir)) {
      fs.mkdirSync(this.memoryDir, { recursive: true });
    }
  }

  public addTurn(sessionId: string, turn: Omit<ChatTurn, 'id' | 'timestamp'>): ChatTurn {
    const fullTurn: ChatTurn = {
      ...turn,
      id: `turn_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      timestamp: new Date().toISOString()
    };

    if (!this.conversationHistory.has(sessionId)) {
      this.conversationHistory.set(sessionId, []);
    }

    this.conversationHistory.get(sessionId)!.push(fullTurn);
    this.persistSession(sessionId);
    return fullTurn;
  }

  public getHistory(sessionId: string, limit: number = 50): ChatTurn[] {
    const turns = this.conversationHistory.get(sessionId) || this.loadSession(sessionId);
    return turns.slice(-limit);
  }

  public clearHistory(sessionId: string): void {
    this.conversationHistory.delete(sessionId);
    const sessionFile = path.resolve(this.memoryDir, `${sessionId}.json`);
    if (fs.existsSync(sessionFile)) {
      fs.unlinkSync(sessionFile);
    }
  }

  private persistSession(sessionId: string): void {
    try {
      const turns = this.conversationHistory.get(sessionId) || [];
      const sessionFile = path.resolve(this.memoryDir, `${sessionId}.json`);
      fs.writeFileSync(sessionFile, JSON.stringify(turns, null, 2), 'utf-8');
    } catch (err) {
      console.warn(`[ConversationalMemory] Failed to persist session ${sessionId}:`, err);
    }
  }

  private loadSession(sessionId: string): ChatTurn[] {
    try {
      const sessionFile = path.resolve(this.memoryDir, `${sessionId}.json`);
      if (fs.existsSync(sessionFile)) {
        const raw = fs.readFileSync(sessionFile, 'utf-8');
        const turns: ChatTurn[] = JSON.parse(raw);
        this.conversationHistory.set(sessionId, turns);
        return turns;
      }
    } catch (err) {
      console.warn(`[ConversationalMemory] Failed to load session ${sessionId}:`, err);
    }
    return [];
  }
}

export const conversationalMemory = new ConversationalMemoryStore();
