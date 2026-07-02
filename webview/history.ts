import type { MemoryEntry, SessionMeta } from '../src/types';
import { chatTitleEl, escapeHtml, historyList, memList, relativeTime, showView } from './dom';
import { post, S } from './state';

function groupOf(ts: number): string {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ts >= startOfToday) {
    return 'Today';
  }
  if (ts >= startOfToday - 86400000) {
    return 'Yesterday';
  }
  if (ts >= startOfToday - 6 * 86400000) {
    return 'Last 7 Days';
  }
  if (ts >= startOfToday - 29 * 86400000) {
    return 'Last 30 Days';
  }
  return 'Older';
}

function matchesFilter(s: SessionMeta): boolean {
  if (!S.historyFilter) {
    return true;
  }
  const haystack = `${s.title ?? ''} ${s.modelLabel ?? ''} ${s.machineName ?? ''} ${s.mode ?? ''}`.toLowerCase();
  return haystack.includes(S.historyFilter);
}

export function renderHistory(): void {
  historyList.innerHTML = '';
  if (S.sessions.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'nyx-empty';
    empty.innerHTML =
      '<div class="nyx-empty-title">No chats yet</div>' +
      '<div class="nyx-empty-sub">Start a conversation and it will show up here. Every chat is saved separately \u2014 switch between them anytime.</div>';
    historyList.appendChild(empty);
    return;
  }
  const visible = S.sessions.filter(matchesFilter);
  if (visible.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'nyx-empty';
    empty.innerHTML = `<div class="nyx-empty-sub">No chats match \u201c${escapeHtml(S.historyFilter)}\u201d.</div>`;
    historyList.appendChild(empty);
    return;
  }
  const order = ['Today', 'Yesterday', 'Last 7 Days', 'Last 30 Days', 'Older'];
  const grouped = new Map<string, SessionMeta[]>();
  for (const s of visible) {
    const key = groupOf(s.updatedAt);
    (grouped.get(key) ?? grouped.set(key, []).get(key)!).push(s);
  }
  for (const group of order) {
    const entries = grouped.get(group);
    if (!entries || entries.length === 0) {
      continue;
    }
    const header = document.createElement('div');
    header.className = 'nyx-hist-header';
    header.textContent = group;
    historyList.appendChild(header);
    for (const s of entries) {
      historyList.appendChild(renderHistoryEntry(s));
    }
  }
}

function renderHistoryEntry(s: SessionMeta): HTMLElement {
  const isActive = s.id === S.currentSessionId;
  const row = document.createElement('div');
  row.className = 'nyx-hist-entry' + (isActive ? ' active' : '');

  const icon = document.createElement('span');
  icon.className = 'nyx-hist-icon';
  icon.textContent = isActive ? '\u25CF' : '\u2713';
  icon.title = isActive ? 'Current chat' : '';

  const textWrap = document.createElement('div');
  textWrap.className = 'nyx-hist-text';

  const title = document.createElement('div');
  title.className = 'nyx-hist-title';
  title.textContent = s.title || 'Untitled';
  textWrap.appendChild(title);

  const sub = document.createElement('div');
  sub.className = 'nyx-hist-sub';

  const hasChanges = s.changedFiles > 0 || s.addedLines > 0 || s.removedLines > 0;
  if (hasChanges) {
    const stats = document.createElement('span');
    stats.className = 'nyx-hist-changes';
    if (s.addedLines > 0) {
      const add = document.createElement('span');
      add.className = 'nyx-stat-add';
      add.textContent = `+${s.addedLines}`;
      stats.appendChild(add);
    }
    if (s.removedLines > 0) {
      const del = document.createElement('span');
      del.className = 'nyx-stat-del';
      del.textContent = `\u2212${s.removedLines}`;
      stats.appendChild(del);
    }
    if (s.changedFiles > 0) {
      const files = document.createElement('span');
      files.className = 'nyx-stat-files';
      files.textContent = `${s.changedFiles} file${s.changedFiles === 1 ? '' : 's'}`;
      stats.appendChild(files);
    }
    sub.appendChild(stats);
  }

  if (s.modelLabel) {
    const model = document.createElement('span');
    model.className = 'nyx-hist-model';
    model.textContent = s.machineName ? `${s.modelLabel} · ${s.machineName}` : s.modelLabel;
    model.title = `Ran with ${s.modelLabel}${s.machineName ? ` on ${s.machineName}` : ''}`;
    sub.appendChild(model);
  }
  if (s.mode) {
    const tag = document.createElement('span');
    tag.className = `nyx-hist-mode ${s.mode}`;
    tag.textContent = s.mode === 'agent' ? 'Agent' : 'Chat';
    tag.title = s.mode === 'agent' ? 'Agent mode (used tools)' : 'Chat mode (no tools)';
    sub.appendChild(tag);
  }
  if (!hasChanges && !s.modelLabel) {
    const stat = document.createElement('span');
    stat.className = 'nyx-hist-stat';
    stat.textContent = relativeTime(s.updatedAt);
    sub.appendChild(stat);
  }
  textWrap.appendChild(sub);

  const del = document.createElement('button');
  del.className = 'nyx-hist-del';
  del.type = 'button';
  del.title = 'Delete';
  del.setAttribute('aria-label', 'Delete conversation');
  del.textContent = '\u2715';

  row.appendChild(icon);
  row.appendChild(textWrap);
  row.appendChild(del);
  row.title = s.modelLabel ? `${s.title}\n${s.modelLabel}${s.machineName ? ` · ${s.machineName}` : ''}` : s.title || '';

  row.addEventListener('click', () => {
    post({ type: 'loadSession', id: s.id });
    showView('chat');
  });
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    post({ type: 'deleteSession', id: s.id });
  });
  return row;
}

