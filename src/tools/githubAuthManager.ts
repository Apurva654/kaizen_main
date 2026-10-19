import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export function resolveProjectRoot(): string {
  let dir = __dirname;
  while (true) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

export interface GitHubUserProfile {
  login: string;
  id: number;
  name: string | null;
  avatar_url: string;
  html_url: string;
  public_repos: number;
  private_repos?: number;
  email?: string | null;
}

export interface GitHubAuthStatus {
  isAuthenticated: boolean;
  username?: string;
  name?: string;
  avatarUrl?: string;
  profileUrl?: string;
  authType: 'token' | 'cli' | 'none';
  publicRepos?: number;
  error?: string;
}

export class GitHubAuthManager {
  private configPath: string;
  private token: string | null = null;
  private lastError: string | undefined;

  constructor() {
    this.configPath = path.join(resolveProjectRoot(), '.env');
    this.loadTokenFromEnv();
  }

  private loadTokenFromEnv(): void {
    if (process.env.GITHUB_TOKEN) {
      this.token = process.env.GITHUB_TOKEN.trim();
      return;
    }

    if (fs.existsSync(this.configPath)) {
      try {
        const envContent = fs.readFileSync(this.configPath, 'utf-8');
        const match = envContent.match(/^GITHUB_TOKEN=(.*)$/m);
        if (match && match[1]) {
          this.token = match[1].trim().replace(/^['"]|['"]$/g, '');
        }
      } catch (err) {
        console.warn('[GitHubAuth] Could not read .env file:', err);
      }
    }
  }

  public getToken(): string | null {
    if (!this.token) {
      this.loadTokenFromEnv();
    }
    return this.token;
  }

  public async setToken(token: string): Promise<GitHubAuthStatus> {
    const cleanToken = token.trim();
    if (!cleanToken) {
      throw new Error('Token cannot be empty.');
    }

    // Validate token against GitHub REST API first
    const profile = await this.fetchProfileWithToken(cleanToken);
    if (!profile) {
      throw new Error('Invalid GitHub Personal Access Token or network request failed.');
    }

    this.token = cleanToken;
    process.env.GITHUB_TOKEN = cleanToken;

    // Persist token in .env file
    try {
      let envContent = '';
      if (fs.existsSync(this.configPath)) {
        envContent = fs.readFileSync(this.configPath, 'utf-8');
      }

      if (/^GITHUB_TOKEN=/m.test(envContent)) {
        envContent = envContent.replace(/^GITHUB_TOKEN=.*$/m, `GITHUB_TOKEN=${cleanToken}`);
      } else {
        envContent = envContent.trim() ? `${envContent.trim()}\nGITHUB_TOKEN=${cleanToken}\n` : `GITHUB_TOKEN=${cleanToken}\n`;
      }

      fs.writeFileSync(this.configPath, envContent, 'utf-8');
    } catch (err) {
      console.warn('[GitHubAuth] Failed to write GITHUB_TOKEN to .env:', err);
    }

    return {
      isAuthenticated: true,
      username: profile.login,
      name: profile.name || profile.login,
      avatarUrl: profile.avatar_url,
      profileUrl: profile.html_url,
      authType: 'token',
      publicRepos: profile.public_repos
    };
  }

  public clearToken(): void {
    this.token = null;
    delete process.env.GITHUB_TOKEN;

    if (fs.existsSync(this.configPath)) {
      try {
        let envContent = fs.readFileSync(this.configPath, 'utf-8');
        envContent = envContent.replace(/^GITHUB_TOKEN=.*$/m, '').trim() + '\n';
        fs.writeFileSync(this.configPath, envContent, 'utf-8');
      } catch (err) {
        console.warn('[GitHubAuth] Failed to clear GITHUB_TOKEN from .env:', err);
      }
    }
  }

  public async fetchProfileWithToken(token: string): Promise<GitHubUserProfile | null> {
    try {
      const response = await fetch('https://api.github.com/user', {
        headers: {
          'Authorization': `Bearer ${token}`,
          'User-Agent': 'Kaizen-AI-Agent',
          'Accept': 'application/vnd.github.v3+json'
        }
      });

      if (!response.ok) {
        this.lastError = response.status === 401
          ? 'GitHub rejected the token (401). It is invalid, expired or revoked.'
          : `GitHub API returned status ${response.status}.`;
        console.warn(`[GitHubAuth] ${this.lastError}`);
        return null;
      }

      this.lastError = undefined;
      const data = (await response.json()) as GitHubUserProfile;
      return data;
    } catch (err: any) {
      this.lastError = `Could not reach api.github.com: ${err?.message || err}`;
      console.error('[GitHubAuth] API fetch error:', err);
      return null;
    }
  }

  public async checkCLIStatus(): Promise<{ isLoggedIN: boolean; username?: string; error?: string }> {
    try {
      const { stdout } = await execAsync('gh api user --jq .login', { timeout: 8000 });
      const login = stdout.trim();
      if (login) return { isLoggedIN: true, username: login };
    } catch {
      // fall through to parsing `gh auth status`
    }

    // `gh auth status` writes to stderr (even on success) in most gh versions.
    let output = '';
    try {
      const { stdout, stderr } = await execAsync('gh auth status', { timeout: 5000 });
      output = `${stdout}\n${stderr}`;
    } catch (err: any) {
      output = `${err?.stdout || ''}\n${err?.stderr || ''}`;
    }
    const match = output.match(/Logged in to github\.com (?:account|as) ([a-zA-Z0-9_\-]+)/i);
    if (match && match[1]) {
      return { isLoggedIN: true, username: match[1] };
    }
    return { isLoggedIN: false, error: 'GitHub CLI (gh) not installed or not logged in' };
  }

  public async getStatus(): Promise<GitHubAuthStatus> {
    const activeToken = this.getToken();
    if (activeToken) {
      const profile = await this.fetchProfileWithToken(activeToken);
      if (profile) {
        return {
          isAuthenticated: true,
          username: profile.login,
          name: profile.name || profile.login,
          avatarUrl: profile.avatar_url,
          profileUrl: profile.html_url,
          authType: 'token',
          publicRepos: profile.public_repos
        };
      }
    }

    const cliRes = await this.checkCLIStatus();
    if (cliRes.isLoggedIN && cliRes.username) {
      return {
        isAuthenticated: true,
        username: cliRes.username,
        name: cliRes.username,
        avatarUrl: `https://github.com/${cliRes.username}.png`,
        profileUrl: `https://github.com/${cliRes.username}`,
        authType: 'cli'
      };
    }

    return {
      isAuthenticated: false,
      authType: 'none',
      error: activeToken ? this.lastError : (cliRes.error || 'No GITHUB_TOKEN found in ' + this.configPath)
    };
  }
}

export const githubAuthManager = new GitHubAuthManager();
