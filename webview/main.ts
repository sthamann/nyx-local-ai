import type { HostToWebview, ModelInfo } from '../src/types';
import {
  autonomySelect,
  chatTitleEl,
  tabsToggleBtn,
  histBtn,
  histNewBtn,
  histSearch,
  historyView,
  machinesView,
  manageBtn,
  memBackBtn,
  memBtn,
  memClearBtn,
  memoryView,
  mmAddBtn,
  mmBackBtn,
  modelSelect,
  newBtn,
  refreshBtn,
  scrollToBottom,
  showView,
  speedEl,
} from './dom';
import { persist, post, S } from './state';
import {
  addApproval,
  addError,
  addStepLimit,
  appendToolProgress,
  applyToolResult,
  hasTranscript,
  onAssistantDelta,
  onAssistantEnd,
  onAssistantStart,
  onReasoning,
  onSetupStatus,
  registerToolCall,
  renderEmptyState,
  renderPlan,
  renderQuestion,
  renderTranscript,
  renderUser,
  replaceLastAssistant,
  setSpeed,
  setStatus,
  showWorking,
  hideWorking,
  toolDetail,
  TOOL_VERBS,
} from './transcript';
import {
  closePrivacyPopup,
  initComposer,
  onMentionResults,
  renderAttachments,
  renderContext,
  renderQueue,
  setBusy,
  setComposerText,
  setMode,
  showContextDetail,
  showNetworkLog,
} from './composer';
import { renderHistory, renderMemory, renderSessionTabs, updateChatTitle } from './history';
import { isEditing, onBenchmarks, onBenchSetup, onMachineTestResult, renderMachines, startAdd, stopEditing } from './machines';
import { initReview, renderReview, updateChangesChip } from './review';

/** Capability badges shown next to the model name in the picker (#19). */
function modelBadges(m: ModelInfo): string {
  if (!m.capabilities) {
    return '';
  }
  const parts: string[] = [];
  if (m.capabilities.includes('tools')) {
    parts.push('\u{1F527}');
  }
  if (m.capabilities.includes('vision')) {
    parts.push('\u{1F441}');
  }
  if (m.capabilities.includes('thinking')) {
    parts.push('\u{1F9E0}');
  }
  return parts.length > 0 ? ` ${parts.join('')}` : '';
}

function populateModels(): void {
  modelSelect.innerHTML = '';
  if (S.models.length === 0) {
    const opt = document.createElement('option');
    opt.textContent = 'No models — click ⚙ to add';
    opt.value = '';
    modelSelect.appendChild(opt);
    modelSelect.disabled = true;
    return;
  }
  modelSelect.disabled = false;
  const order: string[] = [];
  const groups = new Map<string, ModelInfo[]>();
  for (const m of S.models) {
    const key = m.machineName ?? m.provider;
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(m);
  }
  for (const key of order) {
    const group = document.createElement('optgroup');
    group.label = key;
    for (const m of groups.get(key)!) {
      const opt = document.createElement('option');
      opt.value = m.key;
      opt.textContent = `${m.label}${modelBadges(m)}`;
      if (m.key === S.selectedKey) {
        opt.selected = true;
      }
      group.appendChild(opt);
    }
    modelSelect.appendChild(group);
  }
}

// ---- Top bar & view switching ----

modelSelect.addEventListener('change', () => {
  S.selectedKey = modelSelect.value || undefined;
  persist();
});
autonomySelect.addEventListener('change', () => {
  post({ type: 'setAutonomy', value: autonomySelect.value });
});

function openHistory(): void {
  renderHistory();
  showView('history');
  histSearch.focus();
}
histBtn.addEventListener('click', () => (historyView.hidden ? openHistory() : showView('chat')));
histSearch.addEventListener('input', () => {
  S.historyFilter = histSearch.value.trim().toLowerCase();
  renderHistory();
});
histNewBtn.addEventListener('click', () => {
  S.historyFilter = '';
  histSearch.value = '';
  post({ type: 'newChat' });
  showView('chat');
});
memBtn.addEventListener('click', () => {
  if (memoryView.hidden) {
    post({ type: 'listMemories' });
    renderMemory();
    showView('memory');
  } else {
    showView('chat');
  }
});
memBackBtn.addEventListener('click', () => showView('chat'));
memClearBtn.addEventListener('click', () => {
  if (S.memories.length > 0) {
    post({ type: 'clearMemories' });
  }
});
newBtn.addEventListener('click', () => {
  post({ type: 'newChat' });
  showView('chat');
});
refreshBtn.addEventListener('click', () => post({ type: 'refreshModels' }));
tabsToggleBtn.addEventListener('click', () => {
  S.showSessionTabs = !S.showSessionTabs;
  persist();
  renderSessionTabs();
});
manageBtn.addEventListener('click', () => {
  post({ type: 'getMachines' });
  stopEditing();
  renderMachines();
  showView('machines');
});
mmBackBtn.addEventListener('click', () => {
  stopEditing();
  showView('chat');
});
mmAddBtn.addEventListener('click', () => startAdd());

