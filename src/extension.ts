import * as vscode from 'vscode';
import { KaizenWebviewProvider } from './webviewProvider';
import { KaizenBackendClient, ConnectionState, HealthStatus } from './client/backendClient';

let backendClient: KaizenBackendClient | null = null;

export function activate(context: vscode.ExtensionContext) {
  console.log('🚀 Kaizen AI Copilot Extension is activating...');

  // 1. Read configuration
  const config = vscode.workspace.getConfiguration('kaizen');
  const backendUrl = config.get<string>('backendUrl') || 'http://localhost:3000';

  // 2. Instantiate Backend Client
  backendClient = new KaizenBackendClient(backendUrl);

  // 3. Create Status Bar Indicator
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'kaizen.checkBackend';
  statusBar.text = '$(sync~spin) Kaizen: Connecting...';
  statusBar.tooltip = `Kaizen AI Backend: Connecting to ${backendUrl}`;
  statusBar.show();
  context.subscriptions.push(statusBar);

  // Update Status Bar based on client connection state
  backendClient.onConnectionStateChange((state: ConnectionState, health?: HealthStatus | null) => {
    if (state === 'connected') {
      const model = health?.modelProvider === 'gemini' ? 'Gemini 2.5' : 'Local';
      statusBar.text = `$(sparkle) Kaizen: Connected (${model})`;
      statusBar.tooltip = `Kaizen AI Backend connected at ${backendClient?.getBaseUrl()}\nUptime: ${Math.round(health?.uptime || 0)}s\nClick to check status.`;
    } else if (state === 'connecting') {
      statusBar.text = `$(sync~spin) Kaizen: Connecting...`;
      statusBar.tooltip = `Connecting to Kaizen AI Backend at ${backendClient?.getBaseUrl()}`;
    } else {
      statusBar.text = `$(warning) Kaizen: Offline`;
      statusBar.tooltip = `Kaizen AI Backend is offline at ${backendClient?.getBaseUrl()}\nEnsure "npm run server" is running.\nClick to reconnect.`;
    }
  });

  // Watch for configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('kaizen.backendUrl')) {
        const newUrl = vscode.workspace.getConfiguration('kaizen').get<string>('backendUrl') || 'http://localhost:3000';
        backendClient?.setBaseUrl(newUrl);
      }
    })
  );

  // 4. Instantiate Webview Provider
  const provider = new KaizenWebviewProvider(context.extensionUri, backendClient);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      KaizenWebviewProvider.viewType,
      provider,
      {
        webviewOptions: {
          retainContextWhenHidden: true
        }
      }
    )
  );

  // 5. Register Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('kaizen.openSidebar', () => {
      vscode.commands.executeCommand('workbench.view.extension.kaizen-activitybar');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('kaizen.checkBackend', async () => {
      if (!backendClient) return;
      try {
        const health = await backendClient.checkHealth();
        vscode.window.showInformationMessage(
          `Kaizen AI Backend is online at ${backendClient.getBaseUrl()} (v${health.version}, Model: ${health.modelProvider})`
        );
      } catch (err: any) {
        vscode.window.showWarningMessage(
          `Kaizen AI Backend is offline at ${backendClient.getBaseUrl()}.\nStart with: npm run server`
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('kaizen.applyPatch', async () => {
      const activeEditor = vscode.window.activeTextEditor;
      if (!activeEditor) {
        vscode.window.showInformationMessage('No active editor open to apply patch.');
        return;
      }
      vscode.window.showInformationMessage(`Kaizen apply patch command ready for ${activeEditor.document.fileName}`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('kaizen.startBackend', () => {
      const kaizenDir = context.extensionUri.fsPath;
      const terminal = vscode.window.terminals.find(t => t.name === 'Kaizen Backend Server') ||
        vscode.window.createTerminal({
          name: 'Kaizen Backend Server',
          cwd: kaizenDir
        });
      terminal.show();
      const fs = require('fs');
      const path = require('path');
      const hasSrc = fs.existsSync(path.join(kaizenDir, 'src', 'server.ts'));
      const startCmd = hasSrc ? 'npm run server' : 'node dist/server.js';
      terminal.sendText(startCmd);
      vscode.window.showInformationMessage(`Starting Kaizen Backend Server (${startCmd})...`);
    })
  );

  // Initial health check
  backendClient.checkHealth().catch(() => {
    // Offline status is handled by status bar listener
  });

  console.log('🚀 Kaizen AI Copilot Extension activated successfully!');
}

export function deactivate() {
  console.log('Kaizen AI Copilot Extension deactivating.');
  if (backendClient) {
    backendClient.dispose();
    backendClient = null;
  }
}
