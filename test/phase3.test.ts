import * as path from 'path';
import * as fs from 'fs';
import {
  hasErrorEvidence,
  hasEnhancementIntent,
  reconcileIntent,
  intentAgentNode,
  isBrowserQuery
} from '../src/agents/intentAgent';
import { normalizeSandboxPath } from '../src/tools/sandboxPathUtils';
import { runPipeline, resolvePendingHitl } from '../src/server';

async function runPhase3TestSuite() {
  console.log('🧪 ========================================================');
  console.log('🧪 KAIZEN AI - Phase 3 Verification Test Suite');
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

  // --- 1. hasErrorEvidence pure function tests ---
  console.log('\n--- 1. hasErrorEvidence tests ---');
  assert(hasErrorEvidence('TypeError: x is not a function at game.js:649') === true, 'Matches TypeError');
  assert(hasErrorEvidence('Uncaught ReferenceError: window is not defined') === true, 'Matches ReferenceError');
  assert(hasErrorEvidence('SyntaxError: Unexpected token import') === true, 'Matches SyntaxError');
  assert(hasErrorEvidence('AssertionError: expected 5 to equal 10') === true, 'Matches AssertionError');
  assert(hasErrorEvidence('Traceback (most recent call last):') === true, 'Matches Traceback');
  assert(hasErrorEvidence('at render (src/sandbox/game.js:120:15)') === true, 'Matches stack-frame pattern');
  assert(hasErrorEvidence('src/sandbox/game.js:42 error occurred') === true, 'Matches file.ext:line pattern');
  assert(hasErrorEvidence('error TS2304: Cannot find name') === true, 'Matches TS error code');
  assert(hasErrorEvidence('Error: ENOENT: no such file or directory') === true, 'Matches ENOENT');
  assert(hasErrorEvidence('Error: MODULE_NOT_FOUND') === true, 'Matches MODULE_NOT_FOUND');
  assert(hasErrorEvidence('1 failing test in suite') === true, 'Matches failing test');
  assert(hasErrorEvidence('process exited with exit code 1') === true, 'Matches exit code');
  assert(hasErrorEvidence('Upgrade the existing KAIZEN SPEEDWAY 3D game with better physics and a minimap') === false, 'False for feature upgrade request');
  assert(hasErrorEvidence('Refactor game.js into modules') === false, 'False for refactoring request');
  assert(hasErrorEvidence('What is a binary search tree?') === false, 'False for conceptual question');

  // --- 2. hasEnhancementIntent pure function tests ---
  console.log('\n--- 2. hasEnhancementIntent tests ---');
  assert(hasEnhancementIntent('Upgrade the existing KAIZEN SPEEDWAY 3D game') === true, 'Matches upgrade');
  assert(hasEnhancementIntent('Enhance the existing dashboard with real-time websocket charts') === true, 'Matches enhance');
  assert(hasEnhancementIntent('Improve the existing calculator project') === true, 'Matches improve');
  assert(hasEnhancementIntent('Extend the existing authentication module') === true, 'Matches extend');
  assert(hasEnhancementIntent('Overhaul the existing navigation menu') === true, 'Matches overhaul');
  assert(hasEnhancementIntent('Revamp the existing landing page') === true, 'Matches revamp');
  assert(hasEnhancementIntent('Polish the existing user settings modal') === true, 'Matches polish');
  assert(hasEnhancementIntent('Redesign the game UI') === true, 'Matches redesign');
  assert(hasEnhancementIntent('Rewrite the physics engine in WebGL') === true, 'Matches rewrite');
  assert(hasEnhancementIntent('Add feature to track lap times') === true, 'Matches add feature');
  assert(hasEnhancementIntent('Add support for gamepad controllers') === true, 'Matches add support');
  assert(hasEnhancementIntent('Implement realistic drift mechanics') === true, 'Matches implement');
  assert(hasEnhancementIntent('Build a minimap component') === true, 'Matches build');
  assert(hasEnhancementIntent('Make it better with smoother animations') === true, 'Matches make it better');
  assert(hasEnhancementIntent('TypeError: x is not a function at game.js:649') === false, 'False for pure error');
  assert(hasEnhancementIntent('git status and show changes') === false, 'False for git status');

  // --- 3. reconcileIntent pure function tests ---
  console.log('\n--- 3. reconcileIntent tests ---');
  // DEBUG_ERROR + enhancement wording + no error evidence -> GENERATE_CODE
  assert(
    reconcileIntent('DEBUG_ERROR', 'Upgrade the existing KAIZEN SPEEDWAY 3D game with better physics and a minimap') === 'GENERATE_CODE',
    'Reconciles DEBUG_ERROR + upgrade to GENERATE_CODE'
  );
  assert(
    reconcileIntent('RUN_EXISTING_TESTS', 'Enhance the existing dashboard with charts') === 'GENERATE_CODE',
    'Reconciles RUN_EXISTING_TESTS + enhance to GENERATE_CODE'
  );
  // DEBUG_ERROR + refactor wording + no error evidence -> REFACTOR
  assert(
    reconcileIntent('DEBUG_ERROR', 'Refactor game.js into modules and clean up code') === 'REFACTOR',
    'Reconciles DEBUG_ERROR + refactor to REFACTOR'
  );
  // DEBUG_ERROR with !hasErrorEvidence && no "fix|bug|broken|not working|crash" wording -> GENERATE_CODE
  assert(
    reconcileIntent('DEBUG_ERROR', 'Please inspect the project and make changes') === 'GENERATE_CODE',
    'Reconciles DEBUG_ERROR without evidence or bug keywords to GENERATE_CODE'
  );
  // DEBUG_ERROR with concrete error evidence -> keeps DEBUG_ERROR
  assert(
    reconcileIntent('DEBUG_ERROR', 'TypeError: x is not a function at game.js:649, fix it') === 'DEBUG_ERROR',
    'Preserves DEBUG_ERROR when concrete error evidence is present'
  );
  assert(
    reconcileIntent('DEBUG_ERROR', 'Fix the broken submit button in src/sandbox/index.html') === 'DEBUG_ERROR',
    'Preserves DEBUG_ERROR when broken keyword and file are present'
  );

  // --- 4. normalizeSandboxPath normalization tests ---
  console.log('\n--- 4. Path normalization tests ---');
  assert(normalizeSandboxPath('src/game.js') === 'src/sandbox/game.js', 'Normalizes src/game.js -> src/sandbox/game.js');
  assert(normalizeSandboxPath('game.js') === 'src/sandbox/game.js', 'Normalizes game.js -> src/sandbox/game.js');
  assert(normalizeSandboxPath('src/sandbox/game.js') === 'src/sandbox/game.js', 'Leaves src/sandbox/game.js unchanged');
  assert(normalizeSandboxPath('./src/game.js') === 'src/sandbox/game.js', 'Normalizes ./src/game.js');
  assert(normalizeSandboxPath('../outside.js') === '', 'Rejects path traversal ..');
  assert(normalizeSandboxPath('') === '', 'Empty path returns empty string');

  // --- 5. isBrowserQuery with 'existing' + build verb ---
  console.log('\n--- 5. isBrowserQuery with "existing" + build verb ---');
  assert(
    isBrowserQuery('Inspect the existing webpage and build a new contact form') === false,
    'Existing + build verb is not a browser query'
  );
  assert(
    isBrowserQuery('Open the existing project and upgrade the UI components') === false,
    'Existing + upgrade verb is not a browser query'
  );
  assert(
    isBrowserQuery('open src/sandbox/index.html and inspect it') === true,
    'Direct browser inspection request is a browser query'
  );

  // --- 6. intentAgentNode: Output path normalization and routing ---
  console.log('\n--- 6. intentAgentNode deterministic routing ---');
  const resUpgrade = await intentAgentNode({
    userInput: 'Upgrade the existing KAIZEN SPEEDWAY 3D game with better physics and a minimap',
    targetFiles: ['src/game.js']
  } as any);
  assert(resUpgrade.status === 'ROUTED_GENERATE_CODE', 'Upgrade existing routes to ROUTED_GENERATE_CODE', resUpgrade.status);
  assert(
    resUpgrade.targetFiles.every(f => f.startsWith('src/sandbox/')),
    'All targetFiles in ROUTED_GENERATE_CODE are normalized to src/sandbox/...',
    JSON.stringify(resUpgrade.targetFiles)
  );

  const resRefactor = await intentAgentNode({
    userInput: 'Refactor game.js into modules',
    targetFiles: ['src/game.js']
  } as any);
  assert(resRefactor.status === 'ROUTED_REFACTOR', 'Refactor routes to ROUTED_REFACTOR', resRefactor.status);
  assert(
    resRefactor.targetFiles.includes('src/sandbox/game.js'),
    'Target files normalized to src/sandbox/game.js',
    JSON.stringify(resRefactor.targetFiles)
  );

  // --- 7. Server Branch A safety net reroute ---
  console.log('\n--- 7. Server Branch A safety net reroute & upgrade tests ---');
  const sandboxDir = path.resolve(process.cwd(), 'src/sandbox');
  if (!fs.existsSync(sandboxDir)) {
    fs.mkdirSync(sandboxDir, { recursive: true });
  }
  const testHtml = path.resolve(sandboxDir, 'index.html');
  const testJs = path.resolve(sandboxDir, 'game.js');
  const testCss = path.resolve(sandboxDir, 'styles.css');
  const backupJs = path.resolve(sandboxDir, 'game.js.p3bak');

  let originalJsContent: string | null = null;
  if (fs.existsSync(testJs)) {
    originalJsContent = fs.readFileSync(testJs, 'utf-8');
  }

  try {
    // Write a compact, clean browser fixture so LLM runs deterministically fast
    fs.writeFileSync(testHtml, '<!DOCTYPE html><html><body><script src="game.js"></script></body></html>');
    fs.writeFileSync(testJs, '// Minimal game fixture\nlet score = 0;\nfunction addScore(pts) { score += pts; return score; }\n');
    if (!fs.existsSync(testCss)) {
      fs.writeFileSync(testCss, 'body { margin: 0; }');
    }

    // Test 7a: Branch A reroute: DEBUG_ERROR, tests pass, zero patches, no error evidence -> planner runs
    const events: Array<{ eventType: string; data: any }> = [];
    const promptBranchA = 'Fix the bug where score is not incrementing in src/sandbox/game.js';
    const finalStateA = await runPipeline(
      promptBranchA,
      undefined,
      'phase3_branch_a_reroute_session',
      (eventType, data) => {
        events.push({ eventType, data });
        if (eventType === 'hitl_request') {
          setTimeout(() => resolvePendingHitl(data.sessionId, 'approve'), 50);
        }
      },
      { initialStatus: 'ROUTED_DEBUG_ERROR' }
    );

    const reroutedStep = events.find(
      e => e.eventType === 'agent_step' &&
           e.data?.agent === 'DebuggerAgent' &&
           typeof e.data?.message === 'string' &&
           e.data.message.includes('Rerouting to Planner')
    );
    assert(
      !!reroutedStep,
      'Branch A safety net caught non-evidence debug request and rerouted to Planner',
      JSON.stringify(reroutedStep)
    );

    const plannerRan = events.some(
      e => e.eventType === 'agent_step' && e.data?.agent === 'PlannerAgent'
    );
    assert(plannerRan, 'PlannerAgent was executed after Branch A reroute');
    assert(finalStateA.status !== 'ROUTED_DEBUG_ERROR', 'State is not trapped in ROUTED_DEBUG_ERROR', finalStateA.status);

    // Reset sandbox files for Test 7b
    for (const extra of ['physics.js', 'minimap.js', 'ui.js']) {
      const p = path.resolve(sandboxDir, extra);
      if (fs.existsSync(p)) {
        try { fs.unlinkSync(p); } catch {}
      }
    }
    fs.writeFileSync(testHtml, '<!DOCTYPE html><html><body><script src="game.js"></script></body></html>');
    fs.writeFileSync(testJs, '// Minimal game fixture\nlet score = 0;\nfunction addScore(pts) { score += pts; return score; }\n');

    // Test 7b: End-to-end fixture: browser project upgrade request completes without a heal loop
    const upgradeEvents: Array<{ eventType: string; data: any }> = [];
    const finalStateUpgrade = await runPipeline(
      'Upgrade the existing KAIZEN SPEEDWAY 3D game with better physics and a minimap',
      undefined,
      'phase3_upgrade_session',
      (eventType, data) => {
        upgradeEvents.push({ eventType, data });
        if (eventType === 'hitl_request') {
          setTimeout(() => resolvePendingHitl(data.sessionId, 'approve'), 50);
        }
      }
    );

    const healLoopTriggered = upgradeEvents.some(
      e => e.eventType === 'agent_step' &&
           typeof e.data?.message === 'string' &&
           e.data.message.includes('Self-healing attempt')
    );
    assert(!healLoopTriggered, 'Browser project upgrade completed without triggering a self-healing loop');
    assert(
      finalStateUpgrade.status !== 'ROUTED_DEBUG_ERROR',
      'Browser project upgrade not trapped in ROUTED_DEBUG_ERROR',
      finalStateUpgrade.status
    );
  } finally {
    for (const extra of ['physics.js', 'minimap.js', 'ui.js']) {
      const p = path.resolve(sandboxDir, extra);
      if (fs.existsSync(p)) {
        try { fs.unlinkSync(p); } catch {}
      }
    }
    if (originalJsContent !== null) {
      fs.writeFileSync(testJs, originalJsContent, 'utf-8');
    }
  }

  console.log('\n========================================================');
  console.log(`Phase 3 Results: ${passedTests}/${totalTests} tests passed`);
  console.log('========================================================\n');
  process.exit(0);
}

runPhase3TestSuite().catch(err => {
  console.error('Phase 3 test suite failed with error:', err);
  process.exit(1);
});
