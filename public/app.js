// Kaizen AI - Dual-Mode Client Engine (VS Code Extension Webview + Standalone Web App)
document.addEventListener('DOMContentLoaded', () => {
  const fileTree = document.getElementById('file-tree');
  const targetFilesList = document.getElementById('target-files-list');
  const editorTabs = document.getElementById('editor-tabs');
  const editorFilePath = document.getElementById('editor-file-path');
  const codeEditor = document.getElementById('code-editor');
  const lineNumbers = document.getElementById('line-numbers');
  const saveFileBtn = document.getElementById('save-file-btn');
  const refreshFilesBtn = document.getElementById('refresh-files-btn');
  const chatForm = document.getElementById('chat-form');
  const chatInput = document.getElementById('chat-input');
  const widgetsContainer = document.getElementById('widgets-container');
  const toggleTelemetryBtn = document.getElementById('toggle-telemetry-btn');
  const telemetryModal = document.getElementById('telemetry-modal');
  const closeModalBtn = document.getElementById('close-modal-btn');
  const telemetryBody = document.getElementById('telemetry-body');

  let activeFilePath = 'src/sandbox/main.ts';
  let isReadOnlyBrowserSession = false;
  let sseSource = null;
  let pastedImagePayload = null;

  // Detect VS Code Extension Environment
  const vscode = (typeof acquireVsCodeApi === 'function') ? acquireVsCodeApi() : null;
  const isVsCodeEnv = !!vscode;

  if (isVsCodeEnv) {
    document.body.classList.add('vscode-environment');
    console.log('[UI] Running inside Native VS Code Extension Webview');
  }

  // Stepper Header Collapsible Accordion Toggle
  const stepperContainer = document.getElementById('agent-stepper-container');
  const stepperHeaderToggle = document.getElementById('stepper-header-toggle');
  const stepperInlineStatus = document.getElementById('stepper-inline-status');

  if (stepperHeaderToggle && stepperContainer) {
    stepperHeaderToggle.addEventListener('click', () => {
      stepperContainer.classList.toggle('collapsed');
    });
  }

  // Permission Gate Mode Toggle Control
  const permissionModeBtn = document.getElementById('permission-mode-btn');
  const permissionModeText = document.getElementById('permission-mode-text');
  let currentPermissionMode = 'deny_first';

  if (permissionModeBtn && permissionModeText) {
    permissionModeBtn.addEventListener('click', async () => {
      const nextMode = currentPermissionMode === 'deny_first' ? 'auto_mode' : 'deny_first';
      try {
        const res = await fetch('/api/permission/mode', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: nextMode })
        });
        const data = await res.json();
        if (data.success) {
          currentPermissionMode = data.mode;
          updatePermissionGateUI(data.mode);
          showToast(`Permission Gate: Switched to ${data.mode === 'auto_mode' ? 'Auto-Mode Active' : 'Deny-First Mode'}`, 'info');
        }
      } catch (e) {
        showToast('Failed to update Permission Gate mode', 'error');
      }
    });
  }

  function updatePermissionGateUI(mode) {
    if (!permissionModeBtn || !permissionModeText) return;
    if (mode === 'auto_mode') {
      permissionModeBtn.className = 'permission-gate-pill auto-mode';
      permissionModeText.textContent = 'Auto-Mode Active';
    } else {
      permissionModeBtn.className = 'permission-gate-pill deny-first';
      permissionModeText.textContent = 'Deny-First Mode';
    }
  }

  // Toast Notification System
  function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 200);
    }, 3000);
  }

  // Prompt History Manager
  const HISTORY_KEY = 'kaizen_prompt_history_v1';
  let promptHistory = [];
  let historyIndex = -1;
  try {
    promptHistory = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  } catch (e) {
    promptHistory = [];
  }

  function addPromptToHistory(prompt) {
    if (!prompt) return;
    promptHistory = promptHistory.filter(p => p !== prompt);
    promptHistory.unshift(prompt);
    if (promptHistory.length > 50) promptHistory.pop();
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(promptHistory));
    } catch (e) {}
    historyIndex = -1;
  }

  // Keyboard Shortcuts Modal Toggle
  const shortcutsModal = document.getElementById('shortcuts-modal');
  const closeShortcutsBtn = document.getElementById('close-shortcuts-btn');
  const toggleShortcuts = () => shortcutsModal && shortcutsModal.classList.toggle('hidden');

  if (closeShortcutsBtn) closeShortcutsBtn.addEventListener('click', toggleShortcuts);

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === '/') {
      e.preventDefault();
      toggleShortcuts();
    }
    if (e.key === 'Escape') {
      if (shortcutsModal && !shortcutsModal.classList.contains('hidden')) {
        shortcutsModal.classList.add('hidden');
      } else if (stepperContainer && !stepperContainer.classList.contains('collapsed')) {
        stepperContainer.classList.add('collapsed');
      }
    }
  });

  // Clipboard Screenshot Paste & Keyboard Listener
  const imagePreviewContainer = document.getElementById('image-preview-container');
  if (chatInput && imagePreviewContainer) {
    chatInput.addEventListener('paste', (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;

      for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') !== -1) {
          e.preventDefault();
          const file = items[i].getAsFile();
          if (!file) continue;

          // Validate image size < 10MB
          if (file.size > 10 * 1024 * 1024) {
            showToast('Image size exceeds 10MB limit', 'error');
            return;
          }

          const reader = new FileReader();
          reader.onload = (evt) => {
            pastedImagePayload = evt.target.result;
            imagePreviewContainer.innerHTML = `
              <div class="image-thumb-wrapper">
                <img src="${pastedImagePayload}" alt="Pasted Screenshot Preview" />
                <button type="button" class="image-thumb-remove" title="Remove Screenshot">&times;</button>
              </div>
            `;
            imagePreviewContainer.classList.remove('hidden');
            showToast(`✓ Screenshot attached (${(file.size / 1024).toFixed(0)} KB)`, 'success');

            const removeBtn = imagePreviewContainer.querySelector('.image-thumb-remove');
            if (removeBtn) {
              removeBtn.addEventListener('click', () => {
                pastedImagePayload = null;
                imagePreviewContainer.innerHTML = '';
                imagePreviewContainer.classList.add('hidden');
                showToast('Screenshot removed', 'info');
              });
            }
          };
          reader.readAsDataURL(file);
          break;
        }
      }
    });

    // Enter Key Submission & Up/Down Prompt History Navigation
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        chatForm.requestSubmit();
      } else if (e.key === 'ArrowUp') {
        if (chatInput.selectionStart === 0 && promptHistory.length > 0) {
          if (historyIndex < promptHistory.length - 1) {
            historyIndex++;
            chatInput.value = promptHistory[historyIndex];
          }
        }
      } else if (e.key === 'ArrowDown') {
        if (historyIndex > 0) {
          historyIndex--;
          chatInput.value = promptHistory[historyIndex];
        } else if (historyIndex === 0) {
          historyIndex = -1;
          chatInput.value = '';
        }
      }
    });

    // Interactive Prompt Textarea Drag-to-Resize Handler
    const promptResizeBar = document.getElementById('prompt-resize-bar');
    if (promptResizeBar) {
      let isDraggingPrompt = false;
      let startY = 0;
      let startHeight = 0;

      promptResizeBar.addEventListener('mousedown', (e) => {
        isDraggingPrompt = true;
        startY = e.clientY;
        startHeight = chatInput.offsetHeight;
        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'ns-resize';
      });

      document.addEventListener('mousemove', (e) => {
        if (!isDraggingPrompt) return;
        const deltaY = startY - e.clientY; // Dragging UP increases prompt box height
        const newHeight = Math.max(60, Math.min(650, startHeight + deltaY));
        chatInput.style.height = `${newHeight}px`;
      });

      document.addEventListener('mouseup', () => {
        if (isDraggingPrompt) {
          isDraggingPrompt = false;
          document.body.style.userSelect = '';
          document.body.style.cursor = '';
        }
      });
    }

    // Auto-expand textarea as user types multi-line prompts
    chatInput.addEventListener('input', () => {
      chatInput.style.height = 'auto';
      const newHeight = Math.max(60, Math.min(650, chatInput.scrollHeight));
      chatInput.style.height = `${newHeight}px`;
    });
  }

  // Voice Input Speech Recognition Engine (Web Speech API)
  const voiceInputBtn = document.getElementById('voice-input-btn');
  let recognition = null;
  let isRecordingVoice = false;

  if (voiceInputBtn && chatInput) {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      voiceInputBtn.addEventListener('click', () => {
        showToast('Web Speech API is not supported in this browser environment', 'error');
      });
    } else {
      recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.lang = 'en-US';

      recognition.onstart = () => {
        isRecordingVoice = true;
        voiceInputBtn.classList.add('recording');
        voiceInputBtn.title = 'Stop Recording Voice';
        showToast('🎙️ Listening... Speak your prompt clearly', 'info');
      };

      recognition.onresult = (event) => {
        let transcript = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          transcript += event.results[i][0].transcript;
        }

        if (transcript) {
          const currentText = chatInput.value || '';
          // Avoid duplicating interim transcripts
          chatInput.value = transcript;
          chatInput.style.height = 'auto';
          chatInput.style.height = `${Math.max(60, Math.min(650, chatInput.scrollHeight))}px`;
        }
      };

      recognition.onerror = (event) => {
        console.warn('[VoiceInput] Speech recognition error:', event.error);
        isRecordingVoice = false;
        voiceInputBtn.classList.remove('recording');
        voiceInputBtn.title = 'Click to speak (Voice Input)';
        if (event.error !== 'no-speech') {
          showToast(`Voice input notice: ${event.error}`, 'info');
        }
      };

      recognition.onend = () => {
        isRecordingVoice = false;
        voiceInputBtn.classList.remove('recording');
        voiceInputBtn.title = 'Click to speak (Voice Input)';
        if (chatInput.value.trim()) {
          showToast('✓ Voice transcript captured', 'success');
        }
      };

      voiceInputBtn.addEventListener('click', () => {
        if (isRecordingVoice) {
          recognition.stop();
        } else {
          try {
            recognition.start();
          } catch (e) {
            console.warn('[VoiceInput] Failed to start recognition:', e);
          }
        }
      });
    }
  }

  // 1. Initialize File Explorer
  async function loadSandboxFiles() {
    if (isVsCodeEnv) {
      vscode.postMessage({ type: 'GET_ACTIVE_FILE' });
      return;
    }
    try {
      const res = await fetch('/api/workspace/files');
      const data = await res.json();
      fileTree.innerHTML = '';

      if (!data.sandboxFiles || data.sandboxFiles.length === 0) {
        fileTree.innerHTML = `<div class="tree-placeholder">Empty window. Run a prompt to generate code!</div>`;
        return;
      }

      // Strict filter for internal benchmark test suite folders (test1..test5)
      const visibleFiles = data.sandboxFiles.filter(file => {
        const nameLower = file.name.toLowerCase();
        const pathLower = file.path.toLowerCase();
        if (/^test[1-5]$/i.test(file.name)) return false;
        if (pathLower.includes('/test1') || pathLower.includes('/test2') ||
            pathLower.includes('/test3') || pathLower.includes('/test4') ||
            pathLower.includes('/test5') || pathLower.includes('\\test1') ||
            pathLower.includes('\\test2') || pathLower.includes('\\test3') ||
            pathLower.includes('\\test4') || pathLower.includes('\\test5')) {
          return false;
        }
        return true;
      });

      if (visibleFiles.length === 0) {
        fileTree.innerHTML = `<div class="tree-placeholder">Workspace empty. Type a prompt to create project files!</div>`;
        return;
      }

      visibleFiles.forEach(file => {
        const item = document.createElement('div');
        item.className = `tree-item ${file.path === activeFilePath ? 'active' : ''}`;
        item.setAttribute('data-path', file.path);
        
        item.innerHTML = `
          <div class="tree-item-label">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            <span>${file.name}</span>
          </div>
          <button type="button" class="tree-item-delete-btn" title="Delete file '${file.name}'">&times;</button>
        `;

        item.querySelector('.tree-item-label').addEventListener('click', () => openFileInEditor(file.path));

        const delBtn = item.querySelector('.tree-item-delete-btn');
        if (delBtn) {
          delBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (confirm(`Delete '${file.name}' from sandbox?`)) {
              try {
                const deleteRes = await fetch(`/api/workspace/file?path=${encodeURIComponent(file.path)}`, {
                  method: 'DELETE'
                });
                if (deleteRes.ok) {
                  showToast(`Deleted ${file.name}`, 'info');
                  if (activeFilePath === file.path) {
                    activeFilePath = '';
                    if (codeEditor) codeEditor.value = '';
                    if (editorFilePath) editorFilePath.textContent = 'No file open';
                    updateLineNumbers();
                  }
                  loadSandboxFiles();
                } else {
                  showToast('Failed to delete file', 'error');
                }
              } catch (err) {
                showToast('Error deleting file', 'error');
              }
            }
          });
        }

        fileTree.appendChild(item);
      });

      // Auto-open first file if none selected or if active path is invalid
      if (visibleFiles.length > 0 && (!activeFilePath || !visibleFiles.some(f => f.path === activeFilePath))) {
        openFileInEditor(visibleFiles[0].path);
      }
    } catch (err) {
      fileTree.innerHTML = `<div class="tree-placeholder">Workspace files managed via VS Code.</div>`;
    }
  }

  // Clear Sandbox Workspace Listener
  const clearSandboxBtn = document.getElementById('clear-sandbox-btn');
  if (clearSandboxBtn) {
    clearSandboxBtn.addEventListener('click', async () => {
      if (confirm('Are you sure you want to clear all sandbox files and make an empty window?')) {
        try {
          const res = await fetch('/api/workspace/clear-sandbox', { method: 'POST' });
          if (res.ok) {
            showToast('Sandbox playground cleared (Empty Window)', 'success');
            activeFilePath = '';
            if (codeEditor) codeEditor.value = '';
            if (editorFilePath) editorFilePath.textContent = 'No file open';
            updateLineNumbers();
            loadSandboxFiles();
          } else {
            showToast('Failed to clear sandbox', 'error');
          }
        } catch (err) {
          showToast('Error clearing sandbox', 'error');
        }
      }
    });
  }

  function updateLineNumbers() {
    if (!codeEditor || !lineNumbers) return;
    const lines = codeEditor.value.split('\n').length;
    let numbersHtml = '';
    for (let i = 1; i <= lines; i++) {
      numbersHtml += `${i}<br>`;
    }
    lineNumbers.innerHTML = numbersHtml;
  }

  if (codeEditor) codeEditor.addEventListener('input', updateLineNumbers);
  if (saveFileBtn) saveFileBtn.addEventListener('click', saveActiveFile);
  if (refreshFilesBtn) refreshFilesBtn.addEventListener('click', loadSandboxFiles);

  function exitReadOnlyBrowserMode() {
    isReadOnlyBrowserSession = false;
    const browserSessionSec = document.getElementById('browser-session-section');
    if (browserSessionSec) {
      browserSessionSec.classList.add('hidden');
    }
    if (saveFileBtn) {
      saveFileBtn.disabled = false;
      saveFileBtn.classList.remove('disabled-readonly');
      saveFileBtn.title = 'Save File';
      saveFileBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Save File`;
    }
  }

  // 2. Open File in Editor
  async function openFileInEditor(relPath) {
    exitReadOnlyBrowserMode();
    activeFilePath = relPath;
    if (editorFilePath) editorFilePath.textContent = relPath;

    document.querySelectorAll('.tree-item').forEach(el => {
      el.classList.toggle('active', el.getAttribute('data-path') === relPath);
    });

    if (editorTabs) {
      editorTabs.innerHTML = `
        <div class="tab active" data-path="${relPath}">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          <span>${relPath.split('/').pop()}</span>
        </div>
      `;
    }

    if (isVsCodeEnv) return;

    try {
      const res = await fetch(`/api/workspace/file?path=${encodeURIComponent(relPath)}`);
      if (!res.ok) {
        if (codeEditor) codeEditor.value = `// File not found: ${relPath}`;
        updateLineNumbers();
        return;
      }
      const data = await res.json();
      if (data.path && data.path !== relPath) {
        activeFilePath = data.path;
        if (editorFilePath) editorFilePath.textContent = data.path;
        if (editorTabs) {
          editorTabs.innerHTML = `
            <div class="tab active" data-path="${data.path}">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
              <span>${data.path.split('/').pop()}</span>
            </div>
          `;
        }
      }
      if (codeEditor) codeEditor.value = data.content;
      updateLineNumbers();
    } catch (err) {
      if (codeEditor) codeEditor.value = `// Error loading file: ${err}`;
      updateLineNumbers();
    }
  }

  // 3. Save File Content
  async function saveActiveFile() {
    if (isReadOnlyBrowserSession) {
      showToast('Read-Only Browser Inspection — File saving is disabled', 'info');
      return;
    }
    if (!saveFileBtn || !codeEditor || !activeFilePath) return;
    try {
      saveFileBtn.disabled = true;
      saveFileBtn.textContent = 'Saving...';
      const res = await fetch('/api/workspace/file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: activeFilePath, content: codeEditor.value })
      });
      const data = await res.json();
      if (res.ok) {
        saveFileBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Saved!`;
      } else {
        alert(data.error || 'Failed to save file');
        saveFileBtn.innerHTML = 'Save File';
      }
      setTimeout(() => {
        saveFileBtn.disabled = false;
        saveFileBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Save File`;
      }, 1800);
    } catch (err) {
      alert('Error saving file');
      saveFileBtn.disabled = false;
    }
  }

  function updateLineNumbers() {
    if (!codeEditor || !lineNumbers) return;
    const lines = codeEditor.value.split('\n').length;
    let numbersHtml = '';
    for (let i = 1; i <= lines; i++) {
      numbersHtml += `${i}<br>`;
    }
    lineNumbers.innerHTML = numbersHtml;
  }

  if (codeEditor) codeEditor.addEventListener('input', updateLineNumbers);
  if (saveFileBtn) saveFileBtn.addEventListener('click', saveActiveFile);
  if (refreshFilesBtn) refreshFilesBtn.addEventListener('click', loadSandboxFiles);

  let currentRunId = null;
  const ALL_STEPS = ['intent', 'context', 'planner', 'coder', 'testrunner', 'debugger', 'reviewer'];

  // 4. Dual-Mode Messaging & Stream Setup
  function initStreamAndListeners() {
    if (isVsCodeEnv) {
      // Listen for postMessages from VS Code Extension Host (extension.ts)
      window.addEventListener('message', (event) => {
        const message = event.data;
        handleIncomingEvent(message.type, message.data);
      });
    } else {
      // Standalone web app SSE Stream
      if (sseSource) sseSource.close();
      sseSource = new EventSource('/api/stream');

      sseSource.addEventListener('pipeline_start', (e) => handleIncomingEvent('PIPELINE_START', JSON.parse(e.data)));
      sseSource.addEventListener('agent_step', (e) => handleIncomingEvent('AGENT_STEP', JSON.parse(e.data)));
      sseSource.addEventListener('hitl_request', (e) => handleIncomingEvent('HITL_REQUEST', JSON.parse(e.data)));
      sseSource.addEventListener('pipeline_complete', (e) => handleIncomingEvent('PIPELINE_COMPLETE', JSON.parse(e.data)));
      sseSource.addEventListener('pipeline_error', (e) => handleIncomingEvent('PIPELINE_ERROR', JSON.parse(e.data)));
    }
  }

  function updateRiskScoreBadge(score) {
    const riskBadge = document.getElementById('risk-score-badge');
    const riskVal = document.getElementById('risk-score-val');
    if (!riskVal || score === undefined || score === null) return;

    const numScore = Number(score);
    riskVal.textContent = numScore;

    if (riskBadge) {
      riskBadge.classList.remove('low-risk', 'med-risk', 'medium-risk', 'high-risk');
      if (numScore >= 70) {
        riskBadge.classList.add('high-risk');
        riskBadge.title = `Current Task Risk Score: ${numScore}/100 (HIGH RISK — Intercept Active)`;
      } else if (numScore >= 30) {
        riskBadge.classList.add('med-risk');
        riskBadge.title = `Current Task Risk Score: ${numScore}/100 (MEDIUM RISK)`;
      } else {
        riskBadge.classList.add('low-risk');
        riskBadge.title = `Current Task Risk Score: ${numScore}/100 (LOW RISK — Safe Execution)`;
      }
    }
  }

  function calculatePromptRisk(prompt) {
    const p = (prompt || '').toLowerCase();
    if (/\b(delete|remove|rm\s|rm -rf|del\s|git push|sudo|chmod|npm publish)\b/i.test(p)) {
      return 90;
    }
    if (/\b(terminal|command|exec|shell)\b/i.test(p)) {
      return 75;
    }
    if (/\b(commit|git commit)\b/i.test(p)) {
      return 50;
    }
    if (/\b(write|create|make|add|modify|update)\b/i.test(p)) {
      return 45;
    }
    if (/\b(test|run test|unittest)\b/i.test(p)) {
      return 35;
    }
    return 10;
  }

  function handleIncomingEvent(type, data) {
    if (!data) return;

    if (data.riskScore !== undefined && data.riskScore !== null) {
      updateRiskScoreBadge(data.riskScore);
    } else if (data.result && data.result.riskScore !== undefined) {
      updateRiskScoreBadge(data.result.riskScore);
    }

    // Run ID guard to ignore stale events from old runs
    if (type === 'PIPELINE_START') {
      currentRunId = data.runId || `run_${Date.now()}`;
      if (data.route !== 'MCP_BROWSER' && data.route !== 'ROUTED_MCP_BROWSER') {
        exitReadOnlyBrowserMode();
      }
      resetStepper();
    } else if (data.runId && currentRunId && data.runId !== currentRunId) {
      console.log(`[KAIZEN][UI] Stale event ignored for runId: ${data.runId} (active: ${currentRunId})`);
      return;
    }

    switch (type) {
      case 'AGENT_STEP':
        updateStepper(data.agent, data.status, data.message, data.runId);
        if (data.result && data.result.targetFiles) {
          renderTargetBadges(data.result.targetFiles);
        }
        if (data.result && data.result.diffCards) {
          renderDiffCards(data.result.diffCards);
        }
        break;

      case 'HITL_REQUEST':
        renderHitlChoiceCard(data);
        break;

      case 'PIPELINE_COMPLETE':
        if (data.route === 'MCP_BROWSER' || data.route === 'ROUTED_MCP_BROWSER') {
          renderBrowserInspectionUI(data);
        } else {
          finalizeStepper(data);
          if (data.status === 'SUCCESS' || data.status === 'DEBUG_COMPLETE' || data.status === 'TESTS_PASSED') {
            loadSandboxFiles();
            if (data.targetFiles && data.targetFiles[0]) {
              openFileInEditor(data.targetFiles[0]);
            }
          } else if (data.route === 'EXPLAIN_CODE' || data.status === 'EXPLAIN_COMPLETE' || data.explanation) {
            renderExplanationCard(data);
          } else if (data.status === 'FAILED' || data.status === 'ABORTED') {
            renderErrorCard(data.message || data.error || 'Pipeline execution ended with failures.');
          }
        }
        break;

      case 'PIPELINE_ERROR':
        finalizeStepper({ status: 'FAILED', error: data.error });
        renderErrorCard(data.error || 'Pipeline execution error.');
        break;

      case 'ACTIVE_FILE_INFO':
        if (data.path) {
          openFileInEditor(data.path);
          if (codeEditor) codeEditor.value = data.content;
          updateLineNumbers();
        }
        break;
    }
  }

  // Render dedicated Browser Inspection Result Mode
  function renderBrowserInspectionUI(data) {
    isReadOnlyBrowserSession = true;
    activeFilePath = '';

    if (saveFileBtn) {
      saveFileBtn.disabled = true;
      saveFileBtn.classList.add('disabled-readonly');
      saveFileBtn.title = 'Read-Only Browser Inspection — File saving disabled';
      saveFileBtn.innerHTML = `🌐 Read-Only Browser Inspection`;
    }

    if (editorFilePath) editorFilePath.textContent = '🌐 Read-Only Browser Inspection';
    if (editorTabs) {
      editorTabs.innerHTML = `
        <div class="tab active" data-path="browser-inspection">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10z"/></svg>
          <span>Browser Inspection (Read-Only)</span>
        </div>
      `;
    }
    if (codeEditor) {
      codeEditor.value = `// 🌐 Browser Inspection Active (Read-Only Mode)\n// No workspace files created or modified.\n// Inspect structured Playwright browser output in the panel.`;
      updateLineNumbers();
    }

    // Display Browser Session section separately from workspace target files
    const browserSessionSec = document.getElementById('browser-session-section');
    const browserSessionUrl = document.getElementById('browser-session-url');
    if (browserSessionSec) {
      browserSessionSec.classList.remove('hidden');
      if (browserSessionUrl) {
        const urlMatch = data.explanation && data.explanation.match(/\*\*URL\*\*: `(.*?)`/);
        browserSessionUrl.textContent = urlMatch ? urlMatch[1] : 'http://localhost:3000/';
      }
    }

    // ACTIVE TARGET FILES must show "None — browser inspection has no workspace targets."
    if (targetFilesList) {
      targetFilesList.innerHTML = `<span class="target-badge empty">None — browser inspection has no workspace targets.</span>`;
    }

    const hasAction = Boolean(data.explanation && data.explanation.includes('Browser Action Executed'));
    renderBrowserStepperTimeline(hasAction);

    if (data.explanation) {
      renderExplanationCard(data);
    }
  }

  function renderBrowserStepperTimeline(hasAction = false) {
    const timelineBody = document.getElementById('stepper-timeline-body');
    if (!timelineBody) return;

    if (hasAction) {
      timelineBody.innerHTML = `
        <div class="step-item completed" title="1. Browser Request: User query received">
          <div class="step-icon">✓</div>
          <div class="step-content"><div class="step-name">Browser Request</div><div class="step-detail">Query received</div></div>
        </div>
        <div class="step-arrow">›</div>
        <div class="step-item completed" title="2. Intent Classification: ROUTED_MCP_BROWSER">
          <div class="step-icon">✓</div>
          <div class="step-content"><div class="step-name">Intent</div><div class="step-detail">MCP Browser</div></div>
        </div>
        <div class="step-arrow">›</div>
        <div class="step-item completed" title="3. Permission Gate: Navigation risk evaluated">
          <div class="step-icon">✓</div>
          <div class="step-content"><div class="step-name">Permission Gate</div><div class="step-detail">Nav Gate</div></div>
        </div>
        <div class="step-arrow">›</div>
        <div class="step-item completed" title="4. Playwright MCP: Connected over stdio transport">
          <div class="step-icon">✓</div>
          <div class="step-content"><div class="step-name">Playwright MCP</div><div class="step-detail">Stdio transport</div></div>
        </div>
        <div class="step-arrow">›</div>
        <div class="step-item completed" title="5. Navigate: browser_navigate executed">
          <div class="step-icon">✓</div>
          <div class="step-content"><div class="step-name">Navigate</div><div class="step-detail">Target URL</div></div>
        </div>
        <div class="step-arrow">›</div>
        <div class="step-item completed" title="6. Initial Snapshot: Accessibility tree parsed">
          <div class="step-icon">✓</div>
          <div class="step-content"><div class="step-name">Initial Snapshot</div><div class="step-detail">Initial DOM</div></div>
        </div>
        <div class="step-arrow">›</div>
        <div class="step-item completed" title="7. Target Resolution: Resolved target in snapshot">
          <div class="step-icon">✓</div>
          <div class="step-content"><div class="step-name">Target Resolution</div><div class="step-detail">Ref resolved</div></div>
        </div>
        <div class="step-arrow">›</div>
        <div class="step-item completed" title="8. Permission Gate: Action risk evaluated">
          <div class="step-icon">✓</div>
          <div class="step-content"><div class="step-name">Permission Gate</div><div class="step-detail">Action Gate</div></div>
        </div>
        <div class="step-arrow">›</div>
        <div class="step-item completed" title="9. Browser Action: MCP tool executed">
          <div class="step-icon">✓</div>
          <div class="step-content"><div class="step-name">Browser Action</div><div class="step-detail">Action executed</div></div>
        </div>
        <div class="step-arrow">›</div>
        <div class="step-item completed" title="10. Post-Action Snapshot: DOM snapshot after action">
          <div class="step-icon">✓</div>
          <div class="step-content"><div class="step-name">Post Snapshot</div><div class="step-detail">Post-click DOM</div></div>
        </div>
        <div class="step-arrow">›</div>
        <div class="step-item completed" title="11. Browser Result: Final Generative UI rendered">
          <div class="step-icon">✓</div>
          <div class="step-content"><div class="step-name">Browser Result</div><div class="step-detail">Structured UI</div></div>
        </div>
      `;
    } else {
      timelineBody.innerHTML = `
        <div class="step-item completed" title="1. Browser Request: User query received">
          <div class="step-icon">✓</div>
          <div class="step-content"><div class="step-name">Browser Request</div><div class="step-detail">Query received</div></div>
        </div>
        <div class="step-arrow">›</div>
        <div class="step-item completed" title="2. Intent Classification: ROUTED_MCP_BROWSER">
          <div class="step-icon">✓</div>
          <div class="step-content"><div class="step-name">Intent</div><div class="step-detail">MCP Browser</div></div>
        </div>
        <div class="step-arrow">›</div>
        <div class="step-item completed" title="3. Permission Gate: Evaluated risk score">
          <div class="step-icon">✓</div>
          <div class="step-content"><div class="step-name">Permission Gate</div><div class="step-detail">Risk evaluated</div></div>
        </div>
        <div class="step-arrow">›</div>
        <div class="step-item completed" title="4. Playwright MCP: Connected over stdio transport">
          <div class="step-icon">✓</div>
          <div class="step-content"><div class="step-name">Playwright MCP</div><div class="step-detail">Stdio transport</div></div>
        </div>
        <div class="step-arrow">›</div>
        <div class="step-item completed" title="5. Navigate: browser_navigate executed">
          <div class="step-icon">✓</div>
          <div class="step-content"><div class="step-name">Navigate</div><div class="step-detail">Target URL</div></div>
        </div>
        <div class="step-arrow">›</div>
        <div class="step-item completed" title="6. Snapshot: browser_snapshot extracted DOM">
          <div class="step-icon">✓</div>
          <div class="step-content"><div class="step-name">Snapshot</div><div class="step-detail">DOM snapshot</div></div>
        </div>
        <div class="step-arrow">›</div>
        <div class="step-item completed" title="7. Browser Result: Structured Generative UI rendered">
          <div class="step-icon">✓</div>
          <div class="step-content"><div class="step-name">Browser Result</div><div class="step-detail">Structured UI</div></div>
        </div>
      `;
    }

    if (stepperInlineStatus) {
      stepperInlineStatus.textContent = '✔ Browser Inspection Completed';
    }
  }

  function restoreDefaultCodingStepperTimeline() {
    const timelineBody = document.getElementById('stepper-timeline-body');
    if (!timelineBody) return;

    if (!document.getElementById('step-intent')) {
      timelineBody.innerHTML = `
        <div class="step-item" id="step-intent" title="1. Intent Classification: Routing query to agent nodes">
          <div class="step-icon">1</div>
          <div class="step-content">
            <div class="step-name">Intent</div>
            <div class="step-detail">Routing query</div>
          </div>
        </div>
        <div class="step-arrow">›</div>
        <div class="step-item" id="step-context" title="2. Context Retrieval: Graphify AST & symbol extraction">
          <div class="step-icon">2</div>
          <div class="step-content">
            <div class="step-name">Context</div>
            <div class="step-detail">Symbol extraction</div>
          </div>
        </div>
        <div class="step-arrow">›</div>
        <div class="step-item" id="step-planner" title="3. Planner Agent: Grounded task step generation">
          <div class="step-icon">3</div>
          <div class="step-content">
            <div class="step-name">Planner</div>
            <div class="step-detail">Task generation</div>
          </div>
        </div>
        <div class="step-arrow">›</div>
        <div class="step-item" id="step-coder" title="4. Coder Agent: Multi-file patch generation">
          <div class="step-icon">4</div>
          <div class="step-content">
            <div class="step-name">Coder</div>
            <div class="step-detail">Patch generation</div>
          </div>
        </div>
        <div class="step-arrow">›</div>
        <div class="step-item" id="step-testrunner" title="5. Test Suite Execution: Workspace unit test verification">
          <div class="step-icon">5</div>
          <div class="step-content">
            <div class="step-name">Test Suite</div>
            <div class="step-detail">Workspace tests</div>
          </div>
        </div>
        <div class="step-arrow">›</div>
        <div class="step-item" id="step-debugger" title="6. Debugger Agent: Diagnosing failure & applying fix">
          <div class="step-icon">6</div>
          <div class="step-content">
            <div class="step-name">Debugger</div>
            <div class="step-detail">Self-healing fix</div>
          </div>
        </div>
        <div class="step-arrow">›</div>
        <div class="step-item" id="step-reviewer" title="7. Reviewer Agent: Quality audit & approval">
          <div class="step-icon">7</div>
          <div class="step-content">
            <div class="step-name">Reviewer</div>
            <div class="step-detail">Quality audit</div>
          </div>
        </div>
      `;
    }
  }

  // 5. Update Agent Stepper Visuals
  function resetStepper() {
    restoreDefaultCodingStepperTimeline();
    const defaults = {
      'intent': 'Routing query to agent nodes',
      'context': 'Graphify AST & symbol extraction',
      'planner': 'Grounded task step generation',
      'coder': 'Multi-file patch generation',
      'testrunner': 'Workspace unit test verification',
      'debugger': 'Diagnosing failure & applying fix',
      'reviewer': 'Quality audit & approval'
    };

    ALL_STEPS.forEach(step => {
      const el = document.getElementById(`step-${step}`);
      if (el) {
        el.className = 'step-item';
        const detailEl = el.querySelector('.step-detail');
        if (detailEl) detailEl.textContent = defaults[step] || 'Pending';
      }
    });
  }

  function updateStepper(agentName, status, msg, runId) {
    const map = {
      'IntentAgent': 'intent',
      'ContextRetrievalAgent': 'context',
      'PlannerAgent': 'planner',
      'CoderAgent': 'coder',
      'TestRunnerAgent': 'testrunner',
      'DebuggerAgent': 'debugger',
      'ReviewerAgent': 'reviewer'
    };
    const key = map[agentName];
    if (!key) return;

    if (stepperInlineStatus) {
      if (status === 'running') {
        const readableNames = {
          'IntentAgent': 'Routing intent...',
          'ContextRetrievalAgent': 'Analyzing context...',
          'PlannerAgent': 'Generating plan...',
          'CoderAgent': 'Generating code...',
          'TestRunnerAgent': 'Running tests...',
          'DebuggerAgent': 'Debugging code...',
          'ReviewerAgent': 'Reviewing files...'
        };
        stepperInlineStatus.textContent = `⚡ ${readableNames[agentName] || agentName}`;
      } else if (status === 'completed') {
        stepperInlineStatus.textContent = `✔ Step completed`;
      }
    }

    const stepEl = document.getElementById(`step-${key}`);
    if (!stepEl) return;

    stepEl.className = `step-item ${status}`;
    const detailEl = stepEl.querySelector('.step-detail');
    if (detailEl) {
      if (msg) {
        detailEl.textContent = msg;
      } else if (status === 'completed') {
        detailEl.textContent = 'Completed';
      } else if (status === 'skipped') {
        detailEl.textContent = 'Skipped';
      } else if (status === 'failed') {
        detailEl.textContent = 'Failed';
      }
    }
  }

  function finalizeStepper(data) {
    const completed = data.completedStages || [];
    const skipped = data.skippedStages || [];

    ALL_STEPS.forEach(step => {
      const stepEl = document.getElementById(`step-${step}`);
      if (!stepEl) return;
      const detailEl = stepEl.querySelector('.step-detail');

      if (skipped.includes(step)) {
        stepEl.className = 'step-item skipped';
        if (detailEl) detailEl.textContent = 'Skipped';
      } else if (completed.includes(step)) {
        stepEl.className = 'step-item completed';
        if (detailEl && detailEl.textContent.startsWith('Analyzing')) {
          detailEl.textContent = 'Completed';
        }
      } else {
        // Clear any running / pending items
        if (stepEl.classList.contains('running')) {
          stepEl.className = 'step-item completed';
          if (detailEl) detailEl.textContent = 'Completed';
        } else if (stepEl.className === 'step-item') {
          stepEl.className = 'step-item skipped';
          if (detailEl) detailEl.textContent = 'Skipped';
        }
      }
    });
  }

  function renderTargetBadges(targetFiles) {
    if (isReadOnlyBrowserSession) return;
    if (!targetFilesList) return;
    targetFilesList.innerHTML = '';
    if (!targetFiles || targetFiles.length === 0) {
      targetFilesList.innerHTML = `<span class="target-badge empty">None selected</span>`;
      return;
    }
    targetFiles.forEach(tf => {
      const span = document.createElement('span');
      span.className = 'target-badge';
      span.textContent = tf;
      targetFilesList.appendChild(span);
    });
  }

  // 6. Generative UI Widget: Ambiguity & Choice Cards (HITL)
  function renderHitlChoiceCard(data) {
    const card = document.createElement('div');
    card.className = 'gen-card choice-card';

    if (data.type === 'GIT_PERMISSION_APPROVAL') {
      const riskBadge = `<span style="background: rgba(255,165,0,0.2); color: #ffa500; padding: 2px 6px; border-radius: 4px; font-weight: bold; font-size: 11px;">Risk Score: ${data.riskScore}/100</span>`;
      card.innerHTML = `
        <div class="choice-card-header" style="color: var(--warning, #e6a23c);">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          <span>${data.title}</span> ${riskBadge}
        </div>
        <p style="font-size: 12px; color: var(--text-main); margin-top: 8px;">${data.message}</p>
        <div class="choice-actions" style="margin-top: 12px;">
          <button class="btn-reject" style="background: rgba(245,108,108,0.2); color: #f56c6c; border: 1px solid #f56c6c; padding: 6px 12px; border-radius: 4px; cursor: pointer;">Deny Action</button>
          <button class="btn-approve" style="background: #409eff; color: white; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-weight: bold;">Approve Git Action</button>
        </div>
      `;

      const approveBtn = card.querySelector('.btn-approve');
      const rejectBtn = card.querySelector('.btn-reject');

      approveBtn.addEventListener('click', async () => {
        await sendHitlResponse('approve');
        card.innerHTML = `<div class="choice-card-header" style="color: var(--success, #67c23a)">✔ Git Action Approved by Developer</div>`;
      });

      rejectBtn.addEventListener('click', async () => {
        await sendHitlResponse('reject');
        card.innerHTML = `<div class="choice-card-header" style="color: var(--danger, #f56c6c)">✖ Git Action Denied by Developer</div>`;
      });

      widgetsContainer.appendChild(card);
      card.scrollIntoView({ behavior: 'smooth' });
      return;
    }

    if (data.type === 'TERMINAL_PERMISSION_APPROVAL') {
      const riskBadge = `<span style="background: rgba(255,165,0,0.2); color: #ffa500; padding: 2px 6px; border-radius: 4px; font-weight: bold; font-size: 11px;">Risk Score: ${data.riskScore}/100</span>`;
      const cmdSnippet = data.command ? `<pre style="background: rgba(0,0,0,0.2); padding: 6px; border-radius: 4px; font-family: monospace; font-size: 11px; margin-top: 6px; overflow-x: auto;"><code>${data.command}</code></pre>` : '';
      card.innerHTML = `
        <div class="choice-card-header" style="color: var(--warning, #e6a23c);">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 17l6-6-6-6"/><path d="M12 19h8"/></svg>
          <span>${data.title}</span> ${riskBadge}
        </div>
        <p style="font-size: 12px; color: var(--text-main); margin-top: 8px;">${data.message}</p>
        ${cmdSnippet}
        <div class="choice-actions" style="margin-top: 12px;">
          <button class="btn-reject" style="background: rgba(245,108,108,0.2); color: #f56c6c; border: 1px solid #f56c6c; padding: 6px 12px; border-radius: 4px; cursor: pointer;">Deny Action</button>
          <button class="btn-approve" style="background: #409eff; color: white; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-weight: bold;">Approve Terminal Action</button>
        </div>
      `;

      const approveBtn = card.querySelector('.btn-approve');
      const rejectBtn = card.querySelector('.btn-reject');

      approveBtn.addEventListener('click', async () => {
        await sendHitlResponse('approve');
        card.innerHTML = `<div class="choice-card-header" style="color: var(--success, #67c23a)">✔ Terminal Action Approved by Developer</div>`;
      });

      rejectBtn.addEventListener('click', async () => {
        await sendHitlResponse('reject');
        card.innerHTML = `<div class="choice-card-header" style="color: var(--danger, #f56c6c)">✖ Terminal Action Denied by Developer</div>`;
      });

      widgetsContainer.appendChild(card);
      card.scrollIntoView({ behavior: 'smooth' });
      return;
    }

    if (data.type === 'PLAN_APPROVAL') {
      const coderStepEl = document.getElementById('step-coder');
      if (coderStepEl) {
        coderStepEl.className = 'step-item waiting';
        const d = coderStepEl.querySelector('.step-detail');
        if (d) d.textContent = 'Waiting for Approval';
      }
      if (stepperInlineStatus) {
        stepperInlineStatus.textContent = '⏸ Waiting for Plan Approval';
      }
    }

    let stepsHtml = '';
    if (data.plan && data.plan.length > 0) {
      stepsHtml = `<div class="plan-steps-list">` +
        data.plan.map((s, idx) => {
          const rawDesc = typeof s === 'string' ? s : (s.description || s.task || `Step ${s.id || idx + 1}`);
          const cleanDesc = rawDesc.replace(new RegExp(`^Step\\s*${s.id || idx + 1}[:\\s-]*`, 'i'), '').trim() || rawDesc;
          const tf = (typeof s === 'object' && s.targetFile) ? s.targetFile : null;
          const targetBadge = tf ? `<span style="background: rgba(99,102,241,0.2); color: #a5b4fc; border: 1px solid rgba(99,102,241,0.35); padding: 1px 6px; border-radius: 4px; font-family: monospace; font-size: 10px; margin-left: 6px;">${tf}</span>` : '';
          return `<div class="plan-step-row"><strong>Step ${s.id || idx + 1}:</strong> ${cleanDesc} ${targetBadge}</div>`;
        }).join('') +
        `</div>`;
    }

    card.innerHTML = `
      <div class="choice-card-header">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <span>${data.title}</span>
      </div>
      <p style="font-size: 12px; color: var(--text-main);">${data.message}</p>
      ${stepsHtml}
      <textarea class="choice-input" placeholder="Provide feedback or guidance (optional)..." rows="2"></textarea>
      <div class="choice-actions">
        <button class="btn-reject">Reject Plan</button>
        <button class="btn-approve">Approve & Generate Code</button>
      </div>
    `;

    const feedbackInput = card.querySelector('.choice-input');
    const approveBtn = card.querySelector('.btn-approve');
    const rejectBtn = card.querySelector('.btn-reject');

    approveBtn.addEventListener('click', async () => {
      const feedback = feedbackInput.value.trim();
      const action = feedback ? 'feedback' : 'approve';
      await sendHitlResponse(action, feedback);
      card.innerHTML = `<div class="choice-card-header" style="color: var(--success)">✔ Plan Approved by Developer</div>`;
      if (stepperInlineStatus) stepperInlineStatus.textContent = '⚡ Plan approved. Starting Coder...';
    });

    rejectBtn.addEventListener('click', async () => {
      await sendHitlResponse('reject');
      card.innerHTML = `<div class="choice-card-header" style="color: var(--danger)">✖ Plan Rejected by Developer</div>`;
      if (stepperInlineStatus) stepperInlineStatus.textContent = '✖ Plan rejected by user.';
    });

    widgetsContainer.appendChild(card);
    card.scrollIntoView({ behavior: 'smooth' });
  }

  async function sendHitlResponse(action, message = '') {
    if (isVsCodeEnv) {
      vscode.postMessage({ type: 'HITL_RESPOND', action, message });
    } else {
      await fetch('/api/hitl/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, message })
      });
    }
  }

  // 7. Generative UI Widget: Interactive Code Diff Cards
  function renderDiffCards(cards) {
    if (!cards || cards.length === 0) return;

    cards.forEach(cardData => {
      const card = document.createElement('div');
      card.className = 'gen-card diff-card';

      const origLines = (cardData.originalCode || '').split('\n');
      const genLines = (cardData.generatedCode || '').split('\n');

      let diffHtml = '';
      genLines.forEach((line, idx) => {
        const isNew = !origLines.includes(line);
        const lineClass = isNew ? 'diff-line add' : 'diff-line';
        const prefix = isNew ? '+ ' : '  ';
        diffHtml += `<div class="${lineClass}">${prefix}${escapeHtml(line)}</div>`;
      });

      card.innerHTML = `
        <div class="diff-card-header">
          <span class="diff-filename">📄 ${cardData.filePath}</span>
          <div style="display: flex; gap: 6px;">
            ${isVsCodeEnv ? `<button class="btn-primary-sm open-diff-btn" style="background: var(--bg-card); border: 1px solid var(--border-color);">VS Code Diff</button>` : ''}
            <button class="btn-primary-sm apply-patch-btn">Apply Patch</button>
          </div>
        </div>
        <div class="diff-viewer">${diffHtml}</div>
      `;

      if (isVsCodeEnv) {
        const openDiffBtn = card.querySelector('.open-diff-btn');
        if (openDiffBtn) {
          openDiffBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'OPEN_NATIVE_DIFF', filePath: cardData.filePath, code: cardData.generatedCode });
          });
        }
      }

      card.querySelector('.apply-patch-btn').addEventListener('click', async () => {
        if (isVsCodeEnv) {
          vscode.postMessage({ type: 'APPLY_PATCH', filePath: cardData.filePath, code: cardData.generatedCode });
        } else {
          await fetch('/api/workspace/file', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: cardData.filePath, content: cardData.generatedCode })
          });
          openFileInEditor(cardData.filePath);
        }
        card.querySelector('.apply-patch-btn').textContent = 'Applied!';
      });

      widgetsContainer.appendChild(card);
    });
  }

  // 8. Generative UI Widget: Reviewer Quality Report Card
  function renderReviewerBadgeCard(review) {
    if (!review) return;
    const card = document.createElement('div');
    card.className = 'gen-card reviewer-card';

    const isApproved = review.approved;
    const badgeText = isApproved ? '✔ Code Review Passed' : '✖ Review Flagged Issues';
    const badgeColor = isApproved ? 'var(--success)' : 'var(--danger)';

    card.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <span style="font-size: 13px; font-weight: 600;">Code Review Report</span>
        <span class="score-badge" style="border-color: ${badgeColor}; color: ${badgeColor}; font-weight: 500;">
          ${badgeText}
        </span>
      </div>
      <p style="font-size: 12px; color: var(--text-muted);">${review.summary || review.overview || 'Review complete.'}</p>
    `;

    widgetsContainer.appendChild(card);
  }

  function renderCompletionCard(data) {
    const card = document.createElement('div');
    card.className = 'gen-card';
    card.style.borderColor = 'var(--success)';
    card.innerHTML = `
      <div style="color: var(--success); font-weight: 600; font-size: 13px;">
        ✨ Task Completed
      </div>
      <p style="font-size: 12px; color: var(--text-muted);">
        Target files updated in workspace. Review diff cards above or inspect active editor.
      </p>
    `;
    widgetsContainer.appendChild(card);
  }

  function renderExplanationCard(data) {
    const card = document.createElement('div');
    card.className = 'agent-msg-wall';
    
    const text = data.explanation || (data.state && data.state.extractedContext) || 'Task completed.';
    
    card.innerHTML = parseMarkdownToHtml(text);
    widgetsContainer.appendChild(card);
    card.scrollIntoView({ behavior: 'smooth' });
  }

  function parseMarkdownToHtml(md) {
    if (!md) return '';
    
    let html = md;
    
    // 1. Code blocks
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
      return `<pre class="code-block-container"><code>${escapeHtml(code.trim())}</code></pre>`;
    });

    // 2. Inline code
    html = html.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');

    // 3. Tables
    const lines = html.split('\n');
    let inTable = false;
    let tableRows = [];
    let resultLines = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('|') && line.endsWith('|')) {
        if (line.replace(/\|/g, '').replace(/[\s-]/g, '') === '') {
          continue;
        }
        inTable = true;
        const cells = line.split('|').slice(1, -1).map(c => c.trim());
        tableRows.push(cells);
      } else {
        if (inTable) {
          resultLines.push(buildHtmlTable(tableRows));
          tableRows = [];
          inTable = false;
        }
        resultLines.push(line);
      }
    }
    if (inTable && tableRows.length > 0) {
      resultLines.push(buildHtmlTable(tableRows));
    }

    html = resultLines.join('\n');

    // 4. Headings
    html = html.replace(/^### (.*$)/gim, '<h4 class="md-h4">$1</h4>');
    html = html.replace(/^## (.*$)/gim, '<h3 class="md-h3">$1</h3>');
    html = html.replace(/^# (.*$)/gim, '<h2 class="md-h2">$1</h2>');

    // 5. Bold & Italics
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');

    // 6. Bullet lists
    html = html.replace(/^\s*[\-\*]\s+(.*$)/gim, '<li class="md-li">$1</li>');
    html = html.replace(/(<li class="md-li">.*<\/li>\n?)+/g, '<ul class="md-ul">$&</ul>');

    // 7. Paragraphs
    html = html.split('\n\n').map(p => {
      if (p.startsWith('<h') || p.startsWith('<div') || p.startsWith('<ul') || p.startsWith('<pre')) {
        return p;
      }
      return `<p class="md-p">${p.replace(/\n/g, '<br/>')}</p>`;
    }).join('');

    return html;
  }

  function buildHtmlTable(rows) {
    if (!rows || rows.length === 0) return '';
    const header = rows[0];
    const body = rows.slice(1);

    let tableHtml = `<div class="table-responsive"><table class="styled-table"><thead><tr>`;
    header.forEach(cell => {
      tableHtml += `<th>${cell}</th>`;
    });
    tableHtml += `</tr></thead><tbody>`;

    body.forEach(row => {
      tableHtml += `<tr>`;
      row.forEach(cell => {
        tableHtml += `<td>${cell}</td>`;
      });
      tableHtml += `</tr>`;
    });

    tableHtml += `</tbody></table></div>`;
    return tableHtml;
  }

  function renderErrorCard(errorMsg) {
    const card = document.createElement('div');
    card.className = 'gen-card';
    card.style.borderColor = 'var(--danger)';
    card.style.background = 'rgba(239, 68, 68, 0.08)';
    card.innerHTML = `
      <div style="color: var(--danger); font-weight: 600; font-size: 13px; display: flex; align-items: center; gap: 8px;">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
        <span>Execution Error / Task Failed</span>
      </div>
      <p style="font-size: 12px; color: var(--text-main); font-family: var(--font-mono); line-height: 1.5;">
        ${escapeHtml(errorMsg || 'An error occurred during execution.')}
      </p>
    `;
    widgetsContainer.appendChild(card);
    card.scrollIntoView({ behavior: 'smooth' });
  }

  // Helper escape HTML
  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // 9. Prompt Submission Logic
  let isSubmitting = false;
  chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const query = chatInput.value.trim();
    if (!query && !pastedImagePayload) {
      showToast('Prompt cannot be empty', 'error');
      return;
    }

    if (isSubmitting) return; // Prevent double-tap submit
    isSubmitting = true;

    addPromptToHistory(query);

    const activeImage = pastedImagePayload;
    pastedImagePayload = null;
    if (imagePreviewContainer) {
      imagePreviewContainer.innerHTML = '';
      imagePreviewContainer.classList.add('hidden');
    }

    chatInput.value = '';
    resetStepper();

    const userCard = document.createElement('div');
    userCard.className = 'user-msg-bubble';
    let imageHtml = activeImage ? `<div style="margin-top: 6px;"><img src="${activeImage}" style="height: 60px; border-radius: 4px; border: 1px solid var(--border-color);" /></div>` : '';
    userCard.innerHTML = `
      <div style="font-size: 13px; color: #e0e7ff; font-weight: 500;">${escapeHtml(query || 'Attached image query')}</div>
      ${imageHtml}
    `;
    widgetsContainer.appendChild(userCard);
    userCard.scrollIntoView({ behavior: 'smooth' });

    // Handle @test comprehensive / @test all-features verification command
    if (query.startsWith('@test')) {
      showToast('→ Running comprehensive verification suite...', 'info');
      try {
        const res = await fetch('/api/test/comprehensive');
        const data = await res.json();
        renderVerificationReportCard(data.results);
      } catch (err) {
        showToast('Verification test execution failed', 'error');
      } finally {
        isSubmitting = false;
      }
      return;
    }

    const estimatedRisk = calculatePromptRisk(query);
    updateRiskScoreBadge(estimatedRisk);

    showToast('→ Submitting prompt to pipeline...', 'info');

    if (isVsCodeEnv) {
      vscode.postMessage({ type: 'RUN_PIPELINE', userInput: query, imagePayload: activeImage });
      isSubmitting = false;
    } else {
      try {
        await fetch('/api/pipeline/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userInput: query, imagePayload: activeImage })
        });
      } catch (err) {
        showToast('Failed to launch pipeline execution', 'error');
      } finally {
        isSubmitting = false;
      }
    }
  });

  function renderVerificationReportCard(results) {
    if (!results) return;
    const card = document.createElement('div');
    card.className = 'gen-card verification-report-card';
    
    let rowsHtml = results.map(r => {
      const isPass = r.status === 'PASS';
      const isWarn = r.status === 'WARN';
      const badgeClass = isPass ? 'badge-pass' : (isWarn ? 'badge-warn' : 'badge-fail');
      const badgeText = isPass ? '✔ PASS' : (isWarn ? '⚠ WARN' : '✖ FAIL');
      
      return `
        <div class="verification-row">
          <div class="verification-header-row">
            <span class="verification-feature-name">${escapeHtml(r.feature)}</span>
            <span class="verification-badge ${badgeClass}">${badgeText}</span>
          </div>
          <div class="verification-detail-text">${escapeHtml(r.details)}</div>
        </div>
      `;
    }).join('');

    card.innerHTML = `
      <div class="verification-card-title">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
        <span>COMPREHENSIVE VERIFICATION REPORT</span>
      </div>
      <div class="verification-rows-container">${rowsHtml}</div>
    `;
    widgetsContainer.appendChild(card);
    card.scrollIntoView({ behavior: 'smooth' });
  }

  // Prompt Chips listener
  document.querySelectorAll('.prompt-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      chatInput.value = chip.getAttribute('data-prompt');
    });
  });

  // 10. Interactive Mouse Pointer Drag Resizer Engine
  function initMousePointerResizers() {
    const mainBody = document.querySelector('.main-body');
    const resizerLeft = document.getElementById('resizer-left');
    const resizerRight = document.getElementById('resizer-right');

    if (!mainBody) return;

    // Resize Left Workspace Panel
    if (resizerLeft) {
      let isDraggingLeft = false;
      resizerLeft.addEventListener('mousedown', (e) => {
        isDraggingLeft = true;
        resizerLeft.classList.add('dragging');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
      });

      document.addEventListener('mousemove', (e) => {
        if (!isDraggingLeft) return;
        const newWidth = Math.max(160, Math.min(e.clientX, 500));
        mainBody.style.setProperty('--left-width', `${newWidth}px`);
      });

      document.addEventListener('mouseup', () => {
        if (isDraggingLeft) {
          isDraggingLeft = false;
          resizerLeft.classList.remove('dragging');
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
        }
      });
    }

    // Resize Right Kaizen Extension Sidebar
    if (resizerRight) {
      let isDraggingRight = false;
      resizerRight.addEventListener('mousedown', (e) => {
        isDraggingRight = true;
        resizerRight.classList.add('dragging');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
      });

      document.addEventListener('mousemove', (e) => {
        if (!isDraggingRight) return;
        const windowWidth = window.innerWidth;
        const newWidth = Math.max(260, Math.min(windowWidth - e.clientX, 850));
        mainBody.style.setProperty('--right-width', `${newWidth}px`);
      });

      document.addEventListener('mouseup', () => {
        if (isDraggingRight) {
          isDraggingRight = false;
          resizerRight.classList.remove('dragging');
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
        }
      });
    }
  }

  // 10. Telemetry Modal listener
  if (toggleTelemetryBtn) {
    toggleTelemetryBtn.addEventListener('click', async () => {
      if (telemetryModal) telemetryModal.classList.remove('hidden');
      try {
        const res = await fetch('/api/langfuse/traces');
        const data = await res.json();
        if (!data.traces || data.traces.length === 0) {
          if (telemetryBody) telemetryBody.innerHTML = `<div class="trace-placeholder">No trace logs recorded yet.</div>`;
          return;
        }
        if (telemetryBody) {
          telemetryBody.innerHTML = data.traces.map(t => `
            <div style="background: var(--bg-card); padding: 10px; border-radius: 6px; margin-bottom: 8px;">
              <div style="color: var(--primary); font-weight: 600;">${t.agentName} (${t.modelName})</div>
              <div style="font-size: 11px; color: var(--text-muted);">Latency: ${t.latencyMs}ms | Tokens: In ${t.promptTokens} / Out ${t.completionTokens}</div>
            </div>
          `).join('');
        }
      } catch (err) {
        if (telemetryBody) telemetryBody.innerHTML = `Telemetry traces available in server logs.`;
      }
    });
  }

  if (closeModalBtn) {
    closeModalBtn.addEventListener('click', () => telemetryModal.classList.add('hidden'));
  }

  // --- GRAPHIFY EXPLORER CONTROLLER ---
  const viewTabEditor = document.getElementById('view-tab-editor');
  const viewTabGraphify = document.getElementById('view-tab-graphify');
  const btnToggleGraphify = document.getElementById('btn-toggle-graphify');
  const editorViewContainer = document.getElementById('editor-view-container');
  const graphifyViewContainer = document.getElementById('graphify-view-container');

  const graphifySearchInput = document.getElementById('graphify-search-input');
  const graphifyBtnFit = document.getElementById('graphify-btn-fit');
  const graphifyBtnRefresh = document.getElementById('graphify-btn-refresh');
  const graphifyNodeDrawer = document.getElementById('graphify-node-drawer');
  const closeDrawerBtn = document.getElementById('close-drawer-btn');

  let currentGraphScope = 'current-task';
  let visNetworkInstance = null;
  let currentGraphData = null;

  function switchCenterView(viewName) {
    if (viewName === 'graphify') {
      if (viewTabEditor) viewTabEditor.classList.remove('active');
      if (viewTabGraphify) viewTabGraphify.classList.add('active');
      if (editorViewContainer) editorViewContainer.classList.add('hidden');
      if (graphifyViewContainer) graphifyViewContainer.classList.remove('hidden');
      loadGraphifyGraph();
    } else {
      if (viewTabGraphify) viewTabGraphify.classList.remove('active');
      if (viewTabEditor) viewTabEditor.classList.add('active');
      if (graphifyViewContainer) graphifyViewContainer.classList.add('hidden');
      if (editorViewContainer) editorViewContainer.classList.remove('hidden');
    }
  }

  if (viewTabEditor) viewTabEditor.addEventListener('click', () => switchCenterView('editor'));
  if (viewTabGraphify) viewTabGraphify.addEventListener('click', () => switchCenterView('graphify'));
  if (btnToggleGraphify) btnToggleGraphify.addEventListener('click', () => switchCenterView('graphify'));
  if (closeDrawerBtn) closeDrawerBtn.addEventListener('click', () => {
    if (graphifyNodeDrawer) graphifyNodeDrawer.classList.add('hidden');
  });

  const modeButtons = document.querySelectorAll('.graph-mode-btn');
  modeButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      modeButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentGraphScope = btn.dataset.mode || 'current-task';
      loadGraphifyGraph();
    });
  });

  if (graphifyBtnRefresh) graphifyBtnRefresh.addEventListener('click', () => loadGraphifyGraph());
  if (graphifyBtnFit) {
    graphifyBtnFit.addEventListener('click', () => {
      if (visNetworkInstance) visNetworkInstance.fit({ animation: true });
    });
  }

  if (graphifySearchInput) {
    graphifySearchInput.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase().trim();
      if (!q || !currentGraphData || !visNetworkInstance) return;
      const matchedNode = currentGraphData.nodes.find(n => 
        n.label.toLowerCase().includes(q) || (n.path && n.path.toLowerCase().includes(q))
      );
      if (matchedNode) {
        visNetworkInstance.selectNodes([matchedNode.id]);
        visNetworkInstance.focus(matchedNode.id, { scale: 1.2, animation: true });
        renderNodeDrawer(matchedNode);
      }
    });
  }

  async function loadGraphifyGraph() {
    try {
      const url = `/api/graphify/current?scope=${encodeURIComponent(currentGraphScope)}&activeFile=${encodeURIComponent(activeFilePath)}`;
      const res = await fetch(url);
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      if (!data || !Array.isArray(data.nodes) || !Array.isArray(data.edges)) {
        throw new Error('Invalid graph data payload structure');
      }

      currentGraphData = data;
      updateGraphifyStats(data.metadata || {});
      renderVisNetwork(data);
    } catch (err) {
      console.warn('[GraphifyExplorer] Failed to load graph data:', err);
      showToast('Failed to load Graphify graph data', 'error');
    }
  }

  function updateGraphifyStats(meta) {
    if (!meta) return;
    const f = document.getElementById('stat-files');
    const s = document.getElementById('stat-symbols');
    const d = document.getElementById('stat-deps');
    const e = document.getElementById('stat-edges');
    const x = document.getElementById('stat-ext');
    const u = document.getElementById('stat-unresolved');

    if (f) f.textContent = meta.files || 0;
    if (s) s.textContent = meta.symbols || 0;
    if (d) d.textContent = meta.dependencies || 0;
    if (e) e.textContent = meta.edges || 0;
    if (x) x.textContent = meta.externalDependencies || 0;
    if (u) u.textContent = meta.unresolved || 0;
  }

  function renderVisNetwork(data) {
    const container = document.getElementById('graphify-network-canvas');
    if (!container || !data || !Array.isArray(data.nodes)) return;

    if (typeof vis === 'undefined') {
      container.innerHTML = `<div style="padding: 20px; color: var(--text-muted); text-align: center;">
        <p style="margin-bottom: 8px;">Vis.js network engine is loading...</p>
        <button id="retry-vis-btn" style="background: #4f46e5; color: white; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer;">Refresh Network Graph</button>
      </div>`;
      const btn = document.getElementById('retry-vis-btn');
      if (btn) btn.addEventListener('click', () => loadGraphifyGraph());
      return;
    }

    const visNodes = data.nodes.map(n => {
      let color = { background: '#1e293b', border: '#475569', highlight: { background: '#334155', border: '#818cf8' } };
      let shape = 'box';
      let font = { color: '#f8fafc', face: 'Inter, sans-serif' };

      if (n.type === 'file') {
        shape = 'box';
        if (n.status === 'active') {
          color = { background: '#312e81', border: '#818cf8', highlight: { background: '#4338ca', border: '#a5b4fc' } };
        } else if (n.status === 'generated') {
          color = { background: '#064e3b', border: '#10b981', highlight: { background: '#047857', border: '#34d399' } };
        } else if (n.status === 'modified') {
          color = { background: '#78350f', border: '#f59e0b', highlight: { background: '#92400e', border: '#fbbf24' } };
        } else if (n.status === 'test') {
          color = { background: '#581c87', border: '#c084fc', highlight: { background: '#6b21a8', border: '#e879f9' } };
        }
      } else if (n.type === 'symbol') {
        shape = 'ellipse';
        color = { background: '#0f172a', border: '#38bdf8', highlight: { background: '#1e293b', border: '#7dd3fc' } };
        font.color = '#7dd3fc';
      } else if (n.type === 'external') {
        shape = 'hexagon';
        color = { background: '#27272a', border: '#a1a1aa', highlight: { background: '#3f3f46', border: '#e4e4e7' } };
        font.color = '#a1a1aa';
      } else if (n.type === 'unresolved') {
        shape = 'diamond';
        color = { background: '#450a0a', border: '#ef4444', highlight: { background: '#7f1d1d', border: '#f87171' } };
        font.color = '#fca5a5';
      }

      return {
        id: n.id,
        label: n.label,
        shape,
        color,
        font,
        margin: 10,
        rawNode: n
      };
    });

    const visEdges = data.edges.map(e => {
      let color = '#475569';
      let dashes = false;
      if (e.type === 'IMPORTS') color = '#818cf8';
      else if (e.type === 'EXPORTS' || e.type === 'DEFINES') { color = '#38bdf8'; dashes = true; }
      else if (e.type === 'DEPENDS_ON') color = '#a1a1aa';

      return {
        id: e.id,
        from: e.source,
        to: e.target,
        arrows: 'to',
        label: e.symbols && e.symbols.length > 0 ? e.symbols.join(', ') : e.label,
        color: { color, highlight: '#c084fc' },
        font: { color: '#94a3b8', size: 10, align: 'top' },
        dashes
      };
    });

    const networkData = {
      nodes: new vis.DataSet(visNodes),
      edges: new vis.DataSet(visEdges)
    };

    const options = {
      physics: {
        solver: 'forceAtlas2Based',
        forceAtlas2Based: {
          gravitationalConstant: -50,
          centralGravity: 0.01,
          springLength: 100,
          springConstant: 0.08
        },
        maxVelocity: 50,
        timestep: 0.35,
        stabilization: { iterations: 150 }
      },
      interaction: {
        hover: true,
        tooltipDelay: 200,
        zoomView: true,
        dragNodes: true,
        dragView: true
      }
    };

    if (visNetworkInstance) visNetworkInstance.destroy();
    visNetworkInstance = new vis.Network(container, networkData, options);

    visNetworkInstance.on('selectNode', (params) => {
      if (params.nodes.length > 0) {
        const selectedId = params.nodes[0];
        const raw = data.nodes.find(n => n.id === selectedId);
        if (raw) renderNodeDrawer(raw);
      }
    });

    if (data.metadata.activeFile) {
      const activeNode = data.nodes.find(n => n.id === data.metadata.activeFile);
      if (activeNode) {
        visNetworkInstance.selectNodes([activeNode.id]);
      }
    }
  }

  function renderNodeDrawer(node) {
    if (!graphifyNodeDrawer) return;
    graphifyNodeDrawer.classList.remove('hidden');

    const typeBadge = document.getElementById('drawer-node-type-badge');
    const title = document.getElementById('drawer-node-label');
    const body = document.getElementById('drawer-node-body');

    if (typeBadge) {
      typeBadge.textContent = (node.type || 'FILE').toUpperCase();
      typeBadge.className = `badge-pill ${node.status || ''}`;
    }

    if (title) title.textContent = node.label;

    let content = `
      <div class="drawer-section">
        <div class="drawer-section-label">Node Metadata</div>
        <div class="drawer-fact-row"><span class="drawer-fact-key">ID:</span> <span>${node.id}</span></div>
        <div class="drawer-fact-row"><span class="drawer-fact-key">Type:</span> <span>${node.type}</span></div>
        ${node.path ? `<div class="drawer-fact-row"><span class="drawer-fact-key">Path:</span> <span>${node.path}</span></div>` : ''}
        ${node.language ? `<div class="drawer-fact-row"><span class="drawer-fact-key">Language:</span> <span>${node.language}</span></div>` : ''}
        ${node.status ? `<div class="drawer-fact-row"><span class="drawer-fact-key">Status:</span> <span>${node.status.toUpperCase()}</span></div>` : ''}
      </div>
    `;

    if (node.type === 'file') {
      content += `
        <div class="drawer-section">
          <div class="drawer-section-label">Facts</div>
          <div class="drawer-fact-row"><span class="drawer-fact-key">Declared Symbols:</span> <span>${node.symbolsCount || 0}</span></div>
          <div class="drawer-fact-row"><span class="drawer-fact-key">Imports:</span> <span>${node.importsCount || 0}</span></div>
        </div>
      `;
      if (node.contentSnippet) {
        content += `
          <div class="drawer-section">
            <div class="drawer-section-label">Content Snippet</div>
            <pre class="node-code-snippet">${escapeHtml(node.contentSnippet)}</pre>
          </div>
        `;
      }
    } else if (node.type === 'symbol') {
      content += `
        <div class="drawer-section">
          <div class="drawer-section-label">Symbol Details</div>
          <div class="drawer-fact-row"><span class="drawer-fact-key">Symbol Type:</span> <span>${node.symbolType || 'symbol'}</span></div>
          <div class="drawer-fact-row"><span class="drawer-fact-key">Declared In:</span> <span>${node.declaredIn || 'N/A'}</span></div>
          <div class="drawer-fact-row"><span class="drawer-fact-key">Exported:</span> <span>${node.isExported ? 'Yes' : 'No'}</span></div>
        </div>
      `;
    }

    if (body) body.innerHTML = content;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Init
  loadSandboxFiles();
  openFileInEditor('src/sandbox/main.ts');
  initStreamAndListeners();
  initMousePointerResizers();
});
