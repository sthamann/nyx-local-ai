const app = document.getElementById('app') as HTMLDivElement;
app.innerHTML = `
  <div class="nyx-topbar">
    <button id="nyx-hist" class="nyx-icon-btn" type="button" title="Chats \u2014 switch between conversations" aria-label="Chats">&#9776;</button>
    <button id="nyx-new" class="nyx-icon-btn nyx-new" type="button" title="Start a new chat">+ New</button>
    <span class="nyx-chat-title" id="nyx-chat-title" title=""></span>
    <button id="nyx-mem" class="nyx-icon-btn" type="button" title="Project memory" aria-label="Project memory">&#129504;</button>
    <button id="nyx-refresh" class="nyx-icon-btn" type="button" title="Refresh models" aria-label="Refresh models">&#8635;</button>
  </div>
  <div id="nyx-chat" class="nyx-view">
    <div class="nyx-subbar">
      <select class="nyx-select" id="nyx-model" aria-label="Active model" title="Active model — the local agent that answers"></select>
      <button id="nyx-manage" class="nyx-icon-btn" type="button" title="Manage models & machines" aria-label="Manage models">&#9881;</button>
      <div class="nyx-mode" role="group" aria-label="Mode">
        <button id="nyx-mode-agent" type="button" aria-pressed="true" title="Agent — can read, search, edit and run tools in your workspace">Agent</button>
        <button id="nyx-mode-chat" type="button" aria-pressed="false" title="Chat — a plain answer, no tools or file changes">Chat</button>
      </div>
    </div>
    <div class="nyx-messages" id="nyx-messages" role="log" aria-live="polite"></div>
    <div class="nyx-composer">
      <div class="nyx-queue" id="nyx-queue" hidden>
        <div class="nyx-queue-head">
          <button class="nyx-queue-toggle" id="nyx-queue-toggle" type="button" aria-expanded="true" title="Queued messages — run one after another">
            <span class="nyx-queue-caret" id="nyx-queue-caret">&#9662;</span>
            <span id="nyx-queue-count">0 Queued</span>
          </button>
          <button class="nyx-queue-clear" id="nyx-queue-clear" type="button" title="Clear queue" aria-label="Clear queue">&#128465;</button>
        </div>
        <div class="nyx-queue-list" id="nyx-queue-list"></div>
      </div>
      <div class="nyx-subbar">
        <button class="nyx-context" id="nyx-context" type="button" hidden title="Context usage — click to compact now">
          <span class="nyx-context-bar"><span class="nyx-context-fill" id="nyx-context-fill"></span></span>
          <span class="nyx-context-label" id="nyx-context-label"></span>
        </button>
        <span class="nyx-speed" id="nyx-speed" hidden title="Generation speed (tokens per second)"></span>
      </div>
      <div class="nyx-attachments" id="nyx-attachments"></div>
      <div class="nyx-input-wrap">
        <div class="nyx-mentions" id="nyx-mentions" hidden role="listbox" aria-label="File suggestions"></div>
        <textarea class="nyx-textarea" id="nyx-input" rows="1"
          placeholder="Ask Nyx to build or change something… (@ to mention a file)" aria-label="Message to the agent"></textarea>
      </div>
      <div class="nyx-composer-row">
        <button class="nyx-attach-btn" id="nyx-attach" type="button" title="Attach files or folders (or right-click a file in the Explorer → Add to Nyx context)" aria-label="Attach files">&#128206;</button>
        <span class="nyx-hint">Enter to send · Shift+Enter newline · @ mentions files</span>
        <button class="nyx-btn" id="nyx-send" type="button">Send</button>
      </div>
    </div>
  </div>
  <div id="nyx-history" class="nyx-view" hidden>
    <div class="nyx-agents-head">
      <div class="nyx-search-wrap">
        <span class="nyx-search-icon" aria-hidden="true">&#128269;</span>
        <input id="nyx-hist-search" class="nyx-search" type="text" placeholder="Search chats\u2026" aria-label="Search chats" autocomplete="off" spellcheck="false" />
      </div>
      <button id="nyx-hist-new" class="nyx-icon-btn nyx-new" type="button" title="Start a new chat">+ New</button>
    </div>
    <div class="nyx-history" id="nyx-history-list"></div>
  </div>
  <div id="nyx-memory" class="nyx-view" hidden>
    <div class="nyx-mm-head">
      <button id="nyx-mem-back" class="nyx-icon-btn" type="button">&#8249; Back</button>
      <span class="nyx-mem-title">Project memory</span>
      <span class="nyx-spacer"></span>
      <button id="nyx-mem-clear" class="nyx-icon-btn" type="button" title="Clear all memories">Clear all</button>
    </div>
    <div class="nyx-mem-list" id="nyx-mem-list"></div>
  </div>
  <div id="nyx-machines" class="nyx-view" hidden>
    <div class="nyx-mm-head">
      <button id="nyx-mm-back" class="nyx-icon-btn" type="button">&#8249; Back</button>
      <span class="nyx-spacer"></span>
      <button id="nyx-mm-add" class="nyx-icon-btn nyx-new" type="button">+ Add machine</button>
    </div>
    <div class="nyx-mm-body" id="nyx-mm-body"></div>
  </div>
  <div id="nyx-drop" class="nyx-drop-overlay" hidden>
    <div class="nyx-drop-card">
      <div class="nyx-drop-icon">&#128206;</div>
      <div class="nyx-drop-title" id="nyx-drop-title">Drop to attach</div>
      <div class="nyx-drop-sub" id="nyx-drop-sub">Hold <b>Shift</b> while dragging from the Explorer</div>
    </div>
  </div>
`;

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

