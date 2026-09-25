import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { validateBeforeSubmission, FileMetadata } from './universalValidator';
import { dockerSandbox } from './dockerSandbox';

export type TestFailureType = 'TOOL_EXECUTION_FAILURE' | 'TEST_FAILURE' | 'CODE_FAILURE' | 'TIMEOUT';

export interface StructuredTestFailure {
  success: boolean;
  executionEnvironment: 'docker' | 'process';
  targetFiles: string[];
  testFiles: string[];
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  failureType: TestFailureType;
  errorType?: string;
  errorMessage?: string;
  sourceFile?: string;
  testFile?: string;
  summary?: string;
}

export interface TestExecutionResult {
  passed: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  summary: string;
  testedFiles: string[];
  failureType?: TestFailureType;
  structuredFailure?: StructuredTestFailure;
}

/**
 * Universal Multi-Language Workspace Test & Validation Runner
 */
export async function runWorkspaceTests(targetFiles: string[] = []): Promise<TestExecutionResult> {
  const rootDir = process.cwd();
  const sandboxDir = path.resolve(rootDir, 'src/sandbox');

  // Categorize target files and test files
  const isTestFile = (filePath: string) => {
    const norm = filePath.replace(/\\/g, '/');
    const baseName = path.basename(norm);
    return norm.includes('/tests/') || baseName.startsWith('test_') || baseName.endsWith('_test.py') || baseName.endsWith('.test.ts');
  };

  // Discover all files in src/sandbox
  const allSandboxFiles: string[] = [];
  if (fs.existsSync(sandboxDir)) {
    const list = fs.readdirSync(sandboxDir);
    for (const item of list) {
      if (/^test[1-5]$/i.test(item)) continue;
      const rel = `src/sandbox/${item}`;
      if (fs.statSync(path.join(sandboxDir, item)).isFile()) {
        allSandboxFiles.push(rel);
      }
    }
  }

  const combinedTargets = Array.from(new Set([...targetFiles, ...allSandboxFiles]));
  const pyTestFiles = combinedTargets.filter(f => f.endsWith('.py') && isTestFile(f));
  const pyImplFiles = combinedTargets.filter(f => f.endsWith('.py') && !isTestFile(f));
  const isWebProject = targetFiles.some(f => f.endsWith('.html') || f.endsWith('.css') || (f.endsWith('.js') && !f.includes('.test.')));
  const hasTargetPyFiles = targetFiles.some(f => f.endsWith('.py'));

  if (isWebProject && !hasTargetPyFiles) {
    const htmlFiles = targetFiles.filter(f => f.endsWith('.html'));
    let webPassed = true;
    let summaryText = 'Static HTML/Web project validation PASSED cleanly.';

    for (const hf of htmlFiles) {
      if (fs.existsSync(hf)) {
        const content = fs.readFileSync(hf, 'utf-8');
        if (!content.includes('<!DOCTYPE html>') && !content.includes('<html')) {
          webPassed = false;
          summaryText = `HTML validation warning: '${hf}' missing DOCTYPE html declaration`;
        }
      }
    }

    return {
      passed: webPassed,
      exitCode: webPassed ? 0 : 1,
      stdout: summaryText,
      stderr: webPassed ? '' : summaryText,
      summary: summaryText,
      testedFiles: targetFiles
    };
  }

  // If there are Python test files in src/sandbox or src/sandbox/tests, run Python tests via Docker Sandbox engine
  const testsDir = path.resolve(sandboxDir, 'tests');
  const hasPyTestInSubdir = fs.existsSync(testsDir) && fs.readdirSync(testsDir).some(f => f.startsWith('test_') && f.endsWith('.py'));

  if ((pyTestFiles.length > 0 || (hasPyTestInSubdir && hasTargetPyFiles)) && hasTargetPyFiles) {
    const isDockerAvailable = await dockerSandbox.checkDockerAvailable(true);
    const env: 'docker' | 'process' = isDockerAvailable ? 'docker' : 'process';

    // Command selection
    let pyTestCmd = `python -m unittest discover -s src/sandbox -p "test_*.py"`;
    if (hasPyTestInSubdir) {
      pyTestCmd = `python -m unittest discover -s src/sandbox/tests -p "test_*.py"`;
    }
    if (pyTestFiles.length > 0) {
      const formattedFiles = pyTestFiles.map(f => f.replace(/\\/g, '/'));
      pyTestCmd = `python -m unittest ${formattedFiles.join(' ')}`;
    }

    const sandboxResult = await dockerSandbox.executeSandboxedCommand(pyTestCmd, rootDir);
    const passed = sandboxResult.success;
    const logText = sandboxResult.output || '';

    // Classify failure type accurately
    let failureType: TestFailureType = 'TEST_FAILURE';
    if (!passed) {
      if (/not recognized as an internal or external command|command not found|permission denied|docker error|TOOL_EXECUTION_FAILURE|invalid command/i.test(logText)) {
        failureType = 'TOOL_EXECUTION_FAILURE';
      } else if (/SyntaxError|IndentationError|ImportError|ModuleNotFoundError/i.test(logText)) {
        failureType = 'CODE_FAILURE';
      } else if (/timed out|ETIMEDOUT/i.test(logText)) {
        failureType = 'TIMEOUT';
      }
    }

    // Extract errorType and errorMessage
    let errorType = failureType === 'TOOL_EXECUTION_FAILURE' ? 'ToolExecutionError' : 'AssertionError';
    let errorMessage = failureType === 'TOOL_EXECUTION_FAILURE' ? 'Command/Tool execution failed' : 'Test failed';
    const errMatch = logText.match(/(\b[A-Za-z0-9_]*Error\b):\s*(.+)/);
    if (errMatch) {
      errorType = errMatch[1].trim();
      errorMessage = errMatch[2].trim();
    } else if (logText.includes('FAIL:')) {
      errorType = 'AssertionError';
      const failLine = logText.split('\n').find(l => l.includes('FAIL:')) || 'Assertion failure';
      errorMessage = failLine.trim();
    }

    const primaryTestFile = pyTestFiles[0] || (hasPyTestInSubdir ? 'src/sandbox/tests/test_buggy_divide.py' : 'src/sandbox/test_buggy_divide.py');
    const primaryImplFile = pyImplFiles[0] || primaryTestFile.replace('test_', '').replace('/tests/', '/');

    let structuredFailure: StructuredTestFailure | undefined = undefined;
    if (!passed) {
      structuredFailure = {
        success: false,
        executionEnvironment: env,
        targetFiles: pyImplFiles.length > 0 ? pyImplFiles : [primaryImplFile],
        testFiles: pyTestFiles.length > 0 ? pyTestFiles : [primaryTestFile],
        command: isDockerAvailable ? `docker run --rm -v "src/sandbox:/app" -w /app python:alpine ${pyTestCmd}` : pyTestCmd,
        exitCode: sandboxResult.exitCode || 1,
        stdout: sandboxResult.output,
        stderr: sandboxResult.output,
        failureType,
        errorType,
        errorMessage,
        sourceFile: primaryImplFile,
        testFile: primaryTestFile,
        summary: `Python unit test failed [${failureType}] (${errorType}: ${errorMessage})`
      };
    }

    return {
      passed,
      exitCode: sandboxResult.exitCode,
      stdout: sandboxResult.output,
      stderr: sandboxResult.output,
      summary: passed ? 'Python unit tests PASSED cleanly in Docker Sandbox.' : `Python unit tests FAILED in Docker Sandbox [${failureType}] (${errorType}: ${errorMessage}).`,
      testedFiles: combinedTargets,
      failureType: passed ? undefined : failureType,
      structuredFailure
    };
  }

  // 1. Run Universal Multi-Language Validation Pipeline Gate for non-Python / mixed stacks
  const sandboxFiles: FileMetadata[] = allSandboxFiles.map(f => ({ name: path.basename(f), path: f }));
  try {
    const report = await validateBeforeSubmission(sandboxFiles, rootDir);
    const passed = report.canSubmit;
    const summary = report.formattedReport;
    const testedFiles = targetFiles.length > 0 ? targetFiles : sandboxFiles.map(f => f.path || f.name);

    let structuredFailure: StructuredTestFailure | undefined = undefined;
    if (!passed) {
      const isDockerAvailable = await dockerSandbox.checkDockerAvailable(true);
      structuredFailure = {
        success: false,
        executionEnvironment: isDockerAvailable ? 'docker' : 'process',
        targetFiles: targetFiles.filter(f => !isTestFile(f)),
        testFiles: targetFiles.filter(f => isTestFile(f)),
        command: 'npm test',
        exitCode: 1,
        stdout: summary,
        stderr: report.reason || 'Validation pipeline failure',
        failureType: 'TEST_FAILURE',
        errorType: 'ValidationError',
        errorMessage: report.reason || 'Validation gate blocked',
        sourceFile: targetFiles.find(f => !isTestFile(f)) || 'src/sandbox/main.ts',
        testFile: targetFiles.find(f => isTestFile(f)) || '',
        summary: `Universal validation pipeline failed`
      };
    }

    return {
      passed,
      exitCode: passed ? 0 : 1,
      stdout: summary,
      stderr: report.reason || '',
      summary,
      testedFiles,
      structuredFailure
    };
  } catch (err: any) {
    return new Promise<TestExecutionResult>((resolve) => {
      exec('npx ts-node src/sandbox/main.ts', { cwd: rootDir, timeout: 15000 }, (error, stdout, stderr) => {
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
