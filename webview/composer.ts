import type { AttachmentMeta, ChatMode, NetworkLogEntry } from '../src/types';
import {
  attachBtn,
  attachRow,
  contextEl,
  contextFill,
  contextLabel,
  dropOverlay,
  dropSub,
  escapeHtml,
  formatTokens,
  inputEl,
  mentionsEl,
  modeAgentBtn,
  modeChatBtn,
  privacyBtn,
  queueCaret,
  queueClear,
  queueCount,
  queueEl,
  queueList,
  queueRunBtn,
  queueToggle,
  scrollToBottom,
  sendBtn,
  showView,
} from './dom';
import { hasTranscript, renderEmptyState, setStatus } from './transcript';
import { persist, post, S } from './state';

let queueCollapsed = false;

// ---- Prompt history (shell-style arrow-up recall) ----

const HISTORY_CAP = 50;
let histIdx: number | null = null;
let draftBeforeNav = '';

function rememberPrompt(text: string): void {
  const history = S.promptHistory;
  if (history[history.length - 1] !== text) {
    history.push(text);
    if (history.length > HISTORY_CAP) {
      history.splice(0, history.length - HISTORY_CAP);
    }
  }
  histIdx = null;
  persist();
}

/** Returns true when the key was consumed by history navigation. */
function historyKeydown(e: KeyboardEvent): boolean {
  const history = S.promptHistory;
  if (history.length === 0) {
    return false;
  }
  const atStart = inputEl.selectionStart === 0 && inputEl.selectionEnd === 0;
  const atEnd = inputEl.selectionStart === inputEl.value.length;
  if (e.key === 'ArrowUp' && (inputEl.value === '' || atStart || histIdx !== null)) {
    if (histIdx === null) {
      draftBeforeNav = inputEl.value;
      histIdx = history.length;
    }
    if (histIdx > 0) {
      histIdx--;
      setComposerText(history[histIdx]);
    }
    return true;
  }
  if (e.key === 'ArrowDown' && histIdx !== null && atEnd) {
    histIdx++;
    if (histIdx >= history.length) {
      histIdx = null;
      setComposerText(draftBeforeNav);
    } else {
      setComposerText(history[histIdx]);
    }
    return true;
  }
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') {
    histIdx = null;
  }
  return false;
}

// ---- Sending ----

export function sendText(text: string): void {
  showView('chat');
  scrollToBottom(true);
  post({ type: 'sendMessage', text, modelKey: S.selectedKey ?? '', mode: S.mode });
}

export function submitInput(): void {
  const text = inputEl.value.trim();
  if (!text) {
    if (!S.busy && S.queue.length > 0) {
      // Empty send with a queue = run the next queued job.
      post({ type: 'sendMessage', text: '', modelKey: S.selectedKey ?? '', mode: S.mode });
    }
    return;
  }
  rememberPrompt(text);
  if (S.busy) {
    post({ type: 'queueAdd', text });
  } else {
    sendText(text);
  }
  inputEl.value = '';
  inputEl.style.height = 'auto';
  persist('');
}

