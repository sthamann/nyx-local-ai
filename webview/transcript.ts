import type { DiffSummary, DisplayItem, PlanItem, QuestionType, SetupStatus } from '../src/types';
import { escapeHtml, messagesEl, planEl, scrollToBottom, speedEl } from './dom';
import { renderMarkdown, renderMarkdownFinal } from './markdown';
import { post, S } from './state';

let assistantEl: HTMLElement | null = null;
let assistantText = '';
const toolResultSetters = new Map<string, ToolResultSetter>();
const toolBodies = new Map<string, HTMLElement>();

let genStartAt = 0;
let genChars = 0;

// Live "thinking" (reasoning) block state for the current assistant turn.
let thinkBodyEl: HTMLElement | null = null;
let thinkSummaryEl: HTMLElement | null = null;
let thinkText = '';
let thinkStartAt = 0;
let thinkTimer: ReturnType<typeof setInterval> | undefined;

export function clearEmptyState(): void {
  messagesEl.querySelector('.nyx-empty')?.remove();
}

export function hasTranscript(): boolean {
  return messagesEl.querySelector('.nyx-msg, .nyx-tool, .nyx-error') !== null;
}

const EXAMPLE_PROMPTS = [
  'Explain what this project does',
  'Find and fix bugs in the current file',
  'Add a small feature and show me the diff',
  'Summarize https://example.com',
];

/** Last first-run diagnosis from the host, rendered into the empty state. */
let lastSetup: SetupStatus | undefined;

/** Stores the host's setup diagnosis and refreshes the guided empty state. */
export function onSetupStatus(status: SetupStatus): void {
  lastSetup = status;
  if (!hasTranscript()) {
    renderEmptyState();
  }
}

function setupRow(ok: boolean, text: string, action?: { label: string; onClick: () => void; disabled?: boolean }): HTMLElement {
  const row = document.createElement('div');
  row.className = 'nyx-setup-row';
  const icon = document.createElement('span');
  icon.textContent = ok ? '\u2713' : '\u25CB';
  icon.className = ok ? 'nyx-setup-ok' : 'nyx-setup-todo';
  const label = document.createElement('span');
  label.className = 'nyx-setup-text';
  label.textContent = text;
  row.appendChild(icon);
  row.appendChild(label);
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'nyx-btn secondary';
    btn.textContent = action.label;
    btn.disabled = action.disabled === true;
    btn.addEventListener('click', () => {
      btn.disabled = true;
      action.onClick();
    });
    row.appendChild(btn);
  }
  return row;
}

/** Guided first-run card: diagnoses the setup and offers one-click fixes. */
function buildSetupCard(): HTMLElement {
  const card = document.createElement('div');
  card.className = 'nyx-setup';
  const setup = lastSetup;
  if (!setup) {
    card.textContent = 'Checking your local setup…';
    post({ type: 'diagnoseSetup' });
    return card;
  }
  card.appendChild(
    setupRow(
      setup.ollamaReachable,
      setup.ollamaReachable ? `Ollama is running (${setup.ollamaUrl})` : `Ollama is not reachable at ${setup.ollamaUrl} — start it (\`ollama serve\`) or add a machine via ⚙`,
      setup.ollamaReachable ? undefined : { label: '\u21BB Check again', onClick: () => post({ type: 'diagnoseSetup' }) },
    ),
  );
  card.appendChild(
    setupRow(
      setup.hasCoder,
      setup.hasCoder
        ? 'A coding model is available'
        : setup.pulling
          ? `Downloading ${setup.pulling}… (one-time, a few GB)`
          : 'No coding model installed yet',
      setup.hasCoder || !setup.ollamaReachable
        ? undefined
        : { label: setup.pulling ? 'Downloading…' : 'Pull qwen2.5-coder:7b', onClick: () => post({ type: 'setupAction', action: 'pullCoder' }), disabled: Boolean(setup.pulling) },
    ),
  );
  if (setup.indexEnabled) {
    card.appendChild(
      setupRow(
        setup.hasIndex,
        setup.hasIndex ? 'Semantic code index is built' : 'Semantic code index not built yet',
        setup.hasIndex || !setup.ollamaReachable
          ? undefined
          : { label: 'Build index', onClick: () => post({ type: 'setupAction', action: 'buildIndex' }) },
      ),
    );
  }
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.className = 'nyx-btn secondary nyx-setup-refresh';
  refresh.textContent = '\u21BB Re-scan models';
  refresh.addEventListener('click', () => {
    post({ type: 'refreshModels' });
    post({ type: 'diagnoseSetup' });
  });
  card.appendChild(refresh);
  return card;
}

