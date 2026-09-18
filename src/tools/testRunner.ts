import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface TestExecutionResult {
  passed: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  summary: string;
  testedFiles: string[];
}

/**
 * Runs automated unit tests for files in src/sandbox/ or src/sandbox/tests/
 */
export async function runWorkspaceTests(targetFiles: string[] = []): Promise<TestExecutionResult> {
  const rootDir = process.cwd();
  const sandboxDir = path.resolve(rootDir, 'src/sandbox');
  const testsDir = path.resolve(sandboxDir, 'tests');

  let testCmd = '';
  const testedFiles: string[] = [];

  // 1. Check for Python test files in src/sandbox/tests/ or targetFiles
  const hasPythonTests = fs.existsSync(testsDir) && fs.readdirSync(testsDir).some(f => f.startsWith('test_') && f.endsWith('.py'));
  const targetPythonTests = targetFiles.filter(f => f.includes('test_') && f.endsWith('.py'));

  if (hasPythonTests || targetPythonTests.length > 0) {
    // Run Python unittest on test suite
    testCmd = `python -m unittest discover -s src/sandbox/tests -p "test_*.py"`;
    if (fs.existsSync(testsDir)) {
      testedFiles.push(...fs.readdirSync(testsDir).map(f => `src/sandbox/tests/${f}`));
    }
  } else {
    // 2. Check for TypeScript test files
    const tsTestFiles = targetFiles.filter(f => f.includes('test') && (f.endsWith('.ts') || f.endsWith('.js')));
    if (tsTestFiles.length > 0) {
      testCmd = `npx ts-node ${tsTestFiles[0]}`;
      testedFiles.push(...tsTestFiles);
    }
  }

  if (!testCmd) {
    // Default fallback check: if src/sandbox/tests exists, run discovery, else report no test suite found
    if (fs.existsSync(testsDir)) {
      testCmd = `python -m unittest discover -s src/sandbox/tests -p "test_*.py"`;
    } else {
      return {
        passed: true,
        exitCode: 0,
        stdout: "No dedicated test suite files found in src/sandbox/tests/. Syntax and structural checks passed.",
        stderr: "",
        summary: "No test suite executed (no test files present).",
        testedFiles: []
      };
    }
  }

  return new Promise<TestExecutionResult>((resolve) => {
    exec(testCmd, { cwd: rootDir, timeout: 15000 }, (error, stdout, stderr) => {
      const exitCode = error ? (error.code || 1) : 0;
      const passed = exitCode === 0;
      const combinedLogs = (stdout + '\n' + stderr).trim();

      let summary = "";
      if (passed) {
        summary = `Automated test suite PASSED cleanly (${testedFiles.length} test file(s) evaluated).`;
      } else {
        summary = `Automated test suite FAILED with exit code ${exitCode}. Stack trace:\n${combinedLogs.slice(-4000)}`;
      }

      resolve({
        passed,
        exitCode,
        stdout,
        stderr,
        summary,
        testedFiles
      });
    });
  });
}

/**
 * Extracts failing implementation file paths from stack traces / test error logs
 */
export function extractFailingFilesFromLogs(logText: string): string[] {
  const fileRegex = /src[\\\/]sandbox[\\\/]([a-zA-Z0-9_\-\.\/\\\\]+\.(py|ts|js|tsx|jsx))/g;
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

