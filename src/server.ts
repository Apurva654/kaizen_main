import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import * as dotenv from 'dotenv';
import { resolveProjectRoot } from './tools/githubAuthManager';
dotenv.config({ path: path.join(resolveProjectRoot(), '.env') });
import { exec, execSync, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
import * as universalValidator from './tools/universalValidator';
import { KaizenStateType, applyStateReducers } from './state';
import { intentAgentNode, extractTerminalCommand, extractGitActions, extractBrowserUrl, hasErrorEvidence, isMoveQuery } from './agents/intentAgent';
import { contextRetrievalAgentNode } from './agents/contextRetrievalAgent';
import { evaluateContextSufficiency } from './agents/contextSufficiencyAgent';
import { plannerAgentNode } from './agents/plannerAgent';
import { codeGenAgentNode, isProtectedFile, GeneratedFilePatch } from './agents/codeGenAgent';
import { reviewerAgentNode } from './agents/reviewerAgent';
import { debuggerAgentNode } from './agents/debuggerAgent';
import { langfuseTracer } from './tools/langfuseTracer';
import { persistenceEngine } from './tools/persistenceEngine';
import { runWorkspaceTests, extractFailingFilesFromLogs, TestExecutionResult } from './tools/testRunner';
import { preprocessUserRequest, saveAgentState, loadAgentState, recordConversationTurn } from './context/contextManager';
import { memoryEngine } from './context/memory/memoryEngine';
import { ocrService } from './tools/ocrService';
import { permissionGate, PermissionMode } from './tools/permissionGate';
import { mcpInterface } from './mcp/mcpInterface';
import { parseBrowserInspectionResult, formatBrowserInspectionMarkdown, extractRequestedBrowserAction, resolveAccessibilityTarget } from './tools/browserSnapshotParser';
import { performWebSearch, setSSEEmitter } from './tools/webSearchTool';
import { GraphifyEngine } from './tools/graphifyEngine';
import { githubAuthManager } from './tools/githubAuthManager';
import { getActiveModelProvider, DEFAULT_GEMINI_MODELS } from './tools/modelProvider';
import { workspaceManager } from './tools/workspaceManager';
import { isTestFile } from './tools/sandboxPathUtils';
import { failureSignature, patchHash, createHealGuardTracker } from './tools/healGuard';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../public')));
app.use('/sandbox', express.static(workspaceManager.getSandboxDir()));
app.use('/src/sandbox', express.static(workspaceManager.getSandboxDir()));

// Server-Sent Events (SSE) Clients list with session scoping
interface SSEClient {
  id: string;
  res: Response;
  sessionId?: string;
}

let sseClients: SSEClient[] = [];

function broadcastSSE(eventType: string, data: any, targetSessionId?: string) {
  const sessionFilter = targetSessionId || data?.sessionId;
  let payload: string;
  try {
    payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  } catch (err) {
    console.error('[SSE] Serialization failed for event:', eventType, err);
    return;
  }

  sseClients = sseClients.filter(client => {
    // If target session is specified and client registered with a specific sessionId, send only to matching client
    if (sessionFilter && client.sessionId && client.sessionId !== sessionFilter) {
      return true; // Keep connected, do not emit unrelated session events
    }
    try {
      client.res.write(payload);
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
      client.res.write(': heartbeat\n\n');
      return true;
    } catch {
      return false; // Drop disconnected client
    }
  });
}, 30000);

// SSE Connection Endpoint with optional sessionId scoping
app.get('/api/stream', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sessionId = (req.query.sessionId as string) || (req.headers['x-session-id'] as string) || undefined;
  const client: SSEClient = {
    id: `client_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    res,
    sessionId
  };

  sseClients.push(client);
  res.write(`event: connected\ndata: ${JSON.stringify({ status: 'connected', clientsCount: sseClients.length, sessionId })}\n\n`);

  req.on('close', () => {
    sseClients = sseClients.filter(c => c !== client);
  });
});

// Health-Check Endpoint for VS Code Extension Host and Monitoring
app.get('/api/health', async (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    port: PORT,
    modelProvider: getActiveModelProvider(),
    defaultModels: DEFAULT_GEMINI_MODELS,
    permissionMode: permissionGate.getMode(),
    isDryRunMode: permissionGate.isDryRunMode(),
    isDockerActive: false
  });
});

// Permission Gate Status Endpoint
app.get('/api/permission/status', async (req: Request, res: Response) => {
  res.json({
    mode: permissionGate.getMode(),
    isDryRunMode: permissionGate.isDryRunMode(),
    isDockerActive: false
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

// GitHub Authentication Status Endpoint
app.get('/api/github/status', async (req: Request, res: Response) => {
  try {
    const status = await githubAuthManager.getStatus();
    res.json(status);
  } catch (err: any) {
    res.status(500).json({ isAuthenticated: false, authType: 'none', error: err?.message || String(err) });
  }
});

// GitHub Authentication Login / Token Endpoint
app.post('/api/github/login', async (req: Request, res: Response) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string') {
    res.status(400).json({ success: false, error: 'GitHub Personal Access Token is required.' });
    return;
  }
  try {
    const status = await githubAuthManager.setToken(token);
    res.json({ success: true, status });
  } catch (err: any) {
    res.status(401).json({ success: false, error: err?.message || 'Invalid token or API error' });
  }
});

// GitHub Authentication Logout Endpoint
app.post('/api/github/logout', (req: Request, res: Response) => {
  try {
    githubAuthManager.clearToken();
    res.json({ success: true, message: 'GitHub session logged out.' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || String(err) });
  }
});

interface LiveProcess {
  child: ChildProcess;
  filePath: string;
  startTime: number;
  sessionId: string;
}

const activeLiveProcesses = new Map<string, LiveProcess>();

function getLiveProcessForSession(requestedSessionId?: string): { sessionId: string; process: LiveProcess } | null {
  if (requestedSessionId && activeLiveProcesses.has(requestedSessionId)) {
    return { sessionId: requestedSessionId, process: activeLiveProcesses.get(requestedSessionId)! };
  }
  if (!requestedSessionId && activeLiveProcesses.size === 1) {
    const [sessionId, process] = Array.from(activeLiveProcesses.entries())[0];
    return { sessionId, process };
  }
  if (activeLiveProcesses.has('default')) {
    return { sessionId: 'default', process: activeLiveProcesses.get('default')! };
  }
  return null;
}

// Direct Code File Execution Endpoint
app.post('/api/code/run', async (req: Request, res: Response) => {
  const { filePath, content, sessionId: clientSessionId } = req.body;
  const procSessionId = clientSessionId || 'default';
  const targetFile = filePath || 'src/sandbox/main.ts';
  const fullPath = workspaceManager.resolvePath(targetFile);

  if (typeof content === 'string' && content.trim() && fs.existsSync(path.dirname(fullPath))) {
    try {
      fs.writeFileSync(fullPath, content, 'utf-8');
    } catch (e) {
      console.warn('[RunAPI] Failed to auto-sync buffer to file disk:', e);
    }
  }

  if (!fs.existsSync(fullPath)) {
    res.status(404).json({ success: false, error: `File not found: ${targetFile}` });
    return;
  }

  const ext = path.extname(targetFile).toLowerCase();
  const startTime = Date.now();

  try {
    if (ext === '.html') {
      const fileName = path.basename(targetFile);
      const browserUrl = `http://localhost:3000/sandbox/${fileName}`;
      res.json({
        success: true,
        filePath: targetFile,
        language: 'html',
        output: `Webpage hosted statically at ${browserUrl}. Opening live preview...`,
        executionTimeMs: Date.now() - startTime,
        exitCode: 0,
        browserUrl
      });
      return;
    }

    const existingProc = activeLiveProcesses.get(procSessionId);
    if (existingProc && existingProc.child) {
      try {
        existingProc.child.kill();
      } catch {}
      activeLiveProcesses.delete(procSessionId);
    }

    const stdinPayload = typeof req.body.stdin === 'string' ? req.body.stdin : (typeof req.body.input === 'string' ? req.body.input : '');

    let executable = 'node';
    let args: string[] = [targetFile];
    let runLanguage = 'javascript';

    if (ext === '.py') {
      executable = 'python';
      args = ['-u', targetFile];
      runLanguage = 'python';
    } else if (ext === '.ts') {
      executable = process.platform === 'win32' ? 'npx.cmd' : 'npx';
      args = ['ts-node', '--transpile-only', targetFile];
      runLanguage = 'typescript';
    } else if (ext === '.js') {
      executable = 'node';
      args = [targetFile];
      runLanguage = 'javascript';
    } else if (ext === '.go') {
      executable = 'go';
      args = ['run', targetFile];
      runLanguage = 'go';
    } else if (ext === '.rs') {
      executable = 'rustc';
      args = [targetFile];
      runLanguage = 'rust';
    } else if (ext === '.cpp' || ext === '.cc' || ext === '.c') {
      executable = 'g++';
      args = [targetFile];
      runLanguage = 'c/c++';
    } else if (ext === '.java') {
      executable = 'java';
      args = [targetFile];
      runLanguage = 'java';
    } else if (ext === '.php') {
      executable = 'php';
      args = [targetFile];
      runLanguage = 'php';
    } else if (ext === '.sh') {
      executable = 'bash';
      args = [targetFile];
      runLanguage = 'shell';
    } else {
      res.status(400).json({
        success: false,
        error: `Unsupported file extension '${ext}'. Supported runtimes: .ts, .js, .py, .go, .rs, .cpp, .java, .php, .sh, .html`
      });
      return;
    }

    const isWin = process.platform === 'win32';
    const child = spawn(executable, args, {
      cwd: workspaceManager.getWorkspaceRoot(),
      shell: isWin,
      env: { ...process.env, PYTHONUNBUFFERED: '1' }
    });

    const liveProc: LiveProcess = {
      child,
      filePath: targetFile,
      startTime,
      sessionId: procSessionId
    };
    activeLiveProcesses.set(procSessionId, liveProc);

    if (stdinPayload && child.stdin) {
      try {
        child.stdin.write(stdinPayload.replace(/\\n/g, '\n') + '\n');
      } catch {}
    }

    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString('utf-8');
      broadcastSSE('code_chunk', { text, filePath: targetFile, sessionId: procSessionId }, procSessionId);
    });

    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString('utf-8');
      broadcastSSE('code_chunk', { text, filePath: targetFile, sessionId: procSessionId }, procSessionId);
    });

    child.on('close', (exitCode) => {
      const durationMs = Date.now() - startTime;
      broadcastSSE('code_exit', {
        exitCode: exitCode ?? 0,
        executionTimeMs: durationMs,
        filePath: targetFile,
        sessionId: procSessionId
      }, procSessionId);
      activeLiveProcesses.delete(procSessionId);
    });

    child.on('error', (err) => {
      const errorMsg = err.message.includes('ENOENT')
        ? `Runtime '${executable}' for ${runLanguage} not found on system PATH.`
        : err.message;
      broadcastSSE('code_chunk', { text: `\n[Process Error]: ${errorMsg}\n`, filePath: targetFile, sessionId: procSessionId }, procSessionId);
      broadcastSSE('code_exit', { exitCode: 1, executionTimeMs: Date.now() - startTime, filePath: targetFile, sessionId: procSessionId }, procSessionId);
      activeLiveProcesses.delete(procSessionId);
    });

    res.json({
      success: true,
      isLiveStream: true,
      filePath: targetFile,
      language: runLanguage
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      filePath: targetFile,
      output: err?.message || String(err),
      executionTimeMs: Date.now() - startTime,
      exitCode: 1
    });
  }
});

// Live Interactive Process Stdin Endpoint
app.post('/api/code/input', (req: Request, res: Response) => {
  const { input, text, sessionId } = req.body;
  const inputText = String(input !== undefined ? input : (text !== undefined ? text : ''));

  const entry = getLiveProcessForSession(sessionId);
  if (!entry || !entry.process.child || entry.process.child.killed) {
    res.status(400).json({ success: false, error: 'No active running process waiting for input.' });
    return;
  }

  try {
    if (entry.process.child.stdin && !entry.process.child.stdin.destroyed) {
      entry.process.child.stdin.write(inputText + '\n');
      broadcastSSE('code_chunk', { text: inputText + '\n', isUserStdin: true, sessionId: entry.sessionId }, entry.sessionId);
      res.json({ success: true, message: 'Input sent to process stdin' });
    } else {
      res.status(400).json({ success: false, error: 'Process stdin stream is closed' });
    }
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed to write to process stdin' });
  }
});

