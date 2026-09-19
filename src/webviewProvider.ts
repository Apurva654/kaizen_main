import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { KaizenStateType } from './state';
import { intentAgentNode } from './agents/intentAgent';
import { contextRetrievalAgentNode } from './agents/contextRetrievalAgent';
import { plannerAgentNode } from './agents/plannerAgent';
import { codeGenAgentNode, isProtectedFile, GeneratedFilePatch } from './agents/codeGenAgent';
import { reviewerAgentNode } from './agents/reviewerAgent';
import { debuggerAgentNode } from './agents/debuggerAgent';
import { runWorkspaceTests, extractFailingFilesFromLogs } from './tools/testRunner';

export class KaizenWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'kaizen.sidebarView';
  private _view?: vscode.WebviewView;
  private _pendingHitlResolver: ((value: { action: 'approve' | 'reject' | 'feedback'; message?: string }) => void) | null = null;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
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

    webview.onDidReceiveMessage(async (message: any) => {
      switch (message.type) {
        case 'RUN_PIPELINE': {
          this.runAgentPipeline(message.userInput);
          break;
        }
        case 'HITL_RESPOND': {
          if (this._pendingHitlResolver) {
            this._pendingHitlResolver({ action: message.action, message: message.message });
            this._pendingHitlResolver = null;
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
            const relPath = vscode.workspace.asRelativePath(activeEditor.document.uri);
            this.postMessageToWebview('ACTIVE_FILE_INFO', {
              path: relPath,
              content: activeEditor.document.getText()
            });
          }
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

  public async runAgentPipeline(userInput: string) {
    this.postMessageToWebview('PIPELINE_START', { userInput, timestamp: new Date().toISOString() });

    // Determine target file from active editor if open
    let initialTargets: string[] = [];
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
      const relPath = vscode.workspace.asRelativePath(activeEditor.document.uri).replace(/\\/g, '/');
      if (relPath.startsWith('src/sandbox/')) {
        initialTargets = [relPath];
      }
    }

    const runId = `run_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const createdAt = new Date().toISOString();

    const postWebviewEvent = (type: string, data: any) => {
      this.postMessageToWebview(type, { ...data, runId });
    };

    postWebviewEvent('PIPELINE_START', { userInput, timestamp: createdAt });

    let state: KaizenStateType = {
      sessionId: `sess_${Date.now()}`,
      runId,
      createdAt,
      userInput,
      targetFiles: initialTargets,
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

    const completedStages: string[] = [];
    const skippedStages: string[] = [];

    const finalizeExecution = async (finalStatus: string, extraData: Record<string, any> = {}) => {
      state.lifecycleStatus = finalStatus;
      state.completedStages = Array.from(new Set(completedStages));
      state.skippedStages = Array.from(new Set(skippedStages));

      postWebviewEvent('PIPELINE_COMPLETE', {
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
      postWebviewEvent('AGENT_STEP', { agent: 'IntentAgent', status: 'running', message: 'Classifying intent...' });
      const intentOutput = await intentAgentNode(state);
      state.status = intentOutput.status;
      state.targetFiles = intentOutput.targetFiles;
      completedStages.push('intent');

      postWebviewEvent('AGENT_STEP', { 
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
      postWebviewEvent('AGENT_STEP', { agent: 'ContextRetrievalAgent', status: 'running', message: 'Analyzing workspace AST symbols...' });
      const retrievalOutput = await contextRetrievalAgentNode(state);
      state.extractedContext = retrievalOutput.extractedContext;
      state.targetFiles = retrievalOutput.targetFiles;
      completedStages.push('context');

      postWebviewEvent('AGENT_STEP', { 
        agent: 'ContextRetrievalAgent', 
        status: 'completed', 
        result: { extractedContext: state.extractedContext } 
      });

      if (state.status === "ROUTED_EXPLAIN_CODE") {
        skippedStages.push('planner', 'coder', 'testrunner', 'debugger', 'reviewer');
        await finalizeExecution('EXPLAIN_COMPLETE', {
          route: 'EXPLAIN_CODE',
          explanation: state.extractedContext || "No code context to explain."
        });
        return;
      }

      // Branch A: Existing Test Run & Debug Workflow
      if (state.status === "ROUTED_RUN_EXISTING_TESTS" || state.status === "ROUTED_DEBUG_ERROR") {
        skippedStages.push('planner', 'coder');
        postWebviewEvent('AGENT_STEP', { agent: 'PlannerAgent', status: 'skipped', message: 'Bypassed for existing test execution' });
        postWebviewEvent('AGENT_STEP', { agent: 'CoderAgent', status: 'skipped', message: 'Bypassed until test failures detected' });

        postWebviewEvent('AGENT_STEP', { agent: 'TestRunnerAgent', status: 'running', message: 'Executing workspace automated unit test suite...' });
        let testResult = await runWorkspaceTests(state.targetFiles);
        completedStages.push('testrunner');

        postWebviewEvent('AGENT_STEP', { 
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

            postWebviewEvent('AGENT_STEP', { 
              agent: 'DebuggerAgent', 
              status: 'running', 
              message: `Self-Healing Test Failure Diagnosis (Attempt #${state.retryCount}/${MAX_SELF_HEAL_RETRIES})...` 
            });

            state.extractedContext = `${state.extractedContext}\n\n[AUTOMATED TEST FAILURE REPORT - ATTEMPT #${state.retryCount}]:\n${testResult.summary}\n${testResult.stderr}\nPlease diagnose the root cause and generate fixed patches to make tests pass.`;

            const debugResult = await debuggerAgentNode(state);
            completedStages.push('debugger');

            if (debugResult.filePatches && debugResult.filePatches.length > 0) {
              for (const patch of debugResult.filePatches) {
                await this.applyPatchToVSCodeDocument(patch.filePath, patch.code);
              }
              completedStages.push('coder');
              postWebviewEvent('AGENT_STEP', { 
                agent: 'CoderAgent', 
                status: 'completed', 
                result: { filePatches: debugResult.filePatches, diffCards: await this.prepareDiffCards(debugResult.filePatches) } 
              });
            }

            postWebviewEvent('AGENT_STEP', { 
              agent: 'DebuggerAgent', 
              status: 'completed', 
              result: { rootCause: debugResult.rootCause, fixExplanation: debugResult.fixExplanation } 
            });

            postWebviewEvent('AGENT_STEP', { agent: 'TestRunnerAgent', status: 'running', message: `Re-running unit tests after bug fix (Attempt #${state.retryCount})...` });
            testResult = await runWorkspaceTests(state.targetFiles);
            postWebviewEvent('AGENT_STEP', { agent: 'TestRunnerAgent', status: 'completed', result: { summary: testResult.summary, passed: testResult.passed } });
          }
        } else {
          skippedStages.push('debugger');
          postWebviewEvent('AGENT_STEP', { agent: 'DebuggerAgent', status: 'skipped', message: 'No test failures detected' });
        }

        if (testResult.passed) {
          postWebviewEvent('AGENT_STEP', { agent: 'ReviewerAgent', status: 'running', message: 'Performing automated code review & quality audit...' });
          const reviewResult = await reviewerAgentNode(state);
          completedStages.push('reviewer');

          postWebviewEvent('AGENT_STEP', { 
            agent: 'ReviewerAgent', 
            status: 'completed', 
            result: reviewResult 
          });

          await finalizeExecution('TESTS_PASSED', {
            route: state.status,
            testResult,
            reviewResult,
            diffCards: await this.prepareDiffCards([])
          });
        } else {
          skippedStages.push('reviewer');
          postWebviewEvent('AGENT_STEP', { agent: 'DebuggerAgent', status: 'failed', message: 'Self-healing retries exhausted without resolving test failures.' });
          postWebviewEvent('AGENT_STEP', { agent: 'ReviewerAgent', status: 'skipped', message: 'Code review skipped due to unresolved test failures.' });

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
        postWebviewEvent('AGENT_STEP', { agent: 'PlannerAgent', status: 'running', message: 'Generating execution plan...' });
        const plannerOutput = await plannerAgentNode(state);
        state.plan = plannerOutput.plan || [];
        state.status = plannerOutput.status || "PLANNED";
        completedStages.push('planner');

        postWebviewEvent('AGENT_STEP', { 
          agent: 'PlannerAgent', 
          status: 'completed', 
          result: { plan: state.plan, status: state.status } 
        });

        // 4. HITL Plan Approval Card
        postWebviewEvent('HITL_REQUEST', {
          type: 'PLAN_APPROVAL',
          title: 'Plan Approval Required',
          message: 'Please review the generated plan before proceeding to code generation.',
          plan: state.plan,
          targetFiles: state.targetFiles
        });

        const hitlPromise = new Promise<{ action: 'approve' | 'reject' | 'feedback'; message?: string }>((resolve) => {
          this._pendingHitlResolver = resolve;
        });
        const timeoutPromise = new Promise<{ action: 'approve'; message?: string }>((resolve) => {
          setTimeout(() => {
            if (this._pendingHitlResolver) {
              this._pendingHitlResolver = null;
              resolve({ action: 'approve', message: 'Auto-approved via non-interactive timeout guard.' });
            }
          }, 30000);
        });

        const userHitlResponse = await Promise.race([hitlPromise, timeoutPromise]);

        if (userHitlResponse.action === 'reject') {
          skippedStages.push('coder', 'testrunner', 'debugger', 'reviewer');
          await finalizeExecution('ABORTED', { message: 'Plan rejected by user.' });
          return;
        }

        if (userHitlResponse.action === 'feedback' && userHitlResponse.message) {
          state.userInput = `${state.userInput} (User plan feedback: ${userHitlResponse.message})`;
          const updatedPlannerOutput = await plannerAgentNode(state);
          state.plan = updatedPlannerOutput.plan || state.plan;

          postWebviewEvent('AGENT_STEP', { 
            agent: 'PlannerAgent', 
            status: 'completed', 
            result: { plan: state.plan, status: state.status } 
          });
        }

        // 5. Coder Agent
        postWebviewEvent('AGENT_STEP', { agent: 'CoderAgent', status: 'running', message: 'Generating code patches...' });
        let coderOutput = await codeGenAgentNode(state);
        state.extractedContext = coderOutput.extractedContext || state.extractedContext;
        completedStages.push('coder');

        const diffCards = await this.prepareDiffCards(coderOutput.filePatches || []);
        postWebviewEvent('AGENT_STEP', { 
          agent: 'CoderAgent', 
          status: 'completed', 
          result: { filePatches: coderOutput.filePatches, diffCards } 
        });

        // 6. Test Runner & Self-Healing Debugger Loop
        postWebviewEvent('AGENT_STEP', { agent: 'TestRunnerAgent', status: 'running', message: 'Executing automated unit tests...' });
        let testResult = await runWorkspaceTests(state.targetFiles);
        completedStages.push('testrunner');

        postWebviewEvent('AGENT_STEP', { 
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

            postWebviewEvent('AGENT_STEP', { 
              agent: 'DebuggerAgent', 
              status: 'running', 
              message: `Self-Healing Test Failure Diagnosis (Attempt #${state.retryCount}/${MAX_SELF_HEAL_RETRIES})...` 
            });

            state.extractedContext = `${state.extractedContext}\n\n[AUTOMATED TEST FAILURE REPORT - ATTEMPT #${state.retryCount}]:\n${testResult.summary}\n${testResult.stderr}\nPlease diagnose the root cause and generate fixed patches to make tests pass.`;

            const debugResult = await debuggerAgentNode(state);
            completedStages.push('debugger');
            if (debugResult.filePatches && debugResult.filePatches.length > 0) {
              for (const patch of debugResult.filePatches) {
                await this.applyPatchToVSCodeDocument(patch.filePath, patch.code);
              }
            }

            postWebviewEvent('AGENT_STEP', { 
              agent: 'DebuggerAgent', 
              status: 'completed', 
              result: { rootCause: debugResult.rootCause, fixExplanation: debugResult.fixExplanation } 
            });

            postWebviewEvent('AGENT_STEP', { agent: 'TestRunnerAgent', status: 'running', message: `Re-running unit tests after bug fix (Attempt #${state.retryCount})...` });
            testResult = await runWorkspaceTests(state.targetFiles);
            postWebviewEvent('AGENT_STEP', { agent: 'TestRunnerAgent', status: 'completed', result: { summary: testResult.summary, passed: testResult.passed } });
          }
        } else {
          skippedStages.push('debugger');
        }

        // 7. Reviewer Agent
        postWebviewEvent('AGENT_STEP', { agent: 'ReviewerAgent', status: 'running', message: 'Performing automated code review...' });
        let reviewResult = await reviewerAgentNode(state);
        completedStages.push('reviewer');

        postWebviewEvent('AGENT_STEP', { 
          agent: 'ReviewerAgent', 
          status: 'completed', 
          result: reviewResult 
        });

        // Apply file patches directly to VS Code Workspace
        if (coderOutput.filePatches && coderOutput.filePatches.length > 0) {
          for (const patch of coderOutput.filePatches) {
            await this.applyPatchToVSCodeDocument(patch.filePath, patch.code);
          }
        }

        await finalizeExecution('SUCCESS', {
          filePatches: coderOutput.filePatches,
          diffCards: await this.prepareDiffCards(coderOutput.filePatches || []),
          reviewResult,
          testResult
        });
        return;
      }
    } catch (err: any) {
      await finalizeExecution('FAILED', { error: err?.message || String(err) });
    }
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

  // Apply Patch using VS Code Native WorkspaceEdit API
  private async applyPatchToVSCodeDocument(filePath: string, newCode: string) {
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

    // Write file content directly
    fs.writeFileSync(fullUri.fsPath, newCode, 'utf-8');

    // Open text document in VS Code
    const doc = await vscode.workspace.openTextDocument(fullUri);
    await vscode.window.showTextDocument(doc, { preview: false });

    vscode.window.showInformationMessage(`Kaizen AI applied patch to ${filePath}`);
  }

  // Launch VS Code Native Diff Editor
  private async openVSCodeNativeDiff(filePath: string, generatedCode: string) {
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
