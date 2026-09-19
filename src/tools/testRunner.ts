import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { validateBeforeSubmission, FileMetadata } from './universalValidator';

export interface TestExecutionResult {
  passed: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  summary: string;
  testedFiles: string[];
}

/**
 * Universal Multi-Language Workspace Test & Validation Runner
 */
export async function runWorkspaceTests(targetFiles: string[] = []): Promise<TestExecutionResult> {
  const rootDir = process.cwd();
  const sandboxDir = path.resolve(rootDir, 'src/sandbox');

  // Discover sandbox files for stack detection
  const sandboxFiles: FileMetadata[] = [];
  if (fs.existsSync(sandboxDir)) {
    const list = fs.readdirSync(sandboxDir);
    for (const item of list) {
      if (/^test[1-5]$/i.test(item)) continue;
      const fullPath = path.join(sandboxDir, item);
      const stat = fs.statSync(fullPath);
      sandboxFiles.push({
        name: item,
        path: `src/sandbox/${item}`,
        isDir: stat.isDirectory()
      });
    }
  }

  // 1. Run Universal Multi-Language Validation Pipeline Gate
  try {
    const report = await validateBeforeSubmission(sandboxFiles, rootDir);
    const passed = report.canSubmit;
    const summary = report.formattedReport;
    const testedFiles = targetFiles.length > 0 ? targetFiles : sandboxFiles.map(f => f.path || f.name);

    return {
      passed,
      exitCode: passed ? 0 : 1,
      stdout: summary,
      stderr: report.reason || '',
      summary: summary,
      testedFiles
    };
  } catch (err: any) {
    // Fallback runner if universal pipeline catches execution anomaly
    const testsDir = path.resolve(sandboxDir, 'tests');
    const hasPythonTests = fs.existsSync(testsDir) && fs.readdirSync(testsDir).some(f => f.startsWith('test_') && f.endsWith('.py'));
    const testCmd = hasPythonTests ? `python -m unittest discover -s src/sandbox/tests -p "test_*.py"` : `npx ts-node src/sandbox/main.ts`;

    return new Promise<TestExecutionResult>((resolve) => {
      exec(testCmd, { cwd: rootDir, timeout: 15000 }, (error, stdout, stderr) => {
        const exitCode = error ? (error.code || 1) : 0;
        const passed = exitCode === 0;
        const combinedLogs = (stdout + '\n' + stderr).trim();

        resolve({
          passed,
          exitCode,
          stdout,
          stderr,
          summary: passed ? 'Automated test suite PASSED.' : `Test failed with exit code ${exitCode}:\n${combinedLogs.slice(-2000)}`,
          testedFiles: targetFiles
        });
      });
    });
  }
}

/**
 * Extracts failing implementation file paths from stack traces / test error logs
 */
export function extractFailingFilesFromLogs(logText: string): string[] {
  const fileRegex = /src[\\\/]sandbox[\\\/]([a-zA-Z0-9_\-\.\/\\\\]+\.(py|ts|js|tsx|jsx|cpp|rs|go|java|cs|php))/g;
  const matches: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = fileRegex.exec(logText)) !== null) {
    const fullPath = `src/sandbox/${match[1]}`.replace(/\\/g, '/');
    const baseName = path.basename(fullPath);
    if (!baseName.startsWith('test_') && !fullPath.includes('/tests/')) {
      matches.push(fullPath);
    }
  }
  return Array.from(new Set(matches));
}
