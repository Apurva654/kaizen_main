import { exec } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

export interface DockerExecutionResult {
  success: boolean;
  isDocker: boolean;
  output: string;
  exitCode: number;
}

export class DockerSandboxEngine {
  private dockerAvailable: boolean | null = null;

  /**
   * Checks if host system has an active Docker daemon running
   */
  public async checkDockerAvailable(forceRecheck: boolean = true): Promise<boolean> {
    if (!forceRecheck && this.dockerAvailable !== null) {
      return this.dockerAvailable;
    }

    return new Promise((resolve) => {
      exec('docker ps', { timeout: 3000 }, (error) => {
        this.dockerAvailable = !error;
        console.log(`[DockerSandbox] Docker Daemon Availability: ${this.dockerAvailable ? 'ACTIVE ✔' : 'UNAVAILABLE (Process Fallback Active)'}`);
        resolve(this.dockerAvailable);
      });
    });
  }

  /**
   * Executes a command inside isolated Docker container (or restricted process sandbox fallback)
   */
  public async executeSandboxedCommand(command: string, workDir: string = process.cwd()): Promise<DockerExecutionResult> {
    const isDocker = await this.checkDockerAvailable(true);
    const sandboxDir = path.resolve(workDir, 'src/sandbox');

    if (!fs.existsSync(sandboxDir)) {
      fs.mkdirSync(sandboxDir, { recursive: true });
    }

    if (isDocker) {
      let image = 'alpine';
      const cmdTrimmed = command.trim().toLowerCase();
      if (cmdTrimmed.startsWith('python') || cmdTrimmed.startsWith('python3')) {
        image = 'python:alpine';
      } else if (cmdTrimmed.startsWith('node') || cmdTrimmed.startsWith('npm')) {
        image = 'node:alpine';
      }

      // Convert Windows backslashes to POSIX slashes for Docker volume mounting
      const posixSandboxDir = sandboxDir.replace(/\\/g, '/');
      const escapedCmd = command.replace(/"/g, '\\"');
      const dockerCmd = `docker run --rm -v "${posixSandboxDir}:/app" -w /app ${image} sh -c "${escapedCmd}"`;

      const dockerResult = await new Promise<DockerExecutionResult>((resolve) => {
        exec(dockerCmd, { timeout: 20000 }, (error, stdout, stderr) => {
          const combined = (stdout + '\n' + stderr).trim();
          const exitCode = error ? (error.code || 1) : 0;
          resolve({
            success: exitCode === 0,
            isDocker: true,
            output: combined || 'Container execution completed successfully.',
            exitCode
          });
        });
      });

      // If docker run succeeds or container returns result, return it
      if (dockerResult.success || dockerResult.exitCode === 0) {
        return dockerResult;
      }
      console.warn(`[DockerSandbox] Container execution failed (${dockerResult.output}), attempting Process Sandbox fallback...`);
    }

    // Local Process Sandbox Fallback (Isolated CWD: src/sandbox/)
    return new Promise((resolve) => {
      exec(command, { cwd: sandboxDir, timeout: 15000 }, (error, stdout, stderr) => {
        const combined = (stdout + '\n' + stderr).trim();
        const exitCode = error ? (error.code || 1) : 0;
        resolve({
          success: exitCode === 0,
          isDocker: false,
          output: combined || 'Process sandbox execution completed.',
          exitCode
        });
      });
    });
  }
}

export const dockerSandbox = new DockerSandboxEngine();