export function renderEmptyState(): void {
  messagesEl.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'nyx-empty';

  if (S.models.length === 0) {
    const title = document.createElement('div');
    title.className = 'nyx-empty-title';
    title.textContent = 'Let’s get Nyx running';
    const sub = document.createElement('div');
    sub.className = 'nyx-empty-sub';
    sub.textContent = 'Nyx runs entirely on your own hardware. Three quick checks:';
    wrap.appendChild(title);
    wrap.appendChild(sub);
    wrap.appendChild(buildSetupCard());
    messagesEl.appendChild(wrap);
    return;
  }

  const title = document.createElement('div');
  title.className = 'nyx-empty-title';
  title.textContent = 'Ask Nyx anything about your code';
  const sub = document.createElement('div');
  sub.className = 'nyx-empty-sub';
  sub.textContent =
    S.mode === 'agent'
      ? 'Agent mode can read, search, edit and run things in your workspace. Type @ to mention a file, paste a URL to include a page, or attach files with the 📎 clip.'
      : 'Chat mode replies without using tools. Switch to Agent to let Nyx work in your project.';
  wrap.appendChild(title);
  wrap.appendChild(sub);

  const examples = document.createElement('div');
  examples.className = 'nyx-examples';
  for (const text of EXAMPLE_PROMPTS) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'nyx-example';
    chip.textContent = text;
    chip.title = 'Use this prompt';
    chip.addEventListener('click', () => {
      const input = document.getElementById('nyx-input') as HTMLTextAreaElement;
      input.value = text;
      input.focus();
      input.dispatchEvent(new Event('input'));
    });
    examples.appendChild(chip);
  }
  wrap.appendChild(examples);

  // Models are there — still offer the semantic index when it hasn't been built.
  if (lastSetup === undefined) {
    post({ type: 'diagnoseSetup' });
  } else if (lastSetup.indexEnabled && !lastSetup.hasIndex) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'nyx-example nyx-setup-index';
    chip.textContent = '\u{1F9ED} Build the semantic code index (meaning-based search)';
    chip.addEventListener('click', () => {
      chip.disabled = true;
      post({ type: 'setupAction', action: 'buildIndex' });
    });
    examples.appendChild(chip);
  }
  messagesEl.appendChild(wrap);
}

function addBubble(role: 'user' | 'assistant'): HTMLElement {
  clearEmptyState();
  const wrap = document.createElement('div');
  wrap.className = `nyx-msg ${role}`;
  const label = document.createElement('div');
  label.className = 'nyx-role';
  label.textContent = role === 'user' ? 'You' : 'Nyx';
  const bubble = document.createElement('div');
  bubble.className = 'nyx-bubble';
  wrap.appendChild(label);
  wrap.appendChild(bubble);
  messagesEl.appendChild(wrap);
  return bubble;
}

export function renderUser(text: string, checkpointId?: string): void {
  const bubble = addBubble('user');
  bubble.style.whiteSpace = 'pre-wrap';
  bubble.textContent = text;
  if (checkpointId) {
    const wrap = bubble.parentElement as HTMLElement;
    const actions = document.createElement('div');
    actions.className = 'nyx-msg-actions';
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'nyx-msg-action';
    editBtn.textContent = '\u21A9 Edit & rerun';
    editBtn.title = 'Restore files to this point and edit the message';
    editBtn.addEventListener('click', () => post({ type: 'restoreCheckpoint', checkpointId }));
    actions.appendChild(editBtn);
    wrap.appendChild(actions);
  }
}

export function renderAssistant(text: string): void {
  const bubble = addBubble('assistant');
  renderMarkdownFinal(bubble, text);
}

/** Replaces the streamed assistant bubble content with the cleaned final text. */
export function replaceLastAssistant(text: string): void {
  const bubbles = messagesEl.querySelectorAll('.nyx-msg.assistant .nyx-bubble');
  const last = bubbles[bubbles.length - 1] as HTMLElement | undefined;
  if (!last) {
    if (text.trim()) {
      renderAssistant(text);
    }
    return;
  }
  if (text.trim()) {
    renderMarkdownFinal(last, text);
  } else {
    last.parentElement?.remove();
  }
}

