import * as fs from 'fs';
import * as path from 'path';

export interface WorkflowCheckpoint {
  sessionId: string;
  stepName: string;
  timestamp: string;
  status: 'PENDING' | 'COMPLETED' | 'FAILED' | 'APPROVAL_REQUIRED';
  agentState?: Record<string, any>;
  hitlAction?: 'approve' | 'reject' | 'feedback';
  hitlMessage?: string;
}

export class WorkflowMemoryStore {
  private memoryDir: string;
  private checkpointCache: Map<string, WorkflowCheckpoint[]> = new Map();

  constructor(memoryDir?: string) {
    this.memoryDir = memoryDir || path.resolve(process.cwd(), '.memory/workflow');
    if (!fs.existsSync(this.memoryDir)) {
      fs.mkdirSync(this.memoryDir, { recursive: true });
    }
  }

  public recordCheckpoint(checkpoint: Omit<WorkflowCheckpoint, 'timestamp'>): WorkflowCheckpoint {
    const fullCp: WorkflowCheckpoint = {
      ...checkpoint,
      timestamp: new Date().toISOString()
    };

    if (!this.checkpointCache.has(checkpoint.sessionId)) {
      this.checkpointCache.set(checkpoint.sessionId, []);
    }

    this.checkpointCache.get(checkpoint.sessionId)!.push(fullCp);
    this.persistWorkflows(checkpoint.sessionId);
    return fullCp;
  }

  public getCheckpoints(sessionId: string): WorkflowCheckpoint[] {
    if (this.checkpointCache.has(sessionId)) {
      return this.checkpointCache.get(sessionId)!;
    }
    return this.loadWorkflows(sessionId);
  }

  public getLatestCheckpoint(sessionId: string): WorkflowCheckpoint | null {
    const cps = this.getCheckpoints(sessionId);
    return cps.length > 0 ? cps[cps.length - 1] : null;
  }

  private persistWorkflows(sessionId: string): void {
    try {
      const cps = this.checkpointCache.get(sessionId) || [];
      const file = path.resolve(this.memoryDir, `${sessionId}.json`);
      fs.writeFileSync(file, JSON.stringify(cps, null, 2), 'utf-8');
    } catch (err) {
      console.warn(`[WorkflowMemory] Failed to persist workflow checkpoints for session ${sessionId}:`, err);
    }
  }

  private loadWorkflows(sessionId: string): WorkflowCheckpoint[] {
    try {
      const file = path.resolve(this.memoryDir, `${sessionId}.json`);
      if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file, 'utf-8');
        const cps: WorkflowCheckpoint[] = JSON.parse(raw);
        this.checkpointCache.set(sessionId, cps);
        return cps;
      }
    } catch (err) {
      console.warn(`[WorkflowMemory] Failed to load workflow checkpoints for session ${sessionId}:`, err);
    }
    return [];
  }
}

export const workflowMemory = new WorkflowMemoryStore();