export function setComposerText(text: string): void {
  inputEl.value = text;
  inputEl.style.height = 'auto';
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 180)}px`;
  inputEl.focus();
  inputEl.setSelectionRange(text.length, text.length);
}

export function setMode(next: ChatMode): void {
  S.mode = next;
  modeAgentBtn.setAttribute('aria-pressed', String(next === 'agent'));
  modeChatBtn.setAttribute('aria-pressed', String(next === 'chat'));
  persist(inputEl.value);
  if (!hasTranscript()) {
    renderEmptyState();
  }
}

export function setBusy(value: boolean): void {
  S.busy = value;
  sendBtn.textContent = S.busy ? 'Stop' : 'Send';
  sendBtn.classList.toggle('secondary', S.busy);
}

// ---- Queue (host-owned, #33) ----

export function renderQueue(): void {
  const queue = S.queue;
  queueEl.hidden = queue.length === 0;
  queueCount.textContent = `${queue.length} Queued`;
  queueCaret.innerHTML = queueCollapsed ? '&#9656;' : '&#9662;';
  queueList.hidden = queueCollapsed;
  queueList.innerHTML = '';
  queue.forEach((text, index) => {
    const row = document.createElement('div');
    row.className = 'nyx-queue-item';
    const label = document.createElement('span');
    label.className = 'nyx-queue-text';
    label.textContent = text;
    const actions = document.createElement('span');
    actions.className = 'nyx-queue-actions';
    const runNow = document.createElement('button');
    runNow.type = 'button';
    runNow.className = 'nyx-queue-send';
    runNow.title = 'Send now (interrupts the current run)';
    runNow.setAttribute('aria-label', 'Send now');
    runNow.innerHTML = '&#9654;';
    runNow.addEventListener('click', () => post({ type: 'queueRunNow', index }));
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.title = 'Edit';
    edit.setAttribute('aria-label', 'Edit');
    edit.innerHTML = '&#9998;';
    edit.addEventListener('click', () => {
      setComposerText(text);
      const next = queue.slice();
      next.splice(index, 1);
      post({ type: 'queueSet', items: next });
    });
    const up = document.createElement('button');
    up.type = 'button';
    up.title = 'Move up';
    up.setAttribute('aria-label', 'Move up');
    up.innerHTML = '&#8593;';
    up.disabled = index === 0;
    up.addEventListener('click', () => {
      const next = queue.slice();
      [next[index - 1], next[index]] = [next[index], next[index - 1]];
      post({ type: 'queueSet', items: next });
    });
    const del = document.createElement('button');
    del.type = 'button';
    del.title = 'Remove';
    del.setAttribute('aria-label', 'Remove');
    del.innerHTML = '&#128465;';
    del.addEventListener('click', () => {
      const next = queue.slice();
      next.splice(index, 1);
      post({ type: 'queueSet', items: next });
    });
    actions.appendChild(runNow);
    actions.appendChild(edit);
    actions.appendChild(up);
    actions.appendChild(del);
    row.appendChild(label);
    row.appendChild(actions);
    queueList.appendChild(row);
  });
}

// ---- Attachments ----

export function renderAttachments(items: AttachmentMeta[]): void {
  attachRow.innerHTML = '';
  attachRow.hidden = items.length === 0;
  for (const item of items) {
    const chip = document.createElement('span');
    chip.className = 'nyx-chip';
    const icon =
      item.kind === 'folder'
        ? '\u{1F4C1}'
        : item.kind === 'selection'
          ? '\u{1F4CC}'
          : item.kind === 'terminal'
            ? '\u2318'
            : item.kind === 'handoff'
              ? '\u{1F4E5}'
              : '\u{1F4C4}';
    const name = item.label ?? item.name;
    chip.innerHTML = `<span>${icon}</span><span class="nyx-chip-name">${escapeHtml(name)}</span><button type="button" class="nyx-chip-x" aria-label="Remove">\u2715</button>`;
    chip.querySelector('.nyx-chip-x')?.addEventListener('click', () => post({ type: 'removeAttachment', path: item.path }));
    attachRow.appendChild(chip);
  }
}

// ---- Context meter ----

export function renderContext(used: number, budget: number): void {
  if (budget <= 0) {
    contextEl.hidden = true;
    return;
  }
  const pct = Math.min(100, Math.round((used / budget) * 100));
  contextEl.hidden = false;
  contextFill.style.width = `${pct}%`;
  contextLabel.textContent = `${formatTokens(used)}/${formatTokens(budget)} \u00b7 ${pct}%`;
  contextEl.title = `Context usage: ${used.toLocaleString()} / ${budget.toLocaleString()} tokens (${pct}%) — click to compact now`;
  contextEl.classList.toggle('warn', pct >= 75 && pct < 90);
  contextEl.classList.toggle('high', pct >= 90);
}

// ---- Context breakdown popup ----

function closeContextPopup(): void {
  document.getElementById('nyx-ctx-popup')?.remove();
}

/** Shows what occupies the context window, with a compact-now action. */
export function showContextDetail(parts: Array<{ label: string; tokens: number }>, total: number, budget: number): void {
  closeContextPopup();
  const popup = document.createElement('div');
  popup.id = 'nyx-ctx-popup';
  popup.className = 'nyx-ctx-popup';
  popup.setAttribute('role', 'dialog');
  popup.setAttribute('aria-label', 'Context usage breakdown');

  const fmt = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const head = document.createElement('div');
  head.className = 'nyx-ctx-popup-head';
  head.textContent = `Context: ${fmt(total)} / ${fmt(budget)} tokens`;
  popup.appendChild(head);

  for (const part of parts) {
    const row = document.createElement('div');
    row.className = 'nyx-ctx-popup-row';
    const label = document.createElement('span');
    label.textContent = part.label;
    const value = document.createElement('span');
    value.className = 'nyx-ctx-popup-tokens';
    const pct = total > 0 ? Math.round((part.tokens / Math.max(total, 1)) * 100) : 0;
    value.textContent = `${fmt(part.tokens)} · ${pct}%`;
    row.appendChild(label);
    row.appendChild(value);
    popup.appendChild(row);
  }

  const actions = document.createElement('div');
  actions.className = 'nyx-ctx-popup-actions';
  const compactBtn = document.createElement('button');
  compactBtn.type = 'button';
  compactBtn.className = 'nyx-btn secondary';
  compactBtn.textContent = 'Compact now';
  compactBtn.addEventListener('click', () => {
    closeContextPopup();
    post({ type: 'compact' });
  });
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'nyx-btn secondary';
  closeBtn.textContent = 'Close';
  closeBtn.addEventListener('click', closeContextPopup);
  actions.appendChild(compactBtn);
  actions.appendChild(closeBtn);
  popup.appendChild(actions);

  (contextEl.parentElement ?? document.body).appendChild(popup);
}

// ---- Privacy report popup (per-session network log) ----

/** Closes the privacy popup (also on chat switch — the log is per session). */
export function closePrivacyPopup(): void {
  document.getElementById('nyx-privacy-popup')?.remove();
}

/** Lists every host the session contacted, so "no cloud calls" is checkable. */
export function showNetworkLog(entries: NetworkLogEntry[]): void {
  closePrivacyPopup();
  const popup = document.createElement('div');
  popup.id = 'nyx-privacy-popup';
  popup.className = 'nyx-ctx-popup';
  popup.setAttribute('role', 'dialog');
  popup.setAttribute('aria-label', 'Privacy report — contacted hosts');

  const head = document.createElement('div');
  head.className = 'nyx-ctx-popup-head';
  head.textContent = entries.length === 0 ? 'No network activity this session' : `Hosts contacted this session (${entries.length})`;
  popup.appendChild(head);

  for (const entry of entries.slice(0, 20)) {
    const row = document.createElement('div');
    row.className = 'nyx-ctx-popup-row';
    const label = document.createElement('span');
    label.textContent = entry.host;
    label.title = entry.purposes.join(', ');
    const value = document.createElement('span');
    value.className = 'nyx-ctx-popup-tokens';
    value.textContent = `${entry.purposes.join(', ')} · ${entry.count}×`;
    row.appendChild(label);
    row.appendChild(value);
    popup.appendChild(row);
  }

  const note = document.createElement('div');
  note.className = 'nyx-ctx-popup-row nyx-privacy-note';
  note.textContent =
    entries.length === 0
      ? 'Model calls, fetches, and downloads will appear here.'
      : 'Local/LAN hosts are your own machines; anything else was explicitly triggered (web search, URL fetch, downloads).';
  popup.appendChild(note);

  const actions = document.createElement('div');
  actions.className = 'nyx-ctx-popup-actions';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'nyx-btn secondary';
  closeBtn.textContent = 'Close';
  closeBtn.addEventListener('click', closePrivacyPopup);
  actions.appendChild(closeBtn);
  popup.appendChild(actions);

  (privacyBtn.parentElement ?? document.body).appendChild(popup);
}

// ---- @-mention autocomplete (#11) ----

let mentionToken = 0;
let mentionItems: string[] = [];
let mentionSelected = 0;
let mentionStart = -1;

function closeMentions(): void {
  mentionsEl.hidden = true;
  mentionItems = [];
  mentionStart = -1;
}

export function isMentionOpen(): boolean {
  return !mentionsEl.hidden;
}

function renderMentions(): void {
  mentionsEl.innerHTML = '';
  if (mentionItems.length === 0) {
    mentionsEl.hidden = true;
    return;
  }
  mentionsEl.hidden = false;
  mentionItems.forEach((file, i) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'nyx-mention-item' + (i === mentionSelected ? ' active' : '');
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(i === mentionSelected));
    const base = file.split('/').pop() ?? file;
    row.innerHTML = `<span class="nyx-mention-name">${escapeHtml(base)}</span><span class="nyx-mention-path">${escapeHtml(file)}</span>`;
    row.addEventListener('click', () => acceptMention(i));
    mentionsEl.appendChild(row);
  });
}

function acceptMention(index: number): void {
  const file = mentionItems[index];
  if (!file || mentionStart < 0) {
    return;
  }
  const caret = inputEl.selectionStart ?? inputEl.value.length;
  const before = inputEl.value.slice(0, mentionStart);
  const after = inputEl.value.slice(caret);
  inputEl.value = `${before}@${file} ${after}`;
  const pos = before.length + file.length + 2;
  inputEl.setSelectionRange(pos, pos);
  inputEl.focus();
  closeMentions();
}

function checkMention(): void {
  const caret = inputEl.selectionStart ?? inputEl.value.length;
  const before = inputEl.value.slice(0, caret);
  const match = before.match(/(?:^|\s)@([\w./\\-]*)$/);
  if (!match) {
    closeMentions();
    return;
  }
  mentionStart = caret - match[1].length - 1;
  const query = match[1];
  if (query.length < 1) {
    closeMentions();
    mentionStart = caret - 1; // keep position; wait for more chars
    return;
  }
  mentionToken++;
  post({ type: 'mentionQuery', token: String(mentionToken), query });
}

export function onMentionResults(token: string, files: string[]): void {
  if (token !== String(mentionToken)) {
    return;
  }
  mentionItems = files.slice(0, 8);
  mentionSelected = 0;
  renderMentions();
}

/** Handles composer keys; returns true when the key was consumed by the dropdown. */
function mentionKeydown(e: KeyboardEvent): boolean {
  if (mentionsEl.hidden) {
    return false;
  }
  if (e.key === 'ArrowDown') {
    mentionSelected = Math.min(mentionItems.length - 1, mentionSelected + 1);
    renderMentions();
    return true;
  }
  if (e.key === 'ArrowUp') {
    mentionSelected = Math.max(0, mentionSelected - 1);
    renderMentions();
    return true;
  }
  if (e.key === 'Enter' || e.key === 'Tab') {
    acceptMention(mentionSelected);
    return true;
  }
  if (e.key === 'Escape') {
    closeMentions();
    return true;
  }
  return false;
}

// ---- Drag & drop files/folders from the Explorer ----

let dragDepth = 0;
let dropHintTimer: ReturnType<typeof setTimeout> | undefined;

// VS Code / Cursor expose Explorer drags under several data-transfer types
// depending on version; accept all of them so a drop is recognised.
function isFileDrag(dt: DataTransfer | null): boolean {
  if (!dt) {
    return false;
  }
  return Array.from(dt.types).some((t) => {
    const type = t.toLowerCase();
    return (
      type === 'text/uri-list' ||
      type === 'files' ||
      type === 'resourceurls' ||
      type === 'codefiles' ||
      type.includes('uri-list') ||
      type.startsWith('application/vnd.code')
    );
  });
}

/** Turns a raw entry (URI or filesystem path) into a file:// URI string. */
function toUri(raw: unknown): string | undefined {
  const t = String(raw ?? '').trim();
  if (!t) {
    return undefined;
  }
  if (/^[a-zA-Z][\w+.-]*:\/\//.test(t)) {
    return t; // already a URI (file://, vscode-file://, …)
  }
  if (t.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(t)) {
    const norm = t.replace(/\\/g, '/').replace(/^([a-zA-Z]:)/, '/$1');
    return `file://${encodeURI(norm)}`;
  }
  return undefined;
}

