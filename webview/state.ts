import type { ChatMode, Machine, MemoryEntry, ModelInfo, SessionMeta, WebviewToHost } from '../src/types';

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

export function post(message: WebviewToHost): void {
  vscode.postMessage(message);
}

interface PersistedState {
  selectedKey?: string;
  mode?: ChatMode;
  draft?: string;
  showSessionTabs?: boolean;
  promptHistory?: string[];
}

const saved = (vscode.getState() as PersistedState | undefined) ?? {};

/** Mutable UI state shared across webview modules. */
export const S = {
  models: [] as ModelInfo[],
  sessions: [] as SessionMeta[],
  machines: [] as Machine[],
  memories: [] as MemoryEntry[],
  currentSessionId: undefined as string | undefined,
  selectedKey: saved.selectedKey as string | undefined,
  mode: (saved.mode ?? 'agent') as ChatMode,
  busy: false,
  queue: [] as string[],
  userStopped: false,
  historyFilter: '',
  savedDraft: saved.draft ?? '',
  showSessionTabs: saved.showSessionTabs ?? true,
  promptHistory: saved.promptHistory ?? ([] as string[]),
  /** Extension version, delivered by the host with the config message (About popup). */
  version: undefined as string | undefined,
};

export function persist(draft?: string): void {
  const liveDraft = draft ?? (document.getElementById('nyx-input') as HTMLTextAreaElement | null)?.value ?? '';
  vscode.setState({
    selectedKey: S.selectedKey,
    mode: S.mode,
    draft: liveDraft,
    showSessionTabs: S.showSessionTabs,
    promptHistory: S.promptHistory,
  } satisfies PersistedState);
}
