import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { isProtectedFile } from './tools/sandboxPathUtils';

export interface GeneratedFilePatch {
  filePath: string;
  code: string;
  imports?: string[];
}
import { KaizenBackendClient, HealthStatus, BackendStreamEvent, ConnectionState } from './client/backendClient';

export class KaizenWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'kaizen.sidebarView';
  private _view?: vscode.WebviewView;
  private _activeSessionId: string | null = null;
  private _streamUnsubscribe: (() => void) | null = null;
  private _stateUnsubscribe: (() => void) | null = null;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _backendClient: KaizenBackendClient
  ) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    this.setupWebview(webviewView.webview);
  }

  public setupWebview(webview: vscode.Webview) {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webview.html = this._getHtmlForWebview(webview);

    // Clean up previous listeners if any
    if (this._streamUnsubscribe) {
      this._streamUnsubscribe();
      this._streamUnsubscribe = null;
    }
    if (this._stateUnsubscribe) {
      this._stateUnsubscribe();
      this._stateUnsubscribe = null;
    }

    // Subscribe to backend connection state updates
    this._stateUnsubscribe = this._backendClient.onConnectionStateChange((state: ConnectionState, health?: HealthStatus | null) => {
      this.postMessageToWebview('BACKEND_STATUS', {
        connected: state === 'connected',
        state,
        url: this._backendClient.getBaseUrl(),
        health
      });
    });

    // Subscribe to backend SSE events and forward to webview
    this._streamUnsubscribe = this._backendClient.onStreamEvent(async (event: BackendStreamEvent) => {
      switch (event.event) {
        case 'pipeline_start':
          this._activeSessionId = event.data?.sessionId || null;
          this.postMessageToWebview('PIPELINE_START', event.data);
          break;

        case 'agent_step':
          this.postMessageToWebview('AGENT_STEP', event.data);
          break;

        case 'hitl_request':
          this.postMessageToWebview('HITL_REQUEST', event.data);
          break;

        case 'pipeline_complete': {
          let diffCards = undefined;
          if (event.data?.filePatches && Array.isArray(event.data.filePatches) && event.data.filePatches.length > 0) {
            diffCards = await this.prepareDiffCards(event.data.filePatches);
          }
          this.postMessageToWebview('PIPELINE_COMPLETE', {
            ...event.data,
            diffCards: diffCards || event.data?.diffCards
          });
          break;
        }

        case 'code_chunk':
          this.postMessageToWebview('CODE_CHUNK', event.data);
          break;

        case 'code_exit':
          this.postMessageToWebview('CODE_EXIT', event.data);
          break;

        default:
          this.postMessageToWebview(event.event.toUpperCase(), event.data);
          break;
      }
    });

    // Start background SSE stream
    this._backendClient.connectStream();

    // Check backend health immediately on open
    this._backendClient.checkHealth().catch(() => {
      // Handled by state listener
    });

    // Handle messages coming from Webview UI
    webview.onDidReceiveMessage(async (message: any) => {
      switch (message.type) {
        case 'RUN_PIPELINE': {
          await this.handleRunPipeline(message.userInput || '', message.imagePayload, message.sessionId);
          break;
        }

        case 'HITL_RESPOND': {
          await this.handleHitlResponse(message.action, message.message, message.sessionId);
          break;
        }

        case 'CHECK_BACKEND': {
          try {
            const health = await this._backendClient.checkHealth();
            vscode.window.showInformationMessage(`Kaizen Backend connected on ${this._backendClient.getBaseUrl()}`);
            this.postMessageToWebview('BACKEND_STATUS', {
              connected: true,
              state: 'connected',
              url: this._backendClient.getBaseUrl(),
              health
            });
          } catch (err: any) {
            vscode.window.showErrorMessage(`Kaizen Backend offline: ${err?.message || err}`);
            this.postMessageToWebview('BACKEND_STATUS', {
              connected: false,
              state: 'disconnected',
              url: this._backendClient.getBaseUrl(),
              error: err?.message || String(err)
            });
          }
          break;
        }

        case 'APPLY_PATCH': {
          await this.applyPatchToVSCodeDocument(message.filePath, message.code);
          break;
        }

        case 'OPEN_NATIVE_DIFF': {
          await this.openVSCodeNativeDiff(message.filePath, message.code);
          break;
        }

        case 'GET_ACTIVE_FILE': {
          const activeEditor = vscode.window.activeTextEditor;
          if (activeEditor) {
            const relPath = vscode.workspace.asRelativePath(activeEditor.document.uri).replace(/\\/g, '/');
            this.postMessageToWebview('ACTIVE_FILE_INFO', {
              path: relPath,
              content: activeEditor.document.getText()
            });
          } else {
            this.postMessageToWebview('ACTIVE_FILE_INFO', { path: null, content: null });
          }
          break;
        }

        case 'RUN_CODE': {
          await this.handleRunCode(message.filePath);
          break;
        }
      }
    });
  }

  private postMessageToWebview(type: string, payload: any) {
    if (this._view) {
      this._view.webview.postMessage({ type, data: payload });
    }
  }

  private async handleRunPipeline(rawUserInput: string, imagePayload?: string, clientSessionId?: string) {
    // 1. Verify backend connectivity first
    try {
      await this._backendClient.checkHealth();
    } catch (err: any) {
      const errorMsg = `Kaizen Backend is unreachable at ${this._backendClient.getBaseUrl()}.\nPlease ensure the backend is running with "npm run server".`;
      vscode.window.showErrorMessage(errorMsg, 'Start Backend Server', 'Retry').then(async (selection) => {
        if (selection === 'Start Backend Server') {
          vscode.commands.executeCommand('kaizen.startBackend');
        } else if (selection === 'Retry') {
          await this.handleRunPipeline(rawUserInput, imagePayload, clientSessionId);
        }
      });
      this.postMessageToWebview('PIPELINE_ERROR', {
        status: 'FAILED',
        error: errorMsg
      });
      return;
    }

    // 2. Read context from active text editor if relevant
    let userInput = rawUserInput;
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && !rawUserInput.includes('[Active File Context]')) {
      const relPath = vscode.workspace.asRelativePath(activeEditor.document.uri).replace(/\\/g, '/');
      const selection = activeEditor.selection;
      const selectedText = activeEditor.document.getText(selection);
      if (selectedText && selectedText.trim().length > 0) {
        userInput = `${rawUserInput}\n\n[Active File Context: ${relPath} (Selected Lines ${selection.start.line + 1}-${selection.end.line + 1})]:\n\`\`\`\n${selectedText}\n\`\`\``;
      }
    }

    try {
      this.postMessageToWebview('PIPELINE_START', {
        userInput: rawUserInput,
        timestamp: new Date().toISOString()
      });

      const res = await this._backendClient.runPipeline({
        userInput,
        imagePayload,
        sessionId: clientSessionId || this._activeSessionId || undefined
      });

      console.log('[Kaizen Extension Host] Pipeline initiated on backend:', res.message);
    } catch (err: any) {
      console.error('[Kaizen Extension Host] Pipeline launch error:', err);
      vscode.window.showErrorMessage(`Failed to launch pipeline on backend: ${err?.message || err}`);
      this.postMessageToWebview('PIPELINE_ERROR', {
        status: 'FAILED',
        error: err?.message || String(err)
      });
    }
  }

  private async handleHitlResponse(action: 'approve' | 'reject' | 'feedback', message?: string, sessionId?: string) {
    const targetSessionId = sessionId || this._activeSessionId;
    if (!targetSessionId) {
      vscode.window.showWarningMessage('No active session ID found for human approval response.');
      return;
    }

    try {
      await this._backendClient.respondHitl(targetSessionId, action, message);
      console.log(`[Kaizen Extension Host] HITL ${action} dispatched for session ${targetSessionId}`);
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to send approval response to backend: ${err?.message || err}`);
    }
  }

  private async handleRunCode(targetFile?: string) {
    const file = targetFile || 'src/sandbox/main.ts';
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const rootPath = workspaceFolders ? workspaceFolders[0].uri.fsPath : process.cwd();
    const fullPath = path.resolve(rootPath, file);
    const startTime = Date.now();

    if (!fs.existsSync(fullPath)) {
      this.postMessageToWebview('CODE_EXECUTION_RESULT', {
        success: false,
        filePath: file,
        output: `File not found: ${file}`,
        executionTimeMs: 0,
        exitCode: 1
      });
      return;
    }

    const ext = path.extname(file).toLowerCase();
    if (ext === '.html') {
      const fileName = path.basename(file);
      const browserUrl = `${this._backendClient.getBaseUrl()}/sandbox/${fileName}`;
      this.postMessageToWebview('CODE_EXECUTION_RESULT', {
        success: true,
        filePath: file,
        language: 'html',
        output: `Webpage hosted statically at ${browserUrl}. Opening live preview...`,
        executionTimeMs: Date.now() - startTime,
        exitCode: 0,
        browserUrl
      });
      return;
    }

    const command = ext === '.py'
      ? `python "${file}"`
      : (ext === '.ts' || ext === '.js' ? `npx ts-node --transpile-only "${file}"` : `node "${file}"`);

    const cp = require('child_process');
    cp.exec(command, { cwd: rootPath }, (err: any, stdout: string, stderr: string) => {
      const durationMs = Date.now() - startTime;
      const outputStr = (stdout + (stderr ? '\n' + stderr : '')).trim() || err?.message || '(Clean execution output)';
      this.postMessageToWebview('CODE_EXECUTION_RESULT', {
        success: !err,
        filePath: file,
        language: ext === '.py' ? 'python' : 'typescript',
        output: outputStr,
        executionTimeMs: durationMs,
        exitCode: err ? (err.code || 1) : 0
      });
    });
  }

  private async prepareDiffCards(filePatches: GeneratedFilePatch[]) {
    const cards = [];
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const rootPath = workspaceFolders ? workspaceFolders[0].uri.fsPath : process.cwd();

    for (const patch of filePatches) {
      let originalCode = "";
      const fullPath = path.resolve(rootPath, patch.filePath);
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

  // Apply Patch using VS Code Native Workspace APIs
  public async applyPatchToVSCodeDocument(filePath: string, newCode: string) {
    if (isProtectedFile(filePath)) {
      vscode.window.showErrorMessage(`Security Policy Violation: '${filePath}' is protected.`);
      return;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    const rootPath = workspaceFolders ? workspaceFolders[0].uri.fsPath : process.cwd();
    const fullUri = vscode.Uri.file(path.resolve(rootPath, filePath));

    // Ensure directory exists
    const dir = path.dirname(fullUri.fsPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Write file content
    fs.writeFileSync(fullUri.fsPath, newCode, 'utf-8');

    // Open text document in VS Code
    const doc = await vscode.workspace.openTextDocument(fullUri);
    await vscode.window.showTextDocument(doc, { preview: false });

    vscode.window.showInformationMessage(`Kaizen AI applied patch to ${filePath}`);
  }

  // Launch VS Code Native Diff Editor
  public async openVSCodeNativeDiff(filePath: string, generatedCode: string) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const rootPath = workspaceFolders ? workspaceFolders[0].uri.fsPath : process.cwd();
    const originalUri = vscode.Uri.file(path.resolve(rootPath, filePath));

    // Create temporary file for generated content diff
    const tempDir = path.resolve(rootPath, 'node_modules/.kaizen_temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    const tempUri = vscode.Uri.file(path.resolve(tempDir, `generated_${path.basename(filePath)}`));
    fs.writeFileSync(tempUri.fsPath, generatedCode, 'utf-8');

    await vscode.commands.executeCommand(
      'vscode.diff',
      originalUri,
      tempUri,
      `Kaizen Diff: ${filePath} ↔ Proposed Code`
    );
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const htmlPath = path.join(this._extensionUri.fsPath, 'public', 'index.html');
    let htmlContent = fs.readFileSync(htmlPath, 'utf-8');

    // Make local assets URI-compatible for VS Code Webview
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'public', 'styles.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'public', 'app.js'));

    htmlContent = htmlContent.replace('href="styles.css"', `href="${styleUri}"`);
    htmlContent = htmlContent.replace('src="app.js"', `src="${scriptUri}"`);

    return htmlContent;
  }
}