const TOOL_ICONS: Record<string, string> = {
  read_file: '\u{1F4C4}',
  list_dir: '\u{1F4C1}',
  search_files: '\u{1F50D}',
  semantic_search: '\u{1F9ED}',
  find_files: '\u{1F50E}',
  file_outline: '\u{1F5C2}',
  find_symbol: '\u{1F3AF}',
  find_references: '\u{1F517}',
  format_file: '\u{1FA84}',
  http_request: '\u{1F4E1}',
  wait: '\u23F3',
  write_file: '\u270F\uFE0F',
  edit_file: '\u270F\uFE0F',
  delete_file: '\u{1F5D1}\uFE0F',
  rename_file: '\u{1F504}',
  get_diagnostics: '\u26A0\uFE0F',
  fetch_url: '\u{1F310}',
  web_search: '\u{1F50D}',
  run_command: '\u2318',
  run_script: '\u{1F9EA}',
  git_diff: '\u{1F500}',
  git_log: '\u{1F4DC}',
  check_process: '\u23F1',
  kill_process: '\u23F9',
  browser_navigate: '\u{1F310}',
  browser_snapshot: '\u{1F4F7}',
  browser_click: '\u{1F5B1}',
  browser_type: '\u2328',
  browser_screenshot: '\u{1F4F8}',
  browser_close: '\u274E',
  read_rule: '\u{1F4D0}',
  use_skill: '\u2728',
  recall_memory: '\u{1F9E0}',
  save_memory: '\u{1F4BE}',
  ask_user: '\u2753',
};

export const TOOL_VERBS: Record<string, string> = {
  read_file: 'Read',
  list_dir: 'Listed',
  search_files: 'Searched',
  semantic_search: 'Searched semantically',
  find_files: 'Searched files',
  file_outline: 'Outlined',
  find_symbol: 'Found symbol',
  find_references: 'Found references',
  format_file: 'Formatted',
  http_request: 'HTTP',
  wait: 'Waited',
  write_file: 'Created',
  edit_file: 'Edited',
  delete_file: 'Deleted',
  rename_file: 'Renamed',
  get_diagnostics: 'Checked lints',
  fetch_url: 'Fetched',
  web_search: 'Searched web',
  run_command: 'Ran',
  run_script: 'Ran script',
  git_diff: 'Read git diff',
  git_log: 'Read git log',
  check_process: 'Checked process',
  kill_process: 'Stopped process',
  browser_navigate: 'Browsed',
  browser_snapshot: 'Read page',
  browser_click: 'Clicked',
  browser_type: 'Typed',
  browser_screenshot: 'Screenshot',
  browser_close: 'Closed browser',
  read_rule: 'Read rule',
  use_skill: 'Used skill',
  recall_memory: 'Recalled memory',
  save_memory: 'Saved memory',
  ask_user: 'Asked',
};

export function summarizeArgs(name: string, rawArgs: string): string {
  try {
    const args = JSON.parse(rawArgs) as Record<string, unknown>;
    if (name === 'run_command') {
      return String(args.command ?? '');
    }
    if (name === 'search_files' || name === 'semantic_search' || name === 'find_files' || name === 'web_search' || name === 'recall_memory' || name === 'find_symbol') {
      return String(args.query ?? '');
    }
    if (name === 'find_references') {
      return String(args.symbol ?? '');
    }
    if (name === 'http_request') {
      return `${String(args.method ?? 'GET')} ${String(args.url ?? '')}`.slice(0, 80);
    }
    if (name === 'wait') {
      return `${String(args.seconds ?? '?')}s`;
    }
    if (name.startsWith('mcp_')) {
      const firstString = Object.values(args).find((v) => typeof v === 'string');
      return typeof firstString === 'string' ? firstString.slice(0, 80) : '';
    }
    if (name === 'fetch_url' || name === 'browser_navigate') {
      return String(args.url ?? '');
    }
    if (name === 'browser_click' || name === 'browser_type') {
      return `[${String(args.ref ?? '?')}]${args.text ? ` ${String(args.text).slice(0, 40)}` : ''}`;
    }
    if (name === 'run_script') {
      return String(args.language ?? '');
    }
    if (name === 'save_memory') {
      return String(args.title ?? '');
    }
    if (name === 'rename_file') {
      return `${String(args.from ?? '')} \u2192 ${String(args.to ?? '')}`;
    }
    if (name === 'check_process' || name === 'kill_process') {
      return String(args.id ?? '');
    }
    return String(args.path ?? args.name ?? '');
  } catch {
    return '';
  }
}

function prettyArgs(rawArgs: string): string {
  try {
    return JSON.stringify(JSON.parse(rawArgs), null, 2);
  } catch {
    return rawArgs;
  }
}