export function updateChatTitle(): void {
  const current = S.currentSessionId ? S.sessions.find((s) => s.id === S.currentSessionId) : undefined;
  const title = current?.title ?? '';
  chatTitleEl.textContent = title;
  chatTitleEl.title = title;
}

// ---- Memory view ----

export function renderMemory(): void {
  memList.innerHTML = '';
  if (S.memories.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'nyx-empty';
    empty.textContent = 'No memories yet. Nyx will remember key outcomes after each session.';
    memList.appendChild(empty);
    return;
  }
  for (const entry of S.memories) {
    memList.appendChild(renderMemoryEntry(entry));
  }
}

function renderMemoryEntry(entry: MemoryEntry): HTMLElement {
  const row = document.createElement('div');
  row.className = 'nyx-mem-entry';

  const head = document.createElement('div');
  head.className = 'nyx-mem-entry-head';
  const title = document.createElement('span');
  title.className = 'nyx-mem-entry-title';
  title.textContent = entry.title || 'Untitled';
  const badge = document.createElement('span');
  badge.className = `nyx-mem-badge ${entry.source}`;
  badge.textContent = entry.source === 'agent' ? 'saved' : 'auto';
  const del = document.createElement('button');
  del.className = 'nyx-mem-del';
  del.type = 'button';
  del.title = 'Delete memory';
  del.setAttribute('aria-label', 'Delete memory');
  del.innerHTML = '&#10005;';
  del.addEventListener('click', () => post({ type: 'deleteMemory', id: entry.id }));
  head.appendChild(title);
  head.appendChild(badge);
  head.appendChild(del);

  const summary = document.createElement('div');
  summary.className = 'nyx-mem-summary';
  summary.textContent = entry.summary;

  const meta = document.createElement('div');
  meta.className = 'nyx-mem-meta';
  meta.textContent = relativeTime(entry.updatedAt);

  row.appendChild(head);
  row.appendChild(summary);

  if (entry.files.length > 0) {
    const files = document.createElement('div');
    files.className = 'nyx-mem-files';
    for (const f of entry.files) {
      const chip = document.createElement('button');
      chip.className = 'nyx-mem-file';
      chip.type = 'button';
      chip.textContent = f;
      chip.title = 'Open file';
      chip.addEventListener('click', () => post({ type: 'openFile', path: f }));
      files.appendChild(chip);
    }
    row.appendChild(files);
  }

  row.appendChild(meta);
  return row;
}
