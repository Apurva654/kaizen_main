import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { exec, execSync } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
import * as universalValidator from './tools/universalValidator';
import { KaizenStateType } from './state';
import { intentAgentNode, extractTerminalCommand, extractGitActions, extractBrowserUrl } from './agents/intentAgent';
import { contextRetrievalAgentNode } from './agents/contextRetrievalAgent';
import { plannerAgentNode } from './agents/plannerAgent';
import { codeGenAgentNode, isProtectedFile, GeneratedFilePatch, saveFilePatchesToServerDiskWithVerification } from './agents/codeGenAgent';
import { reviewerAgentNode } from './agents/reviewerAgent';
import { debuggerAgentNode } from './agents/debuggerAgent';
import { langfuseTracer } from './tools/langfuseTracer';
import { persistenceEngine } from './tools/persistenceEngine';
import { runWorkspaceTests, extractFailingFilesFromLogs } from './tools/testRunner';
import { preprocessUserRequest, saveAgentState, loadAgentState, recordConversationTurn } from './context/contextManager';
import { memoryEngine } from './context/memory/memoryEngine';
import { ocrService } from './tools/ocrService';
import { permissionGate, PermissionMode } from './tools/permissionGate';
import { mcpInterface } from './mcp/mcpInterface';
import { dockerSandbox } from './tools/dockerSandbox';
import { parseBrowserInspectionResult, formatBrowserInspectionMarkdown, extractRequestedBrowserAction, resolveAccessibilityTarget } from './tools/browserSnapshotParser';
import { performWebSearch, setSSEEmitter } from './tools/webSearchTool';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../public')));
app.use('/sandbox', express.static(path.resolve(process.cwd(), 'src/sandbox')));
app.use('/src/sandbox', express.static(path.resolve(process.cwd(), 'src/sandbox')));

// Server-Sent Events (SSE) Clients list
let sseClients: Response[] = [];

function broadcastSSE(eventType: string, data: any) {
  let payload: string;
  try {
    payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  } catch (err) {
    console.error('[SSE] Serialization failed for event:', eventType, err);
    return;
  }
  sseClients = sseClients.filter(client => {
    try {
      client.write(payload);
      return true;
    } catch {
      return false; // Automatically drop dead connections
    }
  });
}

// Heartbeat to keep SSE alive and automatically prune dead client connections
setInterval(() => {
  sseClients = sseClients.filter(client => {
    try {
      client.write(': heartbeat\n\n');
      return true;
    } catch {
      return false; // Drop disconnected client
    }
  });
}, 30000);

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

// Permission Gate Status Endpoint
app.get('/api/permission/status', async (req: Request, res: Response) => {
  const isDockerActive = await dockerSandbox.checkDockerAvailable();
  res.json({
    mode: permissionGate.getMode(),
    isDryRunMode: permissionGate.isDryRunMode(),
    isDockerActive
  });
});

// Permission Gate Mode Update Endpoint
app.post('/api/permission/mode', (req: Request, res: Response) => {
  const { mode } = req.body;
  if (mode === 'deny_first' || mode === 'auto_mode') {
    permissionGate.setMode(mode as PermissionMode);
    res.json({ success: true, mode: permissionGate.getMode() });
  } else {
    res.status(400).json({ error: "Invalid mode. Must be 'deny_first' or 'auto_mode'" });
  }
});

// Permission Gate Dry-Run Mode Toggle Endpoint
app.post('/api/permission/dryrun', (req: Request, res: Response) => {
  const { enabled } = req.body;
  if (typeof enabled === 'boolean') {
    permissionGate.setDryRunMode(enabled);
    res.json({ success: true, isDryRunMode: permissionGate.isDryRunMode() });
  } else {
    res.status(400).json({ error: "Invalid payload. 'enabled' boolean is required." });
  }
});