/** Tools whose argument is a workspace path — shown as a bare filename for brevity. */
const PATH_TOOLS = new Set(['read_file', 'write_file', 'edit_file', 'delete_file', 'list_dir', 'read_rule', 'get_diagnostics', 'file_outline', 'format_file']);

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || p;
}

/** A concise, human-readable detail for a tool's summary line (filename or short query). */
export function toolDetail(name: string, rawArgs: string): string {
  const detail = summarizeArgs(name, rawArgs);
  if (!detail) {
    return '';
  }
  return PATH_TOOLS.has(name) ? basename(detail) : detail;
}

function renderDiffPreview(body: HTMLElement, diff: DiffSummary): void {
  body.textContent = '';
  body.classList.add('nyx-diff');
  for (const line of diff.preview) {
    const row = document.createElement('div');
    const marker = line.charAt(0);
    row.className =
      marker === '+'
        ? 'nyx-diff-add'
        : marker === '-'
          ? 'nyx-diff-del'
          : marker === '~'
            ? 'nyx-diff-note'
            : 'nyx-diff-ctx';
    row.textContent = line;
    body.appendChild(row);
  }
}

type ToolResultSetter = (ok: boolean, content: string, filePath?: string, diff?: DiffSummary) => void;

export function createToolCard(name: string, args: string): { card: HTMLElement; setResult: ToolResultSetter; body: HTMLElement } {
  clearEmptyState();
  const card = document.createElement('details');
  card.className = 'nyx-tool';
  const icon = TOOL_ICONS[name] ?? (name.startsWith('mcp_') ? '\u{1F9E9}' : '\u{1F527}');
  const verb = TOOL_VERBS[name] ?? (name.startsWith('mcp_') ? name.replace(/^mcp_/, '').replace(/_/g, ' ') : name);
  card.innerHTML = `
    <summary>
      <span class="nyx-tool-icon">${icon}</span>
      <span class="nyx-tool-verb">${escapeHtml(verb)}</span>
      <span class="nyx-tool-arg" data-role="arg">${escapeHtml(toolDetail(name, args))}</span>
      <span class="nyx-tool-badge" data-role="badge" hidden></span>
      <span class="nyx-tool-spin" data-role="spin"></span>
    </summary>
    <pre class="nyx-tool-body">${escapeHtml(prettyArgs(args))}\n\n…running…</pre>`;
  messagesEl.appendChild(card);
  const body = card.querySelector('.nyx-tool-body') as HTMLElement;

  const setResult: ToolResultSetter = (ok, content, filePath, diff) => {
    card.classList.add(ok ? 'ok' : 'fail');
    const badge = card.querySelector('[data-role="badge"]') as HTMLElement | null;
    const argEl = card.querySelector('[data-role="arg"]') as HTMLElement | null;
    const spin = card.querySelector('[data-role="spin"]') as HTMLElement | null;
    if (spin) {
      spin.remove();
    }

    if (filePath && argEl) {
      card.classList.add('nyx-tool-file');
      argEl.textContent = basename(filePath);
      argEl.classList.add('nyx-file-link');
      argEl.setAttribute('role', 'button');
      argEl.title = `Open ${filePath}`;
      argEl.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        post({ type: 'openFile', path: filePath });
      });
    }
    if (diff && badge) {
      badge.hidden = false;
      badge.innerHTML = `<span class="nyx-badge-add">+${diff.added}</span> <span class="nyx-badge-del">\u2212${diff.removed}</span>`;
    }
    if (diff) {
      card.classList.add('has-diff');
      renderDiffPreview(body, diff);
      card.open = true;
    } else {
      body.textContent = content || (ok ? '(done)' : '(failed)');
      // Background command? Offer a kill button (id is in the result text).
      const bg = content.match(/process id: (bg\d+)/);
      if (bg) {
        const kill = document.createElement('button');
        kill.type = 'button';
        kill.className = 'nyx-btn secondary nyx-kill';
        kill.textContent = `Stop ${bg[1]}`;
        kill.addEventListener('click', () => {
          post({ type: 'killProcess', id: bg[1] });
          kill.disabled = true;
          kill.textContent = 'Stopped';
        });
        card.appendChild(kill);
        card.open = true;
      }
    }
  };
  return { card, setResult, body };
}

export function registerToolCall(id: string, name: string, args: string): void {
  const { setResult, body } = createToolCard(name, args);
  toolResultSetters.set(id, setResult);
  toolBodies.set(id, body);
  body.dataset.streamed = '';
}

