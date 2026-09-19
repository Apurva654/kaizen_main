import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { KaizenStateType } from './state';
import { intentAgentNode } from './agents/intentAgent';
import { contextRetrievalAgentNode } from './agents/contextRetrievalAgent';
import { plannerAgentNode } from './agents/plannerAgent';
import { codeGenAgentNode, isProtectedFile, GeneratedFilePatch } from './agents/codeGenAgent';
import { reviewerAgentNode } from './agents/reviewerAgent';
import { debuggerAgentNode } from './agents/debuggerAgent';
import { langfuseTracer } from './tools/langfuseTracer';
import { persistenceEngine } from './tools/persistenceEngine';
import { runWorkspaceTests, extractFailingFilesFromLogs } from './tools/testRunner';
import { preprocessUserRequest, saveAgentState, loadAgentState, recordConversationTurn } from './tools/context-manager';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../public')));

// Server-Sent Events (SSE) Clients list
let sseClients: Response[] = [];

function broadcastSSE(eventType: string, data: any) {
  const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(client => client.write(payload));
}

// SSE Connection Endpoint
app.get('/api/stream', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.push(res);
  res.write(`event: connected\ndata: ${JSON.stringify({ status: 'connected', clientsCount: sseClients.length })}\n\n`);

  req.on('close', () => {
    sseClients = sseClients.filter(c => c !== res);
  });
});

// Pending HITL (Human-In-The-Loop) Promises
let pendingHitlResolver: ((value: { action: 'approve' | 'reject' | 'feedback'; message?: string }) => void) | null = null;

// HITL Response Endpoint
app.post('/api/hitl/respond', (req: Request, res: Response) => {
  const { action, message } = req.body;
  if (pendingHitlResolver) {
    pendingHitlResolver({ action, message });
    pendingHitlResolver = null;
    res.json({ success: true, message: 'HITL response recorded.' });
  } else {
    res.status(400).json({ success: false, error: 'No pending HITL request.' });
  }
});

// Comprehensive Verification Test Suite Endpoint
app.get('/api/test/comprehensive', async (req: Request, res: Response) => {
  try {
    const { runComprehensiveTests } = await import('./tools/comprehensiveTestRunner');
    const results = await runComprehensiveTests();
    res.json({ success: true, results });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || String(err) });
  }
});

// Run Agent Pipeline Endpoint
app.post('/api/pipeline/run', async (req: Request, res: Response) => {
  const { userInput } = req.body;

  if (!userInput || typeof userInput !== 'string') {
    res.status(400).json({ error: 'userInput string is required.' });
    return;
  }

  // Send immediate response acknowledging execution
  res.json({ status: 'started', message: 'Pipeline execution initiated.' });

  // Execute pipeline asynchronously and broadcast step updates via SSE
  runPipeline(userInput);
});

function logDiagnostic(category: string, action: string, data: Record<string, any>) {
  console.log(`[KAIZEN][${category}] ${action}`, JSON.stringify(data));
}

