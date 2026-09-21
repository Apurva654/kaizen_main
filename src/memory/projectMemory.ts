import * as fs from 'fs';
import * as path from 'path';

export interface ProjectMetadata {
  projectName: string;
  projectRoot: string;
  language: string;
  framework?: string;
  detectedDependencies: string[];
  fileCount: number;
  lastScanned: string;
  envVars?: Record<string, string>;
}

export class ProjectMemoryStore {
  private memoryDir: string;
  private projectCache: Map<string, ProjectMetadata> = new Map();

  constructor(memoryDir?: string) {
    this.memoryDir = memoryDir || path.resolve(process.cwd(), '.memory/project');
    if (!fs.existsSync(this.memoryDir)) {
      fs.mkdirSync(this.memoryDir, { recursive: true });
    }
  }

  public saveProjectMetadata(projectRoot: string, metadata: Partial<ProjectMetadata>): ProjectMetadata {
    const normRoot = path.resolve(projectRoot);
    const existing = this.getProjectMetadata(normRoot) || {
      projectName: path.basename(normRoot),
      projectRoot: normRoot,
      language: 'typescript',
      detectedDependencies: [],
      fileCount: 0,
      lastScanned: new Date().toISOString()
    };

    const updated: ProjectMetadata = {
      ...existing,
      ...metadata,
      projectRoot: normRoot,
      lastScanned: new Date().toISOString()
    };

    this.projectCache.set(normRoot, updated);
    this.persistProject(normRoot, updated);
    return updated;
  }

  public getProjectMetadata(projectRoot: string): ProjectMetadata | null {
    const normRoot = path.resolve(projectRoot);
    if (this.projectCache.has(normRoot)) {
      return this.projectCache.get(normRoot)!;
    }
    return this.loadProject(normRoot);
  }

  private getProjectKey(projectRoot: string): string {
    return Buffer.from(path.resolve(projectRoot)).toString('hex').substring(0, 16);
  }

  private persistProject(projectRoot: string, data: ProjectMetadata): void {
    try {
      const key = this.getProjectKey(projectRoot);
      const file = path.resolve(this.memoryDir, `${key}.json`);
      fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.warn(`[ProjectMemory] Failed to persist project metadata for ${projectRoot}:`, err);
    }
  }

  private loadProject(projectRoot: string): ProjectMetadata | null {
    try {
      const key = this.getProjectKey(projectRoot);
      const file = path.resolve(this.memoryDir, `${key}.json`);
      if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file, 'utf-8');
        const data: ProjectMetadata = JSON.parse(raw);
        this.projectCache.set(projectRoot, data);
        return data;
      }
    } catch (err) {
      console.warn(`[ProjectMemory] Failed to load project metadata for ${projectRoot}:`, err);
    }
    return null;
  }
}

export const projectMemory = new ProjectMemoryStore();
