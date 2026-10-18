import * as path from 'path';
import * as fs from 'fs';
import { isProtectedFile } from './sandboxPathUtils';

/**
 * WorkspaceManager provides unified workspace and sandbox abstractions across:
 * - Backend server processes
 * - VS Code extension host
 * - Tool executions (MCP filesystem, compiler, test runner, validator)
 */
export class WorkspaceManager {
  private hostRepoRoot: string;
  private workspaceRoot: string;
  private sandboxDir: string;

  constructor(customWorkspaceRoot?: string) {
    this.hostRepoRoot = path.resolve(process.cwd());
    const initialRoot = customWorkspaceRoot || process.env.KAIZEN_WORKSPACE_ROOT || this.hostRepoRoot;
    this.workspaceRoot = path.resolve(initialRoot);
    this.sandboxDir = path.resolve(this.workspaceRoot, 'src/sandbox');
    this.ensureSandboxDir();
  }

  public getHostRepoRoot(): string {
    return this.hostRepoRoot;
  }

  public getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }

  public setWorkspaceRoot(newRoot: string): void {
    if (!newRoot || typeof newRoot !== 'string') return;
    const resolved = path.resolve(newRoot);
    this.workspaceRoot = resolved;
    this.sandboxDir = path.resolve(resolved, 'src/sandbox');
    this.ensureSandboxDir();
    console.log(`[WorkspaceManager] Workspace root updated: ${this.workspaceRoot}`);
  }

  public getSandboxDir(): string {
    return this.sandboxDir;
  }

  private ensureSandboxDir(): void {
    try {
      if (!fs.existsSync(this.sandboxDir)) {
        fs.mkdirSync(this.sandboxDir, { recursive: true });
      }
    } catch (err) {
      console.warn('[WorkspaceManager] Could not ensure sandbox directory:', err);
    }
  }

  /**
   * Returns true when the active workspace is distinct from Kaizen's own repository.
   */
  public isExternalProject(): boolean {
    return path.normalize(this.workspaceRoot).toLowerCase() !== path.normalize(this.hostRepoRoot).toLowerCase();
  }

  /**
   * Safely resolves a relative or absolute file path into an absolute path within workspace.
   * Prevents directory traversal attacks.
   */
  public resolvePath(filePath: string): string {
    if (!filePath || typeof filePath !== 'string') {
      return path.resolve(this.sandboxDir, 'main.ts');
    }

    const clean = filePath.replace(/\\/g, '/').trim();
    if (path.isAbsolute(filePath)) {
      const normalizedAbs = path.resolve(filePath);
      return normalizedAbs;
    }

    // Relative path resolution
    const resolved = path.resolve(this.workspaceRoot, clean);
    return resolved;
  }

  /**
   * Normalizes a path into a workspace-relative path with forward slashes.
   */
  public toRelativePath(filePath: string): string {
    if (!filePath) return '';
    const absPath = path.isAbsolute(filePath) ? filePath : this.resolvePath(filePath);
    const rel = path.relative(this.workspaceRoot, absPath).replace(/\\/g, '/');
    return rel;
  }

  /**
   * Verifies if a given path is within the permitted workspace boundaries.
   */
  public isWithinWorkspace(filePath: string): boolean {
    const abs = this.resolvePath(filePath);
    const rel = path.relative(this.workspaceRoot, abs);
    return !rel.startsWith('..') && !path.isAbsolute(rel);
  }

  /**
   * Checks whether a target file is protected from automated write or deletion.
   */
  public isProtected(filePath: string): boolean {
    // If co-located with host repo, apply strict internal protection patterns
    if (!this.isExternalProject()) {
      return isProtectedFile(filePath);
    }

    // In external project workspaces, protect standard critical secrets
    const norm = filePath.replace(/\\/g, '/');
    return /\.env($|\.)/.test(norm) || /\.git(\/|\\|$)/.test(norm);
  }
}

export const workspaceManager = new WorkspaceManager();