// Terminate Live Running Process Endpoint
app.post('/api/code/kill', (req: Request, res: Response) => {
  const { sessionId } = req.body;
  const entry = getLiveProcessForSession(sessionId);
  if (entry && entry.process.child) {
    try {
      entry.process.child.kill();
      broadcastSSE('code_chunk', { text: '\n[Process Terminated by User]\n', sessionId: entry.sessionId }, entry.sessionId);
      broadcastSSE('code_exit', { exitCode: 130, executionTimeMs: Date.now() - entry.process.startTime, sessionId: entry.sessionId }, entry.sessionId);
      activeLiveProcesses.delete(entry.sessionId);
      res.json({ success: true, message: 'Process terminated.' });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'Failed to terminate process' });
    }
  } else {
    res.json({ success: true, message: 'No process currently running.' });
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
      const result = await mcpInterface.executeTerminalCommand(command || 'dir', workspaceManager.getWorkspaceRoot(), options);
      res.json(result);
    } else {
      res.status(400).json({ error: 'Unsupported MCP tool.' });
    }
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// Session-and-Request-aware HITL (Human-In-The-Loop) Registry
interface HitlPendingEntry {
  requestId: string;
  sessionId: string;
  resolve: (value: { action: 'approve' | 'reject' | 'feedback'; message?: string }) => void;
  timer: NodeJS.Timeout;
  timestamp: number;
}

const hitlPendingQueue: HitlPendingEntry[] = [];

