import * as vscode from 'vscode';
import { KaizenWebviewProvider } from './webviewProvider';

export function activate(context: vscode.ExtensionContext) {
  console.log('🚀 Kaizen AI Copilot & Generative UI Extension is now active!');

  const provider = new KaizenWebviewProvider(context.extensionUri);

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

  context.subscriptions.push(
    vscode.commands.registerCommand('kaizen.openSidebar', () => {
      vscode.commands.executeCommand('workbench.view.extension.kaizen-activitybar');
    })
  );



  vscode.window.showInformationMessage('Kaizen AI Copilot Extension activated successfully!');
}

export function deactivate() {
  console.log('Kaizen AI Copilot Extension deactivated.');
}
