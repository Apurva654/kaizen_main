import * as fs from 'fs';
import * as path from 'path';
import { KaizenStateType, PlanStep } from '../state';
import { conversationalMemory } from '../memory/conversationalMemory';
import { projectMemory } from '../memory/projectMemory';
import { workflowMemory } from '../memory/workflowMemory';
import { structuralMemory } from '../memory/structuralMemory';

export interface PipelineSessionRecord {
  sessionId: string;
  userInput: string;
  createdAt: string;
  updatedAt: string;
  status: string;
  targetFiles: string[];
  plan: PlanStep[];
  filePatches?: { filePath: string; code: string }[];
  reviewResult?: any;
  retryCount: number;
}

export interface StateCheckpointRecord {
  sessionId: string;
  stepName: string;
  timestamp: string;
  stateSnapshot: Partial<KaizenStateType>;
}

export interface WorkspaceGraphCacheRecord {
  workspaceRoot: string;
  timestamp: string;
  summary: string;
  fileFactsCount: number;
  structuredPayload?: any;
}

export class PersistenceEngine {
  private baseDir: string;
  private sessionsDir: string;
  private checkpointsDir: string;
  private cacheDir: string;
  private memoryDir: string;

  constructor(customBaseDir?: string) {
    this.baseDir = customBaseDir || path.resolve(process.cwd(), '.kaizen', 'storage');
    this.sessionsDir = path.join(this.baseDir, 'sessions');
    this.checkpointsDir = path.join(this.baseDir, 'checkpoints');
    this.cacheDir = path.join(this.baseDir, 'cache');
    this.memoryDir = path.join(this.baseDir, 'memory');

    this.ensureDirectories();
  }

  private ensureDirectories() {
    [this.baseDir, this.sessionsDir, this.checkpointsDir, this.cacheDir, this.memoryDir].forEach((dir) => {
      if (!fs.existsSync(dir)) {
        try {
          fs.mkdirSync(dir, { recursive: true });
        } catch (err) {
          console.warn(`[PersistenceEngine] Failed to create storage directory '${dir}':`, err);
        }
      }
    });
  }

  public generateSessionId(): string {
    const timestamp = Date.now();
    const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
    return `sess_${timestamp}_${random}`;
  }

  // --- Session & Conversational Memory ---

  public saveSession(session: PipelineSessionRecord): boolean {
    try {
      this.ensureDirectories();
      const filePath = path.join(this.sessionsDir, `${session.sessionId}.json`);
      fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf-8');
      
      this.updateSessionIndex(session);

      // Record into Conversational & Project Memory Tiers
      conversationalMemory.addTurn(session.sessionId, {
        role: 'user',
        content: session.userInput,
        metadata: { status: session.status, targetFiles: session.targetFiles }
      });

      projectMemory.saveProjectMetadata(process.cwd(), {
        fileCount: session.targetFiles?.length || 0,
        envVars: { lastSessionId: session.sessionId }
      });

      return true;
    } catch (err) {
      console.error(`[PersistenceEngine] Error saving session '${session.sessionId}':`, err);
      return false;
    }
  }

  private updateSessionIndex(session: PipelineSessionRecord) {
    try {
      const indexPath = path.join(this.sessionsDir, 'index.json');
      let index: { sessionId: string; userInput: string; createdAt: string; status: string }[] = [];
      if (fs.existsSync(indexPath)) {
        const raw = fs.readFileSync(indexPath, 'utf-8');
        index = JSON.parse(raw);
      }

      const existingIdx = index.findIndex(s => s.sessionId === session.sessionId);
      const summary = {
        sessionId: session.sessionId,
        userInput: session.userInput,
        createdAt: session.createdAt,
        status: session.status
      };

      if (existingIdx !== -1) {
        index[existingIdx] = summary;
      } else {
        index.unshift(summary);
      }

      fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf-8');
    } catch (err) {
      console.error(`[PersistenceEngine] Error updating session index:`, err);
    }
  }