async function runPipeline(rawUserInput: string) {
  const sessionId = persistenceEngine.generateSessionId();
  const runId = `run_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const createdAt = new Date().toISOString();

  const emitSSE = (eventType: string, data: any) => {
    broadcastSSE(eventType, { ...data, runId, sessionId });
  };

  logDiagnostic('RUN', 'INITIATED', { runId, sessionId, rawUserInput });
  emitSSE('pipeline_start', { sessionId, userInput: rawUserInput, timestamp: createdAt });

  // Preprocess input with context manager & handle special @ commands
  const processed = await preprocessUserRequest(rawUserInput);
  if (processed.isCommand && processed.commandResult) {
    emitSSE('agent_step', { agent: 'ContextManager', status: 'completed', message: 'Command executed.' });
    broadcastSSE('pipeline_complete', {
      sessionId,
      runId,
      status: 'GENERAL_COMPLETE',
      route: 'GENERAL_QUERY',
      explanation: processed.commandResult,
      completedStages: ['context'],
      skippedStages: ['intent', 'planner', 'coder', 'testrunner', 'debugger', 'reviewer']
    });
    return;
  }

  const userInput = processed.enhancedPrompt || rawUserInput;

  let state: KaizenStateType = {
    sessionId,
    runId,
    createdAt,
    userInput,
    targetFiles: [],
    extractedContext: "",
    plan: [],
    generatedPatch: "",
    choices: [],
    retryCount: 0,
    status: "INITIALIZED",
    lifecycleStatus: "RUNNING",
    currentStage: "intent",
    completedStages: [],
    skippedStages: [],
    generalAnswer: undefined
  };

  persistenceEngine.saveCheckpoint(sessionId, 'INITIALIZED', state);

  const completedStages: string[] = [];
  const skippedStages: string[] = [];

  const finalizeExecution = async (finalStatus: string, extraData: Record<string, any> = {}) => {
    state.lifecycleStatus = finalStatus;
    state.completedStages = Array.from(new Set(completedStages));
    state.skippedStages = Array.from(new Set(skippedStages));

    logDiagnostic('RUN', 'FINALIZING', { runId, finalStatus, completedStages, skippedStages });

    persistenceEngine.saveSession({
      sessionId,
      userInput,
      createdAt,
      updatedAt: new Date().toISOString(),
      status: finalStatus,
      targetFiles: state.targetFiles,
      plan: state.plan,
      retryCount: state.retryCount,
      ...extraData
    });

    saveAgentState({
      conversationId: sessionId,
      currentTask: rawUserInput,
      completedSteps: completedStages,
      generatedFiles: new Map((state.targetFiles || []).map(f => [f, 'updated'])),
      errors: (state as any).reviewReport?.issues || [],
      timestamp: new Date()
    });

    if (extraData.explanation || state.userInput) {
      recordConversationTurn(rawUserInput, extraData.explanation || 'Task executed successfully.');
    }

    emitSSE('pipeline_complete', {
      sessionId,
      status: finalStatus,
      targetFiles: state.targetFiles,
      plan: state.plan,
      completedStages,
      skippedStages,
      retryCount: state.retryCount,
      ...extraData
    });
  };

  try {
    // 1. Intent Agent
    logDiagnostic('GRAPH', 'ENTER IntentAgent', { userInput });
    emitSSE('agent_step', { agent: 'IntentAgent', status: 'running', message: 'Classifying user intent...' });
    const intentOutput = await intentAgentNode(state);
    state.status = intentOutput.status;
    state.targetFiles = intentOutput.targetFiles;
    completedStages.push('intent');
    logDiagnostic('GRAPH', 'EXIT IntentAgent', { status: state.status, targetFiles: state.targetFiles });
    persistenceEngine.saveCheckpoint(sessionId, 'IntentAgent', state);

    emitSSE('agent_step', { 
      agent: 'IntentAgent', 
      status: 'completed', 
      result: { status: state.status, targetFiles: state.targetFiles } 
    });

    // Routing Logic for General Knowledge & Greetings
    if (state.status === "ROUTED_GENERAL_QUERY") {
      skippedStages.push('context', 'planner', 'coder', 'testrunner', 'debugger', 'reviewer');
      
      let answer = `Hello! How can I help you with your coding project today?`;
      const apiKey = process.env.GROQ_API_KEY;
      if (apiKey && apiKey !== 'your_groq_api_key_here') {
        try {
          const { ChatGroq } = await import('@langchain/groq');
          const model = new ChatGroq({ apiKey, model: 'groq/compound-mini', temperature: 0.5 });
          const res = await model.invoke([
            { role: 'system', content: 'You are a helpful AI assistant. Provide concise, clear, and direct answers to general questions or greetings without generating file code unless explicitly requested.' },
            { role: 'user', content: userInput }
          ]);
          answer = typeof res.content === 'string' ? res.content : String(res.content);
        } catch (err) {
          console.warn('General query LLM invocation failed:', err);
        }
      }

      await finalizeExecution('GENERAL_COMPLETE', {
        route: 'GENERAL_QUERY',
        explanation: answer
      });
      return;
    }

    // 2. Context Retrieval Agent
    logDiagnostic('GRAPH', 'ENTER ContextRetrievalAgent', { targetFiles: state.targetFiles });
    emitSSE('agent_step', { agent: 'ContextRetrievalAgent', status: 'running', message: 'Analyzing workspace graph & AST symbols...' });
    const retrievalOutput = await contextRetrievalAgentNode(state);
    state.extractedContext = retrievalOutput.extractedContext;
    state.targetFiles = retrievalOutput.targetFiles;
    completedStages.push('context');
    logDiagnostic('GRAPH', 'EXIT ContextRetrievalAgent', { contextLength: state.extractedContext.length });
    persistenceEngine.saveCheckpoint(sessionId, 'ContextRetrievalAgent', state);

    emitSSE('agent_step', { 
      agent: 'ContextRetrievalAgent', 
      status: 'completed', 
      result: { extractedContext: state.extractedContext } 
    });

    // Routing Logic for Explanation
    if (state.status === "ROUTED_EXPLAIN_CODE") {
      skippedStages.push('planner', 'coder', 'testrunner', 'debugger', 'reviewer');
      await finalizeExecution('EXPLAIN_COMPLETE', {
        route: 'EXPLAIN_CODE',
        explanation: state.extractedContext || "No context found to explain."
      });
      return;
    }

    // Branch A: Existing Test Run & Debug Workflow
    if (state.status === "ROUTED_RUN_EXISTING_TESTS" || state.status === "ROUTED_DEBUG_ERROR") {
      skippedStages.push('planner', 'coder');
      emitSSE('agent_step', { agent: 'PlannerAgent', status: 'skipped', message: 'Bypassed for existing test execution' });
      emitSSE('agent_step', { agent: 'CoderAgent', status: 'skipped', message: 'Bypassed until test failures detected' });

      logDiagnostic('GRAPH', 'ENTER TestRunnerAgent', { targetFiles: state.targetFiles });
      emitSSE('agent_step', { agent: 'TestRunnerAgent', status: 'running', message: 'Executing workspace automated unit test suite...' });
      let testResult = await runWorkspaceTests(state.targetFiles);
      completedStages.push('testrunner');
      logDiagnostic('TEST', 'RESULT', { passed: testResult.passed, exitCode: testResult.exitCode });

      emitSSE('agent_step', { 
        agent: 'TestRunnerAgent', 
        status: 'completed', 
        result: { summary: testResult.summary, passed: testResult.passed } 
      });

      const MAX_SELF_HEAL_RETRIES = 3;
      if (!testResult.passed) {
        logDiagnostic('SELF_HEAL', 'INITIATING_LOOP', { maxRetries: MAX_SELF_HEAL_RETRIES });
        while (!testResult.passed && state.retryCount < MAX_SELF_HEAL_RETRIES) {
          state.retryCount += 1;

          // Extract failing implementation file paths from test stack traces
          const discoveredFiles = extractFailingFilesFromLogs(`${testResult.summary}\n${testResult.stdout}\n${testResult.stderr}`);
          if (discoveredFiles.length > 0) {
            state.targetFiles = Array.from(new Set([...state.targetFiles, ...discoveredFiles]));
          }

          logDiagnostic('GRAPH', 'ENTER DebuggerAgent', { attempt: state.retryCount, targetFiles: state.targetFiles });
          emitSSE('agent_step', { 
            agent: 'DebuggerAgent', 
            status: 'running', 
            message: `Self-Healing Test Failure Diagnosis (Attempt #${state.retryCount}/${MAX_SELF_HEAL_RETRIES})...` 
          });

          state.extractedContext = `${state.extractedContext}\n\n[AUTOMATED TEST FAILURE REPORT - ATTEMPT #${state.retryCount}]:\n${testResult.summary}\n${testResult.stderr}\nPlease diagnose the root cause and generate fixed patches to make tests pass.`;

          const debugResult = await debuggerAgentNode(state);
          completedStages.push('debugger');
          logDiagnostic('GRAPH', 'EXIT DebuggerAgent', { rootCause: debugResult.rootCause, patches: debugResult.filePatches.length });

          if (debugResult.filePatches && debugResult.filePatches.length > 0) {
            saveFilePatchesToServerDisk(debugResult.filePatches);
            completedStages.push('coder');
            emitSSE('agent_step', { 
              agent: 'CoderAgent', 
              status: 'completed', 
              result: { filePatches: debugResult.filePatches, diffCards: await prepareDiffCards(debugResult.filePatches) } 
            });
          }
          persistenceEngine.saveCheckpoint(sessionId, `DebuggerAgent_Retry_${state.retryCount}`, state);

          emitSSE('agent_step', { 
            agent: 'DebuggerAgent', 
            status: 'completed', 
            result: { rootCause: debugResult.rootCause, fixExplanation: debugResult.fixExplanation } 
          });

          logDiagnostic('GRAPH', 'RE-ENTER TestRunnerAgent', { attempt: state.retryCount });
          emitSSE('agent_step', { agent: 'TestRunnerAgent', status: 'running', message: `Re-running unit tests after self-healing bug fix (Attempt #${state.retryCount})...` });
          testResult = await runWorkspaceTests(state.targetFiles);
          logDiagnostic('TEST', 'RE_RUN_RESULT', { passed: testResult.passed, attempt: state.retryCount });
          emitSSE('agent_step', { agent: 'TestRunnerAgent', status: 'completed', result: { summary: testResult.summary, passed: testResult.passed } });
        }
      } else {
        skippedStages.push('debugger');
        emitSSE('agent_step', { agent: 'DebuggerAgent', status: 'skipped', message: 'No test failures detected' });
      }

      if (testResult.passed) {
        logDiagnostic('GRAPH', 'ENTER ReviewerAgent', { state: 'post_test_pass' });
        emitSSE('agent_step', { agent: 'ReviewerAgent', status: 'running', message: 'Performing automated code review & quality audit...' });
        const reviewResult = await reviewerAgentNode(state);
        completedStages.push('reviewer');
        logDiagnostic('GRAPH', 'EXIT ReviewerAgent', { approved: reviewResult.approved });

        emitSSE('agent_step', { 
          agent: 'ReviewerAgent', 
          status: 'completed', 
          result: reviewResult 
        });

        await finalizeExecution('TESTS_PASSED', {
          route: state.status,
          testResult,
          reviewResult,
          diffCards: await prepareDiffCards([])
        });
      } else {
        skippedStages.push('reviewer');
        emitSSE('agent_step', { agent: 'DebuggerAgent', status: 'failed', message: 'Self-healing retries exhausted without resolving test failures.' });
        emitSSE('agent_step', { agent: 'ReviewerAgent', status: 'skipped', message: 'Code review skipped due to unresolved test failures.' });

        await finalizeExecution('FAILED', {
          error: `Test failures unresolved after ${MAX_SELF_HEAL_RETRIES} retries.`,
          testResult
        });
      }
      return;
    }

    // Branch B: Code Generation & Feature Implementation Workflow
    if (state.status === "ROUTED_GENERATE_CODE" || state.status === "ROUTED_REFACTOR") {
      // 3. Planner Agent
      logDiagnostic('GRAPH', 'ENTER PlannerAgent', {});
      emitSSE('agent_step', { agent: 'PlannerAgent', status: 'running', message: 'Generating execution plan...' });
      const plannerOutput = await plannerAgentNode(state);
      state.plan = plannerOutput.plan || [];
      state.status = plannerOutput.status || "PLANNED";
      completedStages.push('planner');
      persistenceEngine.saveCheckpoint(sessionId, 'PlannerAgent', state);

      emitSSE('agent_step', { 
        agent: 'PlannerAgent', 
        status: 'completed', 
        result: { plan: state.plan, status: state.status } 
      });

      // 4. Human-In-The-Loop (HITL) Plan Approval Request Widget
      emitSSE('hitl_request', {
        type: 'PLAN_APPROVAL',
        title: 'Plan Approval Required',
        message: 'Please review the generated implementation plan before proceeding to code generation.',
        plan: state.plan,
        targetFiles: state.targetFiles
      });

      const hitlPromise = new Promise<{ action: 'approve' | 'reject' | 'feedback'; message?: string }>((resolve) => {
        pendingHitlResolver = resolve;
      });
      const timeoutPromise = new Promise<{ action: 'approve'; message?: string }>((resolve) => {
        setTimeout(() => {
          if (pendingHitlResolver) {
            pendingHitlResolver = null;
            resolve({ action: 'approve', message: 'Auto-approved via non-interactive timeout guard.' });
          }
        }, 30000);
      });

      const userHitlResponse = await Promise.race([hitlPromise, timeoutPromise]);
      emitSSE('hitl_received', { response: userHitlResponse });

      if (userHitlResponse.action === 'reject') {
        skippedStages.push('coder', 'testrunner', 'debugger', 'reviewer');
        await finalizeExecution('ABORTED', { message: 'Plan rejected by user.' });
        return;
      }

      if (userHitlResponse.action === 'feedback' && userHitlResponse.message) {
        emitSSE('agent_step', { agent: 'PlannerAgent', status: 'running', message: 'Updating plan with user feedback...' });
        state.userInput = `${state.userInput} (User plan feedback: ${userHitlResponse.message})`;
        const updatedPlannerOutput = await plannerAgentNode(state);
        state.plan = updatedPlannerOutput.plan || state.plan;
        persistenceEngine.saveCheckpoint(sessionId, 'PlannerAgent_Feedback', state);

        emitSSE('agent_step', { 
          agent: 'PlannerAgent', 
          status: 'completed', 
          result: { plan: state.plan, status: state.status } 
        });
      }

      // 5. Coder Agent
      logDiagnostic('GRAPH', 'ENTER CoderAgent', {});
      emitSSE('agent_step', { agent: 'CoderAgent', status: 'running', message: 'Generating multi-file code patches...' });
      let coderOutput = await codeGenAgentNode(state);
      state.extractedContext = coderOutput.extractedContext || state.extractedContext;
      completedStages.push('coder');
      persistenceEngine.saveCheckpoint(sessionId, 'CoderAgent', state);

      const diffCards = await prepareDiffCards(coderOutput.filePatches || []);
      emitSSE('agent_step', { 
        agent: 'CoderAgent', 
        status: 'completed', 
        result: { filePatches: coderOutput.filePatches, diffCards } 
      });

      saveFilePatchesToServerDisk(coderOutput.filePatches || []);

      // 6. Test Runner & Self-Healing Debugger Loop
      logDiagnostic('GRAPH', 'ENTER TestRunnerAgent', {});
      emitSSE('agent_step', { agent: 'TestRunnerAgent', status: 'running', message: 'Executing workspace automated unit test suite...' });
      let testResult = await runWorkspaceTests(state.targetFiles);
      completedStages.push('testrunner');
      persistenceEngine.saveCheckpoint(sessionId, 'TestRunnerAgent', state);

      emitSSE('agent_step', { 
        agent: 'TestRunnerAgent', 
        status: 'completed', 
        result: { summary: testResult.summary, passed: testResult.passed } 
      });

      const MAX_SELF_HEAL_RETRIES = 3;
      if (!testResult.passed) {
        while (!testResult.passed && state.retryCount < MAX_SELF_HEAL_RETRIES) {
          state.retryCount += 1;

          const discoveredFiles = extractFailingFilesFromLogs(`${testResult.summary}\n${testResult.stdout}\n${testResult.stderr}`);
          if (discoveredFiles.length > 0) {
            state.targetFiles = Array.from(new Set([...state.targetFiles, ...discoveredFiles]));
          }

          emitSSE('agent_step', { 
            agent: 'DebuggerAgent', 
            status: 'running', 
            message: `Self-Healing Test Failure Diagnosis (Attempt #${state.retryCount}/${MAX_SELF_HEAL_RETRIES})...` 
          });

          state.extractedContext = `${state.extractedContext}\n\n[AUTOMATED TEST FAILURE REPORT - ATTEMPT #${state.retryCount}]:\n${testResult.summary}\n${testResult.stderr}\nPlease diagnose the root cause and generate fixed patches to make tests pass.`;

          const debugResult = await debuggerAgentNode(state);
          completedStages.push('debugger');
          if (debugResult.filePatches && debugResult.filePatches.length > 0) {
            saveFilePatchesToServerDisk(debugResult.filePatches);
          }
          persistenceEngine.saveCheckpoint(sessionId, `DebuggerAgent_Retry_${state.retryCount}`, state);

          emitSSE('agent_step', { 
            agent: 'DebuggerAgent', 
            status: 'completed', 
            result: { rootCause: debugResult.rootCause, fixExplanation: debugResult.fixExplanation } 
          });

          emitSSE('agent_step', { agent: 'TestRunnerAgent', status: 'running', message: `Re-running unit tests after self-healing bug fix (Attempt #${state.retryCount})...` });
          testResult = await runWorkspaceTests(state.targetFiles);
          emitSSE('agent_step', { agent: 'TestRunnerAgent', status: 'completed', result: { summary: testResult.summary, passed: testResult.passed } });
        }
      } else {
        skippedStages.push('debugger');
      }

      // 7. Reviewer Agent
      logDiagnostic('GRAPH', 'ENTER ReviewerAgent', {});
      emitSSE('agent_step', { agent: 'ReviewerAgent', status: 'running', message: 'Performing automated code review & quality audit...' });
      let reviewResult = await reviewerAgentNode(state);
      completedStages.push('reviewer');
      persistenceEngine.saveCheckpoint(sessionId, 'ReviewerAgent', state);

      emitSSE('agent_step', { 
        agent: 'ReviewerAgent', 
        status: 'completed', 
        result: reviewResult 
      });

      await finalizeExecution('SUCCESS', {
        filePatches: coderOutput.filePatches,
        diffCards: await prepareDiffCards(coderOutput.filePatches || []),
        reviewResult,
        testResult
      });
      return;
    }

  } catch (err: any) {
    logDiagnostic('RUN', 'ERROR', { error: err?.message || String(err) });
    await finalizeExecution('FAILED', { error: err?.message || String(err) });
  }
}

