import * as path from 'path';
import * as fs from 'fs';
import { parseStackFrame, runBrowserSmokeTest } from '../src/tools/browserSmokeTest';
import { runWorkspaceTests } from '../src/tools/testRunner';
import { runPipeline } from '../src/server';

async function runPhase4TestSuite() {
  console.log('🧪 ========================================================');
  console.log('🧪 KAIZEN AI - Phase 4 Verification Test Suite (Browser Runtime)');
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

  // --- 1. parseStackFrame unit tests ---
  console.log('\n--- 1. parseStackFrame tests ---');
  const frame1 = parseStackFrame(
    'TypeError: Cannot read properties of null (reading "addEventListener")\n    at initGame (http://localhost:3000/sandbox/game.js:45:12)'
  );
  assert(frame1.sourceFile === 'src/sandbox/game.js', 'Parses URL stack frame to normalized src/sandbox/game.js', frame1.sourceFile);
  assert(frame1.line === 45, 'Parses line number 45', String(frame1.line));
  assert(frame1.column === 12, 'Parses column number 12', String(frame1.column));
  assert(frame1.errorType === 'TypeError', 'Parses TypeError class', frame1.errorType);

  const frame2 = parseStackFrame(
    'ReferenceError: playerSpeed is not defined\n    at updatePhysics (http://127.0.0.1:54321/src/sandbox/physics.js:88:5)'
  );
  assert(frame2.sourceFile === 'src/sandbox/physics.js', 'Parses alternate URL path to src/sandbox/physics.js', frame2.sourceFile);
  assert(frame2.line === 88, 'Parses line number 88', String(frame2.line));
  assert(frame2.errorType === 'ReferenceError', 'Parses ReferenceError class', frame2.errorType);

  const frame3 = parseStackFrame(
    'SyntaxError: Unexpected token import\n    at file:///C:/workspace/src/sandbox/main.js:14:3'
  );
  assert(frame3.sourceFile === 'src/sandbox/main.js', 'Parses file:// URL to src/sandbox/main.js', frame3.sourceFile);
  assert(frame3.line === 14, 'Parses line number 14', String(frame3.line));
  assert(frame3.errorType === 'SyntaxError', 'Parses SyntaxError class', frame3.errorType);

  // --- 2. Headless Browser Smoke Test Execution ---
  console.log('\n--- 2. Headless Browser Smoke Test Execution ---');
  const sandboxDir = path.resolve(process.cwd(), 'src/sandbox');
  if (!fs.existsSync(sandboxDir)) {
    fs.mkdirSync(sandboxDir, { recursive: true });
  }

  const testHtml = path.resolve(sandboxDir, 'index.html');
  const testJs = path.resolve(sandboxDir, 'game.js');
  const testCss = path.resolve(sandboxDir, 'styles.css');

  let originalJsContent: string | null = null;
  if (fs.existsSync(testJs)) {
    originalJsContent = fs.readFileSync(testJs, 'utf-8');
  }

  try {
    // 2a. Clean browser project pass
    fs.writeFileSync(testHtml, '<!DOCTYPE html><html><body><script src="game.js"></script></body></html>', 'utf-8');
    fs.writeFileSync(testJs, 'let count = 0;\nfunction increment() { count++; }\nconsole.log("Game started");\n', 'utf-8');

    const cleanResult = await runBrowserSmokeTest(sandboxDir, process.cwd(), 'index.html');
    if (cleanResult.available) {
      assert(cleanResult.passed === true, 'Smoke test PASSED on clean browser project');
      assert(cleanResult.verificationLevel === 'browser_smoke', 'verificationLevel is browser_smoke on pass');
    } else {
      assert(cleanResult.verificationLevel === 'static_only', 'Degrades gracefully to static_only if browser unavailable');
    }

    // 2b. Runtime exception failure in browser project
    fs.writeFileSync(
      testJs,
      '// game runtime\nfunction crash() { throw new ReferenceError("carEngine is not defined"); }\ncrash();\n',
      'utf-8'
    );

    const errorResult = await runBrowserSmokeTest(sandboxDir, process.cwd(), 'index.html');
    if (errorResult.available) {
      assert(errorResult.passed === false, 'Smoke test detected runtime crash in browser project');
      assert(errorResult.errors.length > 0, 'Collected runtime errors');
      const pageErr = errorResult.errors.find(e => e.type === 'pageerror');
      assert(!!pageErr, 'Captured uncaught pageerror');
      assert(pageErr?.errorType === 'ReferenceError', 'Identified ReferenceError type', pageErr?.errorType);
      assert(pageErr?.sourceFile === 'src/sandbox/game.js', 'Identified sourceFile src/sandbox/game.js from stack frame', pageErr?.sourceFile);
    } else {
      console.log('  ⚠️ Skipping live browser failure assertion: headless browser unavailable in this environment.');
    }

    // --- 3. runWorkspaceTests Browser Integration ---
    console.log('\n--- 3. runWorkspaceTests browser integration ---');
    // Clean project test
    fs.writeFileSync(testJs, 'let speed = 50;\nconsole.log("Speed set to", speed);\n', 'utf-8');
    const wsCleanPass = await runWorkspaceTests(['src/sandbox/game.js', 'src/sandbox/index.html']);
    assert(wsCleanPass.passed === true, 'runWorkspaceTests passes for clean browser project');
    assert(
      wsCleanPass.verificationLevel === 'browser_smoke' || wsCleanPass.verificationLevel === 'static_only',
      'runWorkspaceTests returns browser_smoke or static_only',
      wsCleanPass.verificationLevel
    );

    // Static check failure (syntax error) caught before browser smoke test
    fs.writeFileSync(testJs, 'const = 123; // invalid syntax\n', 'utf-8');
    const wsSyntaxFail = await runWorkspaceTests(['src/sandbox/game.js', 'src/sandbox/index.html']);
    assert(wsSyntaxFail.passed === false, 'runWorkspaceTests fails on syntax error');
    assert(wsSyntaxFail.structuredFailure?.errorType === 'SyntaxError', 'Caught SyntaxError in static checks first');

    // Missing asset check caught statically
    fs.writeFileSync(testJs, 'console.log("clean");\n', 'utf-8');
    fs.writeFileSync(testHtml, '<!DOCTYPE html><html><body><script src="missing_file.js"></script></body></html>', 'utf-8');
    const wsAssetFail = await runWorkspaceTests(['src/sandbox/index.html']);
    assert(wsAssetFail.passed === false, 'runWorkspaceTests fails on missing asset reference');
    assert(wsAssetFail.structuredFailure?.errorType === 'AssetNotFoundError', 'Caught AssetNotFoundError in static check');

    // Reset clean files
    fs.writeFileSync(testHtml, '<!DOCTYPE html><html><body><script src="game.js"></script></body></html>', 'utf-8');
    fs.writeFileSync(testJs, 'console.log("Clean code");\n', 'utf-8');

    // --- 4. Pipeline Finalize & SSE Verification Level ---
    console.log('\n--- 4. pipeline_complete surfaces verificationLevel ---');
    const completeEvents: any[] = [];
    await runPipeline(
      'Review existing project status',
      undefined,
      'phase4_complete_test_session',
      (eventType, data) => {
        if (eventType === 'pipeline_complete') {
          completeEvents.push(data);
        }
      }
    );

    assert(completeEvents.length > 0, 'pipeline_complete event emitted');
    const payload = completeEvents[0];
    assert('verificationLevel' in payload, 'verificationLevel field exists in pipeline_complete payload');

  } finally {
    if (originalJsContent !== null) {
      fs.writeFileSync(testJs, originalJsContent, 'utf-8');
    }
  }

  console.log('\n========================================================');
  console.log(`Phase 4 Results: ${passedTests}/${totalTests} tests passed`);
  console.log('========================================================\n');
  process.exit(0);
}

runPhase4TestSuite().catch((err) => {
  console.error('Phase 4 test suite failed with error:', err);
  process.exit(1);
});
