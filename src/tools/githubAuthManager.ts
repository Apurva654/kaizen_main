import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

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

  constructor() {
    this.configPath = path.resolve(process.cwd(), '.env');
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
        console.warn(`[GitHubAuth] API validation returned status ${response.status}`);
        return null;
      }

      const data = (await response.json()) as GitHubUserProfile;
      return data;
    } catch (err) {
      console.error('[GitHubAuth] API fetch error:', err);
      return null;
    }
  }

  public async checkCLIStatus(): Promise<{ isLoggedIN: boolean; username?: string; error?: string }> {
    try {
      const { stdout } = await execAsync('gh auth status', { timeout: 5000 });
      const match = stdout.match(/Logged in to github\.com account ([a-zA-Z0-9_\-]+)/i) ||
                    stdout.match(/Logged in to github\.com as ([a-zA-Z0-9_\-]+)/i);
      if (match && match[1]) {
        return { isLoggedIN: true, username: match[1] };
      }
      return { isLoggedIN: true };
    } catch (err: any) {
      const stderr = err?.stderr || err?.stdout || '';
      const match = stderr.match(/Logged in to github\.com account ([a-zA-Z0-9_\-]+)/i) ||
                    stderr.match(/Logged in to github\.com as ([a-zA-Z0-9_\-]+)/i);
      if (match && match[1]) {
        return { isLoggedIN: true, username: match[1] };
      }
      return { isLoggedIN: false, error: 'GitHub CLI (gh) not logged in' };
    }
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
      authType: 'none'
    };
  }
}

export const githubAuthManager = new GitHubAuthManager();
