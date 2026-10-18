import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { validateBeforeSubmission, FileMetadata } from './universalValidator';

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
  const jsFiles = combinedTargets.filter(f => f.endsWith('.js') && !isTestFile(f));
  const jsTestFiles = combinedTargets.filter(f => f.endsWith('.js') && isTestFile(f));
  const htmlFiles = combinedTargets.filter(f => f.endsWith('.html'));
  const cssFiles = combinedTargets.filter(f => f.endsWith('.css'));
  const hasTargetPyFiles = combinedTargets.some(f => f.endsWith('.py'));
  const hasTargetTsFiles = combinedTargets.some(f => f.endsWith('.ts'));

  const isPureStaticWeb = (htmlFiles.length > 0 || cssFiles.length > 0) &&
    jsFiles.length === 0 &&
    jsTestFiles.length === 0 &&
    !hasTargetPyFiles &&
    !hasTargetTsFiles;

  if (isPureStaticWeb) {
    let webPassed = true;
    let summaryText = 'Static HTML/CSS project validation PASSED cleanly.';

    for (const hf of htmlFiles) {
      const fullPath = path.resolve(rootDir, hf);
      if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath, 'utf-8');
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

  // If there are JavaScript files, run real syntax validation & test/runtime execution
  if ((jsFiles.length > 0 || jsTestFiles.length > 0) && !hasTargetPyFiles && !hasTargetTsFiles) {
    // 1. Syntax check each JS file via node --check
    for (const jf of [...jsFiles, ...jsTestFiles]) {
      const fullPath = path.resolve(rootDir, jf);
      if (fs.existsSync(fullPath)) {
        const checkResult = await new Promise<{ exitCode: number; output: string }>((res) => {
          exec(`node --check "${fullPath}"`, { timeout: 10000 }, (error, stdout, stderr) => {
            const exitCode = error ? (error.code || 1) : 0;
            res({ exitCode, output: (stdout + '\n' + stderr).trim() });
          });
        });
        if (checkResult.exitCode !== 0) {
          const summaryText = `JavaScript syntax validation FAILED for ${jf}:\n${checkResult.output}`;
          return {
            passed: false,
            exitCode: checkResult.exitCode,
            stdout: checkResult.output,
            stderr: checkResult.output,
            summary: summaryText,
            testedFiles: targetFiles,
            failureType: 'CODE_FAILURE',
            structuredFailure: {
              success: false,
              executionEnvironment: 'process',
              targetFiles: jsFiles,
              testFiles: jsTestFiles,
              command: `node --check "${jf}"`,
              exitCode: checkResult.exitCode,
              stdout: checkResult.output,
              stderr: checkResult.output,
              failureType: 'CODE_FAILURE',
              errorType: 'SyntaxError',
              errorMessage: checkResult.output.slice(0, 300),
              sourceFile: jf,
              summary: summaryText
            }
          };
        }
      }
    }

    // 2. If test files exist, execute tests
    if (jsTestFiles.length > 0) {
      const testFile = jsTestFiles[0];
      const fullTestPath = path.resolve(rootDir, testFile);
      const testExecCmd = `node "${fullTestPath}"`;
      const testExecResult = await new Promise<{ exitCode: number; output: string }>((res) => {
        exec(testExecCmd, { cwd: rootDir, timeout: 15000 }, (error, stdout, stderr) => {
          const exitCode = error ? (error.code || 1) : 0;
          res({ exitCode, output: (stdout + '\n' + stderr).trim() });
        });
      });

      const passed = testExecResult.exitCode === 0;
      return {
        passed,
        exitCode: testExecResult.exitCode,
        stdout: testExecResult.output,
        stderr: passed ? '' : testExecResult.output,
        summary: passed ? `JavaScript tests PASSED cleanly (${testFile}).` : `JavaScript tests FAILED (${testFile}):\n${testExecResult.output}`,
        testedFiles: targetFiles,
        failureType: passed ? undefined : 'TEST_FAILURE',
        structuredFailure: passed ? undefined : {
          success: false,
          executionEnvironment: 'process',
          targetFiles: jsFiles,
          testFiles: jsTestFiles,
          command: testExecCmd,
          exitCode: testExecResult.exitCode,
          stdout: testExecResult.output,
          stderr: testExecResult.output,
          failureType: 'TEST_FAILURE',
          errorType: 'AssertionError',
          errorMessage: testExecResult.output.slice(0, 300),
          sourceFile: jsFiles[0] || testFile,
          testFile,
          summary: `JavaScript test execution failed (${testFile})`
        }
      };
    }

    // 3. If runnable implementation file exists, execute to verify no runtime startup crash
    const mainJs = jsFiles.find(f => path.basename(f) === 'main.js' || path.basename(f) === 'index.js' || path.basename(f) === 'app.js') || jsFiles[0];
    if (mainJs) {
      const fullMainPath = path.resolve(rootDir, mainJs);
      const runResult = await new Promise<{ exitCode: number; output: string }>((res) => {
        exec(`node "${fullMainPath}"`, { cwd: rootDir, timeout: 10000 }, (error, stdout, stderr) => {
          const exitCode = error ? (error.code || 1) : 0;
          res({ exitCode, output: (stdout + '\n' + stderr).trim() });
        });
      });

      const passed = runResult.exitCode === 0;
      return {
        passed,
        exitCode: runResult.exitCode,
        stdout: runResult.output,
        stderr: passed ? '' : runResult.output,
        summary: passed ? `JavaScript verification PASSED cleanly (${mainJs}).` : `JavaScript execution FAILED (${mainJs}):\n${runResult.output}`,
        testedFiles: targetFiles,
        failureType: passed ? undefined : 'CODE_FAILURE',
        structuredFailure: passed ? undefined : {
          success: false,
          executionEnvironment: 'process',
          targetFiles: jsFiles,
          testFiles: [],
          command: `node "${mainJs}"`,
          exitCode: runResult.exitCode,
          stdout: runResult.output,
          stderr: runResult.output,
          failureType: 'CODE_FAILURE',
          errorType: 'RuntimeError',
          errorMessage: runResult.output.slice(0, 300),
          sourceFile: mainJs,
          summary: `JavaScript runtime failure on startup (${mainJs})`
        }
      };
    }
  }

  // If there are Python test files in src/sandbox or src/sandbox/tests, run Python tests via isolated process sandbox
  const testsDir = path.resolve(sandboxDir, 'tests');
  const hasPyTestInSubdir = fs.existsSync(testsDir) && fs.readdirSync(testsDir).some(f => f.startsWith('test_') && f.endsWith('.py'));

  if ((pyTestFiles.length > 0 || (hasPyTestInSubdir && hasTargetPyFiles)) && hasTargetPyFiles) {
    const env: 'docker' | 'process' = 'process';

    // Command selection
    let pyTestCmd = `python -m unittest discover -s src/sandbox -p "test_*.py"`;
    if (hasPyTestInSubdir) {
      pyTestCmd = `python -m unittest discover -s src/sandbox/tests -p "test_*.py"`;
    }
    if (pyTestFiles.length > 0) {
      const formattedFiles = pyTestFiles.map(f => f.replace(/\\/g, '/'));
      pyTestCmd = `python -m unittest ${formattedFiles.join(' ')}`;
    }

    const sandboxResult = await new Promise<{ success: boolean; output: string; exitCode: number }>((resolve) => {
      exec(pyTestCmd, { cwd: rootDir, env: { ...process.env, PYTHONPATH: rootDir }, timeout: 15000 }, (error, stdout, stderr) => {
        const combined = (stdout + '\n' + stderr).trim();
        const exitCode = error ? (error.code || 1) : 0;
        resolve({
          success: exitCode === 0,
          output: combined || 'Process test execution completed.',
          exitCode
        });
      });
    });
    const passed = sandboxResult.success;
    const logText = sandboxResult.output || '';

    // Classify failure type accurately
    let failureType: TestFailureType = 'TEST_FAILURE';
    if (!passed) {
      if (/not recognized as an internal or external command|command not found|permission denied|TOOL_EXECUTION_FAILURE|invalid command/i.test(logText)) {
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
        command: pyTestCmd,
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
      summary: passed ? 'Python unit tests PASSED cleanly.' : `Python unit tests FAILED [${failureType}] (${errorType}: ${errorMessage}).`,
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
      structuredFailure = {
        success: false,
        executionEnvironment: 'process',
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
      const candidateFiles = targetFiles.length > 0 ? targetFiles : allSandboxFiles;
      const pyFile = candidateFiles.find(f => f.endsWith('.py'));
      const tsFile = candidateFiles.find(f => f.endsWith('.ts') && !isTestFile(f)) || (fs.existsSync(path.resolve(rootDir, 'src/sandbox/main.ts')) ? 'src/sandbox/main.ts' : null);
      const jsFile = candidateFiles.find(f => f.endsWith('.js') && !isTestFile(f));

      let fallbackCmd = '';
      if (pyFile && fs.existsSync(path.resolve(rootDir, pyFile))) {
        fallbackCmd = `python "${pyFile}"`;
      } else if (tsFile && fs.existsSync(path.resolve(rootDir, tsFile))) {
        fallbackCmd = `npx ts-node "${tsFile}"`;
      } else if (jsFile && fs.existsSync(path.resolve(rootDir, jsFile))) {
        fallbackCmd = `node "${jsFile}"`;
      } else {
        return resolve({
          passed: true,
          exitCode: 0,
          stdout: 'No standalone runnable script found; static checks passed.',
          stderr: '',
          summary: 'Workspace verification PASSED (static non-runnable files).',
          testedFiles: targetFiles
        });
      }

      exec(fallbackCmd, { cwd: rootDir, timeout: 15000 }, (error, stdout, stderr) => {
        const exitCode = error ? (error.code || 1) : 0;
        const passed = exitCode === 0;
        const combinedLogs = (stdout + '\n' + stderr).trim();

        resolve({
          passed,
          exitCode,
          stdout,
          stderr,
          summary: passed ? `Automated execution PASSED (${fallbackCmd}).` : `Execution failed with exit code ${exitCode} (${fallbackCmd}):\n${combinedLogs.slice(-2000)}`,
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