async function prepareDiffCards(filePatches: GeneratedFilePatch[]) {
  const cards = [];
  for (const patch of filePatches) {
    let originalCode = "";
    const fullPath = path.resolve(process.cwd(), patch.filePath);
    if (fs.existsSync(fullPath)) {
      originalCode = fs.readFileSync(fullPath, 'utf-8');
    }
    cards.push({
      filePath: patch.filePath,
      originalCode,
      generatedCode: patch.code
    });
  }
  return cards;
}

function saveFilePatchesToServerDisk(patches: GeneratedFilePatch[]) {
  for (const patch of patches) {
    if (!isProtectedFile(patch.filePath)) {
      try {
        const fullPath = path.resolve(process.cwd(), patch.filePath);
        const dir = path.dirname(fullPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(fullPath, patch.code, 'utf-8');
      } catch (err) {
        console.error(`Failed to write patch ${patch.filePath}:`, err);
      }
    }
  }
}

// Workspace File Explorer API
app.get('/api/workspace/files', (req: Request, res: Response) => {
  const sandboxDir = path.resolve(process.cwd(), 'src/sandbox');
  const files: { name: string; path: string; isDir: boolean }[] = [];

  if (fs.existsSync(sandboxDir)) {
    const list = fs.readdirSync(sandboxDir);
    for (const item of list) {
      // Hide internal benchmark folders test1..test5
      if (/^test[1-5]$/i.test(item)) continue;

      const fullPath = path.join(sandboxDir, item);
      const stat = fs.statSync(fullPath);
      files.push({
        name: item,
        path: `src/sandbox/${item}`,
        isDir: stat.isDirectory()
      });
    }
  }

  res.json({ sandboxFiles: files });
});

// Get File Content API
app.get('/api/workspace/file', (req: Request, res: Response) => {
  const relPath = req.query.path as string;
  if (!relPath) {
    res.status(400).json({ error: 'path query parameter is required' });
    return;
  }

  const fullPath = path.resolve(process.cwd(), relPath);
  if (!fs.existsSync(fullPath)) {
    res.status(404).json({ error: 'File not found' });
    return;
  }

  const content = fs.readFileSync(fullPath, 'utf-8');
  res.json({ path: relPath, content });
});

// Save File Content API
app.post('/api/workspace/file', (req: Request, res: Response) => {
  const { path: relPath, content } = req.body;
  if (!relPath || content === undefined) {
    res.status(400).json({ error: 'path and content are required' });
    return;
  }

  if (isProtectedFile(relPath)) {
    res.status(403).json({ error: `Cannot save to protected file '${relPath}'. All user files must reside in src/sandbox/` });
    return;
  }

  const fullPath = path.resolve(process.cwd(), relPath);
  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(fullPath, content, 'utf-8');
  res.json({ success: true, message: `Saved changes to ${relPath}` });
});

// Delete Single Sandbox File API
app.delete('/api/workspace/file', (req: Request, res: Response) => {
  const relPath = req.query.path as string;
  if (!relPath) {
    res.status(400).json({ error: 'path parameter is required' });
    return;
  }

  if (isProtectedFile(relPath)) {
    res.status(403).json({ error: `Cannot delete protected file '${relPath}'` });
    return;
  }

  const fullPath = path.resolve(process.cwd(), relPath);
  if (fs.existsSync(fullPath)) {
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      fs.rmSync(fullPath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(fullPath);
    }
    res.json({ success: true, message: `Deleted ${relPath}` });
  } else {
    res.status(404).json({ error: 'File not found' });
  }
});

// Clear All User Sandbox Files API
app.post('/api/workspace/clear-sandbox', (req: Request, res: Response) => {
  const sandboxDir = path.resolve(process.cwd(), 'src/sandbox');
  if (fs.existsSync(sandboxDir)) {
    const list = fs.readdirSync(sandboxDir);
    for (const item of list) {
      if (/^test[1-5]$/i.test(item)) continue; // preserve benchmark dirs
      const fullPath = path.join(sandboxDir, item);
      fs.rmSync(fullPath, { recursive: true, force: true });
    }
  }
  res.json({ success: true, message: 'All user sandbox files cleared' });
});

// Storage Tier Endpoints
app.get('/api/storage/sessions', (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string) || 50;
  res.json({
    sessions: persistenceEngine.listSessions(limit)
  });
});

app.get('/api/storage/sessions/:id', (req: Request, res: Response) => {
  const sessionId = req.params.id as string;
  const session = persistenceEngine.getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json({ session });
});

app.get('/api/storage/checkpoints/:id', (req: Request, res: Response) => {
  const sessionId = req.params.id as string;
  const checkpoints = persistenceEngine.getCheckpoints(sessionId);
  res.json({ sessionId, checkpoints });
});

// Telemetry & Langfuse Traces Endpoint
app.get('/api/langfuse/traces', (req: Request, res: Response) => {
  res.json({
    traces: langfuseTracer.getRecordedTraces()
  });
});

app.listen(PORT, () => {
  console.log(`\n==================================================`);
  console.log(`🚀 Kaizen AI Client Tier & Generative UI Server`);
  console.log(`   Running at: http://localhost:${PORT}`);
  console.log(`==================================================\n`);
});