  public getSession(sessionId: string): PipelineSessionRecord | null {
    try {
      const filePath = path.join(this.sessionsDir, `${sessionId}.json`);
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(raw);
      }
    } catch (err) {
      console.error(`[PersistenceEngine] Error reading session '${sessionId}':`, err);
    }
    return null;
  }

  public listSessions(limit: number = 50): { sessionId: string; userInput: string; createdAt: string; status: string }[] {
    try {
      const indexPath = path.join(this.sessionsDir, 'index.json');
      if (fs.existsSync(indexPath)) {
        const raw = fs.readFileSync(indexPath, 'utf-8');
        const list = JSON.parse(raw);
        return list.slice(0, limit);
      }
    } catch (err) {
      console.warn(`[PersistenceEngine] Error listing sessions:`, err);
    }
    return [];
  }

  // --- State Checkpointing & Workflow Memory ---

  public saveCheckpoint(sessionId: string, stepName: string, stateSnapshot: Partial<KaizenStateType>): boolean {
    try {
      this.ensureDirectories();
      const sessionCheckpointsDir = path.join(this.checkpointsDir, sessionId);
      if (!fs.existsSync(sessionCheckpointsDir)) {
        fs.mkdirSync(sessionCheckpointsDir, { recursive: true });
      }

      const timestamp = new Date().toISOString();
      const filename = `${Date.now()}_${stepName}.json`;
      const record: StateCheckpointRecord = {
        sessionId,
        stepName,
        timestamp,
        stateSnapshot
      };

      fs.writeFileSync(path.join(sessionCheckpointsDir, filename), JSON.stringify(record, null, 2), 'utf-8');

      // Record into Workflow Memory Tier
      workflowMemory.recordCheckpoint({
        sessionId,
        stepName,
        status: stepName.includes('Approved') ? 'COMPLETED' : (stepName.includes('Pending') ? 'APPROVAL_REQUIRED' : 'PENDING'),
        agentState: stateSnapshot
      });

      return true;
    } catch (err) {
      console.error(`[PersistenceEngine] Error saving checkpoint '${stepName}' for session '${sessionId}':`, err);
      return false;
    }
  }

  public getCheckpoints(sessionId: string): StateCheckpointRecord[] {
    try {
      const sessionCheckpointsDir = path.join(this.checkpointsDir, sessionId);
      if (fs.existsSync(sessionCheckpointsDir)) {
        const files = fs.readdirSync(sessionCheckpointsDir).sort();
        const records: StateCheckpointRecord[] = [];
        for (const file of files) {
          if (file.endsWith('.json')) {
            const raw = fs.readFileSync(path.join(sessionCheckpointsDir, file), 'utf-8');
            records.push(JSON.parse(raw));
          }
        }
        return records;
      }
    } catch (err) {
      console.error(`[PersistenceEngine] Error reading checkpoints for session '${sessionId}':`, err);
    }
    return [];
  }

  // --- Workspace Graph & Structural Memory ---

  public cacheWorkspaceGraph(workspaceRoot: string, summary: string, fileFactsCount: number, structuredPayload?: any): boolean {
    try {
      this.ensureDirectories();
      const key = workspaceRoot.replace(/[^a-zA-Z0-9]/g, '_');
      const cachePath = path.join(this.cacheDir, `graph_${key}.json`);
      const record: WorkspaceGraphCacheRecord = {
        workspaceRoot,
        timestamp: new Date().toISOString(),
        summary,
        fileFactsCount,
        structuredPayload
      };
      fs.writeFileSync(cachePath, JSON.stringify(record, null, 2), 'utf-8');

      // Record into Structural Memory Tier
      structuralMemory.saveGraphCache(workspaceRoot, structuredPayload || { summary, fileFactsCount });

      return true;
    } catch (err) {
      console.warn(`[PersistenceEngine] Error caching workspace graph:`, err);
      return false;
    }
  }

  public getWorkspaceGraphCache(workspaceRoot: string): WorkspaceGraphCacheRecord | null {
    try {
      const key = workspaceRoot.replace(/[^a-zA-Z0-9]/g, '_');
      const cachePath = path.join(this.cacheDir, `graph_${key}.json`);
      if (fs.existsSync(cachePath)) {
        const raw = fs.readFileSync(cachePath, 'utf-8');
        return JSON.parse(raw);
      }

      const structCache = structuralMemory.getGraphCache(workspaceRoot);
      if (structCache && structCache.structuredPayload) {
        return {
          workspaceRoot: structCache.workspaceRoot,
          timestamp: structCache.timestamp,
          summary: 'Loaded from Structural Memory',
          fileFactsCount: structCache.fileNodesCount,
          structuredPayload: structCache.structuredPayload
        };
      }
    } catch (err) {
      console.warn(`[PersistenceEngine] Error reading workspace graph cache:`, err);
    }
    return null;
  }

  // --- Semantic Memory Layer Persistence ---

  public getMemoryDir(): string {
    return this.memoryDir;
  }

  public appendMemoryJsonl(fileName: string, record: any): boolean {
    try {
      this.ensureDirectories();
      const filePath = path.join(this.memoryDir, fileName.endsWith('.jsonl') ? fileName : `${fileName}.jsonl`);
      const line = JSON.stringify(record) + '\n';
      fs.appendFileSync(filePath, line, 'utf-8');
      return true;
    } catch (err) {
      console.error(`[PersistenceEngine] Error appending memory record to '${fileName}':`, err);
      return false;
    }
  }

  public readMemoryJsonl<T>(fileName: string): T[] {
    try {
      const filePath = path.join(this.memoryDir, fileName.endsWith('.jsonl') ? fileName : `${fileName}.jsonl`);
      if (!fs.existsSync(filePath)) return [];
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      const records: T[] = [];
      for (const line of lines) {
        try {
          records.push(JSON.parse(line));
        } catch {
          // Ignore corrupt line
        }
      }
      return records;
    } catch (err) {
      console.error(`[PersistenceEngine] Error reading memory jsonl '${fileName}':`, err);
      return [];
    }
  }

  public writeMemoryJson(fileName: string, data: any): boolean {
    try {
      this.ensureDirectories();
      const filePath = path.join(this.memoryDir, fileName.endsWith('.json') ? fileName : `${fileName}.json`);
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
      return true;
    } catch (err) {
      console.error(`[PersistenceEngine] Error writing memory json '${fileName}':`, err);
      return false;
    }
  }

  public readMemoryJson<T>(fileName: string): T | null {
    try {
      const filePath = path.join(this.memoryDir, fileName.endsWith('.json') ? fileName : `${fileName}.json`);
      if (!fs.existsSync(filePath)) return null;
      const raw = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(raw);
    } catch (err) {
      console.error(`[PersistenceEngine] Error reading memory json '${fileName}':`, err);
      return null;
    }
  }
}

export const persistenceEngine = new PersistenceEngine();
