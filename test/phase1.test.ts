import * as fs from 'fs';
import * as path from 'path';
import { runWorkspaceTests, isBrowserProject, extractFailingFilesFromLogs } from '../src/tools/testRunner';
import { isTestFile } from '../src/tools/sandboxPathUtils';
import { debuggerAgentNode, resolveImplementationTarget } from '../src/agents/debuggerAgent';

async function runPhase1TestSuite() {
  console.log('🧪 ========================================================');
  console.log('🧪 KAIZEN AI - Phase 1 Verification Test Suite');
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

  const rootDir = process.cwd();
  const sandboxDir = path.resolve(rootDir, 'src/sandbox');
  if (!fs.existsSync(sandboxDir)) {
    fs.mkdirSync(sandboxDir, { recursive: true });
  }

  // --- 1. Shared isTestFile helper tests ---
  console.log('\n--- 1. Shared isTestFile unit tests ---');
  assert(isTestFile('src/sandbox/calculator.test.ts') === true, 'Matches .test.ts');
  assert(isTestFile('src/sandbox/game.test.js') === true, 'Matches .test.js');
  assert(isTestFile('src/sandbox/module.spec.ts') === true, 'Matches .spec.ts');
  assert(isTestFile('src/sandbox/module.spec.js') === true, 'Matches .spec.js');
  assert(isTestFile('src/sandbox/tests/helper.js') === true, 'Matches /tests/ directory');
  assert(isTestFile('src/sandbox/test/helper.js') === true, 'Matches /test/ directory');
  assert(isTestFile('src/sandbox/__tests__/helper.js') === true, 'Matches /__tests__/ directory');
  assert(isTestFile('src/sandbox/test_math.py') === true, 'Matches test_ prefix');
  assert(isTestFile('src/sandbox/math_test.py') === true, 'Matches _test.py suffix');
  assert(isTestFile('src/sandbox/math_test.js') === true, 'Matches _test.js suffix');
  assert(isTestFile('src/sandbox/math_test.ts') === true, 'Matches _test.ts suffix');
  assert(isTestFile('src/sandbox/game.js') === false, 'game.js is NOT a test file');
  assert(isTestFile('src/sandbox/index.html') === false, 'index.html is NOT a test file');
  assert(isTestFile('src/sandbox/styles.css') === false, 'styles.css is NOT a test file');

  // --- 2. testRunner: Browser project static-only pass ---
  console.log('\n--- 2. testRunner: Browser project with window API in game.js ---');
  const browserHtml = path.resolve(sandboxDir, 'p1_browser.html');
  const browserJs = path.resolve(sandboxDir, 'p1_game.js');
  const browserCss = path.resolve(sandboxDir, 'p1_styles.css');

  fs.writeFileSync(browserHtml, `<!DOCTYPE html>
<html>
<head>
  <link rel="stylesheet" href="p1_styles.css">
</head>
<body>
  <canvas id="game"></canvas>
  <script src="p1_game.js"></script>
</body>
</html>`);

  // This JS code throws in Node if executed directly (window/canvas is not defined)
  fs.writeFileSync(browserJs, `
const el = window.document.getElementById('game');
window.localStorage.setItem('score', '100');
window.requestAnimationFrame(() => {});
`);
  fs.writeFileSync(browserCss, 'body { margin: 0; background: #000; }');

  try {
    const isBrowser = isBrowserProject(['src/sandbox/p1_browser.html', 'src/sandbox/p1_game.js'], rootDir);
    assert(isBrowser === true, 'isBrowserProject identifies browser project correctly');

    const result = await runWorkspaceTests([
      'src/sandbox/p1_browser.html',
      'src/sandbox/p1_game.js',
      'src/sandbox/p1_styles.css'
    ]);

    assert(result.passed === true, 'Browser project passes validation without crashing', result.summary);
    assert(result.verificationLevel === 'static_only', 'VerificationLevel is static_only');
    assert(typeof result.verificationNote === 'string' && result.verificationNote.includes('Syntax + asset references validated'), 'VerificationNote accurately set');
  } finally {
    try { fs.unlinkSync(browserHtml); } catch {}
    try { fs.unlinkSync(browserJs); } catch {}
    try { fs.unlinkSync(browserCss); } catch {}
  }

  // --- 3. testRunner: HTML references missing script ---
  console.log('\n--- 3. testRunner: HTML references missing script ---');
  const missingHtml = path.resolve(sandboxDir, 'p1_missing.html');
  fs.writeFileSync(missingHtml, `<!DOCTYPE html>
<html>
<body>
  <script src="non_existent_asset_123.js"></script>
</body>
</html>`);

  try {
    const missingResult = await runWorkspaceTests(['src/sandbox/p1_missing.html']);
    assert(missingResult.passed === false, 'Fails when HTML references missing asset');
    assert(missingResult.failureType === 'CODE_FAILURE', 'FailureType is CODE_FAILURE');
    assert(
      missingResult.summary.includes('non_existent_asset_123.js') ||
      (missingResult.structuredFailure?.errorMessage || '').includes('non_existent_asset_123.js'),
      'Failure summary explicitly names the missing asset'
    );
  } finally {
    try { fs.unlinkSync(missingHtml); } catch {}
  }

  // --- 4. testRunner: game.js with import syntax passes module-safe syntax check ---
  console.log('\n--- 4. testRunner: game.js with import/export syntax ---');
  const esmHtml = path.resolve(sandboxDir, 'p1_esm.html');
  const esmJs = path.resolve(sandboxDir, 'p1_esm.js');
  fs.writeFileSync(esmHtml, `<!DOCTYPE html><html><body><script type="module" src="p1_esm.js"></script></body></html>`);
  fs.writeFileSync(esmJs, `
import { something } from './nonexistent_lib.js';
export function play() {
  window.requestAnimationFrame(() => {});
}
`);

  try {
    const esmResult = await runWorkspaceTests([
      'src/sandbox/p1_esm.html',
      'src/sandbox/p1_esm.js'
    ]);
    assert(esmResult.passed === true, 'ESM import/export in JS file passes module-safe syntax check without SyntaxError');
  } finally {
    try { fs.unlinkSync(esmHtml); } catch {}
    try { fs.unlinkSync(esmJs); } catch {}
  }

  // --- 5. testRunner: Node project (no HTML) still executes and fails on a real throw ---
  console.log('\n--- 5. testRunner: Node project (no HTML) throws runtime crash ---');
  const nodeJs = path.resolve(sandboxDir, 'p1_node_crash.js');
  fs.writeFileSync(nodeJs, `
function boom() {
  throw new Error("Deliberate startup runtime crash");
}
boom();
`);

  try {
    const nodeResult = await runWorkspaceTests(['src/sandbox/p1_node_crash.js']);
    assert(nodeResult.passed === false, 'Node runtime failure fails test runner');
    assert(nodeResult.failureType === 'CODE_FAILURE', 'Failure type is CODE_FAILURE');
    assert(
      nodeResult.summary.includes('Deliberate startup runtime crash') ||
      nodeResult.stdout.includes('Deliberate startup runtime crash') ||
      nodeResult.stderr.includes('Deliberate startup runtime crash'),
      'Error message preserved in test failure output'
    );
  } finally {
    try { fs.unlinkSync(nodeJs); } catch {}
  }

  // --- 6. server/heal: Target ranking prepends existing discovered files ---
  console.log('\n--- 6. server/heal: Discovered files prepended to targetFiles ---');
  const dummyGameJs = path.resolve(sandboxDir, 'p1_rank_game.js');
  fs.writeFileSync(dummyGameJs, '// game logic\n');

  try {
    let stateTargetFiles = ['src/sandbox/index.html'];
    const mockLogs = `Error occurred at src/sandbox/p1_rank_game.js:42:15 in updateLoop`;
    const discoveredFiles = extractFailingFilesFromLogs(mockLogs);
    const existingDiscovered = discoveredFiles.filter(f => fs.existsSync(f) || fs.existsSync(path.resolve(rootDir, f)));

    if (existingDiscovered.length > 0) {
      stateTargetFiles = Array.from(new Set([...existingDiscovered, ...stateTargetFiles]));
    }

    assert(stateTargetFiles[0] === 'src/sandbox/p1_rank_game.js', 'Discovered existing file is ranked FIRST before index.html');
    assert(stateTargetFiles[1] === 'src/sandbox/index.html', 'Previous target is preserved after discovered file');
  } finally {
    try { fs.unlinkSync(dummyGameJs); } catch {}
  }

  // --- 7. debuggerAgent: Prompt includes game.js source and PERMITTED FILES list ---
  console.log('\n--- 7. debuggerAgent: Prompt contains multi-target source & PERMITTED FILES list ---');
  const targetHtmlPath = path.resolve(sandboxDir, 'p1_dbg_index.html');
  const targetJsPath = path.resolve(sandboxDir, 'p1_dbg_game.js');

  fs.writeFileSync(targetHtmlPath, '<html><body><h1>Kaizen Game</h1></body></html>');
  fs.writeFileSync(targetJsPath, 'function initGame() { window.gameScore = 0; }');

  let capturedSystemPrompt = '';
  const mockRunner = async (opts: any) => {
    capturedSystemPrompt = opts.system;
    return {
      result: {
        rootCause: 'Window reference needs browser context or safe check',
        fixExplanation: 'Wrapped window access in safe check',
        files: [
          { filePath: 'src/sandbox/p1_dbg_game.js', code: 'function initGame() { if (typeof window !== "undefined") window.gameScore = 0; }' },
          { filePath: 'src/sandbox/p1_dbg_index.html', code: '<html><body><h1>Kaizen Game Updated</h1></body></html>' },
          { filePath: 'package.json', code: '{ "name": "hacked" }' },
          { filePath: 'src/sandbox/game.test.js', code: 'test("pass", () => {});' }
        ]
      },
      model: 'mock-gemini'
    };
  };

  try {
    const dbgState: any = {
      userInput: 'Fix game',
      targetFiles: ['src/sandbox/p1_dbg_index.html', 'src/sandbox/p1_dbg_game.js'],
      failureDetails: { summary: 'Error in p1_dbg_game.js:1:1' }
    };

    const dbgResult = await debuggerAgentNode(dbgState, { runStructuredFn: mockRunner as any });

    assert(capturedSystemPrompt.includes('PERMITTED FILES: [src/sandbox/p1_dbg_index.html, src/sandbox/p1_dbg_game.js]. Primary suspect: src/sandbox/p1_dbg_index.html.'), 'System prompt contains exact PERMITTED FILES format and primary suspect');
    assert(capturedSystemPrompt.includes('function initGame() { window.gameScore = 0; }'), 'System prompt contains game.js source code');
    assert(capturedSystemPrompt.includes('<html><body><h1>Kaizen Game</h1></body></html>'), 'System prompt contains index.html source code');

    // Verify security checks still reject package.json and game.test.js
    assert(dbgResult.filePatches.length === 2, 'Only legitimate implementation patches accepted');
    assert(!dbgResult.filePatches.some(p => p.filePath.includes('package.json')), 'Protected package.json patch was strictly rejected');
    assert(!dbgResult.filePatches.some(p => isTestFile(p.filePath)), 'Test file patch was strictly rejected');
  } finally {
    try { fs.unlinkSync(targetHtmlPath); } catch {}
    try { fs.unlinkSync(targetJsPath); } catch {}
  }

  // --- 8. debuggerAgent: failureReason tags on DEBUG_FAILED ---
  console.log('\n--- 8. debuggerAgent: failureReason tags on failure branches ---');
  const noTargetRes = await debuggerAgentNode({ targetFiles: [] } as any);
  assert(noTargetRes.status === 'DEBUG_FAILED', 'Status is DEBUG_FAILED for no target');
  assert(noTargetRes.failureReason === 'NO_TARGET', 'failureReason is NO_TARGET');

  const oldKey = process.env.GEMINI_API_KEY;
  try {
    process.env.GEMINI_API_KEY = '';
    const noKeyRes = await debuggerAgentNode({ targetFiles: ['src/sandbox/game.js'] } as any);
    assert(noKeyRes.status === 'DEBUG_FAILED', 'Status is DEBUG_FAILED for missing key');
    assert(noKeyRes.failureReason === 'LLM_UNAVAILABLE', 'failureReason is LLM_UNAVAILABLE');
  } finally {
    process.env.GEMINI_API_KEY = oldKey;
  }

  console.log(`\n========================================================`);
  console.log(`🎉 PHASE 1 VERIFICATION COMPLETE: ${passedTests}/${totalTests} CHECKS PASSED`);
  console.log(`========================================================\n`);
}

runPhase1TestSuite().catch(err => {
  console.error('Phase 1 test suite failed:', err);
  process.exit(1);
});