/** Streams live command output into the running tool card (#13). */
export function appendToolProgress(id: string, chunk: string): void {
  const body = toolBodies.get(id);
  if (!body) {
    return;
  }
  if (body.dataset.streamed === '') {
    body.dataset.streamed = '1';
    body.textContent = '';
    const card = body.closest('details') as HTMLDetailsElement | null;
    if (card) {
      card.open = true;
    }
  }
  body.textContent = (body.textContent ?? '') + chunk;
  if (body.textContent.length > 20000) {
    body.textContent = body.textContent.slice(-20000);
  }
  scrollToBottom();
}

export function applyToolResult(id: string, ok: boolean, content: string, filePath?: string, diff?: DiffSummary): void {
  toolResultSetters.get(id)?.(ok, content, filePath, diff);
  toolBodies.delete(id);
}

// ---- Approvals (#8, #10, #31) ----

const DANGEROUS_COMMAND_RE =
  /\brm\s+(-[a-z]*[rf][a-z]*\s+)+|--force|\bsudo\b|\bmkfs|\bdd\s+if=|curl[^|]*\|\s*(ba)?sh|wget[^|]*\|\s*(ba)?sh|\bgit\s+push\s+.*--force|\bgit\s+reset\s+--hard|\bchmod\s+777|>\s*\/dev\/sd/i;

export function addApproval(id: string, name: string, args: string, diff?: DiffSummary, filePath?: string): void {
  clearEmptyState();
  clearStatus();
  const detail = summarizeArgs(name, args) || prettyArgs(args);
  const isCommand = name === 'run_command' || name === 'run_script';
  const title =
    name === 'run_command'
      ? 'Run this command?'
      : name === 'write_file' || name === 'edit_file'
        ? `Apply this change${filePath ? ` to ${basename(filePath)}` : ''}?`
        : `Allow "${name}"?`;
  const dangerous = isCommand && DANGEROUS_COMMAND_RE.test(detail);

  const card = document.createElement('div');
  card.className = 'nyx-approval' + (dangerous ? ' danger' : '');
  card.innerHTML = `
    <div class="nyx-approval-title">${escapeHtml(title)}</div>
    ${dangerous ? '<div class="nyx-approval-danger">\u26A0 This command looks destructive — review it carefully.</div>' : ''}
    <pre data-role="detail">${escapeHtml(detail)}</pre>
    <div class="nyx-approval-actions">
      <button class="nyx-btn" type="button" data-approve="yes">Approve</button>
      <button class="nyx-btn secondary" type="button" data-approve="always" title="Allow '${escapeHtml(name)}' without asking for the rest of this chat">Always allow</button>
      <button class="nyx-btn secondary" type="button" data-approve="no">Reject</button>
    </div>`;

  // Show the proposed diff instead of raw args for edits (#8).
  if (diff) {
    const pre = card.querySelector('[data-role="detail"]') as HTMLElement;
    const badge = `+${diff.added} \u2212${diff.removed}`;
    renderDiffPreview(pre, diff);
    const info = document.createElement('div');
    info.className = 'nyx-approval-stats';
    info.textContent = `${filePath ?? ''} ${badge}`.trim();
    if (filePath) {
      const openDiff = document.createElement('button');
      openDiff.type = 'button';
      openDiff.className = 'nyx-file-link nyx-open-diff';
      openDiff.textContent = 'Open diff';
      openDiff.title = 'Open the native diff view (session start ↔ current file)';
      openDiff.addEventListener('click', () => post({ type: 'openDiff', path: filePath }));
      info.appendChild(document.createTextNode(' '));
      info.appendChild(openDiff);
    }
    pre.before(info);
  }

  const finish = (approved: boolean, always: boolean): void => {
    post({ type: 'toolDecision', id, approved, always });
    card.innerHTML = `<div class="nyx-approval-title">${approved ? (always ? 'Approved (always for this chat).' : 'Approved.') : 'Rejected.'}</div>`;
  };
  card.querySelector('[data-approve="yes"]')?.addEventListener('click', () => finish(true, false));
  card.querySelector('[data-approve="always"]')?.addEventListener('click', () => finish(true, true));
  card.querySelector('[data-approve="no"]')?.addEventListener('click', () => finish(false, false));
  messagesEl.appendChild(card);
  const firstBtn = card.querySelector('[data-approve="yes"]') as HTMLButtonElement | null;
  firstBtn?.focus();
  scrollToBottom(true);
}

// ---- Questions ----