function parseUriList(dt: DataTransfer | null): string[] {
  if (!dt) {
    return [];
  }
  const out: string[] = [];
  const add = (raw: unknown): void => {
    const uri = toUri(raw);
    if (uri) {
      out.push(uri);
    }
  };
  const consume = (raw: string): void => {
    const s = raw.trim();
    if (s.startsWith('[') || s.startsWith('{')) {
      try {
        const data = JSON.parse(s);
        for (const item of Array.isArray(data) ? data : [data]) {
          if (typeof item === 'string') {
            add(item);
          } else if (item && typeof item === 'object') {
            const rec = item as Record<string, unknown>;
            add(rec.resource ?? rec.uri ?? rec.path ?? rec.fsPath ?? rec.external);
          }
        }
        return;
      } catch {
        // Fall through to line parsing.
      }
    }
    for (const line of s.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        add(trimmed);
      }
    }
  };
  for (const type of ['text/uri-list', 'application/vnd.code.uri-list', 'resourceurls', 'CodeFiles', 'codefiles', 'text/plain']) {
    let raw = '';
    try {
      raw = dt.getData(type);
    } catch {
      raw = '';
    }
    if (raw) {
      consume(raw);
    }
    if (out.length > 0) {
      break;
    }
  }
  return Array.from(new Set(out));
}

