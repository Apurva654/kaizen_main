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
  const runCodeBtn = document.getElementById('run-code-btn');
  const codeOutputConsole = document.getElementById('code-output-console');
  const consoleStatusBadge = document.getElementById('console-status-badge');
  const consoleTimeBadge = document.getElementById('console-time-badge');
  const consoleOutputBody = document.getElementById('console-output-body');
  const closeConsoleBtn = document.getElementById('close-console-btn');
  const consoleStdinInput = document.getElementById('console-stdin-input');
  const sendStdinBtn = document.getElementById('send-stdin-btn');

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
            openTabsList = [];
            tabsContentMap.clear();
            activeFilePath = '';
            if (codeEditor) codeEditor.value = '';
            if (editorFilePath) editorFilePath.textContent = 'No file open';
            renderTabsHeader();
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

  // Multi-Tab Editor State
  let openTabsList = [];
  const tabsContentMap = new Map();

  function renderTabsHeader() {
    if (!editorTabs) return;
    editorTabs.innerHTML = '';

    openTabsList.forEach(relPath => {
      const fileName = relPath.split('/').pop();
      const tabEl = document.createElement('div');
      tabEl.className = `tab ${relPath === activeFilePath ? 'active' : ''}`;
      tabEl.setAttribute('data-path', relPath);

      tabEl.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        <span>${fileName}</span>
        <span class="tab-close-btn" title="Close tab">&times;</span>
      `;

      tabEl.addEventListener('click', (e) => {
        if (e.target.classList.contains('tab-close-btn')) {
          e.stopPropagation();
          closeTab(relPath);
        } else {
          openFileInEditor(relPath);
        }
      });

      editorTabs.appendChild(tabEl);
    });
  }

  function closeTab(relPath) {
    openTabsList = openTabsList.filter(p => p !== relPath);
    tabsContentMap.delete(relPath);

    if (activeFilePath === relPath) {
      if (openTabsList.length > 0) {
        const nextTab = openTabsList[openTabsList.length - 1];
        openFileInEditor(nextTab);
      } else {
        activeFilePath = '';
        if (codeEditor) codeEditor.value = '';
        if (editorFilePath) editorFilePath.textContent = 'No file open';
        updateLineNumbers();
        renderTabsHeader();
      }
    } else {
      renderTabsHeader();
    }
  }

  // 2. Open File in Editor
  async function openFileInEditor(relPath, targetLine) {
    if (!relPath) return;
    exitReadOnlyBrowserMode();

    if (!openTabsList.includes(relPath)) {
      openTabsList.push(relPath);
    }

    activeFilePath = relPath;
    if (editorFilePath) editorFilePath.textContent = relPath;

    document.querySelectorAll('.tree-item').forEach(el => {
      el.classList.toggle('active', el.getAttribute('data-path') === relPath);
    });

    renderTabsHeader();

    if (isVsCodeEnv) return;

    try {
      const res = await fetch(`/api/workspace/file?path=${encodeURIComponent(relPath)}`);
      if (!res.ok) {
        if (codeEditor) codeEditor.value = `// File not found: ${relPath}`;
        updateLineNumbers();
        return;
      }
      const data = await res.json();
      const actualPath = data.path || relPath;
      if (actualPath !== relPath) {
        openTabsList = openTabsList.map(p => p === relPath ? actualPath : p);
        activeFilePath = actualPath;
        if (editorFilePath) editorFilePath.textContent = actualPath;
        renderTabsHeader();
      }
      tabsContentMap.set(actualPath, data.content);
      if (codeEditor) codeEditor.value = data.content;
      updateLineNumbers();

      if (targetLine && targetLine > 0 && codeEditor) {
        const lines = codeEditor.value.split('\n');
        let charIndex = 0;
        for (let i = 0; i < Math.min(targetLine - 1, lines.length); i++) {
          charIndex += lines[i].length + 1;
        }
        codeEditor.focus();
        const lineLen = (lines[targetLine - 1] || '').length;
        codeEditor.setSelectionRange(charIndex, charIndex + lineLen);
        codeEditor.scrollTop = Math.max(0, (targetLine - 5) * 18);
      }
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
  let isCodeExecuting = false;

  async function sendStdinInputToProcess() {
    if (!consoleStdinInput) return;
    const val = consoleStdinInput.value;

    if (isCodeExecuting) {
      try {
        await fetch('/api/code/input', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input: val })
        });
        consoleStdinInput.value = '';
      } catch (err) {
        console.warn('[RunAPI] Failed to send stdin to live process:', err);
      }
    } else {
      runActiveCode(val);
      consoleStdinInput.value = '';
    }
  }

  if (runCodeBtn) runCodeBtn.addEventListener('click', () => runActiveCode());
  if (sendStdinBtn) sendStdinBtn.addEventListener('click', sendStdinInputToProcess);
  if (consoleStdinInput) {
    consoleStdinInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        sendStdinInputToProcess();
      }
    });
  }
  if (closeConsoleBtn) closeConsoleBtn.addEventListener('click', () => {
    if (codeOutputConsole) codeOutputConsole.classList.add('hidden');
    if (isCodeExecuting) {
      fetch('/api/code/kill', { method: 'POST' }).catch(() => {});
    }
  });

  async function runActiveCode(customStdin = '') {
    if (!activeFilePath) {
      showToast('No active file selected to run', 'warning');
      return;
    }

    if (saveFileBtn && !isReadOnlyBrowserSession) {
      await saveActiveFile();
    }

    if (codeOutputConsole) codeOutputConsole.classList.remove('hidden');
    if (consoleStatusBadge) {
      consoleStatusBadge.className = 'badge-pill running';
      consoleStatusBadge.textContent = 'Running...';
    }
    if (consoleTimeBadge) consoleTimeBadge.textContent = '0ms';

    if (consoleOutputBody) consoleOutputBody.textContent = '';
    if (runCodeBtn) runCodeBtn.disabled = true;
    isCodeExecuting = true;

    const startTime = Date.now();

    if (isVsCodeEnv && vscode) {
      vscode.postMessage({ type: 'RUN_CODE', filePath: activeFilePath, stdin: customStdin });
      return;
    }

    try {
      const res = await fetch('/api/code/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filePath: activeFilePath,
          content: codeEditor ? codeEditor.value : '',
          approved: true,
          stdin: customStdin
        })
      });
      const data = await res.json();
      if (!data.isLiveStream) {
        renderExecutionOutput(data);
      }
    } catch (err) {
      renderExecutionOutput({
        success: false,
        filePath: activeFilePath,
        output: `Error executing code: ${err?.message || err}`,
        executionTimeMs: Date.now() - startTime,
        exitCode: 1
      });
    }
  }

  function renderExecutionOutput(data) {
    if (runCodeBtn) runCodeBtn.disabled = false;
    if (codeOutputConsole) codeOutputConsole.classList.remove('hidden');

    const exitCode = data.exitCode !== undefined ? data.exitCode : (data.success ? 0 : 1);
    const isSuccess = data.success && exitCode === 0;

    if (consoleStatusBadge) {
      consoleStatusBadge.className = `badge-pill ${isSuccess ? 'success' : 'error'}`;
      consoleStatusBadge.textContent = `Exit Code: ${exitCode}`;
    }

    if (consoleTimeBadge) {
      consoleTimeBadge.textContent = `${data.executionTimeMs || data.durationMs || 0}ms`;
    }

    if (data.output !== undefined) {
      let outText = data.output || '(No output produced)';
      if (data.browserUrl) {
        outText += `\n\n🌐 Live Preview URL: ${data.browserUrl}`;
      }
      if (consoleOutputBody) {
        consoleOutputBody.textContent = outText;
      }
    } else {
      if (consoleOutputBody && !consoleOutputBody.textContent.trim()) {
        consoleOutputBody.textContent = '(No output produced)';
      }
      if (data.browserUrl && consoleOutputBody) {
        consoleOutputBody.textContent += `\n\n🌐 Live Preview URL: ${data.browserUrl}`;
      }
    }

    if (consoleOutputBody) {
      consoleOutputBody.scrollTop = consoleOutputBody.scrollHeight;
    }

    showToast(isSuccess ? `✓ Code executed cleanly (${data.executionTimeMs || 0}ms)` : `❌ Code execution failed with exit code ${exitCode}`, isSuccess ? 'success' : 'error');
  }

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
      sseSource.addEventListener('code_chunk', (e) => handleIncomingEvent('CODE_CHUNK', JSON.parse(e.data)));
      sseSource.addEventListener('code_exit', (e) => handleIncomingEvent('CODE_EXIT', JSON.parse(e.data)));
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
        loadSandboxFiles();
        if (data.route === 'MCP_BROWSER' || data.route === 'ROUTED_MCP_BROWSER') {
          renderBrowserInspectionUI(data);
        } else {
          finalizeStepper(data);
          if (data.route === 'DELETE_FILES' || data.route === 'ROUTED_DELETE_FILES') {
            activeFilePath = '';
            if (codeEditor) codeEditor.value = '';
            updateLineNumbers();
            renderTargetBadges([]);
          } else if (data.targetFiles && data.targetFiles[0]) {
            openFileInEditor(data.targetFiles[0]);
          }
          if (data.route === 'EXPLAIN_CODE' || data.status === 'EXPLAIN_COMPLETE' || data.explanation) {
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

      case 'CODE_EXECUTION_RESULT':
        renderExecutionOutput(data);
        break;

      case 'CODE_CHUNK':
        if (codeOutputConsole) codeOutputConsole.classList.remove('hidden');
        if (consoleOutputBody) {
          consoleOutputBody.textContent += (data.text || '');
          consoleOutputBody.scrollTop = consoleOutputBody.scrollHeight;
        }
        break;

      case 'CODE_EXIT':
        isCodeExecuting = false;
        renderExecutionOutput(data);
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

      const origLinesRaw = (cardData.originalCode || '').replace(/\r\n/g, '\n').split('\n');
      const genLinesRaw = (cardData.generatedCode || '').replace(/\r\n/g, '\n').split('\n');

      const origLinesNormalized = origLinesRaw.map(l => l.trim());
      const genLinesNormalized = genLinesRaw.map(l => l.trim());

      let diffHtml = '';
      const hasOriginal = cardData.originalCode && cardData.originalCode.trim().length > 0;

      if (!hasOriginal) {
        genLinesRaw.forEach(line => {
          diffHtml += `<div class="diff-line add">+ ${escapeHtml(line)}</div>`;
        });
      } else {
        // 1. Render removed lines (-)
        origLinesRaw.forEach((origLine) => {
          const norm = origLine.trim();
          if (norm.length > 0 && !genLinesNormalized.includes(norm)) {
            diffHtml += `<div class="diff-line del">- ${escapeHtml(origLine)}</div>`;
          }
        });
        // 2. Render added (+) and unchanged lines
        genLinesRaw.forEach((genLine) => {
          const norm = genLine.trim();
          const isNew = norm.length > 0 ? !origLinesNormalized.includes(norm) : false;
          const lineClass = isNew ? 'diff-line add' : 'diff-line';
          const prefix = isNew ? '+ ' : '  ';
          diffHtml += `<div class="${lineClass}">${prefix}${escapeHtml(genLine)}</div>`;
        });
      }

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
  const graphifyBtnLegend = document.getElementById('graphify-btn-legend');
  const graphifyLegendPanel = document.getElementById('graphify-legend-panel');
  const graphifyNodeDrawer = document.getElementById('graphify-node-drawer');
  const closeDrawerBtn = document.getElementById('close-drawer-btn');

  let currentGraphScope = 'current-task';
  let currentEdgeFilter = 'all';
  let visNetworkInstance = null;
  let currentGraphData = null;
  let activeSelectedNode = null;

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

  const edgeFilterBtns = document.querySelectorAll('.edge-filter-btn');
  edgeFilterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      edgeFilterBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentEdgeFilter = btn.dataset.edge || 'all';
      loadGraphifyGraph();
    });
  });

  if (graphifyBtnLegend) {
    graphifyBtnLegend.addEventListener('click', () => {
      if (graphifyLegendPanel) graphifyLegendPanel.classList.toggle('hidden');
    });
  }

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
        n.label.toLowerCase().includes(q) || (n.path && n.path.toLowerCase().includes(q)) || n.id.toLowerCase().includes(q)
      );
      if (matchedNode) {
        focusGraphNode(matchedNode.id);
      }
    });
  }

  function focusGraphNode(nodeId) {
    if (!currentGraphData || !visNetworkInstance) return;
    const target = currentGraphData.nodes.find(n => n.id === nodeId || n.path === nodeId);
    if (!target) return;

    visNetworkInstance.selectNodes([target.id]);
    visNetworkInstance.focus(target.id, { scale: 1.25, animation: { duration: 500, easingFunction: 'easeInOutQuad' } });
    activeSelectedNode = target;
    renderNodeDrawer(target);
  }

  async function loadGraphifyGraph() {
    try {
      const url = `/api/graphify/current?scope=${encodeURIComponent(currentGraphScope)}&activeFile=${encodeURIComponent(activeFilePath)}&edgeTypeFilter=${encodeURIComponent(currentEdgeFilter)}`;
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
      let font = { color: '#f8fafc', face: 'Inter, sans-serif', size: 12 };

      if (n.type === 'file') {
        shape = 'box';
        if (n.status === 'active') {
          color = { background: '#1e1b4b', border: '#818cf8', highlight: { background: '#312e81', border: '#a5b4fc' } };
        } else if (n.status === 'generated') {
          color = { background: '#022c22', border: '#10b981', highlight: { background: '#064e3b', border: '#34d399' } };
        } else if (n.status === 'modified') {
          color = { background: '#451a03', border: '#f59e0b', highlight: { background: '#78350f', border: '#fbbf24' } };
        } else if (n.status === 'test') {
          color = { background: '#3b0764', border: '#c084fc', highlight: { background: '#581c87', border: '#e879f9' } };
        }
      } else if (n.type === 'symbol') {
        shape = 'ellipse';
        color = { background: '#0f172a', border: '#38bdf8', highlight: { background: '#1e293b', border: '#7dd3fc' } };
        font.color = '#7dd3fc';
      } else if (n.type === 'external') {
        shape = 'hexagon';
        color = { background: '#18181b', border: '#a1a1aa', highlight: { background: '#27272a', border: '#e4e4e7' } };
        font.color = '#e4e4e7';
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
        margin: 12,
        borderWidth: 2,
        shadow: { enabled: true, color: 'rgba(0,0,0,0.5)', size: 8, x: 2, y: 3 },
        rawNode: n
      };
    });

    const visEdges = data.edges.map(e => {
      let color = '#475569';
      let dashes = false;
      let labelText = e.label || e.type || '';

      if (e.type === 'CALLS') {
        color = '#38bdf8';
        labelText = 'CALLS';
      } else if (e.type === 'IMPORTS') {
        color = '#818cf8';
        labelText = 'IMPORTS';
      } else if (e.type === 'DEFINES') {
        color = '#34d399';
        dashes = true;
        labelText = 'DEFINES';
      } else if (e.type === 'TESTS') {
        color = '#c084fc';
        labelText = 'TESTS';
      } else if (e.type === 'EXPORTS') {
        color = '#34d399';
        dashes = true;
        labelText = 'EXPORTS';
      } else if (e.type === 'DEPENDS_ON') {
        color = '#a1a1aa';
        dashes = true;
        labelText = 'DEPENDS_ON';
      }

      if (e.symbols && e.symbols.length > 0) {
        const symStr = e.symbols.join(', ');
        if (symStr !== e.label && symStr !== e.target && !e.target.endsWith(`:${symStr}`)) {
          labelText = `${labelText} (${symStr})`;
        }
      }

      return {
        id: e.id,
        from: e.source,
        to: e.target,
        arrows: { to: { enabled: true, scaleFactor: 0.8 } },
        label: labelText,
        color: { color, highlight: '#c084fc' },
        font: {
          color: '#cbd5e1',
          size: 10,
          face: 'Inter, sans-serif',
          align: 'middle',
          background: '#090a10',
          strokeWidth: 2,
          strokeColor: '#090a10'
        },
        dashes,
        smooth: { type: 'cubicBezier', forceDirection: 'none', roundness: 0.35 }
      };
    });

    const networkData = {
      nodes: new vis.DataSet(visNodes),
      edges: new vis.DataSet(visEdges)
    };

    const isLargeGraph = visNodes.length > 50 || visEdges.length > 100;

    const options = {
      physics: {
        solver: isLargeGraph ? 'forceAtlas2Based' : 'barnesHut',
        barnesHut: {
          gravitationalConstant: -2500,
          centralGravity: 0.12,
          springLength: 160,
          springConstant: 0.04,
          damping: 0.09,
          avoidOverlap: 0.8
        },
        forceAtlas2Based: {
          gravitationalConstant: -40,
          centralGravity: 0.01,
          springLength: 120,
          springConstant: 0.08
        },
        maxVelocity: 50,
        minVelocity: 0.75,
        timestep: 0.35,
        stabilization: {
          enabled: true,
          iterations: isLargeGraph ? 60 : 180,
          updateInterval: 25
        }
      },
      nodes: { borderWidth: 2 },
      edges: { selectionWidth: 2 },
      interaction: {
        hover: true,
        tooltipDelay: 150,
        zoomView: true,
        dragNodes: true,
        dragView: true,
        navigationButtons: true,
        keyboard: true
      }
    };

    if (visNetworkInstance) visNetworkInstance.destroy();
    visNetworkInstance = new vis.Network(container, networkData, options);

    visNetworkInstance.on('selectNode', (params) => {
      if (params.nodes.length > 0) {
        const selectedId = params.nodes[0];
        const raw = data.nodes.find(n => n.id === selectedId);
        if (raw) {
          activeSelectedNode = raw;
          renderNodeDrawer(raw);
        }
      }
    });

    visNetworkInstance.on('doubleClick', (params) => {
      if (params.nodes.length > 0) {
        const selectedId = params.nodes[0];
        const raw = data.nodes.find(n => n.id === selectedId);
        if (raw) {
          const filePath = raw.path || raw.declaredIn;
          if (filePath) {
            switchCenterView('editor');
            openFileInEditor(filePath, raw.startLine);
          }
        }
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
    const statusBadge = document.getElementById('drawer-node-status-badge');
    const title = document.getElementById('drawer-node-label');
    const body = document.getElementById('drawer-node-body');

    if (typeBadge) {
      typeBadge.textContent = (node.type || 'FILE').toUpperCase();
    }
    if (statusBadge) {
      statusBadge.textContent = (node.status || 'NORMAL').toUpperCase();
    }

    if (title) title.textContent = node.label;

    const isSymbol = node.type === 'symbol';
    const filePath = node.path || node.declaredIn || '';
    const lineStr = (node.startLine && node.endLine) ? `Lines ${node.startLine}–${node.endLine}` : (node.startLine ? `Line ${node.startLine}` : 'Not available');
    const colStr = (node.startColumn && node.endColumn) ? `Cols ${node.startColumn}–${node.endColumn}` : 'Not available';

    let content = `
      <!-- Section 1: Overview -->
      <div class="drawer-section">
        <div class="drawer-section-label">1. Basic Information & Actions</div>
        <div class="drawer-fact-row">
          <span class="drawer-fact-key">Symbol / File:</span>
          <span class="drawer-fact-value code-wrap">${escapeHtml(node.label)}</span>
        </div>
        <div class="drawer-fact-row">
          <span class="drawer-fact-key">Node Type:</span>
          <span class="drawer-fact-value">${escapeHtml(node.type)}</span>
        </div>
        <div class="drawer-fact-row">
          <span class="drawer-fact-key">Status:</span>
          <span class="drawer-fact-value">${escapeHtml((node.status || 'normal').toUpperCase())} (${escapeHtml(node.statusExplanation || 'Standard node')})</span>
        </div>
        ${filePath ? `
        <div class="drawer-fact-row">
          <span class="drawer-fact-key">File Path:</span>
          <span class="drawer-fact-value code-wrap">${escapeHtml(filePath)}</span>
        </div>` : ''}
        <div class="drawer-fact-row">
          <span class="drawer-fact-key">Line Range:</span>
          <span class="drawer-fact-value">${lineStr}</span>
        </div>
        <div class="drawer-fact-row">
          <span class="drawer-fact-key">Column Range:</span>
          <span class="drawer-fact-value">${colStr}</span>
        </div>

        <div class="drawer-action-bar">
          <button class="btn-drawer-action btn-accent" id="btn-open-in-editor" title="Open file and jump to exact line in editor">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            Open in Editor
          </button>
          <button class="btn-drawer-action" id="btn-show-impact" title="Show dependency impact analysis">
            ⚡ Show Impact
          </button>
          <button class="btn-drawer-action" id="btn-trace-path" title="Trace dependency path to another node">
            🔍 Trace Path
          </button>
          <button class="btn-drawer-action" id="btn-preview-context" title="Preview context fed to Kaizen AI agent">
            📋 Preview Context
          </button>
        </div>
      </div>
    `;

    // Section 2: Signature
    if (isSymbol) {
      const sigText = node.signature || `def ${node.label.replace('()', '')}()`;
      let paramRows = '';
      if (node.parameters && node.parameters.length > 0) {
        paramRows = node.parameters.map(p => `
          <tr>
            <td><code>${escapeHtml(p.name)}</code></td>
            <td><code>${escapeHtml(p.type || 'Not available')}</code>${p.isInferred ? '<span class="inferred-tag">(inferred)</span>' : ''}</td>
          </tr>
        `).join('');
      } else {
        paramRows = '<tr><td colspan="2" style="color: var(--text-muted);">None</td></tr>';
      }

      content += `
        <div class="drawer-section">
          <div class="drawer-section-label">2. Signature</div>
          <div class="signature-block">${escapeHtml(sigText)}</div>
          <div style="font-size: 10px; color: var(--text-muted); margin-top: 4px;">PARAMETERS:</div>
          <table class="param-table">
            <thead><tr><th>Name</th><th>Type</th></tr></thead>
            <tbody>${paramRows}</tbody>
          </table>
          <div class="drawer-fact-row" style="margin-top: 4px;">
            <span class="drawer-fact-key">Return Type:</span>
            <span class="drawer-fact-value"><code>${escapeHtml(node.returnType || 'Not available')}</code>${node.returnTypeInferred ? '<span class="inferred-tag">(inferred)</span>' : ''}</span>
          </div>
        </div>
      `;
    }

    // Section 3: Documentation
    content += `
      <div class="drawer-section">
        <div class="drawer-section-label">3. Documentation</div>
        <div class="drawer-sub" style="font-family: var(--font-mono); white-space: pre-wrap; color: #cbd5e1;">${escapeHtml(node.documentation || 'No documentation available')}</div>
      </div>
    `;

    // Section 4: Structural Metrics
    content += `
      <div class="drawer-section">
        <div class="drawer-section-label">4. Structural Metrics</div>
        <div class="drawer-fact-row"><span class="drawer-fact-key">Lines of Code (LOC):</span> <span class="drawer-fact-value">${node.loc || 'Not available'}</span></div>
        <div class="drawer-fact-row"><span class="drawer-fact-key">Cyclomatic Complexity:</span> <span class="drawer-fact-value">${node.complexity || '1'}</span></div>
        <div class="drawer-fact-row"><span class="drawer-fact-key">Number of Branches:</span> <span class="drawer-fact-value">${node.branches || '0'}</span></div>
        <div class="drawer-fact-row"><span class="drawer-fact-key">Number of Parameters:</span> <span class="drawer-fact-value">${node.parameterCount || (node.parameters ? node.parameters.length : 0)}</span></div>
        <div class="drawer-fact-row"><span class="drawer-fact-key">Direct Callees:</span> <span class="drawer-fact-value">${node.callees ? node.callees.length : 0}</span></div>
        <div class="drawer-fact-row"><span class="drawer-fact-key">Direct Callers:</span> <span class="drawer-fact-value">${node.callers ? node.callers.length : 0}</span></div>
      </div>
    `;

    // Section 5: Calls (Direct Callees)
    if (isSymbol) {
      let calleesContent = '<div class="drawer-sub">No direct callees inside this symbol</div>';
      if (node.callees && node.callees.length > 0) {
        calleesContent = '<div class="drawer-item-list">' + node.callees.map(c => `
          <button class="drawer-item-pill graph-focus-btn" data-target="${escapeHtml(c.id)}" title="Focus ${c.name}() on graph">
            ➔ ${escapeHtml(c.name)}()
          </button>
        `).join('') + '</div>';
      }

      content += `
        <div class="drawer-section">
          <div class="drawer-section-label">5. Calls (Direct Callees)</div>
          ${calleesContent}
        </div>
      `;
    }

    // Section 6: Called By (Direct Callers)
    if (isSymbol) {
      let callersContent = '<div class="drawer-sub">No direct callers detected</div>';
      if (node.callers && node.callers.length > 0) {
        callersContent = '<div class="drawer-item-list">' + node.callers.map(c => `
          <button class="drawer-item-pill graph-focus-btn" data-target="${escapeHtml(c.id)}" title="Focus ${c.name}() on graph">
            ⬅ ${escapeHtml(c.name)}()
          </button>
        `).join('') + '</div>';
      }

      content += `
        <div class="drawer-section">
          <div class="drawer-section-label">6. Called By (Direct Callers)</div>
          ${callersContent}
        </div>
      `;
    }

    // Section 7: Dependencies / Contained Symbols
    if (node.type === 'file') {
      let symList = '<div class="drawer-sub">No symbols declared</div>';
      if (node.containedSymbols && node.containedSymbols.length > 0) {
        symList = '<div class="drawer-item-list">' + node.containedSymbols.map(s => `
          <button class="drawer-item-pill graph-focus-btn" data-target="${escapeHtml(s.id)}" title="Focus ${s.name}() on graph">
            ƒ ${escapeHtml(s.name)}()
          </button>
        `).join('') + '</div>';
      }
      content += `
        <div class="drawer-section">
          <div class="drawer-section-label">7. Contained Symbols (${node.symbolsCount || 0})</div>
          ${symList}
        </div>
      `;
    }

    // Section 8: Related Tests
    let testsContent = '<div class="drawer-sub">No related tests detected.</div>';
    if (node.relatedTests && node.relatedTests.length > 0) {
      testsContent = '<div class="drawer-item-list">' + node.relatedTests.map(t => `
        <button class="drawer-item-pill graph-focus-btn" data-target="${escapeHtml(t.id)}" title="Focus test file on graph">
          ✓ ${escapeHtml(t.name)}
        </button>
      `).join('') + '</div>';
    }

    content += `
      <div class="drawer-section">
        <div class="drawer-section-label">8. Related Tests</div>
        ${testsContent}
      </div>
    `;

    // Section 9: Current Task Relevance & Why is this node relevant?
    const relevance = node.taskRelevance || { isRelevant: false, reasons: ['Workspace component'] };
    const reasonsHtml = relevance.reasons.map(r => `<li>• ${escapeHtml(r)}</li>`).join('');

    content += `
      <div class="drawer-section">
        <div class="drawer-section-label">9. Current Task Relevance</div>
        <div class="drawer-fact-row">
          <span class="drawer-fact-key">Status:</span>
          <span class="drawer-fact-value" style="color: ${relevance.isRelevant ? '#34d399' : '#94a3b8'}; font-weight: 700;">
            ${relevance.isRelevant ? '✓ Relevant to Current Task' : 'Standard Workspace Module'}
          </span>
        </div>
        <div style="font-size: 10px; color: var(--text-muted); margin-top: 4px; font-weight: 700;">WHY THIS NODE IS RELEVANT:</div>
        <ul style="padding-left: 0; list-style: none; font-size: 11px; color: #cbd5e1; margin-top: 4px; display: flex; flex-direction: column; gap: 4px;">
          ${reasonsHtml}
        </ul>
      </div>
    `;

    // Section 10: KAIZEN Context Preview (Collapsible)
    const contextPreviewData = {
      target: node.label,
      type: node.type,
      file: filePath,
      lineRange: lineStr,
      metrics: { loc: node.loc, complexity: node.complexity },
      callers: (node.callers || []).map(c => c.name),
      callees: (node.callees || []).map(c => c.name),
      relatedTests: (node.relatedTests || []).map(t => t.name),
      taskRelevance: relevance.reasons
    };

    content += `
      <div class="drawer-section" id="section-kaizen-context">
        <div class="drawer-section-label">10. KAIZEN Context Preview</div>
        <div class="context-preview-box">${escapeHtml(JSON.stringify(contextPreviewData, null, 2))}</div>
      </div>
    `;

    if (body) body.innerHTML = content;

    // Attach Action Listeners in Drawer
    const btnOpenInEditor = document.getElementById('btn-open-in-editor');
    if (btnOpenInEditor) {
      btnOpenInEditor.addEventListener('click', () => {
        if (filePath) {
          switchCenterView('editor');
          openFileInEditor(filePath, node.startLine);
        }
      });
    }

    const btnShowImpact = document.getElementById('btn-show-impact');
    if (btnShowImpact) {
      btnShowImpact.addEventListener('click', async () => {
        try {
          const res = await fetch(`/api/graphify/impact?id=${encodeURIComponent(node.id)}`);
          const impactData = await res.json();
          alert(`DEPENDENCY IMPACT ANALYSIS\nTarget Node: ${impactData.nodeId}\n\nDirect Dependencies (${impactData.directDependenciesCount}):\n${impactData.dependencies.map(d => '  • ' + d.label + ' [' + d.type + ']').join('\n') || 'None'}\n\nDirect Dependents (${impactData.directDependentsCount}):\n${impactData.dependents.map(d => '  • ' + d.label + ' [' + d.type + ']').join('\n') || 'None'}`);
        } catch (e) {
          showToast('Error computing impact analysis', 'error');
        }
      });
    }

    const btnTracePath = document.getElementById('btn-trace-path');
    if (btnTracePath) {
      btnTracePath.addEventListener('click', async () => {
        const targetNodeId = prompt(`Enter target node ID or symbol name to trace path from '${node.label}':`);
        if (!targetNodeId) return;
        try {
          const res = await fetch(`/api/graphify/trace?sourceId=${encodeURIComponent(node.id)}&targetId=${encodeURIComponent(targetNodeId)}`);
          const traceData = await res.json();
          if (traceData.path && traceData.path.length > 0) {
            const chainStr = traceData.path.map((item, idx) => `${idx + 1}. ${item.label} (${item.type})`).join('\n   ↓\n');
            alert(`DEPENDENCY TRACE PATH:\n\n${chainStr}`);
          } else {
            alert("No dependency path found between nodes.");
          }
        } catch (e) {
          showToast('Error tracing path', 'error');
        }
      });
    }

    const btnPreviewContext = document.getElementById('btn-preview-context');
    if (btnPreviewContext) {
      btnPreviewContext.addEventListener('click', () => {
        const contextSec = document.getElementById('section-kaizen-context');
        if (contextSec) {
          contextSec.scrollIntoView({ behavior: 'smooth' });
        }
      });
    }

    // Attach Graph Node Focus Listeners on Pills
    document.querySelectorAll('.graph-focus-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const targetId = btn.dataset.target;
        if (targetId) {
          focusGraphNode(targetId);
        }
      });
    });
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Movable & Resizable Execution Console Terminal Engine
  function initMovableConsoleEngine() {
    const consoleEl = document.getElementById('code-output-console');
    const consoleHeader = document.getElementById('console-header');
    const consoleResizer = document.getElementById('console-resizer-top');
    const dockBtn = document.getElementById('dock-console-btn');
    const dockIcon = document.getElementById('dock-icon');
    const dockLabel = document.getElementById('dock-label');

    if (!consoleEl || !consoleHeader) return;

    let isMovable = false;
    let isDragging = false;
    let isResizing = false;
    let startX = 0, startY = 0;
    let initialLeft = 0, initialTop = 0;
    let initialHeight = 0;

    function toggleFloatMode(forceFloat = null) {
      isMovable = forceFloat !== null ? forceFloat : !isMovable;
      if (isMovable) {
        // Switch to Floating Movable Mode
        const rect = consoleEl.getBoundingClientRect();
        consoleEl.classList.add('movable');
        const defaultWidth = Math.max(rect.width, 580);
        const defaultHeight = Math.max(rect.height, 260);
        consoleEl.style.width = defaultWidth + 'px';
        consoleEl.style.height = defaultHeight + 'px';

        // Position fixed relative to viewport
        if (!consoleEl.style.top || consoleEl.style.top === 'auto' || consoleEl.style.top === '') {
          const topPos = Math.max(60, window.innerHeight - defaultHeight - 60);
          const leftPos = Math.max(20, (window.innerWidth - defaultWidth) / 2);
          consoleEl.style.top = topPos + 'px';
          consoleEl.style.left = leftPos + 'px';
        }
        if (dockIcon) dockIcon.textContent = '⚓';
        if (dockLabel) dockLabel.textContent = 'Dock';
        if (dockBtn) dockBtn.title = 'Dock console back to bottom of editor';
      } else {
        // Switch back to Docked Mode
        consoleEl.classList.remove('movable');
        consoleEl.style.position = '';
        consoleEl.style.left = '';
        consoleEl.style.top = '';
        consoleEl.style.width = '';
        consoleEl.style.height = '';
        if (dockIcon) dockIcon.textContent = '📌';
        if (dockLabel) dockLabel.textContent = 'Float';
        if (dockBtn) dockBtn.title = 'Float console terminal window';
      }
    }

    if (dockBtn) {
      dockBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleFloatMode();
      });
    }

    // Header Dragging Logic
    consoleHeader.addEventListener('mousedown', (e) => {
      // Don't trigger drag when clicking on action buttons/inputs
      if (e.target.closest('.console-window-actions') || e.target.closest('button') || e.target.closest('input')) {
        return;
      }

      // Automatically enable floating mode on first header drag if docked
      if (!isMovable) {
        toggleFloatMode(true);
      }

      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;

      const rect = consoleEl.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;

      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    // Top Border Resizing Logic (Works in both Docked and Floating mode!)
    if (consoleResizer) {
      consoleResizer.addEventListener('mousedown', (e) => {
        isResizing = true;
        startY = e.clientY;
        const rect = consoleEl.getBoundingClientRect();
        initialHeight = rect.height;
        initialTop = rect.top;

        document.body.style.userSelect = 'none';
        e.preventDefault();
        e.stopPropagation();
      });
    }

    // Global Mousemove & Mouseup handlers
    window.addEventListener('mousemove', (e) => {
      if (isDragging && isMovable) {
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;

        let newLeft = initialLeft + dx;
        let newTop = initialTop + dy;

        // Viewport boundary constraints
        const maxLeft = window.innerWidth - consoleEl.offsetWidth;
        const maxTop = window.innerHeight - 50;

        newLeft = Math.max(0, Math.min(newLeft, maxLeft));
        newTop = Math.max(0, Math.min(newTop, maxTop));

        consoleEl.style.left = newLeft + 'px';
        consoleEl.style.top = newTop + 'px';
      } else if (isResizing) {
        const dy = startY - e.clientY; // dragging upward increases height
        const newHeight = Math.max(120, Math.min(initialHeight + dy, window.innerHeight * 0.85));

        consoleEl.style.height = newHeight + 'px';
        if (isMovable) {
          const newTop = Math.max(0, initialTop - dy);
          consoleEl.style.top = Math.max(0, newTop) + 'px';
        }
      }
    });

    window.addEventListener('mouseup', () => {
      if (isDragging || isResizing) {
        isDragging = false;
        isResizing = false;
        document.body.style.userSelect = '';
      }
    });
  }

  // Init
  loadSandboxFiles();
  openFileInEditor('src/sandbox/main.ts');
  initStreamAndListeners();
  initMousePointerResizers();
  initMovableConsoleEngine();
});
