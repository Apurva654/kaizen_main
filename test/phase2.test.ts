import * as fs from 'fs';
import * as path from 'path';
import {
  failureSignature,
  patchHash,
  normalizeErrorLine,
  createHealGuardTracker
} from '../src/tools/healGuard';
import { runSelfHealLoop } from '../src/server';
import { KaizenStateType, PlanStep } from '../src/state';
import { TestExecutionResult } from '../src/tools/testRunner';

async function runPhase2TestSuite() {
  console.log('🧪 ========================================================');
  console.log('🧪 KAIZEN AI - Phase 2 Verification Test Suite');
  console.log('🧪 ========================================================\n');

  let passedTests = 0;
  let totalTests = 0;

  function assert(condition: boolean, testName: string, details?: string) {
    totalTests++;
    if (condition) {
      passedTests++;
      console.log(`  ✅ PASS: ${testName}`);
    } else {
      console.error(`  ❌ FAIL: ${testName} ${details ? '(' + details + ')' : ''}`);
      throw new Error(`Test assertion failed: ${testName}`);
    }
  }

  const baseState = (overrides: any = {}): any => ({
    userInput: 'Fix bug',
    originalUserRequest: 'Fix bug',
    targetFiles: ['src/sandbox/game.js'],
    structuredFailures: [],
    testLogs: '',
    compilerError: '',
    extractedContext: '',
    retryCount: 0,
    status: 'INITIALIZED',
    ...overrides
  });

  // --- 1. normalizeErrorLine unit tests ---
  console.log('\n--- 1. normalizeErrorLine unit tests ---');
  const winLine = 'TypeError: Cannot read property of undefined at C:\\Users\\APURVA\\repo\\src\\sandbox\\game.js:10:5';
  const normWin = normalizeErrorLine(winLine);
  assert(normWin.includes('game.js'), 'Normalizes Windows drive path', normWin);
  assert(!normWin.includes('C:\\Users'), 'Strips Windows drive prefix', normWin);

  const unixLine = 'Error: boom at /home/runner/work/repo/src/sandbox/game.js:20:1';
  const normUnix = normalizeErrorLine(unixLine);
  assert(normUnix.includes('game.js'), 'Normalizes Unix path', normUnix);
  assert(!normUnix.includes('/home/runner'), 'Strips Unix path prefix', normUnix);

  const tsLine = '2026-10-19T14:50:00.000Z [ERROR] Failed to execute query at index.js:1';
  const normTs = normalizeErrorLine(tsLine);
  assert(!normTs.includes('2026-10-19'), 'Strips ISO timestamp', normTs);

  // --- 2. failureSignature stability and uniqueness ---
  console.log('\n--- 2. failureSignature stability and uniqueness ---');
  const result1: TestExecutionResult = {
    passed: false,
    summary: 'Tests failed with 1 error',
    exitCode: 1,
    failureType: 'CODE_FAILURE',
    testedFiles: ['src/sandbox/game.js'],
    stdout: '',
    structuredFailure: {
      success: false,
      executionEnvironment: 'process',
      targetFiles: ['src/sandbox/game.js'],
      testFiles: [],
      command: 'node test',
      exitCode: 1,
      stdout: '',
      stderr: '',
      failureType: 'CODE_FAILURE',
      errorType: 'TypeError',
      errorMessage: 'x is not a function',
      sourceFile: 'src/sandbox/game.js'
    },
    stderr: '[14:50:00] TypeError: x is not a function at C:\\Users\\APURVA\\src\\sandbox\\game.js:42:10'
  };

  const result2: TestExecutionResult = {
    passed: false,
    summary: 'Tests failed with 1 error',
    exitCode: 1,
    failureType: 'CODE_FAILURE',
    testedFiles: ['src/sandbox/game.js'],
    stdout: '',
    structuredFailure: {
      success: false,
      executionEnvironment: 'process',
      targetFiles: ['src/sandbox/game.js'],
      testFiles: [],
      command: 'node test',
      exitCode: 1,
      stdout: '',
      stderr: '',
      failureType: 'CODE_FAILURE',
      errorType: 'TypeError',
      errorMessage: 'x is not a function',
      sourceFile: 'src/sandbox/game.js'
    },
    stderr: '[15:10:22] TypeError: x is not a function at /var/app/src/sandbox/game.js:42:10'
  };

  const sig1 = failureSignature(result1);
  const sig2 = failureSignature(result2);
  assert(sig1 === sig2, 'failureSignature matches across different environments and timestamps', `sig1=${sig1}, sig2=${sig2}`);

  const resultDifferent: TestExecutionResult = {
    passed: false,
    summary: 'Tests failed with ReferenceError',
    exitCode: 1,
    failureType: 'CODE_FAILURE',
    testedFiles: ['src/sandbox/game.js'],
    stdout: '',
    structuredFailure: {
      success: false,
      executionEnvironment: 'process',
      targetFiles: ['src/sandbox/game.js'],
      testFiles: [],
      command: 'node test',
      exitCode: 1,
      stdout: '',
      stderr: '',
      failureType: 'CODE_FAILURE',
      errorType: 'ReferenceError',
      errorMessage: 'y is not defined',
      sourceFile: 'src/sandbox/game.js'
    },
    stderr: 'ReferenceError: y is not defined at game.js:10:1'
  };
  const sigDifferent = failureSignature(resultDifferent);
  assert(sig1 !== sigDifferent, 'failureSignature differentiates distinct error types');

  // --- 3. patchHash sorting and uniqueness ---
  console.log('\n--- 3. patchHash sorting and uniqueness ---');
  const patchSetA = [
    { filePath: 'src/sandbox/b.js', code: 'console.log("b");' },
    { filePath: 'src/sandbox/a.js', code: 'console.log("a");' }
  ];
  const patchSetB = [
    { filePath: 'src/sandbox/a.js', code: 'console.log("a");' },
    { filePath: 'src/sandbox/b.js', code: 'console.log("b");' }
  ];
  const hashA = patchHash(patchSetA);
  const hashB = patchHash(patchSetB);
  assert(hashA === hashB, 'patchHash is independent of patch ordering in array');
  assert(hashA.length === 16, 'patchHash returns 16-char hex digest');

  const patchSetC = [
    { filePath: 'src/sandbox/a.js', code: 'console.log("modified");' }
  ];
  assert(hashA !== patchHash(patchSetC), 'patchHash changes when code differs');

  // --- 4. Heal loop guard: Prepending discovered failing files ---
  console.log('\n--- 4. Prepending discovered files so game.js is ranked first ---');
  const rootDir = process.cwd();
  const testSandboxFile = path.resolve(rootDir, 'src/sandbox/p2_game.js');
  fs.writeFileSync(testSandboxFile, '// temporary game file for test');

  try {
    const mockState: KaizenStateType = baseState({
      userInput: 'fix error',
      targetFiles: ['src/sandbox/index.html'],
      status: 'ROUTED_RUN_EXISTING_TESTS',
      retryCount: 0
    });

    const failingResult: TestExecutionResult = {
      passed: false,
      summary: 'Failure in src/sandbox/p2_game.js',
      exitCode: 1,
      failureType: 'CODE_FAILURE',
      testedFiles: ['src/sandbox/index.html'],
      stdout: '',
      stderr: 'Error: crash at src/sandbox/p2_game.js:12:4'
    };

    // Tracker creation test
    const tracker = createHealGuardTracker();
    assert(tracker.zeroPatchStreak === 0, 'Tracker initialized with 0 zeroPatchStreak');
    assert(tracker.seenSignatures.size === 0, 'Tracker initialized with empty seenSignatures');

    // Run self-heal loop in Mode A
    const savedPatches: any[] = [];
    const loopResult = await runSelfHealLoop({
      state: mockState,
      testResult: failingResult,
      emitSSE: () => {},
      sessionId: 'test_session_phase2',
      mode: 'A',
      appliedDebuggerPatches: [],
      completedStages: [],
      sessionSnapshots: new Map(),
      saveFilePatchesToServerDisk: (p) => savedPatches.push(...p),
      prepareDiffCards: async () => []
    });

    assert(mockState.targetFiles[0] === 'src/sandbox/p2_game.js', 'Failing file was prepended before index.html', JSON.stringify(mockState.targetFiles));
    assert(mockState.targetFiles.includes('src/sandbox/index.html'), 'Original targets preserved');
    assert(loopResult.testResult.passed === false, 'Test result remains failing');
    assert(typeof loopResult.failureMessage === 'string', 'failureMessage is populated');
    assert(Boolean(loopResult.failureMessage?.includes('Self-healing failed')), 'failureMessage has detailed self-heal info');
    assert(Boolean(loopResult.failureMessage?.includes('Signature:')), 'failureMessage includes failure signature');
    assert(loopResult.attemptsUsed <= 2, 'Halts after zeroPatchStreak reaches 2 (no blind 3 retries)', `Attempts used: ${loopResult.attemptsUsed}`);
  } finally {
    try { fs.unlinkSync(testSandboxFile); } catch {}
  }

  // --- 5. Heal loop: Signature recurrence stops debugger calling ---
  console.log('\n--- 5. Heal loop: Signature recurrence stops debugger calling ---');
  const mockStateSignature: KaizenStateType = baseState({
    userInput: 'fix recurring error',
    targetFiles: ['src/sandbox/game.js'],
    status: 'ROUTED_RUN_EXISTING_TESTS',
    retryCount: 0
  });

  const constantResult: TestExecutionResult = {
    passed: false,
    summary: 'Persistent Assertion Error',
    exitCode: 1,
    failureType: 'TEST_FAILURE',
    testedFiles: ['src/sandbox/game.js'],
    stdout: '',
    structuredFailure: {
      success: false,
      executionEnvironment: 'process',
      targetFiles: ['src/sandbox/game.js'],
      testFiles: [],
      command: 'node test',
      exitCode: 1,
      stdout: '',
      stderr: '',
      failureType: 'TEST_FAILURE',
      errorType: 'AssertionError',
      errorMessage: 'expected true to be false',
      sourceFile: 'src/sandbox/game.js'
    },
    stderr: 'AssertionError: expected true to be false at game.js:50:5'
  };

  const loopSigResult = await runSelfHealLoop({
    state: mockStateSignature,
    testResult: constantResult,
    emitSSE: () => {},
    sessionId: 'test_sig_session',
    mode: 'A',
    appliedDebuggerPatches: [],
    completedStages: [],
    sessionSnapshots: new Map(),
    saveFilePatchesToServerDisk: () => {},
    prepareDiffCards: async () => []
  });

  assert(loopSigResult.attemptsUsed <= 2, 'Debugger is not called for a third attempt when signature recurs or zero patches returned', `Attempts: ${loopSigResult.attemptsUsed}`);
  assert(Boolean(loopSigResult.failureMessage?.includes('Signature:')), 'Failure message contains signature');

  // --- 6. Heal loop: Mode B escalates to CoderAgent when plan exists ---
  console.log('\n--- 6. Heal loop: Mode B escalation sets reviewerFeedback and calls coder ---');
  const planSteps: PlanStep[] = [
    { id: 1, description: 'Implement speedometer UI', status: 'pending' },
    { id: 2, description: 'Bind physics speed', status: 'pending' }
  ];

  const mockStateModeB: KaizenStateType = baseState({
    userInput: 'Add speedometer feature',
    targetFiles: ['src/sandbox/game.js'],
    status: 'ROUTED_GENERATE_CODE',
    retryCount: 0,
    plan: planSteps
  });

  const modeBResult = await runSelfHealLoop({
    state: mockStateModeB,
    testResult: constantResult,
    emitSSE: () => {},
    sessionId: 'test_mode_b_session',
    mode: 'B',
    appliedDebuggerPatches: [],
    coderOutput: { filePatches: [] },
    completedStages: [],
    sessionSnapshots: new Map(),
    saveFilePatchesToServerDisk: () => {},
    prepareDiffCards: async () => []
  });

  assert(modeBResult.escalated === true, 'Mode B escalates when guard triggers');
  assert(typeof mockStateModeB.reviewerFeedback === 'string', 'Reviewer feedback is populated on escalation');
  assert(Boolean(mockStateModeB.reviewerFeedback?.includes('[SELF-HEAL ESCALATION MANDATE')), 'Mandate format applied to reviewerFeedback');
  assert(Boolean(/signature:/i.test(mockStateModeB.reviewerFeedback || '')), 'Reviewer feedback includes failure signature');

  console.log('\n========================================================');
  console.log(`Phase 2 Results: ${passedTests}/${totalTests} tests passed`);
  console.log('========================================================\n');
  process.exit(0);
}

runPhase2TestSuite().catch(err => {
  console.error('Phase 2 test suite failed with error:', err);
  process.exit(1);
});