const MAX_DROP_FILES = 10;
const MAX_DROP_BYTES = 25 * 1024 * 1024;

/** Sends OS-dropped files (bytes, no path available in the webview) to the host. */
async function attachDroppedFiles(files: File[]): Promise<void> {
  let skipped = 0;
  for (const file of files.slice(0, MAX_DROP_FILES)) {
    if (file.size > MAX_DROP_BYTES) {
      skipped++;
      continue;
    }
    const buf = await file.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(buf);
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    post({ type: 'attachFileData', name: file.name, dataBase64: btoa(binary) });
  }
  if (skipped > 0 || files.length > MAX_DROP_FILES) {
    setStatus(`Some dropped files were skipped (max ${MAX_DROP_FILES} files, 25 MB each).`);
  }
}

function showDropOverlay(sub?: string): void {
  if (dropHintTimer) {
    clearTimeout(dropHintTimer);
    dropHintTimer = undefined;
  }
  dropSub.innerHTML = sub ?? 'From the editor Explorer hold <b>Shift</b> · from Finder/OS just drop';
  dropOverlay.hidden = false;
}

function hideDropOverlay(): void {
  dragDepth = 0;
  dropOverlay.hidden = true;
}

// ---- Wiring ----

export function initComposer(): void {
  // Restore an unsent draft after a webview reload.
  if (S.savedDraft) {
    setComposerText(S.savedDraft);
  }

  modeAgentBtn.addEventListener('click', () => setMode('agent'));
  modeChatBtn.addEventListener('click', () => setMode('chat'));
  sendBtn.addEventListener('click', () => {
    if (S.busy) {
      S.userStopped = true;
      post({ type: 'cancel' });
    } else {
      submitInput();
    }
  });
  queueToggle.addEventListener('click', () => {
    queueCollapsed = !queueCollapsed;
    queueToggle.setAttribute('aria-expanded', String(!queueCollapsed));
    renderQueue();
  });
  queueClear.addEventListener('click', () => post({ type: 'queueSet', items: [] }));
  queueRunBtn.addEventListener('click', () => post({ type: 'queueRunAll' }));
  attachBtn.addEventListener('click', () => post({ type: 'attachPick' }));
  privacyBtn.addEventListener('click', () => {
    if (document.getElementById('nyx-privacy-popup')) {
      closePrivacyPopup();
    } else {
      post({ type: 'getNetworkLog' });
    }
  });
  contextEl.addEventListener('click', () => {
    if (document.getElementById('nyx-ctx-popup')) {
      closeContextPopup();
    } else {
      post({ type: 'getContextDetail' });
    }
  });

  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = `${Math.min(inputEl.scrollHeight, 180)}px`;
    persist(inputEl.value);
    checkMention();
  });
  inputEl.addEventListener('keydown', (e) => {
    if (mentionKeydown(e)) {
      e.preventDefault();
      return;
    }
    if (historyKeydown(e)) {
      e.preventDefault();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submitInput();
    }
  });

  // Paste an image straight from the clipboard (screenshot → Cmd+V).
  inputEl.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) {
      return;
    }
    for (const item of items) {
      if (!item.type.startsWith('image/')) {
        continue;
      }
      const file = item.getAsFile();
      if (!file) {
        continue;
      }
      e.preventDefault();
      const reader = new FileReader();
      reader.onload = () => {
        const url = String(reader.result ?? '');
        const base64 = url.slice(url.indexOf(',') + 1);
        if (base64) {
          post({ type: 'attachImage', dataBase64: base64, mime: item.type });
        }
      };
      reader.readAsDataURL(file);
      return;
    }
  });
  inputEl.addEventListener('blur', () => {
    // Delay so a click on a mention row still lands.
    setTimeout(closeMentions, 200);
  });

  window.addEventListener('dragenter', (e) => {
    if (!isFileDrag(e.dataTransfer)) {
      return;
    }
    e.preventDefault();
    dragDepth++;
    showDropOverlay();
  });
  window.addEventListener('dragover', (e) => {
    if (!isFileDrag(e.dataTransfer)) {
      return;
    }
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'copy';
    }
  });
  window.addEventListener('dragleave', (e) => {
    if (!isFileDrag(e.dataTransfer)) {
      return;
    }
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      dropOverlay.hidden = true;
    }
  });
  window.addEventListener('drop', (e) => {
    if (!isFileDrag(e.dataTransfer)) {
      return;
    }
    e.preventDefault();
    const uris = parseUriList(e.dataTransfer);
    if (uris.length > 0) {
      hideDropOverlay();
      post({ type: 'attachDropped', uris });
      showView('chat');
      return;
    }
    // OS drops (Finder/Explorer of the operating system) expose no paths in the
    // sandboxed webview — but they carry the bytes. Ship those to the host.
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length > 0) {
      hideDropOverlay();
      void attachDroppedFiles(files);
      showView('chat');
      return;
    }
    // A file drag with no readable path. This happens when VS Code/Cursor keeps
    // the drop internal (open the file) instead of handing it to the panel.
    showDropOverlay(
      'Couldn’t read the path. Right-click the file in the Explorer → <b>Add to Nyx context</b>, or use the &#128206; button.',
    );
    dropHintTimer = setTimeout(hideDropOverlay, 4200);
  });
}