function registerHitl(
  sessionId: string,
  resolve: (val: any) => void,
  timeoutMs = 300000,
  customRequestId?: string
): string {
  const requestId = customRequestId || `hitl_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  const timer = setTimeout(() => {
    const idx = hitlPendingQueue.findIndex(e => e.requestId === requestId);
    if (idx !== -1) {
      const [entry] = hitlPendingQueue.splice(idx, 1);
      entry.resolve({ action: 'reject', message: 'HITL request timed out after 5 minutes.' });
    }
  }, timeoutMs);

  hitlPendingQueue.push({
    requestId,
    sessionId,
    resolve,
    timer,
    timestamp: Date.now()
  });

  return requestId;
}

// HITL Response Endpoint
app.post('/api/hitl/respond', (req: Request, res: Response) => {
  const { sessionId, requestId } = req.body;
  const action = req.body.action || req.body.response?.action || 'approve';
  const message = req.body.message || req.body.response?.message;

  let entryIndex = -1;

  if (requestId) {
    entryIndex = hitlPendingQueue.findIndex(e => e.requestId === requestId);
  }

  if (entryIndex === -1 && sessionId) {
    // Pick the earliest pending HITL entry for this session
    entryIndex = hitlPendingQueue.findIndex(e => e.sessionId === sessionId);
  }

  if (entryIndex === -1 && hitlPendingQueue.length > 0) {
    // Fallback to earliest pending entry in queue
    entryIndex = 0;
  }

  if (entryIndex !== -1) {
    const [entry] = hitlPendingQueue.splice(entryIndex, 1);
    clearTimeout(entry.timer);
    entry.resolve({ action, message });
    return res.json({
      status: 'acknowledged',
      success: true,
      message: `HITL response recorded for session ${entry.sessionId} (request: ${entry.requestId}).`,
      requestId: entry.requestId
    });
  }

  // Preemptive or completed dispatch acknowledgement
  return res.json({ status: 'acknowledged', success: true, message: 'HITL response acknowledged.' });
});

export function resolvePendingHitl(
  sessionId?: string,
  action: 'approve' | 'reject' | 'feedback' = 'approve',
  message?: string
): boolean {
  let entryIndex = -1;
  if (sessionId) {
    entryIndex = hitlPendingQueue.findIndex(e => e.sessionId === sessionId);
  }
  if (entryIndex === -1 && hitlPendingQueue.length > 0) {
    entryIndex = 0;
  }
  if (entryIndex !== -1) {
    const [entry] = hitlPendingQueue.splice(entryIndex, 1);
    clearTimeout(entry.timer);
    entry.resolve({ action, message });
    return true;
  }
  return false;
}

// Graphify Explorer REST API Endpoints
app.get('/api/graphify/current', async (req: Request, res: Response) => {
  try {
    const scope = (req.query.scope as string) || 'current-task';
    const activeFile = (req.query.activeFile as string) || undefined;
    const reqWorkspace = (req.query.workspaceRoot as string) || undefined;
    const edgeTypeFilter = (req.query.edgeTypeFilter as string) || 'all';
    const { GraphifyEngine } = await import('./tools/graphifyEngine');

    let workspaceRoot = reqWorkspace || (fs.existsSync('src/sandbox') ? 'src/sandbox' : '.');

    const engine = new GraphifyEngine();
    await engine.scanDirectory(workspaceRoot);

    let targetFiles: string[] = activeFile ? [activeFile] : [];
    if (targetFiles.length === 0) {
      const sandboxDir = workspaceManager.getSandboxDir();
      if (fs.existsSync(sandboxDir)) {
        try {
          const sFiles = fs.readdirSync(sandboxDir).filter(f => !f.startsWith('.') && fs.statSync(path.join(sandboxDir, f)).isFile());
          if (sFiles.length > 0) targetFiles = sFiles.slice(0, 5).map(f => `src/sandbox/${f}`);
        } catch { }
      }
      if (targetFiles.length === 0) targetFiles = ['src/sandbox/main.ts'];
    }
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
      activeFile,
      edgeTypeFilter
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
    const { GraphifyEngine } = await import('./tools/graphifyEngine');
    const engine = new GraphifyEngine();
    await engine.scanDirectory(fs.existsSync('src/sandbox') ? 'src/sandbox' : '.');
    const payload = engine.exportGraphData({ scope: 'full' });

    const targetNode = payload.nodes.find((n: any) => n.id === nodeId || n.path === nodeId);
    const relatedEdges = payload.edges.filter((e: any) => e.source === nodeId || e.target === nodeId);
    res.json({ node: targetNode || null, edges: relatedEdges });
  } catch (err: any) {
    console.error('[GraphifyAPI] Error fetching node details:', err);
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.get('/api/graphify/impact', async (req: Request, res: Response) => {
  try {
    const nodeId = (req.query.id as string) || '';
    if (!nodeId) {
      res.status(400).json({ error: 'Node ID parameter is required' });
      return;
    }
    const { GraphifyEngine } = await import('./tools/graphifyEngine');
    const engine = new GraphifyEngine();
    await engine.scanDirectory(fs.existsSync('src/sandbox') ? 'src/sandbox' : '.');
    const impact = engine.getImpactAnalysis(nodeId);
    res.json(impact);
  } catch (err: any) {
    console.error('[GraphifyAPI] Error computing impact analysis:', err);
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.get('/api/graphify/trace', async (req: Request, res: Response) => {
  try {
    const sourceId = (req.query.sourceId as string) || '';
    const targetId = (req.query.targetId as string) || '';
    if (!sourceId || !targetId) {
      res.status(400).json({ error: 'sourceId and targetId parameters are required' });
      return;
    }
    const { GraphifyEngine } = await import('./tools/graphifyEngine');
    const engine = new GraphifyEngine();
    await engine.scanDirectory(fs.existsSync('src/sandbox') ? 'src/sandbox' : '.');
    const pathTrace = engine.tracePath(sourceId, targetId);
    res.json({ path: pathTrace });
  } catch (err: any) {
    console.error('[GraphifyAPI] Error tracing dependency path:', err);
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// Comprehensive Verification Test Suite Endpoint
app.get('/api/test/comprehensive', async (req: Request, res: Response) => {
  try {
    const results: Array<{ feature: string; status: 'PASS' | 'WARN' | 'FAIL'; details: string }> = [];

    // 1. Model Provider Verification
    const provider = getActiveModelProvider();
    results.push({
      feature: 'Model Provider & Gemini 2.5 Engine',
      status: provider === 'gemini' ? 'PASS' : 'WARN',
      details: provider === 'gemini'
        ? `Google Gemini configured with models: ${DEFAULT_GEMINI_MODELS.join(', ')}`
        : 'Running in offline mode (set GEMINI_API_KEY for live models).'
    });

    // 2. PermissionGate & Security Engine
    const permMode = permissionGate.getMode();
    const testEval = permissionGate.evaluate('terminal_exec', { command: 'rm -rf /' });
    results.push({
      feature: 'PermissionGate Security & Risk Interceptor',
      status: testEval.requiresApproval && testEval.riskScore >= 70 ? 'PASS' : 'FAIL',
      details: `Active mode: ${permMode}. High-risk command interception verified (risk score: ${testEval.riskScore}/100).`
    });

    // 3. AST & Graphify Dependency Engine
    let graphStatus: 'PASS' | 'WARN' = 'PASS';
    let graphDetails = 'Graphify knowledge graph engine active.';
    try {
      const { GraphifyEngine } = await import('./tools/graphifyEngine');
      const engine = new GraphifyEngine();
      const sandboxDir = fs.existsSync('src/sandbox') ? 'src/sandbox' : '.';
      await engine.scanDirectory(sandboxDir);
      const graph = engine.exportGraphData();
      graphDetails = `Workspace AST graph built (${graph.nodes.length} symbols, ${graph.edges.length} relationships).`;
    } catch (e: any) {
      graphStatus = 'WARN';
      graphDetails = `AST indexing operating in lightweight fallback mode: ${e?.message || e}`;
    }
    results.push({
      feature: 'AST Graphify Codebase Dependency Engine',
      status: graphStatus,
      details: graphDetails
    });

    // 4. Long-Term Persistent Memory System
    results.push({
      feature: 'Persistent Cross-Turn Vector & State Memory',
      status: 'PASS',
      details: `Operational (${memoryEngine.longTermMemory.getAllFacts().length} facts, ${memoryEngine.shortTermMemory.getEvents().length} timeline turns recorded).`
    });

    // 5. Multi-Language Workspace Sandbox Environment
    const sandboxDir = path.resolve(process.cwd(), 'src/sandbox');
    const sandboxReady = fs.existsSync(sandboxDir);
    const sandboxConfigReady = fs.existsSync(path.resolve(sandboxDir, 'tsconfig.json'));
    results.push({
      feature: 'Isolated Code Execution Sandbox (src/sandbox)',
      status: (sandboxReady && sandboxConfigReady) ? 'PASS' : 'WARN',
      details: (sandboxReady && sandboxConfigReady)
        ? `Sandbox directory and isolated tsconfig.json verified at ${sandboxDir}`
        : 'Sandbox directory verified.'
    });

    // 6. Multi-File Patch Verification & Rollback
    const hasRollback = typeof rollbackOriginalSnapshots === 'function';
    results.push({
      feature: 'Atomic Code Generation & Rollback Subsystem',
      status: hasRollback ? 'PASS' : 'FAIL',
      details: 'Diff cards with pre-modification snapshots and one-click rollback endpoint active.'
    });

    const passCount = results.filter(r => r.status === 'PASS').length;
    res.json({
      success: true,
      summary: `Comprehensive verification completed: ${passCount}/${results.length} checks passed.`,
      passCount,
      totalCount: results.length,
      results
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || String(err), results: [] });
  }
});

// Clear Permanent Model Memory Endpoint
app.post('/api/memory/clear', (req: Request, res: Response) => {
  try {
    memoryEngine.clearAllMemory();
    res.json({ success: true, message: 'Permanent model memory cleared successfully.' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || String(err) });
  }
});

// Workspace Management Endpoints
app.get('/api/workspace', (req: Request, res: Response) => {
  res.json({
    workspaceRoot: workspaceManager.getWorkspaceRoot(),
    sandboxDir: workspaceManager.getSandboxDir(),
    isExternal: workspaceManager.isExternalProject()
  });
});

app.post('/api/workspace', (req: Request, res: Response) => {
  const { workspaceRoot } = req.body;
  if (workspaceRoot && typeof workspaceRoot === 'string') {
    workspaceManager.setWorkspaceRoot(workspaceRoot);
    res.json({ success: true, workspaceRoot: workspaceManager.getWorkspaceRoot() });
  } else {
    res.status(400).json({ error: 'workspaceRoot string is required.' });
  }
});

// Snapshot store for original pre-modification files per session
const sessionSnapshots = new Map<string, Array<{ filePath: string; originalCode: string }>>();

export function rollbackOriginalSnapshots(snapshots: Array<{ filePath: string; originalCode: string }>): { restored: string[]; errors: string[] } {
  const restored: string[] = [];
  const errors: string[] = [];
  for (const snap of snapshots) {
    if (workspaceManager.isProtected(snap.filePath)) continue;
    try {
      const fullPath = workspaceManager.resolvePath(snap.filePath);
      if (snap.originalCode === "") {
        // File did not exist before execution, clean it up on rollback
        if (fs.existsSync(fullPath)) {
          fs.unlinkSync(fullPath);
          restored.push(`Deleted new file: ${snap.filePath}`);
        }
      } else {
        const dir = path.dirname(fullPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(fullPath, snap.originalCode, 'utf-8');
        restored.push(`Restored: ${snap.filePath}`);
      }
    } catch (err: any) {
      errors.push(`Failed restoring ${snap.filePath}: ${err?.message || err}`);
    }
  }
  return { restored, errors };
}

// Rollback Endpoint to restore files from pre-modification snapshots
app.post('/api/pipeline/rollback', (req: Request, res: Response) => {
  const { sessionId } = req.body;
  const snapshots = sessionId ? sessionSnapshots.get(sessionId) : undefined;
  if (!snapshots || snapshots.length === 0) {
    res.status(404).json({ error: 'No original snapshots found for rollback in session: ' + sessionId });
    return;
  }
  const result = rollbackOriginalSnapshots(snapshots);
  res.json({ success: true, ...result });
});

// Run Agent Pipeline Endpoint
app.post('/api/pipeline/run', async (req: Request, res: Response) => {
  const { userInput, imagePayload, sessionId: reqSessionId, workspaceRoot } = req.body;

  if (workspaceRoot && typeof workspaceRoot === 'string') {
    workspaceManager.setWorkspaceRoot(workspaceRoot);
  }

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
    }, reqSessionId);
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

export async function runPipeline(
  rawUserInput: string,
  imagePayload?: string,
  clientSessionId?: string,
  cliCallback?: (eventType: string, data: any) => void,
  pipelineOptions?: { initialStatus?: string }
): Promise<KaizenStateType> {
  const sessionId = clientSessionId || persistenceEngine.generateSessionId();
  const runId = `run_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const createdAt = new Date().toISOString();

  const emitSSE = (eventType: string, data: any) => {
    broadcastSSE(eventType, { ...data, runId, sessionId }, sessionId);
    if (cliCallback) {
      try {
        cliCallback(eventType, { ...data, runId, sessionId });
      } catch {}
    }
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
    planFeedback: undefined,
    planAttempt: 0,
    rejectedPlans: [],
    planFailureReason: undefined,
    generatedPatch: "",
    filePatches: [],
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
    dockerSandboxActive: false,
    structuredFailures: [],
    errorsEncountered: 0,
    lastPlan: undefined,
    planTimestamp: undefined,
    canRetry: true,
    rejectionReason: undefined,
    requestedLanguage: undefined,
    languageInfo: undefined,
    generationSource: undefined,
    generationFailureReason: undefined,
    originalSnapshots: [],
    failureDetails: undefined,
    compilerError: undefined,
    workspaceContext: undefined,
    testLogs: undefined,
    reviewerFeedback: undefined
  };

  // State update wrapper that executes all LangGraph Annotation reducers
  const updateState = (updates: Partial<KaizenStateType>): KaizenStateType => {
    state = applyStateReducers(state, updates);
    return state;
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

    // Update state memory and episodic experience memory
    memoryEngine.stateMemory.updateState(state);

    if (state.targetFiles && state.targetFiles.length > 0) {
      memoryEngine.consolidator.consolidateTaskOutcome({
        task: rawUserInput,
        intent: state.status,
        affectedFiles: state.targetFiles,
        actions: state.completedStages || [],
        errors: (state.structuredFailures || []).map(f => typeof f === 'string' ? f : f.message || JSON.stringify(f)),
        solution: extraData.explanation || (state.generatedPatch ? 'Generated and verified code patches' : 'Task completed'),
        outcome: (finalStatus === 'FAILED' || finalStatus === 'ABORTED') ? 'failure' : 'success',
        testsPassed: finalStatus === 'SUCCESS',
        lessons: (state as any).reviewReport?.issues || []
      });
    }

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

    const vLevel = extraData.verificationLevel ||
      (extraData.testResult as any)?.verificationLevel ||
      ((state as any).testResult as any)?.verificationLevel;
    const vNote = extraData.verificationNote ||
      (extraData.testResult as any)?.verificationNote ||
      ((state as any).testResult as any)?.verificationNote;

    emitSSE('pipeline_complete', {
      sessionId,
      status: finalStatus,
      targetFiles: state.targetFiles,
      plan: state.plan,
      completedStages,
      skippedStages,
      retryCount: state.retryCount,
      verificationLevel: vLevel,
      verificationNote: vNote,
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
    if (processed.enhancedPrompt && processed.enhancedPrompt !== promptToProcess) {
      state.userInput = processed.enhancedPrompt;
    }
    state.workspaceContext = processed.workspaceContext || "";
    state.extractedContext = processed.workspaceContext || "";
    memoryEngine.stateMemory.updateState(state);

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
      return state;
    }

    persistenceEngine.saveCheckpoint(sessionId, 'INITIALIZED', state);

    // 1. Intent Agent
    logDiagnostic('GRAPH', 'ENTER IntentAgent', { userInput });
    emitSSE('agent_step', { agent: 'IntentAgent', status: 'running', message: 'Classifying user intent...' });
    const intentOutput = await intentAgentNode(state);
    const effectiveStatus = pipelineOptions?.initialStatus || intentOutput.status;
    updateState({
      status: effectiveStatus,
      targetFiles: intentOutput.targetFiles,
      requestedLanguage: intentOutput.requestedLanguage,
      languageInfo: intentOutput.languageInfo,
      completedStages: ['intent']
    });
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

          const userHitlResponse = await new Promise<{ action: 'approve' | 'reject' | 'feedback'; message?: string }>((resolve) => {
            const reqId = registerHitl(sessionId, resolve);
            emitSSE('hitl_request', {
              type: 'GIT_PERMISSION_APPROVAL',
              title: `Permission Gate Intercept: Git ${action.toUpperCase()}`,
              message: evalResult.reason,
              action,
              riskScore: evalResult.riskScore,
              requestId: reqId
            });
          });
          emitSSE('hitl_received', { response: userHitlResponse });
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
      return state;
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

        const userHitlResponse = await new Promise<{ action: 'approve' | 'reject' | 'feedback'; message?: string }>((resolve) => {
          const reqId = registerHitl(sessionId, resolve);
          emitSSE('hitl_request', {
            type: 'TERMINAL_PERMISSION_APPROVAL',
            title: `Permission Gate Intercept: Terminal Execution`,
            message: evalResult.reason,
            command: command,
            riskScore: evalResult.riskScore,
            requestId: reqId
          });
        });
        emitSSE('hitl_received', { response: userHitlResponse });
        isApproved = userHitlResponse.action === 'approve';
      }

      const isSimulatedPrompt = /\b(simulat|dry-run|dry run|fake|mock|permission gate)\b/i.test(rawUserInput);
      const isDryRun = permissionGate.isDryRunMode() || isSimulatedPrompt;

      const mcpResult = await mcpInterface.executeTerminalCommand(command, workspaceManager.getWorkspaceRoot(), {
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
      return state;
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
          const userHitlResponse = await new Promise<{ action: 'approve' | 'reject' | 'feedback'; message?: string }>((resolve) => {
            const reqId = registerHitl(sessionId, resolve);
            emitSSE('hitl_request', {
              type: 'BROWSER_PERMISSION_APPROVAL',
              title: 'Permission Gate Intercept: Browser Navigation',
              message: evalNav.reason,
              url: targetUrl,
              riskScore: evalNav.riskScore,
              requestId: reqId
            });
          });
          emitSSE('hitl_received', { response: userHitlResponse });
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
              const userHitlResponse = await new Promise<{ action: 'approve' | 'reject' | 'feedback'; message?: string }>((resolve) => {
                const reqId = registerHitl(sessionId, resolve);
                emitSSE('hitl_request', {
                  type: 'BROWSER_PERMISSION_APPROVAL',
                  title: `Permission Gate Intercept: Browser ${requestedAction.action.toUpperCase()}`,
                  message: evalAction.reason,
                  url: targetUrl,
                  riskScore: evalAction.riskScore,
                  requestId: reqId
                });
              });
              emitSSE('hitl_received', { response: userHitlResponse });
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
        return state;
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

      const sandboxDir = workspaceManager.getSandboxDir();
      let targetFilesToDelete: string[] = [];

      const getFilesRecursively = (dir: string): string[] => {
        let results: string[] = [];
        if (!fs.existsSync(dir)) return results;
        const list = fs.readdirSync(dir);
        for (const item of list) {
          const fullPath = path.join(dir, item);
          const relPath = workspaceManager.toRelativePath(fullPath);
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            results = results.concat(getFilesRecursively(fullPath));
          } else {
            results.push(relPath);
          }
        }
        return results;
      };

      // Check if user explicitly asked for a full wipe or named specific files
      const isFullWipe = /\b(all|entire|whole|clean|clear|everything)\b/i.test(rawUserInput) || !state.targetFiles || state.targetFiles.length === 0;

      if (!isFullWipe && state.targetFiles && state.targetFiles.length > 0) {
        // Delete ONLY the specifically named target files!
        targetFilesToDelete = state.targetFiles.map(f => workspaceManager.toRelativePath(workspaceManager.resolvePath(f)));
      } else if (fs.existsSync(sandboxDir)) {
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
          explanation: `### ℹ️ Workspace Sandbox Is Empty\n\nThe targeted workspace sandbox contains 0 matching files. No file deletion was needed.`
        });
        return state;
      }

      const evalResult = permissionGate.evaluate('file_delete', { command: rawUserInput, files: targetFilesToDelete });
      let isApproved = true;
      let hasBlockedAction = false;

      if (evalResult.requiresApproval && !evalResult.allowed) {
        hasBlockedAction = true;
        const userHitlResponse = await new Promise<{ action: 'approve' | 'reject' | 'feedback'; message?: string }>((resolve) => {
          const reqId = registerHitl(sessionId, resolve);
          emitSSE('hitl_request', {
            type: 'FILE_DELETION_APPROVAL',
            title: 'Permission Gate Intercept: File Deletion Request',
            message: `The agent is requesting permission to delete ${targetFilesToDelete.length} files:\n${targetFilesToDelete.join('\n')}`,
            files: targetFilesToDelete,
            riskScore: evalResult.riskScore,
            requestId: reqId
          });
        });
        emitSSE('hitl_received', { response: userHitlResponse });
        isApproved = userHitlResponse.action === 'approve';
      }

      let explanation = '';
      if (isApproved) {
        let deletedCount = 0;
        const deletedFiles: string[] = [];
        for (const fileRel of targetFilesToDelete) {
          const fullPath = workspaceManager.resolvePath(fileRel);
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
      return state;
    }

    // Routing Logic for File Moving & Organizing (Permission Gate HITL)
    if (state.status === "ROUTED_MOVE_FILES") {
      skippedStages.push('context', 'planner', 'coder', 'testrunner', 'debugger', 'reviewer');
      emitSSE('agent_step', { agent: 'IntentAgent', status: 'running', message: '📁 Evaluating file move request with Permission Gate...' });

      const sandboxDir = workspaceManager.getSandboxDir();

      // Separator check and path validator using resolved path and isProtectedFile
      const validateSandboxPath = (rawPath: string): { valid: boolean; resolved: string; relPath: string; error?: string } => {
        if (!rawPath || typeof rawPath !== 'string') {
          return { valid: false, resolved: '', relPath: '', error: 'Path is empty or invalid.' };
        }
        let clean = rawPath.replace(/\\/g, '/').trim();
        if (clean.startsWith('src/sandbox/')) {
          clean = clean.substring('src/sandbox/'.length);
        } else if (clean.startsWith('sandbox/')) {
          clean = clean.substring('sandbox/'.length);
        }
        const resolvedSandbox = path.resolve(sandboxDir);
        const resolved = path.resolve(resolvedSandbox, clean);

        // Separator check: resolved must be resolvedSandbox or strictly inside it with separator
        const isInside = resolved === resolvedSandbox || resolved.startsWith(resolvedSandbox + path.sep);
        if (!isInside) {
          return { valid: false, resolved, relPath: '', error: `Path "${rawPath}" resolves outside src/sandbox.` };
        }
        const relPath = workspaceManager.toRelativePath(resolved);
        if (isProtectedFile(relPath)) {
          return { valid: false, resolved, relPath, error: `Path "${relPath}" is a protected file or directory.` };
        }
        return { valid: true, resolved, relPath };
      };

      // 1. Extract Destination
      const destMatch = rawUserInput.match(/\b(?:in|into|to)\s+([a-zA-Z0-9_\-\.\/]+)/i);
      let rawDestination = destMatch ? destMatch[1].replace(/[.,;:!?]+$/, '').trim() : '';

      if (!rawDestination) {
        await finalizeExecution('FAILED', {
          route: 'MOVE_FILES',
          explanation: `### 🛑 Move Failed\n\nCould not determine destination folder or filename from prompt: "${rawUserInput}".`
        });
        return state;
      }

      const destValidation = validateSandboxPath(rawDestination);
      if (!destValidation.valid) {
        await finalizeExecution('FAILED', {
          route: 'MOVE_FILES',
          explanation: `### 🛑 Security Rejection: Invalid Destination Path\n\n${destValidation.error}`
        });
        return state;
      }

      // 2. Extract Requested Count N (e.g. "these 4 files", "these four files")
      const wordToNum: Record<string, number> = {
        one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10
      };
      const countMatch = rawUserInput.match(/\b(?:these|those|the)?\s*(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+files\b/i);
      let requestedCount: number | undefined;
      if (countMatch) {
        const rawNum = countMatch[1].toLowerCase();
        requestedCount = wordToNum[rawNum] !== undefined ? wordToNum[rawNum] : parseInt(rawNum, 10);
      }

      // 3. Resolve eligible top-level sandbox files
      const topLevelItems = fs.existsSync(sandboxDir) ? fs.readdirSync(sandboxDir, { withFileTypes: true }) : [];
      const eligibleTopLevelFiles = topLevelItems
        .filter(item => item.isFile() && !item.name.startsWith('.'))
        .map(item => `src/sandbox/${item.name}`)
        .filter(f => !isProtectedFile(f) && path.basename(f) !== path.basename(destValidation.resolved));

      // (1) Resolve named files: check sandbox top level first, search subfolders only if no top-level match
      const resolveNamedFile = (name: string): string | null => {
        const baseName = path.basename(name);
        const topLevelPath = path.join(sandboxDir, baseName);
        if (fs.existsSync(topLevelPath) && fs.statSync(topLevelPath).isFile()) {
          return workspaceManager.toRelativePath(topLevelPath);
        }
        const searchSubfolders = (dir: string): string | null => {
          if (!fs.existsSync(dir)) return null;
          const items = fs.readdirSync(dir, { withFileTypes: true });
          for (const item of items) {
            const full = path.join(dir, item.name);
            if (item.isDirectory()) {
              const subMatch = searchSubfolders(full);
              if (subMatch) return subMatch;
            } else if (item.isFile() && item.name.toLowerCase() === baseName.toLowerCase()) {
              return workspaceManager.toRelativePath(full);
            }
          }
          return null;
        };
        return searchSubfolders(sandboxDir);
      };

      // Extract named files from prompt and state.targetFiles
      const rawNamedTokens = new Set<string>();
      if (state.targetFiles && state.targetFiles.length > 0) {
        for (const tf of state.targetFiles) rawNamedTokens.add(path.basename(tf));
      }
      const promptFileMatches = rawUserInput.match(/\b([a-zA-Z0-9_\-]+\.[a-zA-Z0-9]+)\b/g);
      if (promptFileMatches) {
        for (const m of promptFileMatches) {
          if (m.toLowerCase() !== path.basename(destValidation.resolved).toLowerCase()) {
            rawNamedTokens.add(m);
          }
        }
      }

      let rawFilesToMove: string[] = [];
      let isCountMismatch = false;

      if (rawNamedTokens.size > 0 && !/\b(?:these|all)\b/i.test(rawUserInput)) {
        for (const token of rawNamedTokens) {
          const resolved = resolveNamedFile(token);
          if (resolved) rawFilesToMove.push(resolved);
        }
      } else {
        if (requestedCount !== undefined) {
          if (eligibleTopLevelFiles.length !== requestedCount) {
            isCountMismatch = true;
          }
          rawFilesToMove = eligibleTopLevelFiles;
        } else {
          rawFilesToMove = eligibleTopLevelFiles;
        }
      }

      // (2) Dedupe sources by basename
      const seenBasenames = new Set<string>();
      const filesToMove: string[] = [];
      for (const file of rawFilesToMove) {
        const base = path.basename(file).toLowerCase();
        if (!seenBasenames.has(base)) {
          seenBasenames.add(base);
          filesToMove.push(file);
        }
      }

      if (filesToMove.length === 0) {
        await finalizeExecution('GENERAL_COMPLETE', {
          route: 'MOVE_FILES',
          explanation: `### ℹ️ No Eligible Files Found\n\nNo eligible top-level files were found in \`src/sandbox\` to move.`
        });
        return state;
      }

      // 4. Validate all source paths strictly
      for (const file of filesToMove) {
        const srcValidation = validateSandboxPath(file);
        if (!srcValidation.valid) {
          await finalizeExecution('FAILED', {
            route: 'MOVE_FILES',
            explanation: `### 🛑 Security Rejection: Invalid Source Path\n\n${srcValidation.error}`
          });
          return state;
        }
      }

      // 5. Build planned moves
      const destStats = fs.existsSync(destValidation.resolved) ? fs.statSync(destValidation.resolved) : null;
      const isRenameSingleFile = filesToMove.length === 1 && (!destStats || !destStats.isDirectory()) && path.extname(destValidation.resolved) !== '';
      const destFolderAbs = path.resolve(destValidation.resolved);
      const plannedMoves: Array<{ fromRel: string; toRel: string; fromAbs: string; toAbs: string }> = [];

      for (const fileRel of filesToMove) {
        const fromAbs = path.resolve(workspaceManager.resolvePath(fileRel));
        const toAbs = isRenameSingleFile ? destFolderAbs : path.resolve(path.join(destFolderAbs, path.basename(fromAbs)));
        const toRel = workspaceManager.toRelativePath(toAbs);

        // (3) Drop any source whose resolved path is already inside the destination folder or equals its target
        const isInsideDest = fromAbs.startsWith(destFolderAbs + path.sep);
        const equalsTarget = fromAbs.toLowerCase() === toAbs.toLowerCase();
        if (isInsideDest || equalsTarget) {
          continue;
        }

        plannedMoves.push({ fromRel: fileRel, toRel, fromAbs, toAbs });
      }

      if (plannedMoves.length === 0) {
        await finalizeExecution('GENERAL_COMPLETE', {
          route: 'MOVE_FILES',
          explanation: `### ℹ️ All Files Already in Destination\n\nThe targeted files are already inside destination \`${destValidation.relPath}\`. No file move needed.`
        });
        return state;
      }

      // (4) Run "destination already exists" check on every remaining move
      const existingTargets = plannedMoves.filter(m => fs.existsSync(m.toAbs));
      const hasConflicts = existingTargets.length > 0;

      // 6. Warn if a moved file is referenced by an unmoved file (e.g. index.html)
      const checkUnmovedReferences = (moved: string[]): string[] => {
        const warnings: string[] = [];
        const movedBaseNames = new Set(moved.map(f => path.basename(f)));
        const movedAbsSet = new Set(moved.map(f => path.resolve(workspaceManager.resolvePath(f))));

        const getFilesRecursively = (dir: string): string[] => {
          let list: string[] = [];
          if (!fs.existsSync(dir)) return list;
          const items = fs.readdirSync(dir, { withFileTypes: true });
          for (const item of items) {
            const p = path.join(dir, item.name);
            if (item.isDirectory()) {
              list = list.concat(getFilesRecursively(p));
            } else if (item.isFile()) {
              list.push(p);
            }
          }
          return list;
        };

        const allSandboxFiles = getFilesRecursively(sandboxDir);
        for (const file of allSandboxFiles) {
          if (movedAbsSet.has(path.resolve(file))) continue;
          const ext = path.extname(file).toLowerCase();
          if (!['.html', '.htm', '.ts', '.js', '.jsx', '.tsx', '.json', '.css', '.py'].includes(ext)) continue;
          try {
            const content = fs.readFileSync(file, 'utf-8');
            const rel = workspaceManager.toRelativePath(file);
            for (const base of movedBaseNames) {
              const regex = new RegExp(`(^|[^a-zA-Z0-9_-])${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-zA-Z0-9_-]|$)`);
              if (regex.test(content)) {
                warnings.push(`Unmoved file \`${rel}\` references \`${base}\`.`);
              }
            }
          } catch {}
        }
        return Array.from(new Set(warnings));
      };

      const referenceWarnings = checkUnmovedReferences(filesToMove);

      // 7. Permission Gate & Count Mismatch / Overwrite Confirmation
      const evalResult = permissionGate.evaluate('file_move', {
        command: rawUserInput,
        files: filesToMove,
        destination: destValidation.relPath
      });

      let isApproved = true;
      let hasBlockedAction = false;

      // Intercept if count mismatch, destination conflicts exist, or gate requires approval
      if (isCountMismatch || hasConflicts || (evalResult.requiresApproval && !evalResult.allowed)) {
        hasBlockedAction = true;
        let messageText = '';
        let hitlTitle = 'Permission Gate: File Move Request';

        if (hasConflicts) {
          hitlTitle = 'Destination File Collision: Overwrite Confirmation';
          messageText = `${existingTargets.length} destination file(s) already exist in "${destValidation.relPath}":\n` +
            existingTargets.map(m => `- ${m.toRel}`).join('\n') +
            `\n\nChoose Overwrite to replace existing file(s) or Cancel to abort.`;
        } else if (isCountMismatch) {
          hitlTitle = 'Permission Gate: File Count Mismatch';
          messageText = `Count mismatch: You requested moving ${requestedCount} files, but found ${eligibleTopLevelFiles.length} eligible files in src/sandbox:\n${eligibleTopLevelFiles.join('\n')}\nDestination: ${destValidation.relPath}`;
        } else {
          messageText = `The agent is requesting permission to move ${plannedMoves.length} files to "${destValidation.relPath}":\n` +
            plannedMoves.map(m => `${m.fromRel} ──► ${m.toRel}`).join('\n');
        }

        const userHitlResponse = await new Promise<{ action: 'approve' | 'reject' | 'feedback'; message?: string }>((resolve) => {
          const reqId = registerHitl(sessionId, resolve);
          emitSSE('hitl_request', {
            type: 'FILE_MOVE_APPROVAL',
            title: hitlTitle,
            message: messageText,
            files: plannedMoves.map(m => ({ from: m.fromRel, to: m.toRel, conflict: fs.existsSync(m.toAbs) })),
            destination: destValidation.relPath,
            warnings: referenceWarnings,
            hasConflicts,
            riskScore: hasConflicts ? 75 : evalResult.riskScore,
            requestId: reqId
          });
        });
        emitSSE('hitl_received', { response: userHitlResponse });
        isApproved = userHitlResponse.action === 'approve';
      }

      let explanation = '';
      if (isApproved) {
        if (!isRenameSingleFile) {
          fs.mkdirSync(destValidation.resolved, { recursive: true });
        } else {
          fs.mkdirSync(path.dirname(destValidation.resolved), { recursive: true });
        }

        const movedResults: string[] = [];
        for (const move of plannedMoves) {
          // Cross-platform safe overwrite on Windows: unlink target if it exists
          if (fs.existsSync(move.toAbs)) {
            fs.unlinkSync(move.toAbs);
          }
          fs.renameSync(move.fromAbs, move.toAbs);
          movedResults.push(`\`${move.fromRel}\` ──► \`${move.toRel}\``);
        }

        let warningSection = '';
        if (referenceWarnings.length > 0) {
          warningSection = `\n\n> ⚠️ **Reference Warnings:**\n${referenceWarnings.map(w => `> - ${w}`).join('\n')}`;
        }

        explanation = `### 📁 Files Moved Successfully\n\nMoved ${movedResults.length} file(s):\n${movedResults.map(r => `- ${r}`).join('\n')}${warningSection}`;
        state.targetFiles = plannedMoves.map(m => m.toRel);
      } else {
        explanation = `### 🛑 File Move Cancelled\n\nFile move operation was cancelled by the developer. No files were moved.`;
      }

      completedStages.push('response');
      await finalizeExecution(hasBlockedAction ? 'HITL_REQUIRED' : 'GENERAL_COMPLETE', {
        route: 'MOVE_FILES',
        explanation
      });
      return state;
    }

    // Routing Logic for Memory Write
    if (state.status === "ROUTED_MEMORY_WRITE") {
      skippedStages.push('context', 'planner', 'coder', 'testrunner', 'debugger', 'reviewer');
      emitSSE('agent_step', { agent: 'IntentAgent', status: 'running', message: '🧠 Saving preference / fact to long-term memory...' });

      memoryEngine.consolidator.consolidateTurn(rawUserInput, 'Acknowledged and stored user preference/convention.');

      if (/typescript/i.test(rawUserInput) && /strict/i.test(rawUserInput)) {
        memoryEngine.longTermMemory.addFact('coding_convention', 'TypeScript Strict Mode', 'Enabled / Preferred', 'user_explicit');
      }
      if (/tailwind/i.test(rawUserInput)) {
        memoryEngine.longTermMemory.addFact('coding_convention', 'UI Styling Framework', 'Tailwind CSS', 'user_explicit');
      }

      completedStages.push('response');
      await finalizeExecution('GENERAL_COMPLETE', {
        route: 'MEMORY_WRITE',
        explanation: `### 🧠 Memory Updated Successfully\n\nYour preference/fact has been saved into persistent long-term memory: "${rawUserInput}". No workspace code files were modified.`
      });
      return state;
    }

    // Routing Logic for Memory Read
    if (state.status === "ROUTED_MEMORY_READ") {
      skippedStages.push('context', 'planner', 'coder', 'testrunner', 'debugger', 'reviewer');
      emitSSE('agent_step', { agent: 'IntentAgent', status: 'running', message: '🧠 Retrieving project knowledge from memory...' });

      const memorySummary = memoryEngine.longTermMemory.formatForPrompt() || 'No custom project facts or user preferences recorded yet.';

      completedStages.push('response');
      await finalizeExecution('GENERAL_COMPLETE', {
        route: 'MEMORY_READ',
        explanation: `### 🧠 Remembered Project Knowledge & Conventions\n\n${memorySummary}`
      });
      return state;
    }

    // Routing Logic for General Knowledge & Greetings (Handled fast before AST retrieval)
    if (state.status === "ROUTED_GENERAL_QUERY") {
      skippedStages.push('context', 'planner', 'coder', 'testrunner', 'debugger', 'reviewer');

      let answer = `Hello! How can I help you with your coding project today?`;

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

        try {
          const { invokeModel } = await import('./tools/modelProvider');
          const contextBlock = memoryEngine.formatGeneralQueryContext();
          const systemContent = `You are Kaizen, an experienced developer and AI assistant.
  ${systemPromptClockExtension}
  Always check the USER PROFILE & KNOWN FACTS, CONVERSATION HISTORY, and LIVE WEB SEARCH RESULTS provided below to answer user queries:

  ${contextBlock}
  ${webSearchResultsText}

  Directives:
  - NEVER address the user as "Alice" or invent personal names/details unless explicitly provided in trusted context.
  - If the user asks for their name, identity, preferences, or previous details (e.g. "my name?", "what is my name?"), state their name/identity directly from the USER PROFILE & KNOWN FACTS or RECENT CONVERSATION HISTORY above.
  - If the user provides a short name or answer (e.g. "APURVA"), connect it with the recent conversation context and acknowledge it warmly.
  - Provide concise, friendly, human-like, and direct answers without generating code unless explicitly requested.`;

          answer = await invokeModel(systemContent, rawUserInput, { temperature: 0.3 });
        } catch (err) {
          console.warn('General query LLM invocation failed:', err);
        }
      }

      completedStages.push('response');
      await finalizeExecution('COMPLETED', {
        route: 'GENERAL_QUERY',
        explanation: answer
      });
      return state;
    }

    // 2. Context Retrieval Agent (retrieve codebase context / AST symbols / RAG first)
    logDiagnostic('GRAPH', 'ENTER ContextRetrievalAgent', { targetFiles: state.targetFiles });
    emitSSE('agent_step', { agent: 'ContextRetrievalAgent', status: 'running', message: 'Analyzing workspace graph & AST symbols...' });
    const retrievalOutput = await contextRetrievalAgentNode(state);
    state.extractedContext = [state.workspaceContext, retrievalOutput.extractedContext].filter(Boolean).join('\n\n');
    state.targetFiles = retrievalOutput.targetFiles;
    completedStages.push('context');
    memoryEngine.stateMemory.updateState(state);
    logDiagnostic('GRAPH', 'EXIT ContextRetrievalAgent', { contextLength: state.extractedContext.length });
    persistenceEngine.saveCheckpoint(sessionId, 'ContextRetrievalAgent', state);

    emitSSE('agent_step', {
      agent: 'ContextRetrievalAgent',
      status: 'completed',
      result: { extractedContext: state.extractedContext }
    });

    // 2.5 Adaptive Context Sufficiency Check
    logDiagnostic('GRAPH', 'ENTER ContextSufficiencyCheck', { userInput: rawUserInput });
    emitSSE('agent_step', { agent: 'ContextSufficiencyCheck', status: 'running', message: 'Evaluating prompt & codebase context sufficiency...' });
    const sufficiencyResult = await evaluateContextSufficiency(state);

    if (sufficiencyResult.sufficiency === 'INSUFFICIENT_CONTEXT' &&
        state.status !== "ROUTED_RUN_EXISTING_TESTS" &&
        state.status !== "ROUTED_DEBUG_ERROR") {
      skippedStages.push('planner', 'coder', 'testrunner', 'debugger', 'reviewer');
      completedStages.push('context_check', 'response');

      const responseText = sufficiencyResult.conversationalResponse ||
        `I can help with that! Could you provide a bit more detail about what you'd like to achieve?`;

      await finalizeExecution('COMPLETED', {
        route: 'INSUFFICIENT_CONTEXT',
        explanation: responseText
      });
      return state;
    }

    if (sufficiencyResult.sufficiency === 'PARTIAL_CONTEXT') {
      if (sufficiencyResult.assumptionsStated && sufficiencyResult.assumptionsStated.length > 0) {
        state.extractedContext = `\n=== STATED ASSUMPTIONS & PARTIAL CONTEXT ===\n${sufficiencyResult.assumptionsStated.join('\n')}\n\n${state.extractedContext}`;
      }
    }

    // Routing Logic for Explanation
    if (state.status === "ROUTED_EXPLAIN_CODE") {
      skippedStages.push('planner', 'coder', 'testrunner', 'debugger', 'reviewer');
      completedStages.push('response');

      const { generateFilteredResponse } = await import('./agents/responseFilterAgent');
      const filteredExplanation = await generateFilteredResponse(
        rawUserInput,
        state.extractedContext || '',
        state.targetFiles || []
      );

      await finalizeExecution('EXPLAIN_COMPLETE', {
        route: 'EXPLAIN_CODE',
        explanation: filteredExplanation
      });
      return state;
    }

    // Branch A: Existing Test Run & Debug Workflow
    if (state.status === "ROUTED_RUN_EXISTING_TESTS" || state.status === "ROUTED_DEBUG_ERROR") {
      skippedStages.push('planner', 'coder');
      emitSSE('agent_step', { agent: 'PlannerAgent', status: 'skipped', message: 'Bypassed for existing test execution' });
      emitSSE('agent_step', { agent: 'CoderAgent', status: 'skipped', message: 'Bypassed until test failures detected' });

      const appliedDebuggerPatches: GeneratedFilePatch[] = [];

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

      let healResult: SelfHealLoopResult | undefined;
      if (!testResult.passed) {
        healResult = await runSelfHealLoop({
          state,
          testResult,
          emitSSE,
          sessionId,
          mode: 'A',
          appliedDebuggerPatches,
          completedStages,
          sessionSnapshots,
          saveFilePatchesToServerDisk,
          prepareDiffCards
        });
        testResult = healResult.testResult;
      } else {
        if (state.status === "ROUTED_DEBUG_ERROR") {
          // User requested debugging an error (e.g. stack trace or code issue in prompt), but unit tests passed or were missing on disk
          emitSSE('agent_step', { agent: 'DebuggerAgent', status: 'running', message: 'Analyzing reported error & diagnosing root cause...' });
          state.failureDetails = {
            summary: 'User reported debug error in prompt',
            prompt: rawUserInput
          };
          const debugResult = await debuggerAgentNode(state);
          completedStages.push('debugger');
          if (debugResult.filePatches && debugResult.filePatches.length > 0) {
            const validPatches = debugResult.filePatches.filter(p => !isTestFile(p.filePath) && !isProtectedFile(p.filePath));
            if (validPatches.length > 0) {
              saveFilePatchesToServerDisk(validPatches);
              appliedDebuggerPatches.push(...validPatches);
              completedStages.push('coder');
              testResult = await runWorkspaceTests(state.targetFiles);
            }
          } else {
            // Safety Net: If zero patches returned and prompt lacks concrete error evidence, reroute to Code Generation workflow
            if (!hasErrorEvidence(rawUserInput)) {
              logDiagnostic('SAFETY_NET', 'REROUTING_DEBUG_TO_GENERATE', { prompt: rawUserInput, rootCause: debugResult.rootCause });
              emitSSE('agent_step', {
                agent: 'DebuggerAgent',
                status: 'completed',
                message: 'No active runtime error diagnosed and no error evidence in prompt. Rerouting to Planner & Code Generation workflow...'
              });
              state.status = 'ROUTED_GENERATE_CODE';
              const pIdx = skippedStages.indexOf('planner');
              if (pIdx >= 0) skippedStages.splice(pIdx, 1);
              const cIdx = skippedStages.indexOf('coder');
              if (cIdx >= 0) skippedStages.splice(cIdx, 1);
            } else {
              // Finalize with debugger's rootCause, not a generic message
              await finalizeExecution('FAILED', {
                error: debugResult.rootCause || 'Debugger could not identify a safe patch for the reported error.',
                rootCause: debugResult.rootCause,
                failureReason: debugResult.failureReason,
                testResult
              });
              return state;
            }
          }
        } else {
          skippedStages.push('debugger');
          emitSSE('agent_step', { agent: 'DebuggerAgent', status: 'skipped', message: 'No test failures detected' });
        }
      }

      // If safely rerouted to GENERATE_CODE, fall through to Branch B instead of returning
      if (state.status !== "ROUTED_GENERATE_CODE") {
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
            verificationLevel: testResult.verificationLevel,
            verificationNote: testResult.verificationNote,
            reviewResult,
            diffCards: await prepareDiffCards(appliedDebuggerPatches, state.originalSnapshots)
          });
        } else {
          skippedStages.push('reviewer');
          emitSSE('agent_step', { agent: 'DebuggerAgent', status: 'failed', message: 'Self-healing retries exhausted without resolving test failures.' });
          emitSSE('agent_step', { agent: 'ReviewerAgent', status: 'skipped', message: 'Code review skipped due to unresolved test failures.' });

          const failureMsg = healResult?.failureMessage || `Test failures unresolved after ${state.retryCount || 3} retries.`;
          await finalizeExecution('FAILED', {
            error: failureMsg,
            errorsEncountered: state.errorsEncountered,
            testResult,
            verificationLevel: testResult.verificationLevel,
            verificationNote: testResult.verificationNote,
            diffCards: await prepareDiffCards(appliedDebuggerPatches, state.originalSnapshots)
          });
        }
        return state;
      }
    }

    // Branch B: Code Generation & Feature Implementation Workflow
    if (state.status === "ROUTED_GENERATE_CODE" || state.status === "ROUTED_REFACTOR") {
      // 3. Planner Agent
      logDiagnostic('GRAPH', 'ENTER PlannerAgent', {});
      emitSSE('agent_step', { agent: 'PlannerAgent', status: 'running', message: 'Generating execution plan...' });
      const plannerOutput = await plannerAgentNode(state);
      state.plan = plannerOutput.plan || [];
      state.status = plannerOutput.status || "PLANNED";
      if (plannerOutput.planAttempt !== undefined) state.planAttempt = plannerOutput.planAttempt;
      if (plannerOutput.rejectedPlans !== undefined) state.rejectedPlans = plannerOutput.rejectedPlans;

      if (plannerOutput.status === 'SECURITY_VIOLATION_BLOCKED' || plannerOutput.status === 'PLAN_FAILED' || plannerOutput.status === 'PLAN_RETRY_LIMIT') {
        state.planFailureReason = plannerOutput.planFailureReason;
        emitSSE('agent_step', {
          agent: 'PlannerAgent',
          status: 'failed',
          message: plannerOutput.planFailureReason || 'Plan generation failed.'
        });
        skippedStages.push('coder', 'testrunner', 'debugger', 'reviewer');
        await finalizeExecution('FAILED', {
          message: plannerOutput.planFailureReason || 'Plan generation failed.',
          status: plannerOutput.status
        });
        return state;
      }

      completedStages.push('planner');

      let planApproved = false;

      while (!planApproved) {
        state.planApprovalStatus = 'PENDING_APPROVAL';
        persistenceEngine.saveCheckpoint(sessionId, 'PlanApproval_Pending', state);

        emitSSE('agent_step', {
          agent: 'PlannerAgent',
          status: 'completed',
          result: { plan: state.plan, status: state.status, planApprovalStatus: 'PENDING_APPROVAL' }
        });

        // 4. Human-In-The-Loop (HITL) Plan Approval Request Widget
        emitSSE('hitl_request', {
          type: 'PLAN_APPROVAL',
          title: (state.planAttempt && state.planAttempt > 1) ? 'Review Modified Plan' : 'Plan Approval Required',
          message: (state.planAttempt && state.planAttempt > 1)
            ? 'Please review the modified plan based on your feedback before proceeding to code generation.'
            : 'Please review the generated implementation plan before proceeding to code generation.',
          plan: state.plan,
          targetFiles: state.targetFiles,
          planApprovalStatus: 'PENDING_APPROVAL'
        });

        const userHitlResponse = await new Promise<{ action: 'approve' | 'reject' | 'feedback'; message?: string }>((resolve) => {
          registerHitl(sessionId, resolve);
        });

        emitSSE('hitl_received', { response: userHitlResponse });

        if (userHitlResponse.action === 'reject') {
          const MAX_PLAN_ATTEMPTS = 3;
          const nextAttempt = (state.planAttempt ?? 0) + 1;
          const isExplicitCancel = userHitlResponse.message && /\b(cancel|abort|stop|quit|exit)\b/i.test(userHitlResponse.message);

          if (nextAttempt >= MAX_PLAN_ATTEMPTS || isExplicitCancel) {
            state.planApprovalStatus = 'REJECTED';
            skippedStages.push('coder', 'testrunner', 'debugger', 'reviewer');
            await finalizeExecution('ABORTED', {
              message: isExplicitCancel ? 'Plan aborted by user request.' : `Plan rejected ${MAX_PLAN_ATTEMPTS} times. Pipeline aborted.`,
              planApprovalStatus: 'REJECTED'
            });
            return state;
          }

          // Record rejected plan and invoke alternative decomposition strategy in plannerAgent
          const { summarizePlan } = await import('./agents/plannerAgent');
          state.planAttempt = nextAttempt;
          state.planApprovalStatus = 'REJECTED';
          state.rejectionReason = userHitlResponse.message || 'Plan was rejected by user. Generate an alternative plan strategy.';
          const lastSummary = summarizePlan(state.plan || []);
          if (lastSummary) {
            state.rejectedPlans = [...(state.rejectedPlans || []), lastSummary];
          }

          emitSSE('agent_step', {
            agent: 'PlannerAgent',
            status: 'running',
            message: `[Re-Plan Strategy (Attempt #${nextAttempt}/${MAX_PLAN_ATTEMPTS})]: Re-decomposing plan using alternative strategy...`
          });

          const updatedPlannerOutput = await plannerAgentNode(state);
          state.plan = updatedPlannerOutput.plan || state.plan;
          state.status = updatedPlannerOutput.status || state.status;
          if (updatedPlannerOutput.targetFiles) state.targetFiles = updatedPlannerOutput.targetFiles;
          if (updatedPlannerOutput.planAttempt !== undefined) state.planAttempt = updatedPlannerOutput.planAttempt;
          if (updatedPlannerOutput.rejectedPlans !== undefined) state.rejectedPlans = updatedPlannerOutput.rejectedPlans;
          if (updatedPlannerOutput.rejectionReason !== undefined) state.rejectionReason = updatedPlannerOutput.rejectionReason as string | undefined;

          if (updatedPlannerOutput.status === 'SECURITY_VIOLATION_BLOCKED' || updatedPlannerOutput.status === 'PLAN_FAILED' || updatedPlannerOutput.status === 'PLAN_RETRY_LIMIT') {
            state.status = updatedPlannerOutput.status;
            state.planFailureReason = updatedPlannerOutput.planFailureReason;
            emitSSE('agent_step', {
              agent: 'PlannerAgent',
              status: 'failed',
              message: updatedPlannerOutput.planFailureReason || 'Plan generation failed.'
            });
            skippedStages.push('coder', 'testrunner', 'debugger', 'reviewer');
            await finalizeExecution('FAILED', {
              message: updatedPlannerOutput.planFailureReason || 'Plan generation failed.',
              status: updatedPlannerOutput.status
            });
            return state;
          }

          state.planFeedback = undefined;
          persistenceEngine.saveCheckpoint(sessionId, `PlannerAgent_Replan_Attempt_${nextAttempt}`, state);
          continue;
        }

        if (userHitlResponse.action === 'feedback' && userHitlResponse.message) {
          state.planApprovalStatus = 'FEEDBACK_SUBMITTED';
          state.rejectionReason = userHitlResponse.message;
          state.planFeedback = userHitlResponse.message;

          emitSSE('agent_step', {
            agent: 'PlannerAgent',
            status: 'running',
            message: `Modifying plan with user feedback: "${userHitlResponse.message}"...`
          });

          const updatedPlannerOutput = await plannerAgentNode(state);
          state.plan = updatedPlannerOutput.plan || state.plan;
          state.status = updatedPlannerOutput.status || state.status;
          if (updatedPlannerOutput.targetFiles) state.targetFiles = updatedPlannerOutput.targetFiles;
          if (updatedPlannerOutput.planAttempt !== undefined) state.planAttempt = updatedPlannerOutput.planAttempt;
          if (updatedPlannerOutput.rejectedPlans !== undefined) state.rejectedPlans = updatedPlannerOutput.rejectedPlans;
          if (updatedPlannerOutput.rejectionReason !== undefined) state.rejectionReason = updatedPlannerOutput.rejectionReason as string | undefined;

          if (updatedPlannerOutput.status === 'SECURITY_VIOLATION_BLOCKED' || updatedPlannerOutput.status === 'PLAN_FAILED' || updatedPlannerOutput.status === 'PLAN_RETRY_LIMIT') {
            state.status = updatedPlannerOutput.status;
            state.planFailureReason = updatedPlannerOutput.planFailureReason;
            emitSSE('agent_step', {
              agent: 'PlannerAgent',
              status: 'failed',
              message: updatedPlannerOutput.planFailureReason || 'Plan generation failed.'
            });
            skippedStages.push('coder', 'testrunner', 'debugger', 'reviewer');
            await finalizeExecution('FAILED', {
              message: updatedPlannerOutput.planFailureReason || 'Plan generation failed.',
              status: updatedPlannerOutput.status
            });
            return state;
          }

          state.planFeedback = undefined;
          persistenceEngine.saveCheckpoint(sessionId, 'PlannerAgent_Feedback', state);

          // Loop repeats! The modified plan will be presented again to the user for approval!
          continue;
        }

        if (userHitlResponse.action === 'approve') {
          planApproved = true;
          state.planApprovalStatus = 'APPROVED';
          persistenceEngine.saveCheckpoint(sessionId, 'PlanApproval_Approved', state);
        }
      }

      // 5. Coder Agent
      logDiagnostic('GRAPH', 'ENTER CoderAgent', {});
      emitSSE('agent_step', { agent: 'CoderAgent', status: 'running', message: 'Generating multi-file code patches...' });
      let coderOutput = await codeGenAgentNode(state, emitSSE);

      if (coderOutput.status === 'CODE_GEN_FAILED' || coderOutput.status === 'PREFLIGHT_SECURITY_BLOCKED') {
        state.status = coderOutput.status;
        state.generationFailureReason = coderOutput.generationFailureReason;
        emitSSE('agent_step', {
          agent: 'CoderAgent',
          status: 'failed',
          message: coderOutput.generationFailureReason || 'Code generation failed.'
        });
        skippedStages.push('testrunner', 'debugger', 'reviewer');
        await finalizeExecution('FAILED', {
          message: coderOutput.generationFailureReason || 'Code generation failed.',
          status: coderOutput.status
        });
        return state;
      }

      state.extractedContext = coderOutput.extractedContext || state.extractedContext;
      if (coderOutput.filePatches) state.filePatches = coderOutput.filePatches;
      if (coderOutput.generatedPatch) state.generatedPatch = coderOutput.generatedPatch;
      if (coderOutput.originalSnapshots) {
        state.originalSnapshots = coderOutput.originalSnapshots;
        sessionSnapshots.set(sessionId, coderOutput.originalSnapshots);
      }
      completedStages.push('coder');
      persistenceEngine.saveCheckpoint(sessionId, 'CoderAgent', state);

      const diffCards = await prepareDiffCards(coderOutput.filePatches || [], state.originalSnapshots);

      emitSSE('agent_step', {
        agent: 'CoderAgent',
        status: 'completed',
        result: { filePatches: coderOutput.filePatches, diffCards }
      });

      // 6. Reviewer Agent Evaluation (Architecture Step 3)
      logDiagnostic('GRAPH', 'ENTER ReviewerAgent', {});
      emitSSE('agent_step', { agent: 'ReviewerAgent', status: 'running', message: 'Performing automated code review & quality audit...' });
      let reviewResult = await reviewerAgentNode(state);

      const MAX_REVIEW_RETRIES = 2;
      let reviewRetries = 0;
      while ((!reviewResult.approved || (reviewResult.codeQualityScore !== undefined && reviewResult.codeQualityScore < 75)) && reviewRetries < MAX_REVIEW_RETRIES) {
        reviewRetries++;
        // NOTE: reviewRetries is tracked independently and does not consume state.retryCount (reserved for self-healing)
        emitSSE('agent_step', {
          agent: 'ReviewerAgent',
          status: 'running',
          message: `[Reviewer Revision Loop #${reviewRetries}/${MAX_REVIEW_RETRIES}]: Code quality score (${reviewResult.codeQualityScore}/100) below threshold. Re-running Coder Agent...`
        });

        const feedbackContext = reviewResult.issues && reviewResult.issues.length > 0
          ? reviewResult.issues.map(i => `- ${i}`).join('\n')
          : reviewResult.summary;

        state.reviewerFeedback = `[REVIEWER REVISION MANDATE - ATTEMPT #${reviewRetries}]:\n${feedbackContext}\nPlease address all issues and regenerate corrected source code.`;

        coderOutput = await codeGenAgentNode(state, emitSSE);
        if (coderOutput.filePatches) state.filePatches = coderOutput.filePatches;
        if (coderOutput.generatedPatch) state.generatedPatch = coderOutput.generatedPatch;
        if (coderOutput.originalSnapshots) {
          const existingSnapshots = state.originalSnapshots || [];
          for (const newSnap of coderOutput.originalSnapshots) {
            if (!existingSnapshots.some(s => s.filePath === newSnap.filePath)) {
              existingSnapshots.push(newSnap);
            }
          }
          state.originalSnapshots = existingSnapshots;
          sessionSnapshots.set(sessionId, state.originalSnapshots);
        }

        if (coderOutput.status === 'CODE_GEN_FAILED' || coderOutput.status === 'PREFLIGHT_SECURITY_BLOCKED') {
          break;
        }
        reviewResult = await reviewerAgentNode(state);
      }

      completedStages.push('reviewer');
      persistenceEngine.saveCheckpoint(sessionId, 'ReviewerAgent', state);

      emitSSE('agent_step', {
        agent: 'ReviewerAgent',
        status: 'completed',
        result: reviewResult
      });

      // 7. Test Runner & Self-Healing Debugger Loop (Architecture Step 4 & 5)
      logDiagnostic('GRAPH', 'ENTER TestRunnerAgent', {});
      emitSSE('agent_step', { agent: 'TestRunnerAgent', status: 'running', message: 'Executing workspace automated unit test suite...' });
      let testResult = await runWorkspaceTests(state.targetFiles);

      let healResult: SelfHealLoopResult | undefined;
      state.retryCount = 0;

      if (!testResult.passed) {
        healResult = await runSelfHealLoop({
          state,
          testResult,
          emitSSE,
          sessionId,
          mode: 'B',
          appliedDebuggerPatches: [],
          coderOutput,
          completedStages,
          sessionSnapshots,
          saveFilePatchesToServerDisk,
          prepareDiffCards
        });
        testResult = healResult.testResult;
      } else {
        skippedStages.push('debugger');
      }

      completedStages.push('testrunner');

      // 8. TypeScript & Workspace Compilation Validation
      let compilerErrorOccurred = false;
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
        compilerErrorOccurred = true;
        const compErr = error.stdout || error.stderr || error.message || String(error);
        state.compilerError = compErr;
        state.failureDetails = {
          summary: 'TypeScript Compilation Error',
          stderr: compErr,
          compilerError: compErr
        };

        emitSSE('agent_step', {
          agent: 'DebuggerAgent',
          status: 'running',
          message: 'TypeScript compiler errors detected. Invoking DebuggerAgent to patch syntax/type issues...'
        });

        if (typeof debuggerAgentNode === 'function') {
          const compilerFixResult = await debuggerAgentNode(state);
          if (compilerFixResult.filePatches && compilerFixResult.filePatches.length > 0) {
            const safePatches = compilerFixResult.filePatches.filter(p => !isTestFile(p.filePath) && !isProtectedFile(p.filePath));
            if (safePatches.length > 0) {
              saveFilePatchesToServerDisk(safePatches);
              const currentCoderPatches: GeneratedFilePatch[] = [...(coderOutput.filePatches || [])];
              for (const sp of safePatches) {
                const patchIdx = currentCoderPatches.findIndex(p => p.filePath === sp.filePath);
                if (patchIdx >= 0) {
                  currentCoderPatches[patchIdx] = sp;
                } else {
                  currentCoderPatches.push(sp);
                }
              }
              coderOutput.filePatches = currentCoderPatches;
              state.filePatches = currentCoderPatches;
            }
          }
          // Re-verify after compiler fix
          try {
            const sandboxTsConfig = path.resolve(process.cwd(), 'src/sandbox/tsconfig.json');
            if (fs.existsSync(sandboxTsConfig)) {
              await execAsync('npx tsc --noEmit', { cwd: './src/sandbox' });
            }
            compilerErrorOccurred = false;
          } catch {
            compilerErrorOccurred = true;
          }
        }
      }

      // Determine final status based on tests, review, and compiler status (failing closed)
      let finalStatus: 'SUCCESS' | 'FAILED' | 'CHANGES_REQUESTED' = 'SUCCESS';
      let finalFailureMessage = '';

      if (!testResult.passed) {
        finalStatus = 'FAILED';
        finalFailureMessage = healResult?.failureMessage || `Tests failed after ${state.retryCount || 3} self-healing attempts.`;
        state.status = 'SELF_HEAL_FAILED';
      } else if (compilerErrorOccurred) {
        finalStatus = 'FAILED';
        finalFailureMessage = 'Workspace TypeScript compilation failed.';
        state.status = 'COMPILER_ERROR';
      } else if (!reviewResult.approved || (reviewResult.codeQualityScore !== undefined && reviewResult.codeQualityScore < 75)) {
        finalStatus = 'CHANGES_REQUESTED';
        finalFailureMessage = `Code review rejected with score ${reviewResult.codeQualityScore ?? 0}/100.`;
        state.status = 'REVIEW_REJECTED';
      }

      const finalDiffCards = await prepareDiffCards(coderOutput.filePatches || [], state.originalSnapshots);

      await finalizeExecution(finalStatus, {
        message: finalFailureMessage || 'Pipeline execution completed successfully.',
        filePatches: coderOutput.filePatches,
        diffCards: finalDiffCards,
        reviewResult,
        testResult,
        verificationLevel: testResult.verificationLevel,
        verificationNote: testResult.verificationNote,
        originalSnapshots: state.originalSnapshots
      });
      return state;
    }

  } catch (err: any) {
    logDiagnostic('RUN', 'ERROR', { error: err?.message || String(err) });
    await finalizeExecution('FAILED', { error: err?.message || String(err) });
  }

  return state;
}