export function buildAnsweredQuestion(question: string, answer: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'nyx-question answered';
  const title = document.createElement('div');
  title.className = 'nyx-question-title';
  title.textContent = question;
  const ans = document.createElement('div');
  ans.className = 'nyx-question-answer';
  ans.textContent = answer || '(no answer)';
  card.appendChild(title);
  card.appendChild(ans);
  return card;
}

export function renderQuestion(id: string, question: string, qtype: QuestionType, options: string[]): void {
  clearEmptyState();
  clearStatus();

  const card = document.createElement('div');
  card.className = 'nyx-question';

  const title = document.createElement('div');
  title.className = 'nyx-question-title';
  title.textContent = question;
  card.appendChild(title);

  const form = document.createElement('form');
  form.className = 'nyx-question-form';
  const groupName = `q_${id}`;
  let getAnswer: () => string;

  if (qtype === 'text') {
    const ta = document.createElement('textarea');
    ta.className = 'nyx-question-text';
    ta.rows = 3;
    ta.placeholder = 'Type your answer…';
    ta.setAttribute('aria-label', question);
    form.appendChild(ta);
    getAnswer = () => ta.value.trim();
    setTimeout(() => ta.focus(), 0);
  } else {
    const list = document.createElement('div');
    list.className = 'nyx-question-options';
    list.setAttribute('role', 'group');
    list.setAttribute('aria-label', question);
    const inputs: HTMLInputElement[] = [];
    const inputType = qtype === 'multiple' ? 'checkbox' : 'radio';

    for (const opt of options) {
      const row = document.createElement('label');
      row.className = 'nyx-question-option';
      const input = document.createElement('input');
      input.type = inputType;
      input.name = groupName;
      input.value = opt;
      const span = document.createElement('span');
      span.textContent = opt;
      row.appendChild(input);
      row.appendChild(span);
      list.appendChild(row);
      inputs.push(input);
    }

    const otherRow = document.createElement('label');
    otherRow.className = 'nyx-question-option nyx-question-other';
    const otherToggle = document.createElement('input');
    otherToggle.type = inputType;
    otherToggle.name = groupName;
    const otherText = document.createElement('input');
    otherText.type = 'text';
    otherText.className = 'nyx-question-otherinput';
    otherText.placeholder = 'Other…';
    otherText.addEventListener('input', () => {
      otherToggle.checked = otherText.value.trim().length > 0;
    });
    otherRow.appendChild(otherToggle);
    otherRow.appendChild(otherText);
    list.appendChild(otherRow);
    form.appendChild(list);

    getAnswer = () => {
      const picks: string[] = [];
      for (const inp of inputs) {
        if (inp.checked) {
          picks.push(inp.value);
        }
      }
      if (otherToggle.checked && otherText.value.trim()) {
        picks.push(otherText.value.trim());
      }
      return picks.join(', ');
    };
  }

  const actions = document.createElement('div');
  actions.className = 'nyx-question-actions';
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'nyx-btn';
  submit.textContent = 'Submit';
  actions.appendChild(submit);
  form.appendChild(actions);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const answer = getAnswer();
    if (!answer) {
      return;
    }
    post({ type: 'questionResponse', id, answer });
    card.replaceWith(buildAnsweredQuestion(question, answer));
    scrollToBottom(true);
  });

  card.appendChild(form);
  messagesEl.appendChild(card);
  scrollToBottom(true);
}

// ---- Agent task plan (set_plan tool) ----

export function renderPlan(items: PlanItem[]): void {
  planEl.innerHTML = '';
  planEl.hidden = items.length === 0;
  if (items.length === 0) {
    return;
  }
  const done = items.filter((i) => i.status === 'done').length;
  const head = document.createElement('div');
  head.className = 'nyx-plan-head';
  head.textContent = `Plan · ${done}/${items.length}`;
  planEl.appendChild(head);
  for (const item of items) {
    const row = document.createElement('div');
    row.className = `nyx-plan-item ${item.status}`;
    const icon = document.createElement('span');
    icon.className = 'nyx-plan-icon';
    icon.textContent = item.status === 'done' ? '\u2713' : item.status === 'active' ? '\u25B8' : '\u25CB';
    const text = document.createElement('span');
    text.className = 'nyx-plan-text';
    text.textContent = item.text;
    row.appendChild(icon);
    row.appendChild(text);
    planEl.appendChild(row);
  }
}

// ---- Errors, step limit, working indicator ----