initComposer();
initReview();

// ---- Host → webview dispatcher ----

window.addEventListener('message', (event: MessageEvent<HostToWebview>) => {
  const message = event.data;
  switch (message.type) {
    case 'models':
      S.models = message.models;
      if (message.selectedKey) {
        S.selectedKey = message.selectedKey;
      }
      populateModels();
      if (!hasTranscript()) {
        renderEmptyState();
      }
      persist();
      return;
    case 'userMessage':
      renderUser(message.text, message.checkpointId);
      scrollToBottom(true);
      return;
    case 'assistantStart':
      onAssistantStart();
      return;
    case 'stats':
      setSpeed(message.tokensPerSecond, message.estimated, message.completionTokens);
      return;
    case 'reasoning':
      onReasoning(message.text);
      return;
    case 'assistantDelta':
      onAssistantDelta(message.text);
      return;
    case 'assistantEnd':
      onAssistantEnd();
      return;
    case 'assistantFinal':
      replaceLastAssistant(message.text);
      return;
    case 'toolCall': {
      registerToolCall(message.id, message.name, message.args);
      const detail = toolDetail(message.name, message.args);
      showWorking(`${TOOL_VERBS[message.name] ?? message.name}${detail ? ` ${detail}` : ''}\u2026`);
      scrollToBottom();
      return;
    }
    case 'toolProgress':
      appendToolProgress(message.id, message.chunk);
      return;
    case 'toolResult':
      applyToolResult(message.id, message.ok, message.content, message.filePath, message.diff);
      if (S.busy) {
        showWorking('Working\u2026');
      }
      scrollToBottom();
      return;
    case 'approvalRequest':
      addApproval(message.id, message.name, message.args, message.diff, message.filePath);
      return;
    case 'questionRequest':
      renderQuestion(message.id, message.question, message.qtype, message.options);
      return;
    case 'status':
      setStatus(message.text);
      return;
    case 'error':
      addError(message.text, message.canRetry === true);
      return;
    case 'busy':
      setBusy(message.busy);
      if (message.busy) {
        showWorking();
      } else {
        hideWorking();
      }
      return;
    case 'cleared':
      renderTranscript([]);
      closePrivacyPopup();
      speedEl.hidden = true;
      chatTitleEl.textContent = '';
      chatTitleEl.title = '';
      return;
    case 'sessions':
      S.sessions = message.sessions;
      S.currentSessionId = message.currentId;
      updateChatTitle();
      renderSessionTabs();
      updateChangesChip();
      if (!historyView.hidden) {
        renderHistory();
      }
      return;
    case 'sessionLoaded':
      if (message.mode && message.mode !== S.mode) {
        setMode(message.mode);
      }
      renderTranscript(message.items);
      closePrivacyPopup();
      showView('chat');
      return;
    case 'machines':
      S.machines = message.machines;
      if (!machinesView.hidden && !isEditing()) {
        renderMachines();
      }
      return;
    case 'attachments':
      renderAttachments(message.items);
      return;
    case 'context':
      renderContext(message.usedTokens, message.budgetTokens);
      return;
    case 'memories':
      S.memories = message.entries;
      if (!memoryView.hidden) {
        renderMemory();
      }
      return;
    case 'machineTestResult':
      onMachineTestResult(message.machineId, message.ok, message.models, message.contextLength, message.error);
      return;
    case 'queue':
      S.queue = message.items;
      renderQueue();
      return;
    case 'stepLimit':
      addStepLimit();
      return;
    case 'composerSet':
      setComposerText(message.text);
      return;
    case 'mentionResults':
      onMentionResults(message.token, message.files);
      return;
    case 'plan':
      renderPlan(message.items);
      return;
    case 'config':
      autonomySelect.value = message.autonomy;
      S.version = message.version ?? S.version;
      if (message.accentColor) {
        document.documentElement.style.setProperty('--nyx-accent', message.accentColor);
      } else {
        document.documentElement.style.removeProperty('--nyx-accent');
      }
      return;
    case 'review':
      renderReview(message.files);
      return;
    case 'benchmarks':
      onBenchmarks(message.entries, message.runningKey, message.error);
      return;
    case 'contextDetail':
      showContextDetail(message.parts, message.total, message.budget);
      return;
    case 'setupStatus':
      onSetupStatus(message.status);
      return;
    case 'networkLog':
      showNetworkLog(message.entries);
      return;
    case 'benchSetup':
      onBenchSetup(message.advice);
      return;
    default: {
      const exhaustive: never = message;
      void exhaustive;
    }
  }
});

// Focus tracking powers the host's "Toggle Nyx Focus" command (editor ↔ Nyx).
window.addEventListener('focus', () => post({ type: 'viewFocus', focused: true }));
window.addEventListener('blur', () => post({ type: 'viewFocus', focused: false }));

setMode(S.mode);
renderEmptyState();
post({ type: 'ready' });