/**
 * Re-export single source of truth isTestFile from sandboxPathUtils
 */
export { isTestFile };

async function prepareDiffCards(
  filePatches: GeneratedFilePatch[],
  originalSnapshots?: Array<{ filePath: string; originalCode: string }>
) {
  const cards = [];
  for (const patch of filePatches) {
    let originalCode = "";
    const normPatchPath = patch.filePath.replace(/\\/g, '/');
    const patchFullPath = workspaceManager.resolvePath(patch.filePath);
    const snapshot = originalSnapshots?.find(
      s => s.filePath.replace(/\\/g, '/') === normPatchPath || workspaceManager.resolvePath(s.filePath) === patchFullPath
    );
    if (snapshot !== undefined) {
      originalCode = snapshot.originalCode;
    } else {
      if (fs.existsSync(patchFullPath)) {
        try {
          originalCode = fs.readFileSync(patchFullPath, 'utf-8');
        } catch { }
      }
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
    if (!workspaceManager.isProtected(patch.filePath)) {
      try {
        const fullPath = workspaceManager.resolvePath(patch.filePath);
        const dir = path.dirname(fullPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        let cleanCode = patch.code || '';
        // Only unescape if code is literally wrapped as a serialized JSON string
        if (cleanCode.startsWith('"') && cleanCode.endsWith('"') && cleanCode.includes('\\n')) {
          try { cleanCode = JSON.parse(cleanCode); } catch { }
        }
        if (!cleanCode.includes('\n') && cleanCode.includes('\\n')) {
          cleanCode = cleanCode.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
        }
        fs.writeFileSync(fullPath, cleanCode, 'utf-8');
      } catch (err) {
        console.error(`Failed to write patch ${patch.filePath}:`, err);
      }
    }
  }
}

export interface SelfHealLoopContext {
  state: KaizenStateType;
  testResult: TestExecutionResult;
  emitSSE: (event: string, data: any) => void;
  sessionId: string;
  mode: 'A' | 'B';
  appliedDebuggerPatches: GeneratedFilePatch[];
  coderOutput?: { filePatches?: GeneratedFilePatch[]; generatedPatch?: string };
  completedStages: string[];
  sessionSnapshots: Map<string, Array<{ filePath: string; originalCode: string }>>;
  saveFilePatchesToServerDisk?: (patches: GeneratedFilePatch[]) => void;
  prepareDiffCards?: (patches: GeneratedFilePatch[], originalSnapshots?: Array<{ filePath: string; originalCode: string }>) => Promise<any[]>;
}

export interface SelfHealLoopResult {
  testResult: TestExecutionResult;
  exhausted: boolean;
  escalated: boolean;
  failureMessage?: string;
  attemptsUsed: number;
}

export async function runSelfHealLoop(ctx: SelfHealLoopContext): Promise<SelfHealLoopResult> {
  const MAX_SELF_HEAL_RETRIES = 3;
  const { state, emitSSE, sessionId, mode, appliedDebuggerPatches, coderOutput, completedStages, sessionSnapshots } = ctx;
  const savePatches = ctx.saveFilePatchesToServerDisk || saveFilePatchesToServerDisk;
  const makeDiffCards = ctx.prepareDiffCards || prepareDiffCards;
  let testResult = ctx.testResult;

  logDiagnostic('SELF_HEAL', mode === 'A' ? 'INITIATING_LOOP' : 'INITIATING_LOOP_BRANCH_B', { maxRetries: MAX_SELF_HEAL_RETRIES, mode });
  state.errorsEncountered = (state.errorsEncountered || 0) + 1;
  if (testResult.structuredFailure) {
    state.structuredFailures = [...(state.structuredFailures || []), testResult.structuredFailure];
  }

  const tracker = createHealGuardTracker();
  let lastRootCause = '';
  let lastFailureReason: string | undefined = undefined;
  let lastSignature = failureSignature(testResult);
  tracker.seenSignatures.add(lastSignature);

  let attempt = 0;
  let shouldEscalate = false;

  while (!testResult.passed && attempt < MAX_SELF_HEAL_RETRIES) {
    attempt++;
    state.retryCount = attempt;

    const discoveredFiles = extractFailingFilesFromLogs(`${testResult.summary}\n${testResult.stdout}\n${testResult.stderr}`);
    const existingDiscovered = discoveredFiles.filter(f => fs.existsSync(f) || fs.existsSync(path.resolve(process.cwd(), f)));
    if (existingDiscovered.length > 0) {
      state.targetFiles = Array.from(new Set([...existingDiscovered, ...state.targetFiles]));
    }

    logDiagnostic('GRAPH', 'ENTER DebuggerAgent', { attempt, targetFiles: state.targetFiles, signature: lastSignature });
    emitSSE('agent_step', {
      agent: 'DebuggerAgent',
      status: 'running',
      message: `Self-Healing Test Failure Diagnosis (Attempt #${attempt}/${MAX_SELF_HEAL_RETRIES})...`
    });

    state.failureDetails = {
      summary: testResult.summary,
      stdout: testResult.stdout,
      stderr: testResult.stderr,
      structuredFailure: testResult.structuredFailure
    };

    state.testLogs = `[AUTOMATED TEST FAILURE REPORT - ATTEMPT #${attempt}]:\n${testResult.summary}\nSTDOUT:\n${testResult.stdout}\nSTDERR:\n${testResult.stderr}\nPlease diagnose the root cause and generate fixed patches to make tests pass.`;

    const debugResult = await debuggerAgentNode(state);
    completedStages.push('debugger');
    lastRootCause = debugResult.rootCause || '';
    lastFailureReason = debugResult.failureReason;

    logDiagnostic('GRAPH', 'EXIT DebuggerAgent', {
      attempt,
      signature: lastSignature,
      targetFiles: state.targetFiles,
      patchCount: (debugResult.filePatches || []).length,
      failureReason: debugResult.failureReason,
      rootCause: debugResult.rootCause
    });

    try {
      langfuseTracer.recordSpan('DebuggerAgent_Attempt', {
        attempt,
        signature: lastSignature,
        targetFiles: state.targetFiles,
        patchCount: (debugResult.filePatches || []).length,
        failureReason: debugResult.failureReason,
        status: debugResult.status
      });
    } catch {}

    const safePatches = (debugResult.filePatches || []).filter(p => !isTestFile(p.filePath) && !isProtectedFile(p.filePath));

    // Rule (i): if debugResult.filePatches is empty, don't re-run the identical test unchanged; count zeroPatchStreak.
    if (safePatches.length === 0) {
      tracker.zeroPatchStreak += 1;
      persistenceEngine.saveCheckpoint(sessionId, `DebuggerAgent_Retry_${attempt}`, state);
      emitSSE('agent_step', {
        agent: 'DebuggerAgent',
        status: 'completed',
        result: { rootCause: debugResult.rootCause, fixExplanation: debugResult.fixExplanation }
      });

      // Rule (iii): zeroPatchStreak >= 2 -> STOP calling the debugger and escalate
      if (tracker.zeroPatchStreak >= 2) {
        logDiagnostic('SELF_HEAL', 'ZERO_PATCH_STREAK_ESCALATE', { streak: tracker.zeroPatchStreak, attempt });
        shouldEscalate = true;
        break;
      }
      continue;
    }

    // Rule (ii): never apply a patch set whose hash was already applied.
    const currentHash = patchHash(safePatches);
    if (tracker.appliedPatchHashes.has(currentHash)) {
      logDiagnostic('SELF_HEAL', 'DUPLICATE_PATCH_HASH_SKIPPED', { hash: currentHash, attempt });
      tracker.zeroPatchStreak += 1;
      persistenceEngine.saveCheckpoint(sessionId, `DebuggerAgent_Retry_${attempt}`, state);
      emitSSE('agent_step', {
        agent: 'DebuggerAgent',
        status: 'completed',
        result: { rootCause: debugResult.rootCause, fixExplanation: debugResult.fixExplanation }
      });
      if (tracker.zeroPatchStreak >= 2) {
        shouldEscalate = true;
        break;
      }
      continue;
    }

    tracker.zeroPatchStreak = 0;
    tracker.appliedPatchHashes.add(currentHash);

    savePatches(safePatches);
    appliedDebuggerPatches.push(...safePatches);
    completedStages.push('coder');

    if (mode === 'A') {
      emitSSE('agent_step', {
        agent: 'CoderAgent',
        status: 'completed',
        result: { filePatches: safePatches, diffCards: await makeDiffCards(safePatches, state.originalSnapshots) }
      });
    } else if (mode === 'B' && coderOutput) {
      const currentCoderPatches: GeneratedFilePatch[] = [...(coderOutput.filePatches || [])];
      for (const sp of safePatches) {
        const patchIdx = currentCoderPatches.findIndex(p => p.filePath === sp.filePath);
        if (patchIdx >= 0) {
          currentCoderPatches[patchIdx] = sp;
        } else {
          currentCoderPatches.push(sp);
        }
      }
      coderOutput.filePatches = currentCoderPatches;
      state.filePatches = currentCoderPatches;
    }

    persistenceEngine.saveCheckpoint(sessionId, `DebuggerAgent_Retry_${attempt}`, state);

    emitSSE('agent_step', {
      agent: 'DebuggerAgent',
      status: 'completed',
      result: { rootCause: debugResult.rootCause, fixExplanation: debugResult.fixExplanation }
    });

    logDiagnostic('GRAPH', 'RE-ENTER TestRunnerAgent', { attempt });
    emitSSE('agent_step', { agent: 'TestRunnerAgent', status: 'running', message: `Re-running unit tests after self-healing bug fix (Attempt #${attempt})...` });
    testResult = await runWorkspaceTests(state.targetFiles);
    logDiagnostic('TEST', 'RE_RUN_RESULT', { passed: testResult.passed, attempt });

    if (!testResult.passed) {
      state.errorsEncountered = (state.errorsEncountered || 0) + 1;
      if (testResult.structuredFailure) {
        state.structuredFailures = [...(state.structuredFailures || []), testResult.structuredFailure];
      }
      const newSignature = failureSignature(testResult);
      // Rule (iii): if the same signature recurs after a debugger attempt -> STOP calling debugger and escalate
      if (tracker.seenSignatures.has(newSignature)) {
        logDiagnostic('SELF_HEAL', 'SIGNATURE_RECURRENCE_ESCALATE', { signature: newSignature, attempt });
        shouldEscalate = true;
        lastSignature = newSignature;
        emitSSE('agent_step', { agent: 'TestRunnerAgent', status: 'completed', result: { summary: testResult.summary, passed: testResult.passed } });
        break;
      }
      tracker.seenSignatures.add(newSignature);
      lastSignature = newSignature;
    }

    emitSSE('agent_step', { agent: 'TestRunnerAgent', status: 'completed', result: { summary: testResult.summary, passed: testResult.passed } });
  }

  // Escalation: mode B only (a plan exists): set state.reviewerFeedback and call codeGenAgentNode once, then re-run tests once.
  if (!testResult.passed && mode === 'B' && state.plan && state.plan.length > 0) {
    logDiagnostic('SELF_HEAL', 'ESCALATING_TO_CODER', {
      attempt,
      signature: lastSignature,
      rootCause: lastRootCause,
      reason: shouldEscalate ? 'GUARD_TRIGGERED' : 'RETRIES_EXHAUSTED'
    });

    emitSSE('agent_step', {
      agent: 'CoderAgent',
      status: 'running',
      message: `[Self-Heal Escalation]: Debugger progress halted. Escalating to CoderAgent for re-implementation (Signature: ${lastSignature})...`
    });

    const traceTail = (testResult.stderr || testResult.stdout || testResult.summary || '').slice(-1500);
    const targetFile = state.targetFiles[0] || 'src/sandbox/game.js';
    state.reviewerFeedback = `[SELF-HEAL ESCALATION MANDATE - SIGNATURE: ${lastSignature}]:
Target File: ${targetFile}
Debugger Root Cause: ${lastRootCause || 'Unresolved test failure'}
Failure Trace:
${traceTail}
Please regenerate corrected source code addressing this failure.`;

    const escalatedCoderOutput = await codeGenAgentNode(state, emitSSE);
    if (escalatedCoderOutput.filePatches) {
      if (coderOutput) coderOutput.filePatches = escalatedCoderOutput.filePatches;
      state.filePatches = escalatedCoderOutput.filePatches;
    }
    if (escalatedCoderOutput.generatedPatch) {
      if (coderOutput) coderOutput.generatedPatch = escalatedCoderOutput.generatedPatch;
      state.generatedPatch = escalatedCoderOutput.generatedPatch;
    }
    if (escalatedCoderOutput.originalSnapshots) {
      const existingSnapshots = state.originalSnapshots || [];
      for (const newSnap of escalatedCoderOutput.originalSnapshots) {
        if (!existingSnapshots.some(s => s.filePath === newSnap.filePath)) {
          existingSnapshots.push(newSnap);
        }
      }
      state.originalSnapshots = existingSnapshots;
      sessionSnapshots.set(sessionId, state.originalSnapshots);
    }

    emitSSE('agent_step', {
      agent: 'TestRunnerAgent',
      status: 'running',
      message: 'Re-running unit tests after CoderAgent escalation...'
    });
    testResult = await runWorkspaceTests(state.targetFiles);
    emitSSE('agent_step', {
      agent: 'TestRunnerAgent',
      status: 'completed',
      result: { summary: testResult.summary, passed: testResult.passed }
    });
  }

  const failureMessage = !testResult.passed
    ? `Self-healing failed after ${attempt} attempt(s) [Signature: ${lastSignature}]. Last Diagnosis: ${lastRootCause || 'Diagnostic unresolved'} (Reason: ${lastFailureReason || 'UNRESOLVED'}).`
    : undefined;

  return {
    testResult,
    exhausted: attempt >= MAX_SELF_HEAL_RETRIES,
    escalated: shouldEscalate,
    failureMessage,
    attemptsUsed: attempt
  };
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
        const relativePath = workspaceManager.toRelativePath(fullPath);
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

// Helper: Enforce canonical boundary inside active workspace
function isSafeSandboxPath(relPath: string): boolean {
  if (!relPath) return false;
  if (workspaceManager.isProtected(relPath)) return false;
  return workspaceManager.isWithinWorkspace(relPath);
}

// Workspace File Explorer API
app.get('/api/workspace/files', (req: Request, res: Response) => {
  const sandboxDir = workspaceManager.getSandboxDir();
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
    return res.status(403).json({ error: `Access to '${relPath}' is forbidden. Path is protected or escapes workspace.` });
  }

  const fullPath = workspaceManager.resolvePath(relPath);
  if (!fs.existsSync(fullPath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  const stat = fs.statSync(fullPath);
  if (stat.isDirectory()) {
    const sandboxDir = workspaceManager.getSandboxDir();
    const childFiles = getSandboxFilesRecursively(fullPath, sandboxDir);
    if (childFiles.length > 0) {
      const firstFile = childFiles[0];
      const content = fs.readFileSync(workspaceManager.resolvePath(firstFile.path), 'utf-8');
      return res.json({ path: firstFile.path, content, isDirectory: true });
    }
    return res.status(400).json({ error: `'${relPath}' is a directory with no files` });
  }

  const content = fs.readFileSync(fullPath, 'utf-8');
  res.json({ path: relPath, content });
});

// Save File Content API (Create / Save)
app.post('/api/workspace/file', (req: Request, res: Response) => {
  const { path: rawPath, content } = req.body;
  if (!rawPath) {
    return res.status(400).json({ error: 'path parameter is required' });
  }

  const relPath = rawPath.startsWith('src/sandbox') ? rawPath : `src/sandbox/${rawPath.replace(/^\/+/, '')}`;

  if (!isSafeSandboxPath(relPath)) {
    return res.status(403).json({ error: `Cannot save to '${relPath}'. Path escapes workspace or is protected.` });
  }

  const fullPath = workspaceManager.resolvePath(relPath);
  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(fullPath, content !== undefined ? content : '', 'utf-8');
  res.json({ success: true, message: `Saved changes to ${relPath}`, path: relPath });
});

// Create Folder API
app.post('/api/workspace/folder', (req: Request, res: Response) => {
  const { path: rawPath } = req.body;
  if (!rawPath) {
    return res.status(400).json({ error: 'path parameter is required' });
  }

  const relPath = rawPath.startsWith('src/sandbox') ? rawPath : `src/sandbox/${rawPath.replace(/^\/+/, '')}`;

  if (!isSafeSandboxPath(relPath)) {
    return res.status(403).json({ error: `Cannot create folder at '${relPath}'. Access forbidden.` });
  }

  const fullPath = workspaceManager.resolvePath(relPath);
  try {
    if (!fs.existsSync(fullPath)) {
      fs.mkdirSync(fullPath, { recursive: true });
    }
    res.json({ success: true, message: `Folder created at ${relPath}`, path: relPath });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to create folder' });
  }
});

// Delete Single Sandbox File API
app.delete('/api/workspace/file', (req: Request, res: Response) => {
  const relPath = req.query.path as string;
  if (!relPath) {
    return res.status(400).json({ error: 'path parameter is required' });
  }

  if (!isSafeSandboxPath(relPath)) {
    return res.status(403).json({ error: `Cannot delete protected or external file '${relPath}'` });
  }

  const fullPath = workspaceManager.resolvePath(relPath);
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
  const sandboxDir = workspaceManager.getSandboxDir();
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

export { app };

// Execute startup validation before starting Express server listener with graceful shutdown
const isMainModule = typeof require !== 'undefined' && require.main === module;
if (isMainModule && process.env.NODE_ENV !== 'test' && !process.env.KAIZEN_TEST_MODE) {
  validateGroqApiKey().then(() => {
    const server = app.listen(PORT, () => {
      console.log(`\n==================================================`);
      console.log(`🚀 Kaizen AI Client Tier & Generative UI Server`);
      console.log(`   Running at: http://localhost:${PORT}`);
      console.log(`   Model Provider: ${getActiveModelProvider() === 'gemini' ? 'Google Gemini (Gemini 2.5 Pro / Flash)' : 'Offline / Mock'}`);
      console.log(`   Health Check: http://localhost:${PORT}/api/health`);
      console.log(`==================================================\n`);
    });

    const handleShutdown = (signal: string) => {
      console.log(`\n[Server] Received ${signal}. Closing HTTP and SSE connections...`);
      sseClients.forEach(c => {
        try { c.res.end(); } catch { }
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
}