export function addError(text: string, canRetry = false): void {
  clearEmptyState();
  clearStatus();
  const el = document.createElement('div');
  el.className = 'nyx-error';
  el.textContent = text;
  if (canRetry) {
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'nyx-btn secondary nyx-retry';
    retry.textContent = '\u21BB Retry';
    retry.title = 'Restore the checkpoint and run the last message again';
    retry.addEventListener('click', () => {
      retry.disabled = true;
      post({ type: 'retryLast' });
    });
    el.appendChild(document.createElement('br'));
    el.appendChild(retry);
  }
  messagesEl.appendChild(el);
  scrollToBottom(true);
}

/** Renders the step-limit notice with a Continue button (#15). */
export function addStepLimit(): void {
  clearStatus();
  const el = document.createElement('div');
  el.className = 'nyx-steplimit';
  const label = document.createElement('span');
  label.textContent = 'Step limit reached.';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'nyx-btn';
  btn.textContent = 'Continue';
  btn.addEventListener('click', () => {
    btn.disabled = true;
    el.remove();
    post({ type: 'continueRun' });
  });
  el.appendChild(label);
  el.appendChild(btn);
  messagesEl.appendChild(el);
  scrollToBottom(true);
}

function ensureWorking(): HTMLElement {
  let el = document.getElementById('nyx-working');
  if (!el) {
    el = document.createElement('div');
    el.id = 'nyx-working';
    el.className = 'nyx-working';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.innerHTML =
      '<span class="nyx-working-dots" aria-hidden="true"><i></i><i></i><i></i></span>' +
      '<span class="nyx-working-label"></span>';
  }
  return el;
}

/** Shows a prominent "waiting for the agent" indicator, pinned to the bottom. */
export function showWorking(text = 'Nyx is working\u2026'): void {
  clearEmptyState();
  const el = ensureWorking();
  const label = el.querySelector('.nyx-working-label') as HTMLElement | null;
  if (label) {
    label.textContent = text;
  }
  messagesEl.appendChild(el);
  scrollToBottom();
}

export function hideWorking(): void {
  document.getElementById('nyx-working')?.remove();
}

export function setStatus(text: string): void {
  showWorking(text);
}

export function clearStatus(): void {
  hideWorking();
}

// ---- Speed / stats ----

function formatTok(n: number): string {
  if (!Number.isFinite(n) || n <= 0) {
    return '0';
  }
  if (n >= 1000) {
    return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  }
  return String(Math.round(n));
}

export function setSpeed(tokensPerSecond: number | undefined, estimated: boolean, tokens?: number): void {
  const hasSpeed = !!tokensPerSecond && tokensPerSecond > 0 && Number.isFinite(tokensPerSecond);
  const hasTokens = typeof tokens === 'number' && tokens > 0;
  if (!hasSpeed && !hasTokens) {
    return;
  }
  speedEl.hidden = false;
  const prefix = estimated ? '~' : '';
  const parts: string[] = [];
  if (hasTokens) {
    parts.push(`${prefix}${formatTok(tokens as number)} tok`);
  }
  if (hasSpeed) {
    parts.push(`${prefix}${(tokensPerSecond as number).toFixed(1)} tok/s`);
  }
  speedEl.textContent = parts.join(' \u00b7 ');
}

// ---- Reasoning / streaming ----

/** Streams reasoning ("thinking") text into a collapsible block above the answer. */
export function onReasoning(text: string): void {
  hideWorking();
  clearEmptyState();
  if (!thinkBodyEl) {
    const wrap = document.createElement('div');
    wrap.className = 'nyx-msg nyx-msg-think';
    const details = document.createElement('details');
    details.className = 'nyx-think';
    details.open = true;
    const summary = document.createElement('summary');
    summary.className = 'nyx-think-summary';
    summary.innerHTML =
      '<span class="nyx-think-dot"></span><span class="nyx-think-label">Thinking\u2026</span>';
    const body = document.createElement('div');
    body.className = 'nyx-think-body';
    details.appendChild(summary);
    details.appendChild(body);
    wrap.appendChild(details);
    messagesEl.appendChild(wrap);
    thinkBodyEl = body;
    thinkSummaryEl = summary.querySelector('.nyx-think-label') as HTMLElement;
    thinkText = '';
    thinkStartAt = Date.now();
    if (thinkTimer) {
      clearInterval(thinkTimer);
    }
    thinkTimer = setInterval(() => {
      if (thinkSummaryEl) {
        const secs = Math.round((Date.now() - thinkStartAt) / 1000);
        thinkSummaryEl.textContent = `Thinking\u2026 ${secs}s`;
      }
    }, 1000);
  }
  thinkText += text;
  thinkBodyEl.textContent = thinkText;
  scrollToBottom();
}

