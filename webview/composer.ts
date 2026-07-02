import type { AttachmentMeta, ChatMode } from '../src/types';
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
  queueCaret,
  queueClear,
  queueCount,
  queueEl,
  queueList,
  queueToggle,
  scrollToBottom,
  sendBtn,
  showView,
} from './dom';
import { hasTranscript, renderEmptyState } from './transcript';
import { persist, post, S } from './state';

let queueCollapsed = false;

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
    const icon = item.kind === 'folder' ? '\u{1F4C1}' : item.kind === 'selection' ? '\u{1F4CC}' : '\u{1F4C4}';
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

function showDropOverlay(sub?: string): void {
  if (dropHintTimer) {
    clearTimeout(dropHintTimer);
    dropHintTimer = undefined;
  }
  dropSub.innerHTML = sub ?? 'Hold <b>Shift</b> while dragging from the Explorer';
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
  attachBtn.addEventListener('click', () => post({ type: 'attachPick' }));
  contextEl.addEventListener('click', () => post({ type: 'compact' }));

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
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submitInput();
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
    // A file drag with no readable path. This happens when VS Code/Cursor keeps
    // the drop internal (open the file) instead of handing it to the panel.
    showDropOverlay(
      'Couldn’t read the path. Right-click the file in the Explorer → <b>Add to Nyx context</b>, or use the &#128206; button.',
    );
    dropHintTimer = setTimeout(hideDropOverlay, 4200);
  });
}