// MCP Unified Tool Execution Endpoint
app.post('/api/mcp/execute', async (req: Request, res: Response) => {
  const { tool, action, relPath, content, command, message, options } = req.body;
  try {
    if (tool === 'filesystem') {
      const result = await mcpInterface.executeFilesystemAction(action, relPath || 'src/sandbox/main.ts', content, options);
      res.json(result);
    } else if (tool === 'git') {
      const result = await mcpInterface.executeGitAction(action, message, options);
      res.json(result);
    } else if (tool === 'terminal') {
      const result = await mcpInterface.executeTerminalCommand(command || 'dir', process.cwd(), options);
      res.json(result);
    } else {
      res.status(400).json({ error: 'Unsupported MCP tool.' });
    }
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// Session-aware HITL (Human-In-The-Loop) Registry
const hitlResolvers = new Map<string, (value: { action: 'approve' | 'reject' | 'feedback'; message?: string }) => void>();
let pendingHitlResolver: ((value: { action: 'approve' | 'reject' | 'feedback'; message?: string }) => void) | null = null;

function registerHitl(sessionId: string, resolve: (val: any) => void, timeoutMs = 300000) {
  const timer = setTimeout(() => {
    if (hitlResolvers.has(sessionId)) {
      hitlResolvers.delete(sessionId);
      resolve({ action: 'reject', message: 'HITL request timed out after 5 minutes.' });
    }
  }, timeoutMs);

  const wrapped = (val: any) => {
    clearTimeout(timer);
    hitlResolvers.delete(sessionId);
    pendingHitlResolver = null;
    resolve(val);
  };

  hitlResolvers.set(sessionId, wrapped);
  pendingHitlResolver = wrapped; // Maintains backward-compatibility
}

// HITL Response Endpoint
app.post('/api/hitl/respond', (req: Request, res: Response) => {
  const { sessionId, action, message } = req.body;

  if (sessionId && hitlResolvers.has(sessionId)) {
    const resolver = hitlResolvers.get(sessionId)!;
    resolver({ action, message });
    return res.json({ success: true, message: `HITL response recorded for session ${sessionId}.` });
  }

  if (pendingHitlResolver) {
    pendingHitlResolver({ action, message });
    return res.json({ success: true, message: 'HITL response recorded.' });
  }

  res.status(400).json({ success: false, error: 'No pending HITL request found or request timed out.' });
});

// Graphify Explorer REST API Endpoints
app.get('/api/graphify/current', async (req: Request, res: Response) => {
  try {
    const scope = (req.query.scope as string) || 'current-task';
    const activeFile = (req.query.activeFile as string) || undefined;
    const reqWorkspace = (req.query.workspaceRoot as string) || undefined;
    const { GraphifyEngine } = await import('./tools/graphifyEngine');

    let workspaceRoot = reqWorkspace || (scope === 'full' ? '.' : (fs.existsSync('src') ? '.' : 'src/sandbox'));

    const engine = new GraphifyEngine();
    await engine.scanDirectory(workspaceRoot);

    let targetFiles: string[] = activeFile ? [activeFile] : ['src/sandbox/main.ts', 'src/index.ts', 'src/server.ts'];
    let generatedFiles: string[] = [];

    const cachedGraph = persistenceEngine.getWorkspaceGraphCache(workspaceRoot);
    if (cachedGraph && cachedGraph.structuredPayload) {
      if (cachedGraph.structuredPayload.metadata?.generatedFiles && Array.isArray(cachedGraph.structuredPayload.nodes)) {
        generatedFiles = cachedGraph.structuredPayload.nodes
          .filter((n: any) => n && (n.status === 'generated' || n.status === 'modified'))
          .map((n: any) => n.id);
      }
    }

    const payload = engine.exportGraphData({
      scope,
      targetFiles,
      generatedFiles,
      activeFile
    });

    res.json(payload);
  } catch (err: any) {
    console.error('[GraphifyAPI] Error generating graph payload:', err);
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.get('/api/graphify/node', async (req: Request, res: Response) => {
  try {
    const nodeId = (req.query.id as string) || '';
    if (!nodeId) {
      res.status(400).json({ error: 'Node ID parameter is required' });
      return;
    }
    const cachedGraph = persistenceEngine.getWorkspaceGraphCache('.');
    let payload = cachedGraph?.structuredPayload;
    if (!payload) {
      const { GraphifyEngine } = await import('./tools/graphifyEngine');
      const engine = new GraphifyEngine();
      await engine.scanDirectory('.');
      payload = engine.exportGraphData({ scope: 'full' });
    }
    const targetNode = payload.nodes.find((n: any) => n.id === nodeId || n.path === nodeId);
    const relatedEdges = payload.edges.filter((e: any) => e.source === nodeId || e.target === nodeId);
    res.json({ node: targetNode || null, edges: relatedEdges });
  } catch (err: any) {
    console.error('[GraphifyAPI] Error fetching node details:', err);
    res.status(500).json({ error: err?.message || String(err) });
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
  const { userInput, imagePayload, sessionId: reqSessionId } = req.body;

  if ((!userInput || typeof userInput !== 'string') && !imagePayload) {
    res.status(400).json({ error: 'userInput string or imagePayload is required.' });
    return;
  }

  // Guard against oversized text payloads (50,000 characters limit)
  if (userInput && userInput.length > 50000) {
    res.status(400).json({ error: 'userInput exceeds maximum length of 50,000 characters.' });
    return;
  }

  // Guard against oversized base64 screenshots (>10MB)
  if (imagePayload && typeof imagePayload === 'string' && (imagePayload.length * 3) / 4 > 10 * 1024 * 1024) {
    res.status(400).json({ error: 'imagePayload exceeds maximum allowed size of 10MB.' });
    return;
  }

  // Send immediate response acknowledging execution
  res.json({ status: 'started', message: 'Pipeline execution initiated.' });

  // Execute pipeline asynchronously with unhandled rejection protection
  runPipeline(userInput || '', imagePayload, reqSessionId).catch((err) => {
    console.error('[Pipeline Fatal Error]', err);
    broadcastSSE('pipeline_complete', {
      sessionId: reqSessionId,
      status: 'FAILED',
      error: err?.message || String(err)
    });
  });
});

// Redact passwords, API keys, and sensitive tokens from console logs
function sanitizeForLogging(data: any): any {
  if (typeof data !== 'object' || data === null) return data;
  const sensitiveKeys = ['password', 'token', 'api_key', 'apikey', 'secret', 'authorization'];
  const result: Record<string, any> = Array.isArray(data) ? [...data] : { ...data };
  for (const key of Object.keys(result)) {
    if (sensitiveKeys.some(sk => key.toLowerCase().includes(sk))) {
      result[key] = '[REDACTED]';
    } else if (typeof result[key] === 'string' && /^(gsk_|sk-|Bearer\s+)/i.test(result[key])) {
      result[key] = '[REDACTED]';
    } else if (typeof result[key] === 'object') {
      result[key] = sanitizeForLogging(result[key]);
    }
  }
  return result;
}

function logDiagnostic(category: string, action: string, data: Record<string, any>) {
  const sanitized = sanitizeForLogging(data);
  console.log(`[KAIZEN][${category}] ${action}`, JSON.stringify(sanitized));
}

async function runPipeline(rawUserInput: string, imagePayload?: string, clientSessionId?: string) {
  const sessionId = clientSessionId || persistenceEngine.generateSessionId();
  const runId = `run_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const createdAt = new Date().toISOString();

  const emitSSE = (eventType: string, data: any) => {
    broadcastSSE(eventType, { ...data, runId, sessionId });
  };

  setSSEEmitter(emitSSE);

  const userInput = rawUserInput;
  const originalUserRequest = rawUserInput;

  let state: KaizenStateType = {
    sessionId,
    runId,
    createdAt,
    userInput,
    originalUserRequest,
    targetFiles: [],
    extractedContext: "",
    plan: [],
    planApprovalStatus: 'NONE',
    generatedPatch: "",
    choices: [],
    retryCount: 0,
    status: "INITIALIZED",
    lifecycleStatus: "RUNNING",
    currentStage: "intent",
    completedStages: [],
    skippedStages: [],
    generalAnswer: undefined,
    imagePayload,
    extractedImageText: undefined,
    permissionMode: permissionGate.getMode(),
    riskScore: permissionGate.calculateRiskScore('pipeline_run', { command: userInput }),
    permissionStatus: permissionGate.getMode() === 'auto_mode' ? 'AUTO_APPROVED' : 'APPROVED',
    mcpActions: [],
    dockerSandboxActive: await dockerSandbox.checkDockerAvailable(),
    structuredFailures: [],
    errorsEncountered: 0,
    lastPlan: undefined,
    planTimestamp: undefined,
    canRetry: true,
    rejectionReason: undefined
  };

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

    const isFailure = finalStatus === 'FAILED' || finalStatus === 'ABORTED';
    const normalizedStatus = isFailure ? finalStatus : 'COMPLETED';

    saveAgentState({
      conversationId: sessionId,
      currentTask: rawUserInput,
      completedSteps: completedStages,
      generatedFiles: new Map((state.targetFiles || []).map(f => [f, 'updated'])),
      errors: (state as any).reviewReport?.issues || [],
      status: normalizedStatus,
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
    logDiagnostic('RUN', 'INITIATED', { runId, sessionId, rawUserInput, hasImage: !!imagePayload });
    emitSSE('pipeline_start', { sessionId, userInput: rawUserInput, timestamp: createdAt });

    let extractedImageText = '';
    if (imagePayload) {
      emitSSE('agent_step', { agent: 'IntentAgent', status: 'running', message: '🔍 Vision OCR: Extracting text from screenshot...' });
      extractedImageText = await ocrService.extractTextFromImage(imagePayload);
      state.extractedImageText = extractedImageText || undefined;
    }

    let promptToProcess = rawUserInput;
    if (extractedImageText) {
      promptToProcess = `[Extracted Text from Screenshot]:\n${extractedImageText}\n\n[User Instructions]:\n${rawUserInput || 'Analyze and process attached screenshot code/instructions.'}`;
    }

    // Preprocess input with context manager & handle special @ commands
    const processed = await preprocessUserRequest(promptToProcess);
    state.extractedContext = processed.workspaceContext || "";

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

    persistenceEngine.saveCheckpoint(sessionId, 'INITIALIZED', state);

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

    // Routing Logic for MCP Git Operations
    if (state.status === "ROUTED_MCP_GIT") {
      skippedStages.push('context', 'planner', 'coder', 'testrunner', 'debugger', 'reviewer');
      emitSSE('agent_step', { agent: 'IntentAgent', status: 'running', message: '⚡ Executing Git MCP operations...' });

      const requestedActions = extractGitActions(rawUserInput);

      let combinedOutput = '### 🐙 Git MCP Operation Results\n\n';
      let hasBlockedAction = false;

      for (const action of requestedActions) {
        const evalResult = permissionGate.evaluate(`git_${action}`, { command: `git ${action}` });

        let isApproved = true;

        if (evalResult.requiresApproval && !evalResult.allowed) {
          hasBlockedAction = true;
          combinedOutput += `> [!WARNING]\n> **Git ${action.toUpperCase()} Permission Intercepted** (Risk Score: ${evalResult.riskScore}/100)\n> ${evalResult.reason}\n\n`;

          broadcastSSE('hitl_request', {
            type: 'GIT_PERMISSION_APPROVAL',
            title: `Permission Gate Intercept: Git ${action.toUpperCase()}`,
            message: evalResult.reason,
            action,
            riskScore: evalResult.riskScore
          });

          const userHitlResponse = await new Promise<{ action: 'approve' | 'reject' | 'feedback'; message?: string }>((resolve) => {
            registerHitl(sessionId, resolve);
          });
          broadcastSSE('hitl_received', { response: userHitlResponse });
          isApproved = userHitlResponse.action === 'approve';
        }

        const mcpResult = await mcpInterface.executeGitAction(action, rawUserInput, {
          dryRun: permissionGate.isDryRunMode(),
          approved: isApproved
        });

        const actionLabel = action.toUpperCase();
        if (mcpResult.success) {
          combinedOutput += `#### ${actionLabel} Output (${mcpResult.isSimulated ? 'SIMULATED' : 'EXECUTED'})\n\`\`\`\n${mcpResult.output || '(No changes / clean output)'}\n\`\`\`\n\n`;
        } else {
          combinedOutput += `#### ${actionLabel} Result (${mcpResult.isSimulated ? 'SIMULATED' : 'BLOCKED'})\n\`\`\`\n${mcpResult.output || mcpResult.error}\n\`\`\`\n\n`;
        }
      }

      await finalizeExecution(hasBlockedAction ? 'HITL_REQUIRED' : 'GENERAL_COMPLETE', {
        route: 'MCP_GIT',
        explanation: combinedOutput.trim()
      });
      return;
    }

    // Routing Logic for MCP Terminal Operations
    if (state.status === "ROUTED_MCP_TERMINAL") {
      skippedStages.push('context', 'planner', 'coder', 'testrunner', 'debugger', 'reviewer');
      emitSSE('agent_step', { agent: 'IntentAgent', status: 'running', message: '⚡ Executing Terminal MCP operation...' });

      const command = extractTerminalCommand(rawUserInput);
      const evalResult = permissionGate.evaluate('terminal_exec', { command });
      let isApproved = true;
      let hasBlockedAction = false;

      if (evalResult.requiresApproval && !evalResult.allowed) {
        hasBlockedAction = true;

        broadcastSSE('hitl_request', {
          type: 'TERMINAL_PERMISSION_APPROVAL',
          title: `Permission Gate Intercept: Terminal Execution`,
          message: evalResult.reason,
          command: command,
          riskScore: evalResult.riskScore
        });

        const userHitlResponse = await new Promise<{ action: 'approve' | 'reject' | 'feedback'; message?: string }>((resolve) => {
          registerHitl(sessionId, resolve);
        });
        broadcastSSE('hitl_received', { response: userHitlResponse });
        isApproved = userHitlResponse.action === 'approve';
      }

      const isSimulatedPrompt = /\b(simulat|dry-run|dry run|fake|mock|permission gate)\b/i.test(rawUserInput);
      const isDryRun = permissionGate.isDryRunMode() || isSimulatedPrompt;

      const mcpResult = await mcpInterface.executeTerminalCommand(command, process.cwd(), {
        dryRun: isDryRun,
        approved: isApproved
      });

      let combinedOutput = `### 💻 Terminal MCP Operation Results\n\n`;
      if (mcpResult.success) {
        combinedOutput += `#### Command Output (${mcpResult.isSimulated ? 'SIMULATED' : 'EXECUTED'})\n\`\`\`\n${mcpResult.output || '(Clean output)'}\n\`\`\`\n\n`;
      } else {
        combinedOutput += `#### Command Result (${mcpResult.isSimulated ? 'SIMULATED' : 'BLOCKED'})\n\`\`\`\n${mcpResult.output || mcpResult.error}\n\`\`\`\n\n`;
      }

      await finalizeExecution(hasBlockedAction ? 'HITL_REQUIRED' : 'GENERAL_COMPLETE', {
        route: 'MCP_TERMINAL',
        explanation: combinedOutput.trim()
      });
      return;
    }

    // Routing Logic for MCP Browser / Playwright Operations
    if (state.status === "ROUTED_MCP_BROWSER") {
      skippedStages.push('context', 'planner', 'coder', 'testrunner', 'debugger', 'reviewer');
      state.targetFiles = [];
      emitSSE('agent_step', { agent: 'IntentAgent', status: 'running', message: '🌐 Connecting to External Playwright MCP Server Process...' });

      const targetUrl = extractBrowserUrl(rawUserInput);

      // Connect to external Playwright MCP Server via StdioClientTransport
      await mcpInterface.connectServer('playwright-mcp-stdio');

      try {
        // Run PermissionGate for browser_navigate
        const evalNav = permissionGate.evaluate('browser_navigate', { url: targetUrl });
        let isApproved = true;
        let hasBlockedAction = false;

        if (evalNav.requiresApproval && !evalNav.allowed) {
          hasBlockedAction = true;
          broadcastSSE('hitl_request', {
            type: 'BROWSER_PERMISSION_APPROVAL',
            title: 'Permission Gate Intercept: Browser Navigation',
            message: evalNav.reason,
            url: targetUrl,
            riskScore: evalNav.riskScore
          });

          const userHitlResponse = await new Promise<{ action: 'approve' | 'reject' | 'feedback'; message?: string }>((resolve) => {
            registerHitl(sessionId, resolve);
          });
          broadcastSSE('hitl_received', { response: userHitlResponse });
          isApproved = userHitlResponse.action === 'approve';
        }

        emitSSE('agent_step', { agent: 'IntentAgent', status: 'running', message: `🌐 Navigating browser to ${targetUrl}...` });
        const navRes = await mcpInterface.executeBrowserAction('navigate', { url: targetUrl }, { approved: isApproved });

        emitSSE('agent_step', { agent: 'IntentAgent', status: 'running', message: '🌐 Inspecting page accessibility snapshot...' });
        const snapRes = await mcpInterface.executeBrowserAction('snapshot', {}, { approved: isApproved });

        const combinedBrowserOutput = [navRes.output, snapRes.output, navRes.error, snapRes.error].filter(Boolean).join('\n') || '(No DOM snapshot output returned)';
        const executedToolsList = ['browser_navigate', 'browser_snapshot'];
        let finalInspection = parseBrowserInspectionResult(combinedBrowserOutput, targetUrl, executedToolsList);

        const requestedAction = extractRequestedBrowserAction(rawUserInput);
        if (requestedAction) {
          emitSSE('agent_step', { agent: 'IntentAgent', status: 'running', message: `🔍 Resolving target "${requestedAction.target}" against accessibility tree...` });
          const targetRes = resolveAccessibilityTarget(requestedAction.target, finalInspection);

          if (!targetRes.found) {
            finalInspection.actionExecuted = {
              action: requestedAction.action,
              target: requestedAction.target,
              success: false,
              error: targetRes.error
            };
          } else {
            const evalAction = permissionGate.evaluate(`browser_${requestedAction.action}`, {
              target: requestedAction.target,
              ref: targetRes.elementRef,
              action: requestedAction.action
            });

            let isActionApproved = true;
            if (evalAction.requiresApproval && !evalAction.allowed) {
              hasBlockedAction = true;
              broadcastSSE('hitl_request', {
                type: 'BROWSER_PERMISSION_APPROVAL',
                title: `Permission Gate Intercept: Browser ${requestedAction.action.toUpperCase()}`,
                message: evalAction.reason,
                url: targetUrl,
                riskScore: evalAction.riskScore
              });

              const userHitlResponse = await new Promise<{ action: 'approve' | 'reject' | 'feedback'; message?: string }>((resolve) => {
                registerHitl(sessionId, resolve);
              });
              broadcastSSE('hitl_received', { response: userHitlResponse });
              isActionApproved = userHitlResponse.action === 'approve';
            }

            emitSSE('agent_step', { agent: 'IntentAgent', status: 'running', message: `⚡ Executing browser_${requestedAction.action} on "${requestedAction.target}"...` });
            executedToolsList.push(`browser_${requestedAction.action}`);

            const actionRes = await mcpInterface.executeBrowserAction(
              requestedAction.action,
              { element: targetRes.elementRef, ref: targetRes.elementRef, name: targetRes.targetName, text: requestedAction.text },
              { approved: isActionApproved }
            );

            emitSSE('agent_step', { agent: 'IntentAgent', status: 'running', message: '🌐 Inspecting post-action page snapshot...' });
            executedToolsList.push('browser_snapshot');
            const postSnapRes = await mcpInterface.executeBrowserAction('snapshot', {}, { approved: isActionApproved });

            const postCombinedOutput = [actionRes.output, postSnapRes.output, actionRes.error, postSnapRes.error].filter(Boolean).join('\n') || combinedBrowserOutput;
            finalInspection = parseBrowserInspectionResult(postCombinedOutput, targetUrl, executedToolsList);
            finalInspection.actionExecuted = {
              action: requestedAction.action,
              target: requestedAction.target,
              elementRef: targetRes.elementRef,
              success: actionRes.success,
              error: actionRes.error
            };
          }
        }

        const formattedMarkdown = formatBrowserInspectionMarkdown(finalInspection);
        state.targetFiles = [];

        await finalizeExecution(hasBlockedAction ? 'HITL_REQUIRED' : 'GENERAL_COMPLETE', {
          route: 'MCP_BROWSER',
          targetFiles: [],
          filePatches: [],
          explanation: formattedMarkdown
        });
        return;
      } finally {
        // Guaranteed cleanup: never leak child browser processes
        await mcpInterface.disconnectServer().catch(() => { });
        await mcpInterface.connectServer('default-inprocess').catch(() => { });
      }
    }

    // Routing Logic for File Deletion & Sandbox Clearing (Permission Gate HITL)
    if (state.status === "ROUTED_DELETE_FILES") {
      skippedStages.push('context', 'planner', 'coder', 'testrunner', 'debugger', 'reviewer');
      emitSSE('agent_step', { agent: 'IntentAgent', status: 'running', message: '⚠️ Evaluating file deletion request with Permission Gate...' });

      const sandboxDir = path.resolve(process.cwd(), 'src/sandbox');
      let targetFilesToDelete: string[] = [];

      const getFilesRecursively = (dir: string): string[] => {
        let results: string[] = [];
        if (!fs.existsSync(dir)) return results;
        const list = fs.readdirSync(dir);
        for (const item of list) {
          const fullPath = path.join(dir, item);
          const relPath = path.relative(process.cwd(), fullPath).replace(/\\/g, '/');
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            results = results.concat(getFilesRecursively(fullPath));
          } else {
            results.push(relPath);
          }
        }
        return results;
      };

      if (fs.existsSync(sandboxDir)) {
        targetFilesToDelete = getFilesRecursively(sandboxDir);
      }

      // Parse exclusion patterns from the raw user prompt
      const exceptMatch = rawUserInput.match(/\b(except|exclude|keep|don't delete|save)\s+([a-zA-Z0-9_\-\.\/]+)/i);
      if (exceptMatch) {
        const excludedFile = exceptMatch[2].toLowerCase();
        targetFilesToDelete = targetFilesToDelete.filter(f => !f.toLowerCase().includes(excludedFile));
      }

      if (targetFilesToDelete.length === 0) {
        await finalizeExecution('GENERAL_COMPLETE', {
          route: 'DELETE_FILES',
          explanation: `### ℹ️ Workspace Sandbox Is Empty\n\nThe \`src/sandbox/\` directory is already clean and contains 0 files. No file deletion was needed.`
        });
        return;
      }

      const evalResult = permissionGate.evaluate('file_delete', { command: rawUserInput, files: targetFilesToDelete });
      let isApproved = true;
      let hasBlockedAction = false;

      if (evalResult.requiresApproval && !evalResult.allowed) {
        hasBlockedAction = true;
        broadcastSSE('hitl_request', {
          type: 'FILE_DELETION_APPROVAL',
          title: 'Permission Gate Intercept: File Deletion Request',
          message: `The agent is requesting permission to delete ${targetFilesToDelete.length} files in 'src/sandbox/':\n${targetFilesToDelete.join('\n')}`,
          files: targetFilesToDelete,
          riskScore: evalResult.riskScore
        });

        const userHitlResponse = await new Promise<{ action: 'approve' | 'reject' | 'feedback'; message?: string }>((resolve) => {
          registerHitl(sessionId, resolve);
        });
        broadcastSSE('hitl_received', { response: userHitlResponse });
        isApproved = userHitlResponse.action === 'approve';
      }

      let explanation = '';
      if (isApproved) {
        let deletedCount = 0;
        const deletedFiles: string[] = [];
        for (const fileRel of targetFilesToDelete) {
          const fullPath = path.resolve(process.cwd(), fileRel);
          if (fs.existsSync(fullPath)) {
            try {
              fs.unlinkSync(fullPath);
              deletedCount++;
              deletedFiles.push(fileRel);
            } catch (err: any) {
              console.warn(`Failed to delete ${fileRel}:`, err?.message || err);
            }
          }
        }
        // Clean up empty directories inside sandbox
        if (fs.existsSync(sandboxDir)) {
          try {
            const cleanEmptyDirs = (dir: string) => {
              try {
                const items = fs.readdirSync(dir);
                for (const item of items) {
                  const p = path.join(dir, item);
                  try {
                    if (fs.statSync(p).isDirectory()) {
                      cleanEmptyDirs(p);
                      if (fs.readdirSync(p).length === 0) {
                        fs.rmdirSync(p);
                      }
                    }
                  } catch { }
                }
              } catch { }
            };
            cleanEmptyDirs(sandboxDir);
          } catch { }
        }
        explanation = `### 🗑️ File Deletion Completed\n\nSuccessfully deleted ${deletedCount} files from workspace:\n${deletedFiles.map(f => `- \`${f}\``).join('\n')}`;
      } else {
        explanation = `### 🛑 File Deletion Cancelled\n\nFile deletion request was cancelled by the user. No files were modified or deleted.`;
      }

      await finalizeExecution(hasBlockedAction ? 'HITL_REQUIRED' : 'GENERAL_COMPLETE', {
        route: 'DELETE_FILES',
        explanation
      });
      return;
    }

    // Routing Logic for General Knowledge & Greetings
    if (state.status === "ROUTED_GENERAL_QUERY") {
      skippedStages.push('context', 'planner', 'coder', 'testrunner', 'debugger', 'reviewer');

      let answer = `Hello! How can I help you with your coding project today?`;
      const apiKey = process.env.GROQ_API_KEY;

      const { isAmbiguousQuery } = await import('./agents/intentAgent');
      if (isAmbiguousQuery(rawUserInput)) {
        const langMatch = rawUserInput.match(/\bin\s+([a-zA-Z0-9+#]+)/i);
        const langStr = langMatch ? langMatch[1].toUpperCase() : 'your specified language';
        answer = `I'd be happy to help you create code files in ${langStr}! Could you please clarify what specific program, feature, or logic you'd like to build?\n\nFor example:\n- File Read/Write Operations & Data Persistence\n- Object-Oriented Class Structures & Inheritance\n- Data Structures & Algorithms (e.g. Trees, Graphs, Sorting)\n- CLI Utility Tool or Math Calculator`;
      } else {
        const now = new Date();
        const istTime = now.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true });
        const jstTime = now.toLocaleTimeString('en-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: true });

        const systemPromptClockExtension = `
  Current Context:
  - Current Date/Time: ${now.toISOString()}
  - India (IST): ${istTime}
  - Japan (JST): ${jstTime}
  `;

        // Check if user query requires live web search
        let webSearchResultsText = '';
        const isSearchQuery = /\b(who is|nole|djokovic|news|today|latest|tell me about|what happened|search|google|company|openai|time|cricket|schedule|tour|visiting|match|weather|current|now)\b/i.test(rawUserInput);
        const isMemoryQuery = /\b(my name|what is my name|whats my name|who am i)\b/i.test(rawUserInput);

        if (isSearchQuery && !isMemoryQuery) {
          emitSSE('agent_step', { agent: 'IntentAgent', status: 'running', message: '🌐 Performing live web search (DuckDuckGo / Google)...' });
          const results = await performWebSearch(rawUserInput, emitSSE);
          if (results.length > 0) {
            webSearchResultsText = `\n\n=== LIVE WEB SEARCH RESULTS ===\n` +
              results.map((r, i) => `[${i + 1}] Title: ${r.title}\nURL: ${r.url}\nSnippet: ${r.snippet}`).join('\n\n');
          }
        }

        if (apiKey && apiKey !== 'your_groq_api_key_here') {
          const modelCandidates = [
            'openai/gpt-oss-120b',
            'openai/gpt-oss-20b',
            'qwen/qwen3.8-27b',
            'llama-3.3-70b-versatile',
            'llama-3.1-8b-instant'
          ];

          for (const modelName of modelCandidates) {
            try {
              const { ChatGroq } = await import('@langchain/groq');
              const model = new ChatGroq({ apiKey, model: modelName, temperature: 0.3 });
              const systemContent = `You are Kaizen, a helpful AI assistant.
  ${systemPromptClockExtension}
  Always check the USER PROFILE & KNOWN FACTS, CONVERSATION HISTORY, and LIVE WEB SEARCH RESULTS provided below to answer user queries:

  ${state.extractedContext || userInput}
  ${webSearchResultsText}

  Directives:
  - If LIVE WEB SEARCH RESULTS are provided above, use them to answer facts, current events, or people queries directly.
  - If the user asks for their name or identity, state their name/identity from the KNOWN FACTS and CONVERSATION HISTORY.
  - Provide concise, friendly, and direct answers without generating code unless explicitly requested.`;

              const res: any = await model.invoke([
                { role: 'system', content: systemContent },
                { role: 'user', content: rawUserInput }
              ]);
              answer = typeof res.content === 'string' ? res.content : String(res.content ?? '');
              if (answer) break;
            } catch (err) {
              console.warn(`General query LLM invocation failed for model '${modelName}':`, err);
            }
          }
        }
      }

      completedStages.push('response');
      await finalizeExecution('COMPLETED', {
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
      completedStages.push('response');
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
        state.errorsEncountered = (state.errorsEncountered || 0) + 1;
        if (testResult.structuredFailure) {
          state.structuredFailures = [...(state.structuredFailures || []), testResult.structuredFailure];
        }

        while (!testResult.passed && state.retryCount < MAX_SELF_HEAL_RETRIES) {
          state.retryCount += 1;

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

          const isTestFile = (filePath: string) => {
            const norm = filePath.replace(/\\/g, '/');
            const baseName = path.basename(norm);
            return norm.includes('/tests/') || baseName.startsWith('test_') || baseName.endsWith('_test.py') || baseName.endsWith('.test.ts');
          };

          const validPatches = (debugResult.filePatches || []).filter(p => !isTestFile(p.filePath));

          if (validPatches.length > 0) {
            saveFilePatchesToServerDisk(validPatches);
            completedStages.push('coder');
            emitSSE('agent_step', {
              agent: 'CoderAgent',
              status: 'completed',
              result: { filePatches: validPatches, diffCards: await prepareDiffCards(validPatches) }
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

          if (!testResult.passed) {
            state.errorsEncountered = (state.errorsEncountered || 0) + 1;
            if (testResult.structuredFailure) {
              state.structuredFailures = [...(state.structuredFailures || []), testResult.structuredFailure];
            }
          }

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
          errorsEncountered: state.errorsEncountered,
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
      state.planApprovalStatus = 'PENDING_APPROVAL';
      completedStages.push('planner');
      persistenceEngine.saveCheckpoint(sessionId, 'PlanApproval_Pending', state);

      emitSSE('agent_step', {
        agent: 'PlannerAgent',
        status: 'completed',
        result: { plan: state.plan, status: state.status, planApprovalStatus: 'PENDING_APPROVAL' }
      });

      // 4. Human-In-The-Loop (HITL) Plan Approval Request Widget
      emitSSE('hitl_request', {
        type: 'PLAN_APPROVAL',
        title: 'Plan Approval Required',
        message: 'Please review the generated implementation plan before proceeding to code generation.',
        plan: state.plan,
        targetFiles: state.targetFiles,
        planApprovalStatus: 'PENDING_APPROVAL'
      });

      let userHitlResponse = await new Promise<{ action: 'approve' | 'reject' | 'feedback'; message?: string }>((resolve) => {
        registerHitl(sessionId, resolve);
      });

      emitSSE('hitl_received', { response: userHitlResponse });

      while (userHitlResponse.action === 'reject') {
        state.retryCount = (state.retryCount || 0) + 1;
        if (state.retryCount <= 3) {
          emitSSE('agent_step', {
            agent: 'PlannerAgent',
            status: 'running',
            message: `[Attempt #${state.retryCount}] User rejected plan. Re-planning alternative approach...`
          });
          state.userInput = `${state.originalUserRequest || state.userInput} (Previous plan rejected by user. Generate an alternative refined plan)`;
          const updatedPlannerOutput = await plannerAgentNode(state);
          state.plan = updatedPlannerOutput.plan || state.plan;

          emitSSE('hitl_request', {
            type: 'PLAN_APPROVAL',
            title: 'Plan Approval Required',
            message: 'Please review the generated implementation plan before proceeding to code generation.',
            plan: state.plan,
            targetFiles: state.targetFiles,
            planApprovalStatus: 'PENDING_APPROVAL'
          });

          userHitlResponse = await new Promise<{ action: 'approve' | 'reject' | 'feedback'; message?: string }>((resolve) => {
            registerHitl(sessionId, resolve);
          });

          emitSSE('hitl_received', { response: userHitlResponse });
        } else {
          state.planApprovalStatus = 'REJECTED';
          skippedStages.push('coder', 'testrunner', 'debugger', 'reviewer');
          await finalizeExecution('ABORTED', { message: 'Plan rejected by user max retries reached.', planApprovalStatus: 'REJECTED' });
          return;
        }
      }

      if (userHitlResponse.action === 'feedback' && userHitlResponse.message) {
        state.planApprovalStatus = 'FEEDBACK_SUBMITTED';
        emitSSE('agent_step', { agent: 'PlannerAgent', status: 'running', message: 'Updating plan with user feedback...' });
        state.userInput = `${state.originalUserRequest || state.userInput} (User plan feedback: ${userHitlResponse.message})`;
        const updatedPlannerOutput = await plannerAgentNode(state);
        state.plan = updatedPlannerOutput.plan || state.plan;
        persistenceEngine.saveCheckpoint(sessionId, 'PlannerAgent_Feedback', state);

        emitSSE('agent_step', {
          agent: 'PlannerAgent',
          status: 'completed',
          result: { plan: state.plan, status: state.status }
        });
      }

      state.planApprovalStatus = 'APPROVED';
      persistenceEngine.saveCheckpoint(sessionId, 'PlanApproval_Approved', state);

      // 5. Coder Agent
      logDiagnostic('GRAPH', 'ENTER CoderAgent', {});
      emitSSE('agent_step', { agent: 'CoderAgent', status: 'running', message: 'Generating multi-file code patches...' });
      let coderOutput = await codeGenAgentNode(state);
      state.extractedContext = coderOutput.extractedContext || state.extractedContext;
      completedStages.push('coder');
      persistenceEngine.saveCheckpoint(sessionId, 'CoderAgent', state);

      const diffCards = await prepareDiffCards(coderOutput.filePatches || []);

      // Auto-persist verified patches to disk so tests can validate them
      if (coderOutput.filePatches && coderOutput.filePatches.length > 0) {
        saveFilePatchesToServerDiskWithVerification(coderOutput.filePatches, emitSSE);
      }

      emitSSE('agent_step', {
        agent: 'CoderAgent',
        status: 'completed',
        result: { filePatches: coderOutput.filePatches, diffCards }
      });

      // 6. Test Runner & Self-Healing Debugger Loop
      logDiagnostic('GRAPH', 'ENTER TestRunnerAgent', {});
      emitSSE('agent_step', { agent: 'TestRunnerAgent', status: 'running', message: 'Executing workspace automated unit test suite...' });
      let testResult = await runWorkspaceTests(state.targetFiles);

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

      try {
        if (typeof (universalValidator as any)?.validateWorkspace === 'function') {
          await (universalValidator as any).validateWorkspace(state.targetFiles);
        } else {
          const sandboxTsConfig = path.resolve(process.cwd(), 'src/sandbox/tsconfig.json');
          const rootTsConfig = path.resolve(process.cwd(), 'tsconfig.json');
          if (fs.existsSync(sandboxTsConfig)) {
            await execAsync('npx tsc --noEmit', { cwd: './src/sandbox' });
          } else if (fs.existsSync(rootTsConfig)) {
            await execAsync('npx tsc --noEmit', { cwd: process.cwd() });
          }
        }
      } catch (error: any) {
        (state as any).compilerError = error.stdout || error.message || String(error);
        if (typeof debuggerAgentNode === 'function') {
          await debuggerAgentNode(state);
        }
      }

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
        let cleanCode = patch.code || '';
        // Only unescape if code is literally wrapped as a serialized JSON string
        if (cleanCode.startsWith('"') && cleanCode.endsWith('"') && cleanCode.includes('\\n')) {
          try { cleanCode = JSON.parse(cleanCode); } catch { }
        }
        fs.writeFileSync(fullPath, cleanCode, 'utf-8');
      } catch (err) {
        console.error(`Failed to write patch ${patch.filePath}:`, err);
      }
    }
  }
}

// Helper to recursively retrieve all sandbox files
function getSandboxFilesRecursively(dir: string, baseDir: string = dir): { name: string; path: string; isDir: boolean }[] {
  let results: { name: string; path: string; isDir: boolean }[] = [];
  if (!fs.existsSync(dir)) return results;

  try {
    const list = fs.readdirSync(dir);
    for (const item of list) {
      if (/^test[1-5]$/i.test(item)) continue; // hide benchmark test folders

      const fullPath = path.join(dir, item);
      try {
        const stat = fs.statSync(fullPath);
        const relativePath = path.relative(process.cwd(), fullPath).replace(/\\/g, '/');
        const relativeFromSandbox = path.relative(baseDir, fullPath).replace(/\\/g, '/');

        if (stat.isDirectory()) {
          results = results.concat(getSandboxFilesRecursively(fullPath, baseDir));
        } else {
          results.push({
            name: relativeFromSandbox,
            path: relativePath,
            isDir: false
          });
        }
      } catch {
        continue; // Safely skip broken links or transient files
      }
    }
  } catch (err) {
    console.warn(`[Workspace] Could not read directory ${dir}:`, err);
  }

  return results;
}

// Helper: Enforce canonical boundary inside src/sandbox
function isSafeSandboxPath(relPath: string): boolean {
  if (!relPath) return false;
  const sandboxRoot = path.resolve(process.cwd(), 'src/sandbox');
  const resolved = path.resolve(process.cwd(), relPath);
  return resolved.startsWith(sandboxRoot) && !isProtectedFile(relPath);
}

// Workspace File Explorer API
app.get('/api/workspace/files', (req: Request, res: Response) => {
  const sandboxDir = path.resolve(process.cwd(), 'src/sandbox');
  const files = getSandboxFilesRecursively(sandboxDir, sandboxDir);
  res.json({ sandboxFiles: files });
});

// Get File Content API
app.get('/api/workspace/file', (req: Request, res: Response) => {
  const relPath = req.query.path as string;
  if (!relPath) {
    return res.status(400).json({ error: 'path query parameter is required' });
  }

  if (!isSafeSandboxPath(relPath)) {
    return res.status(403).json({ error: `Access to '${relPath}' is forbidden. All files must stay inside src/sandbox/` });
  }

  const fullPath = path.resolve(process.cwd(), relPath);
  if (!fs.existsSync(fullPath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  const stat = fs.statSync(fullPath);
  if (stat.isDirectory()) {
    const sandboxDir = path.resolve(process.cwd(), 'src/sandbox');
    const childFiles = getSandboxFilesRecursively(fullPath, sandboxDir);
    if (childFiles.length > 0) {
      const firstFile = childFiles[0];
      const content = fs.readFileSync(path.resolve(process.cwd(), firstFile.path), 'utf-8');
      return res.json({ path: firstFile.path, content, isDirectory: true });
    }
    return res.status(400).json({ error: `'${relPath}' is a directory with no files` });
  }

  const content = fs.readFileSync(fullPath, 'utf-8');
  res.json({ path: relPath, content });
});

// Save File Content API
app.post('/api/workspace/file', (req: Request, res: Response) => {
  const { path: relPath, content } = req.body;
  if (!relPath || content === undefined) {
    return res.status(400).json({ error: 'path and content are required' });
  }

  if (!isSafeSandboxPath(relPath)) {
    return res.status(403).json({ error: `Cannot save to '${relPath}'. Path escapes sandbox or is protected.` });
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
    return res.status(400).json({ error: 'path parameter is required' });
  }

  if (!isSafeSandboxPath(relPath)) {
    return res.status(403).json({ error: `Cannot delete protected or non-sandbox file '${relPath}'` });
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
  const skipped: string[] = [];
  if (fs.existsSync(sandboxDir)) {
    const list = fs.readdirSync(sandboxDir);
    for (const item of list) {
      if (/^test[1-5]$/i.test(item)) continue; // preserve benchmark dirs
      const fullPath = path.join(sandboxDir, item);
      try {
        fs.rmSync(fullPath, { recursive: true, force: true });
      } catch (err: any) {
        skipped.push(item);
        console.warn(`[ClearSandbox] Could not remove ${item}:`, err?.message);
      }
    }
  }
  res.json({
    success: true,
    message: skipped.length > 0
      ? `Sandbox cleared (skipped locked items: ${skipped.join(', ')})`
      : 'All user sandbox files cleared'
  });
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

// Validate Groq API key on startup
async function validateGroqApiKey() {
  const API_KEY = process.env.GROQ_API_KEY;

  if (!API_KEY || API_KEY === 'your_groq_api_key_here') {
    console.warn("⚠️ Warning: GROQ_API_KEY is missing or default. AI features will be disabled.");
    return false;
  }

  try {
    console.log("🔍 Validating Groq API key on startup...");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { 'Authorization': `Bearer ${API_KEY}` },
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (response.status === 200) {
      console.log("✅ Groq API Key validated successfully on startup");
      return true;
    } else {
      console.warn(`⚠️ Warning: Groq API returned status ${response.status}. AI features may be degraded.`);
      return false;
    }
  } catch (error: any) {
    console.warn("⚠️ Warning: Could not reach Groq API (offline mode active):", error?.message || error);
    return false;
  }
}

// Execute startup validation before starting Express server listener with graceful shutdown
validateGroqApiKey().then(() => {
  const server = app.listen(PORT, () => {
    console.log(`\n==================================================`);
    console.log(`🚀 Kaizen AI Client Tier & Generative UI Server`);
    console.log(`   Running at: http://localhost:${PORT}`);
    console.log(`==================================================\n`);
  });

  const handleShutdown = (signal: string) => {
    console.log(`\n[Server] Received ${signal}. Closing HTTP and SSE connections...`);
    sseClients.forEach(c => {
      try { c.end(); } catch { }
    });
    server.close(() => {
      console.log('[Server] HTTP listener closed cleanly. Exiting.');
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000);
  };

  process.on('SIGINT', () => handleShutdown('SIGINT'));
  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
});
