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

  // 2. Open File in Editor
  async function openFileInEditor(relPath) {
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
      if (codeEditor) codeEditor.value = data.content;
      updateLineNumbers();
    } catch (err) {
      if (codeEditor) codeEditor.value = `// Error loading file: ${err}`;
      updateLineNumbers();
    }
  }

  // 3. Save File Content
  async function saveActiveFile() {
    if (!saveFileBtn || !codeEditor) return;
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

  function handleIncomingEvent(type, data) {
    if (!data) return;

    // Run ID guard to ignore stale events from old runs
    if (type === 'PIPELINE_START') {
      currentRunId = data.runId || `run_${Date.now()}`;
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
        if (data.agent === 'ReviewerAgent' && data.status === 'completed') {
          renderReviewerBadgeCard(data.result);
        }
        break;

      case 'HITL_REQUEST':
        renderHitlChoiceCard(data);
        break;

      case 'PIPELINE_COMPLETE':
        finalizeStepper(data);
        if (data.status === 'SUCCESS' || data.status === 'DEBUG_COMPLETE' || data.status === 'TESTS_PASSED') {
          renderCompletionCard(data);
          loadSandboxFiles();
          if (data.targetFiles && data.targetFiles[0]) {
            openFileInEditor(data.targetFiles[0]);
          }
        } else if (data.route === 'EXPLAIN_CODE' || data.status === 'EXPLAIN_COMPLETE' || data.explanation) {
          renderExplanationCard(data);
        } else if (data.status === 'FAILED' || data.status === 'ABORTED') {
          renderErrorCard(data.message || data.error || 'Pipeline execution ended with failures.');
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

  // 5. Update Agent Stepper Visuals
  function resetStepper() {
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

    let stepsHtml = '';
    if (data.plan && data.plan.length > 0) {
      stepsHtml = `<div class="plan-steps-list">` +
        data.plan.map((s, idx) => {
          const rawDesc = typeof s === 'string' ? s : (s.description || s.task || `Step ${s.id || idx + 1}`);
          const cleanDesc = rawDesc.replace(new RegExp(`^Step\\s*${s.id || idx + 1}[:\\s-]*`, 'i'), '').trim() || rawDesc;
          return `<div class="plan-step-row"><strong>Step ${s.id || idx + 1}:</strong> ${cleanDesc}</div>`;
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
    });

    rejectBtn.addEventListener('click', async () => {
      await sendHitlResponse('reject');
      card.innerHTML = `<div class="choice-card-header" style="color: var(--danger)">✖ Plan Rejected by Developer</div>`;
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
    card.className = 'gen-card';
    card.style.borderColor = 'var(--primary)';
    card.style.background = 'linear-gradient(180deg, rgba(99, 102, 241, 0.1), var(--bg-card))';
    
    const text = data.explanation || (data.state && data.state.extractedContext) || 'Architecture analysis completed.';
    
    card.innerHTML = `
      <div style="display: flex; align-items: center; gap: 8px; color: #a5b4fc; font-weight: 600; font-size: 13px;">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
        <span>Architecture Analysis & Code Explanation</span>
      </div>
      <div style="font-size: 12px; color: var(--text-main); line-height: 1.6; white-space: pre-wrap; font-family: var(--font-mono); background: #0f1017; padding: 10px; border-radius: 6px; border: 1px solid var(--border-color); max-height: 300px; overflow-y: auto;">
${escapeHtml(text)}
      </div>
    `;
    widgetsContainer.appendChild(card);
    card.scrollIntoView({ behavior: 'smooth' });
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
    userCard.className = 'gen-card';
    userCard.style.background = 'rgba(99, 102, 241, 0.1)';
    userCard.style.borderColor = 'var(--primary)';
    let imageHtml = activeImage ? `<div style="margin-top: 6px;"><img src="${activeImage}" style="height: 60px; border-radius: 4px; border: 1px solid var(--border-color);" /></div>` : '';
    userCard.innerHTML = `
      <div style="font-size: 11px; color: #a5b4fc; font-weight: 600;">USER PROMPT</div>
      <div style="font-size: 13px; color: var(--text-main); font-weight: 500;">${escapeHtml(query || 'Attached image query')}</div>
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
    card.className = 'gen-card';
    card.style.borderColor = 'var(--primary)';
    
    let rowsHtml = results.map(r => {
      const color = r.status === 'PASS' ? 'var(--success)' : (r.status === 'WARN' ? 'var(--warning)' : 'var(--danger)');
      return `<div style="display: flex; justify-content: space-between; font-size: 12px; padding: 4px 0; border-bottom: 1px solid var(--border-color);">
        <span>${escapeHtml(r.feature)}</span>
        <span style="color: ${color}; font-weight: 600;">${r.status}: ${escapeHtml(r.details)}</span>
      </div>`;
    }).join('');

    card.innerHTML = `
      <div style="font-weight: 600; font-size: 13px; color: #a5b4fc; margin-bottom: 8px;">📊 COMPREHENSIVE VERIFICATION REPORT</div>
      <div style="display: flex; flex-direction: column; gap: 4px;">${rowsHtml}</div>
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

  // Init
  loadSandboxFiles();
  openFileInEditor('src/sandbox/main.ts');
  initStreamAndListeners();
  initMousePointerResizers();
});
