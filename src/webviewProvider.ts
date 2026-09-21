import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { KaizenStateType } from './state';
import { intentAgentNode, extractTerminalCommand, extractGitActions, extractBrowserUrl } from './agents/intentAgent';
import { parseBrowserInspectionResult, formatBrowserInspectionMarkdown, extractRequestedBrowserAction, resolveAccessibilityTarget } from './tools/browserSnapshotParser';
import { contextRetrievalAgentNode } from './agents/contextRetrievalAgent';
import { plannerAgentNode } from './agents/plannerAgent';
import { codeGenAgentNode, isProtectedFile, GeneratedFilePatch } from './agents/codeGenAgent';
import { reviewerAgentNode } from './agents/reviewerAgent';
import { debuggerAgentNode } from './agents/debuggerAgent';
import { runWorkspaceTests, extractFailingFilesFromLogs } from './tools/testRunner';
import { preprocessUserRequest, saveAgentState, loadAgentState, recordConversationTurn } from './tools/context-manager';
import { ocrService } from './tools/ocrService';

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
          this.runAgentPipeline(message.userInput || '', message.imagePayload);
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

  public async runAgentPipeline(rawUserInput: string, imagePayload?: string) {
    this.postMessageToWebview('PIPELINE_START', { userInput: rawUserInput, timestamp: new Date().toISOString() });

    let extractedImageText = '';
    if (imagePayload) {
      this.postMessageToWebview('AGENT_STEP', { agent: 'IntentAgent', status: 'running', message: '🔍 Vision OCR: Extracting text from screenshot...' });
      extractedImageText = await ocrService.extractTextFromImage(imagePayload);
    }

    let userInput = rawUserInput;
    if (extractedImageText) {
      userInput = `[Extracted Text from Screenshot]:\n${extractedImageText}\n\n[User Instructions]:\n${rawUserInput || 'Analyze and process attached screenshot code/instructions.'}`;
    }

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

    const promptToPreprocess = userInput || '';
    const processed = await preprocessUserRequest(promptToPreprocess);
    if (processed.isCommand && processed.commandResult) {
      this.postMessageToWebview('PIPELINE_COMPLETE', {
        status: 'GENERAL_COMPLETE',
        explanation: processed.commandResult
      });
      return;
    }

    const enhancedUserInput = processed.enhancedPrompt || promptToPreprocess;

    let state: KaizenStateType = {
      sessionId: `sess_${Date.now()}`,
      runId,
      createdAt,
      userInput: promptToPreprocess,
      originalUserRequest: promptToPreprocess,
      targetFiles: initialTargets,
      extractedContext: processed.workspaceContext || "",
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
      extractedImageText: extractedImageText || undefined,
      permissionMode: 'deny_first',
      riskScore: 25,
      permissionStatus: 'APPROVED',
      mcpActions: [],
      dockerSandboxActive: false,
      structuredFailures: [],
      errorsEncountered: 0
    };

    const completedStages: string[] = [];
    const skippedStages: string[] = [];

    const finalizeExecution = async (finalStatus: string, extraData: Record<string, any> = {}) => {
      state.lifecycleStatus = finalStatus;
      state.completedStages = Array.from(new Set(completedStages));
      state.skippedStages = Array.from(new Set(skippedStages));

      const isFailure = finalStatus === 'FAILED' || finalStatus === 'ABORTED';
      const normalizedStatus = isFailure ? finalStatus : 'COMPLETED';

      saveAgentState({
        conversationId: state.sessionId || 'sess_default',
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

      // Routing Logic for MCP Git Operations
      if (state.status === "ROUTED_MCP_GIT") {
        skippedStages.push('context', 'planner', 'coder', 'testrunner', 'debugger', 'reviewer');
        postWebviewEvent('AGENT_STEP', { agent: 'IntentAgent', status: 'running', message: '⚡ Executing Git MCP operations...' });

        const { permissionGate } = await import('./tools/permissionGate');
        const { mcpInterface } = await import('./mcp/mcpInterface');

        const requestedActions = extractGitActions(rawUserInput);

        let combinedOutput = '### 🐙 Git MCP Operation Results\n\n';
        let hasBlockedAction = false;

        for (const action of requestedActions) {
          const evalResult = permissionGate.evaluate(`git_${action}`, { command: `git ${action}` });

          let isApproved = true;

          if (evalResult.requiresApproval && !evalResult.allowed) {
            hasBlockedAction = true;
            combinedOutput += `> [!WARNING]\n> **Git ${action.toUpperCase()} Permission Intercepted** (Risk Score: ${evalResult.riskScore}/100)\n> ${evalResult.reason}\n\n`;

            postWebviewEvent('HITL_REQUEST', {
              type: 'GIT_PERMISSION_APPROVAL',
              title: `Permission Gate Intercept: Git ${action.toUpperCase()}`,
              message: evalResult.reason,
              action,
              riskScore: evalResult.riskScore
            });

            const userHitlResponse = await new Promise<{ action: 'approve' | 'reject' | 'feedback'; message?: string }>((resolve) => {
              this._pendingHitlResolver = resolve;
            });
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

        completedStages.push('response');
        await finalizeExecution(hasBlockedAction ? 'HITL_REQUIRED' : 'COMPLETED', {
          route: 'MCP_GIT',
          explanation: combinedOutput.trim()
        });
        return;
      }

      // Routing Logic for MCP Terminal Operations
      if (state.status === "ROUTED_MCP_TERMINAL") {
        skippedStages.push('context', 'planner', 'coder', 'testrunner', 'debugger', 'reviewer');
        postWebviewEvent('AGENT_STEP', { agent: 'IntentAgent', status: 'running', message: '⚡ Executing Terminal MCP operation...' });

        const { permissionGate } = await import('./tools/permissionGate');
        const { mcpInterface } = await import('./mcp/mcpInterface');

        const command = extractTerminalCommand(rawUserInput);
        const evalResult = permissionGate.evaluate('terminal_exec', { command });
        let isApproved = true;
        let hasBlockedAction = false;

        if (evalResult.requiresApproval && !evalResult.allowed) {
          hasBlockedAction = true;

          postWebviewEvent('HITL_REQUEST', {
            type: 'TERMINAL_PERMISSION_APPROVAL',
            title: `Permission Gate Intercept: Terminal Execution`,
            message: evalResult.reason,
            command: command,
            riskScore: evalResult.riskScore
          });

          const userHitlResponse = await new Promise<{ action: 'approve' | 'reject' | 'feedback'; message?: string }>((resolve) => {
            this._pendingHitlResolver = resolve;
          });
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

        completedStages.push('response');
        await finalizeExecution(hasBlockedAction ? 'HITL_REQUIRED' : 'COMPLETED', {
          route: 'MCP_TERMINAL',
          explanation: combinedOutput.trim()
        });
        return;
      }

      // Routing Logic for MCP Browser Operations
      if (state.status === "ROUTED_MCP_BROWSER") {
        skippedStages.push('context', 'planner', 'coder', 'testrunner', 'debugger', 'reviewer');
        state.targetFiles = [];
        postWebviewEvent('AGENT_STEP', { agent: 'IntentAgent', status: 'running', message: '🌐 Connecting to External Playwright MCP Server Process...' });

        const { permissionGate } = await import('./tools/permissionGate');
        const { mcpInterface } = await import('./mcp/mcpInterface');

        const targetUrl = extractBrowserUrl(rawUserInput);

        await mcpInterface.connectServer('playwright-mcp-stdio');

        const evalNav = permissionGate.evaluate('browser_navigate', { url: targetUrl });
        let isApproved = true;
        let hasBlockedAction = false;

        if (evalNav.requiresApproval && !evalNav.allowed) {
          hasBlockedAction = true;
          postWebviewEvent('HITL_REQUEST', {
            type: 'BROWSER_PERMISSION_APPROVAL',
            title: 'Permission Gate Intercept: Browser Navigation',
            message: evalNav.reason,
            url: targetUrl,
            riskScore: evalNav.riskScore
          });

          const userHitlResponse = await new Promise<{ action: 'approve' | 'reject' | 'feedback'; message?: string }>((resolve) => {
            this._pendingHitlResolver = resolve;
          });
          isApproved = userHitlResponse.action === 'approve';
        }

        postWebviewEvent('AGENT_STEP', { agent: 'IntentAgent', status: 'running', message: `🌐 Navigating browser to ${targetUrl}...` });
        const navRes = await mcpInterface.executeBrowserAction('navigate', { url: targetUrl }, { approved: isApproved });

        postWebviewEvent('AGENT_STEP', { agent: 'IntentAgent', status: 'running', message: '🌐 Inspecting page accessibility snapshot...' });
        const snapRes = await mcpInterface.executeBrowserAction('snapshot', {}, { approved: isApproved });

        const combinedBrowserOutput = [navRes.output, snapRes.output, navRes.error, snapRes.error].filter(Boolean).join('\n') || '(No DOM snapshot output returned)';
        const executedToolsList = ['browser_navigate', 'browser_snapshot'];
        let finalInspection = parseBrowserInspectionResult(combinedBrowserOutput, targetUrl, executedToolsList);

        const requestedAction = extractRequestedBrowserAction(rawUserInput);
        if (requestedAction) {
          postWebviewEvent('AGENT_STEP', { agent: 'IntentAgent', status: 'running', message: `🔍 Resolving target "${requestedAction.target}" against accessibility tree...` });
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
              postWebviewEvent('HITL_REQUEST', {
                type: 'BROWSER_PERMISSION_APPROVAL',
                title: `Permission Gate Intercept: Browser ${requestedAction.action.toUpperCase()}`,
                message: evalAction.reason,
                url: targetUrl,
                riskScore: evalAction.riskScore
              });

              const userHitlResponse = await new Promise<{ action: 'approve' | 'reject' | 'feedback'; message?: string }>((resolve) => {
                this._pendingHitlResolver = resolve;
              });
              isActionApproved = userHitlResponse.action === 'approve';
            }

            postWebviewEvent('AGENT_STEP', { agent: 'IntentAgent', status: 'running', message: `⚡ Executing browser_${requestedAction.action} on "${requestedAction.target}" (ref: ${targetRes.elementRef})...` });
            executedToolsList.push(`browser_${requestedAction.action}`);

            const actionRes = await mcpInterface.executeBrowserAction(
              requestedAction.action,
              { element: targetRes.elementRef, ref: targetRes.elementRef, name: targetRes.targetName, text: requestedAction.text },
              { approved: isActionApproved }
            );

            postWebviewEvent('AGENT_STEP', { agent: 'IntentAgent', status: 'running', message: '🌐 Inspecting post-action page snapshot...' });
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

        await mcpInterface.disconnectServer();
        await mcpInterface.connectServer('default-inprocess');

        state.targetFiles = [];

        completedStages.push('response');
        await finalizeExecution(hasBlockedAction ? 'HITL_REQUIRED' : 'COMPLETED', {
          route: 'MCP_BROWSER',
          targetFiles: [],
          filePatches: [],
          explanation: formattedMarkdown
        });
        return;
      }

      // Routing Logic for General Knowledge & Greetings
      if (state.status === "ROUTED_GENERAL_QUERY") {
        skippedStages.push('context', 'planner', 'coder', 'testrunner', 'debugger', 'reviewer');
        
        let answer = `Hello! I am Kaizen, an advanced AI Coding Agent. How can I assist you with your project today?`;
        const apiKey = process.env.GROQ_API_KEY;
        if (apiKey && apiKey !== 'your_groq_api_key_here') {
          try {
            const { ChatGroq } = await import('@langchain/groq');
            const model = new ChatGroq({ apiKey, model: 'groq/compound-mini', temperature: 0.3 });
            const systemContent = `You are Kaizen, an advanced AI Coding Agent.
Always check the USER PROFILE & KNOWN FACTS and RECENT CONVERSATION HISTORY provided below to answer user queries:

${enhancedUserInput}

Directives:
- You are KAIZEN, an advanced AI Coding Agent (never identify as ChatGPT or OpenAI).
- If the user asks for their name, identity, or previous details (e.g. "my name?", "whats my name?", "Jannik"), state their name/identity directly from the KNOWN FACTS and CONVERSATION HISTORY above.
- Provide concise, friendly, and direct answers without generating code unless explicitly requested.`;

            const res: any = await model.invoke([
              { role: 'system', content: systemContent },
              { role: 'user', content: rawUserInput }
            ]);
            answer = typeof res.content === 'string' ? res.content : String(res.content ?? '');
          } catch (err) {
            console.warn('General query LLM invocation failed:', err);
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
        completedStages.push('response');
        await finalizeExecution('COMPLETED', {
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

            postWebviewEvent('AGENT_STEP', { 
              agent: 'DebuggerAgent', 
              status: 'running', 
              message: `Self-Healing Test Failure Diagnosis (Attempt #${state.retryCount}/${MAX_SELF_HEAL_RETRIES})...` 
            });

            state.extractedContext = `${state.extractedContext}\n\n[AUTOMATED TEST FAILURE REPORT - ATTEMPT #${state.retryCount}]:\n${testResult.summary}\n${testResult.stderr}\nPlease diagnose the root cause and generate fixed patches to make tests pass.`;

            const debugResult = await debuggerAgentNode(state);
            completedStages.push('debugger');

            const isTestFile = (filePath: string) => {
              const norm = filePath.replace(/\\/g, '/');
              const baseName = path.basename(norm);
              return norm.includes('/tests/') || baseName.startsWith('test_') || baseName.endsWith('_test.py') || baseName.endsWith('.test.ts');
            };

            const validPatches = (debugResult.filePatches || []).filter(p => !isTestFile(p.filePath));

            if (validPatches.length > 0) {
              for (const patch of validPatches) {
                await this.applyPatchToVSCodeDocument(patch.filePath, patch.code);
              }
              completedStages.push('coder');
              postWebviewEvent('AGENT_STEP', { 
                agent: 'CoderAgent', 
                status: 'completed', 
                result: { filePatches: validPatches, diffCards: await this.prepareDiffCards(validPatches) } 
              });
            }

            postWebviewEvent('AGENT_STEP', { 
              agent: 'DebuggerAgent', 
              status: 'completed', 
              result: { rootCause: debugResult.rootCause, fixExplanation: debugResult.fixExplanation } 
            });

            postWebviewEvent('AGENT_STEP', { agent: 'TestRunnerAgent', status: 'running', message: `Re-running unit tests after bug fix (Attempt #${state.retryCount})...` });
            testResult = await runWorkspaceTests(state.targetFiles);

            if (!testResult.passed) {
              state.errorsEncountered = (state.errorsEncountered || 0) + 1;
              if (testResult.structuredFailure) {
                state.structuredFailures = [...(state.structuredFailures || []), testResult.structuredFailure];
              }
            }

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

        state.planApprovalStatus = 'PENDING_APPROVAL';

        // 4. HITL Plan Approval Card
        postWebviewEvent('HITL_REQUEST', {
          type: 'PLAN_APPROVAL',
          title: 'Plan Approval Required',
          message: 'Please review the generated plan before proceeding to code generation.',
          plan: state.plan,
          targetFiles: state.targetFiles,
          planApprovalStatus: 'PENDING_APPROVAL'
        });

        const userHitlResponse = await new Promise<{ action: 'approve' | 'reject' | 'feedback'; message?: string }>((resolve) => {
          this._pendingHitlResolver = resolve;
        });

        if (userHitlResponse.action === 'reject') {
          state.planApprovalStatus = 'REJECTED';
          skippedStages.push('coder', 'testrunner', 'debugger', 'reviewer');
          await finalizeExecution('ABORTED', { message: 'Plan rejected by user.', planApprovalStatus: 'REJECTED' });
          return;
        }

        if (userHitlResponse.action === 'feedback' && userHitlResponse.message) {
          state.planApprovalStatus = 'FEEDBACK_SUBMITTED';
          state.userInput = `${state.originalUserRequest || state.userInput} (User plan feedback: ${userHitlResponse.message})`;
          const updatedPlannerOutput = await plannerAgentNode(state);
          state.plan = updatedPlannerOutput.plan || state.plan;

          postWebviewEvent('AGENT_STEP', { 
            agent: 'PlannerAgent', 
            status: 'completed', 
            result: { plan: state.plan, status: state.status } 
          });
        }

        state.planApprovalStatus = 'APPROVED';

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
