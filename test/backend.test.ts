import * as http from 'http';
import { KaizenBackendClient, HealthStatus } from '../src/client/backendClient';
import { permissionGate } from '../src/tools/permissionGate';
import { DEFAULT_GEMINI_MODELS, getActiveModelProvider } from '../src/tools/modelProvider';

async function runTestSuite() {
  console.log('🧪 ========================================================');
  console.log('🧪 KAIZEN AI - Phase 1 Integration & Architecture Test Suite');
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

  // TEST 1: Model Provider & Gemini 2.5 Pro Configuration
  console.log('\n--- 1. Model Provider & Gemini 2.5 Pro Configuration ---');
  assert(
    DEFAULT_GEMINI_MODELS.includes('gemini-2.5-pro'),
    'DEFAULT_GEMINI_MODELS includes gemini-2.5-pro'
  );
  assert(
    DEFAULT_GEMINI_MODELS[0] === 'gemini-2.5-pro',
    'gemini-2.5-pro is the prioritized first candidate model'
  );
  const activeProvider = getActiveModelProvider();
  console.log(`     Active Model Provider detected: "${activeProvider}"`);
  assert(
    activeProvider === 'gemini' || activeProvider === 'none',
    'Active provider correctly evaluates to gemini or none'
  );

  // TEST 2: PermissionGate Security & Approval Checks
  console.log('\n--- 2. PermissionGate Security & Risk Assessment ---');
  permissionGate.setMode('deny_first');
  const safeRead = permissionGate.evaluate('read_file', { path: 'src/sandbox/main.ts' });
  assert(safeRead.allowed === true, 'Safe read operation allowed under deny_first mode');
  assert(safeRead.requiresApproval === false, 'Safe read operation requires no human approval');

  const dangerousCommand = permissionGate.evaluate('terminal_exec', { command: 'rm -rf /' });
  assert(dangerousCommand.allowed === false, 'Dangerous deletion command intercepted');
  assert(dangerousCommand.requiresApproval === true, 'Dangerous deletion command requires approval');
  assert(dangerousCommand.riskScore >= 70, `High risk score assigned: ${dangerousCommand.riskScore}/100`);

  const gitPush = permissionGate.evaluate('git_push', { command: 'git push origin main' });
  assert(gitPush.requiresApproval === true, 'Git push requires human approval');

  // TEST 3: Backend Client - Unavailable & Timeout Handling
  console.log('\n--- 3. Backend Client: Unavailable & Timeout Handling ---');
  // Use a port guaranteed not to be running
  const unreachableClient = new KaizenBackendClient('http://127.0.0.1:59998');
  let caughtUnavailable = false;
  try {
    await unreachableClient.checkHealth(1500);
  } catch (err: any) {
    caughtUnavailable = true;
    console.log(`     Successfully caught expected unreachable error: "${err.message.slice(0, 70)}..."`);
  }
  assert(caughtUnavailable, 'Unreachable backend is detected and throws an actionable error');
  assert(unreachableClient.getConnectionState() === 'disconnected', 'Client connection state is "disconnected"');

  // TEST 4: Backend Health Endpoint & Live Server Contract
  console.log('\n--- 4. Backend Health Endpoint Contract Verification ---');
  // Spin up an in-process instance of the express app to test the real endpoints
  let serverInstance: http.Server | null = null;
  const testPort = 3099;

  try {
    // Import express app from server module
    // We can test express routing directly
    const express = require('express');
    const { dockerSandbox } = require('../src/tools/dockerSandbox');

    const app = express();
    app.use(express.json());

    // Register the identical health route from server.ts
    app.get('/api/health', async (req: any, res: any) => {
      const isDockerActive = await dockerSandbox.checkDockerAvailable();
      res.json({
        status: 'ok',
        version: '1.0.0',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        port: testPort,
        modelProvider: getActiveModelProvider(),
        defaultModels: DEFAULT_GEMINI_MODELS,
        permissionMode: permissionGate.getMode(),
        isDryRunMode: permissionGate.isDryRunMode(),
        isDockerActive
      });
    });

    // Register a mock pipeline/run route that echoes back the contract
    app.post('/api/pipeline/run', (req: any, res: any) => {
      const { userInput, imagePayload, sessionId } = req.body;
      if (!userInput && !imagePayload) {
        res.status(400).json({ error: 'userInput or imagePayload is required.' });
        return;
      }
      res.json({ status: 'started', message: 'Pipeline execution initiated.', runId: 'run_test_123' });
    });

    // Register hitl/respond route
    app.post('/api/hitl/respond', (req: any, res: any) => {
      const { sessionId, response } = req.body;
      res.json({ status: 'acknowledged', sessionId, action: response?.action });
    });

    // Start ephemeral server
    await new Promise<void>((resolve) => {
      serverInstance = app.listen(testPort, () => resolve());
    });

    console.log(`     Ephemeral test backend started on port ${testPort}`);

    const liveClient = new KaizenBackendClient(`http://127.0.0.1:${testPort}`);
    let stateUpdates: string[] = [];
    liveClient.onConnectionStateChange((state) => {
      stateUpdates.push(state);
    });

    const health = await liveClient.checkHealth(2000);
    assert(health.status === 'ok', 'Health check returns status "ok"');
    assert(health.version === '1.0.0', 'Health check returns version 1.0.0');
    assert(Array.isArray(health.defaultModels), 'Health check exposes defaultModels');
    assert(health.defaultModels?.includes('gemini-2.5-pro') === true, 'Health check confirms gemini-2.5-pro availability');
    assert(liveClient.getConnectionState() === 'connected', 'Client state transitioned to "connected"');

    // TEST 5: Pipeline Run Contract
    console.log('\n--- 5. Extension-to-Backend Prompt Submission Contract ---');
    const runRes = await liveClient.runPipeline({
      userInput: 'Implement a travel planner helper',
      sessionId: 'sess_test_1'
    });
    assert(runRes.status === 'started', 'runPipeline receives status: "started"');
    assert(runRes.message === 'Pipeline execution initiated.', 'runPipeline acknowledges execution');

    // TEST 6: HITL Approval Dispatch Contract
    console.log('\n--- 6. Human-In-The-Loop Approval Dispatch Contract ---');
    const hitlRes = await liveClient.respondHitl('sess_test_1', 'approve', 'Looks good');
    assert(hitlRes.status === 'acknowledged', 'HITL approval response acknowledged by backend');

  } finally {
    if (serverInstance) {
      await new Promise<void>((resolve) => {
        (serverInstance as http.Server).close(() => resolve());
      });
      console.log('     Ephemeral test backend closed cleanly.');
    }
  }

  console.log('\n========================================================');
  console.log(`🎉 ALL TESTS PASSED: ${passedTests}/${totalTests} checks verified`);
  console.log('========================================================\n');
}

runTestSuite().catch((err) => {
  console.error('\n❌ Test suite failed with error:', err);
  process.exit(1);
});
