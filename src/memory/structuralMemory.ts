import * as fs from 'fs';
import * as path from 'path';

export interface StructuralGraphCache {
  workspaceRoot: string;
  timestamp: string;
  fileNodesCount: number;
  symbolCount: number;
  structuredPayload?: any;
}

export class StructuralMemoryStore {
  private memoryDir: string;
  private graphCache: Map<string, StructuralGraphCache> = new Map();

  constructor(memoryDir?: string) {
    this.memoryDir = memoryDir || path.resolve(process.cwd(), '.memory/structural');
    if (!fs.existsSync(this.memoryDir)) {
      fs.mkdirSync(this.memoryDir, { recursive: true });
    }
  }

  public saveGraphCache(workspaceRoot: string, payload: any): StructuralGraphCache {
    const normRoot = path.resolve(workspaceRoot);
    const entry: StructuralGraphCache = {
      workspaceRoot: normRoot,
      timestamp: new Date().toISOString(),
      fileNodesCount: payload?.metadata?.files || payload?.nodes?.length || 0,
      symbolCount: payload?.metadata?.symbols || 0,
      structuredPayload: payload
    };

    this.graphCache.set(normRoot, entry);
    this.persistGraph(normRoot, entry);
    return entry;
  }

  public getGraphCache(workspaceRoot: string): StructuralGraphCache | null {
    const normRoot = path.resolve(workspaceRoot);
    if (this.graphCache.has(normRoot)) {
      return this.graphCache.get(normRoot)!;
    }
    return this.loadGraph(normRoot);
  }

  private getGraphKey(workspaceRoot: string): string {
    return Buffer.from(path.resolve(workspaceRoot)).toString('hex').substring(0, 16);
  }

  private persistGraph(workspaceRoot: string, entry: StructuralGraphCache): void {
    try {
      const key = this.getGraphKey(workspaceRoot);
      const file = path.resolve(this.memoryDir, `${key}.json`);
      fs.writeFileSync(file, JSON.stringify(entry, null, 2), 'utf-8');
    } catch (err) {
      console.warn(`[StructuralMemory] Failed to persist structural graph cache for ${workspaceRoot}:`, err);
    }
  }

  private loadGraph(workspaceRoot: string): StructuralGraphCache | null {
    try {
      const key = this.getGraphKey(workspaceRoot);
      const file = path.resolve(this.memoryDir, `${key}.json`);
      if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file, 'utf-8');
        const entry: StructuralGraphCache = JSON.parse(raw);
        this.graphCache.set(workspaceRoot, entry);
        return entry;
      }
    } catch (err) {
      console.warn(`[StructuralMemory] Failed to load structural graph cache for ${workspaceRoot}:`, err);
    }
    return null;
  }
}

export const structuralMemory = new StructuralMemoryStore();