/** Collapses the current thinking block and stamps how long the model thought. */
export function finalizeThinking(): void {
  if (thinkTimer) {
    clearInterval(thinkTimer);
    thinkTimer = undefined;
  }
  if (!thinkBodyEl) {
    return;
  }
  const details = thinkBodyEl.closest('details') as HTMLDetailsElement | null;
  if (details) {
    details.open = false;
    details.classList.add('done');
  }
  if (thinkSummaryEl) {
    const secs = Math.max(1, Math.round((Date.now() - thinkStartAt) / 1000));
    thinkSummaryEl.textContent = `Thought for ${secs}s`;
  }
  thinkBodyEl = null;
  thinkSummaryEl = null;
  thinkText = '';
}

export function onAssistantStart(): void {
  showWorking('Generating\u2026');
  genStartAt = Date.now();
  genChars = 0;
  thinkBodyEl = null;
  thinkSummaryEl = null;
  thinkText = '';
}

// Streaming render throttle: parsing the *entire* accumulated markdown on every
// token is O(n²) and can freeze the webview on very long generations. We
// re-render at most every RENDER_INTERVAL_MS, and switch to cheap plain-text
// rendering beyond a size threshold (full markdown is restored at the end).
const RENDER_INTERVAL_MS = 120;
const PLAIN_TEXT_THRESHOLD = 60000;
let renderTimer: ReturnType<typeof setTimeout> | undefined;
let lastRenderAt = 0;

function renderStreamingBubble(): void {
  if (!assistantEl) {
    return;
  }
  lastRenderAt = Date.now();
  if (assistantText.length > PLAIN_TEXT_THRESHOLD) {
    // Tail view keeps the DOM small no matter how much the model rambles.
    assistantEl.textContent = `…\n${assistantText.slice(-PLAIN_TEXT_THRESHOLD)}`;
    assistantEl.style.whiteSpace = 'pre-wrap';
  } else {
    renderMarkdown(assistantEl, assistantText);
  }
  assistantEl.classList.add('nyx-cursor');
  scrollToBottom();
}

function scheduleStreamingRender(): void {
  if (renderTimer) {
    return;
  }
  const wait = Math.max(0, RENDER_INTERVAL_MS - (Date.now() - lastRenderAt));
  renderTimer = setTimeout(() => {
    renderTimer = undefined;
    renderStreamingBubble();
  }, wait);
}

export function onAssistantDelta(text: string): void {
  hideWorking();
  finalizeThinking();
  if (!assistantEl) {
    assistantEl = addBubble('assistant');
    assistantText = '';
  }
  genChars += text.length;
  if (genStartAt > 0) {
    const elapsed = (Date.now() - genStartAt) / 1000;
    if (elapsed > 0.4) {
      const estTokens = genChars / 4;
      setSpeed(estTokens / elapsed, true, estTokens);
    }
  }
  assistantText += text;
  scheduleStreamingRender();
}

export function onAssistantEnd(): void {
  finalizeThinking();
  if (renderTimer) {
    clearTimeout(renderTimer);
    renderTimer = undefined;
  }
  if (assistantEl) {
    if (assistantText.trim() === '') {
      assistantEl.parentElement?.remove();
    } else {
      assistantEl.classList.remove('nyx-cursor');
      assistantEl.style.whiteSpace = '';
      renderMarkdownFinal(assistantEl, assistantText);
    }
  }
  assistantEl = null;
  assistantText = '';
  if (S.busy) {
    showWorking('Working\u2026');
  }
}

export function renderTranscript(items: DisplayItem[]): void {
  messagesEl.innerHTML = '';
  toolResultSetters.clear();
  toolBodies.clear();
  assistantEl = null;
  assistantText = '';
  hideWorking();
  for (const item of items) {
    switch (item.kind) {
      case 'user':
        renderUser(item.text, item.checkpointId);
        break;
      case 'assistant':
        renderAssistant(item.text);
        break;
      case 'tool': {
        const { setResult } = createToolCard(item.name, item.args);
        setResult(item.ok, item.content, item.filePath, item.diff);
        break;
      }
      case 'question':
        messagesEl.appendChild(buildAnsweredQuestion(item.question, item.answer));
        break;
      default: {
        const exhaustive: never = item;
        void exhaustive;
      }
    }
  }
  if (items.length === 0) {
    renderEmptyState();
  }
  scrollToBottom(true);
}