export const chatView = el<HTMLDivElement>('nyx-chat');
export const historyView = el<HTMLDivElement>('nyx-history');
export const machinesView = el<HTMLDivElement>('nyx-machines');
export const memoryView = el<HTMLDivElement>('nyx-memory');
export const historyList = el<HTMLDivElement>('nyx-history-list');
export const histSearch = el<HTMLInputElement>('nyx-hist-search');
export const histNewBtn = el<HTMLButtonElement>('nyx-hist-new');
export const memList = el<HTMLDivElement>('nyx-mem-list');
export const mmBody = el<HTMLDivElement>('nyx-mm-body');
export const modelSelect = el<HTMLSelectElement>('nyx-model');
export const messagesEl = el<HTMLDivElement>('nyx-messages');
export const inputEl = el<HTMLTextAreaElement>('nyx-input');
export const sendBtn = el<HTMLButtonElement>('nyx-send');
export const attachBtn = el<HTMLButtonElement>('nyx-attach');
export const attachRow = el<HTMLDivElement>('nyx-attachments');
export const contextEl = el<HTMLButtonElement>('nyx-context');
export const contextFill = el<HTMLElement>('nyx-context-fill');
export const contextLabel = el<HTMLElement>('nyx-context-label');
export const speedEl = el<HTMLElement>('nyx-speed');
export const queueEl = el<HTMLDivElement>('nyx-queue');
export const queueToggle = el<HTMLButtonElement>('nyx-queue-toggle');
export const queueCaret = el<HTMLElement>('nyx-queue-caret');
export const queueCount = el<HTMLElement>('nyx-queue-count');
export const queueClear = el<HTMLButtonElement>('nyx-queue-clear');
export const queueList = el<HTMLDivElement>('nyx-queue-list');
export const modeAgentBtn = el<HTMLButtonElement>('nyx-mode-agent');
export const modeChatBtn = el<HTMLButtonElement>('nyx-mode-chat');
export const histBtn = el<HTMLButtonElement>('nyx-hist');
export const newBtn = el<HTMLButtonElement>('nyx-new');
export const chatTitleEl = el<HTMLElement>('nyx-chat-title');
export const memBtn = el<HTMLButtonElement>('nyx-mem');
export const memBackBtn = el<HTMLButtonElement>('nyx-mem-back');
export const memClearBtn = el<HTMLButtonElement>('nyx-mem-clear');
export const refreshBtn = el<HTMLButtonElement>('nyx-refresh');
export const manageBtn = el<HTMLButtonElement>('nyx-manage');
export const mmBackBtn = el<HTMLButtonElement>('nyx-mm-back');
export const mmAddBtn = el<HTMLButtonElement>('nyx-mm-add');
export const mentionsEl = el<HTMLDivElement>('nyx-mentions');
export const dropOverlay = el<HTMLDivElement>('nyx-drop');
export const dropSub = el<HTMLElement>('nyx-drop-sub');

export function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

export function isNearBottom(): boolean {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
}

export function scrollToBottom(force = false): void {
  if (force || isNearBottom()) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

export type ViewName = 'chat' | 'history' | 'machines' | 'memory';

export function showView(view: ViewName): void {
  chatView.hidden = view !== 'chat';
  historyView.hidden = view !== 'history';
  machinesView.hidden = view !== 'machines';
  memoryView.hidden = view !== 'memory';
}

export function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) {
    return 'just now';
  }
  if (min < 60) {
    return `${min}m ago`;
  }
  const hours = Math.floor(min / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return new Date(ts).toLocaleDateString();
}

export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) {
    return '0';
  }
  if (n >= 1000000) {
    const m = n / 1000000;
    return `${m >= 10 ? m.toFixed(0) : m.toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (n >= 1000) {
    return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  }
  return String(Math.round(n));
}
