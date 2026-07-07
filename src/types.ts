export type ChatMode = 'agent' | 'chat';
export type Provider = 'ollama' | 'lmstudio' | 'custom';

/** The connection kind of a machine (how models are discovered/called). */
export type MachineType = 'ollama' | 'lmstudio' | 'openai';

/** Per-model preferences within a machine. */
export interface MachineModelPref {
  id: string;
  enabled: boolean;
  alias?: string;
}

/** A labeled endpoint on the (local) network that serves models. */
export interface Machine {
  id: string;
  /** Display name, e.g. "2x DGX Spark Cluster". */
  name: string;
  /** Optional hardware descriptor, e.g. "DGX Spark", "Mac Studio". */
  hardware?: string;
  type: MachineType;
  /** Host or base URL, e.g. "http://192.168.1.50:11434". */
  url: string;
  /**
   * Bearer token. Only present in memory — persisted in the editor's
   * SecretStorage, never written to settings.
   */
  apiKey?: string;
  /** UI flag: a key exists in SecretStorage (the key itself is never sent to the webview). */
  hasApiKey?: boolean;
  enabled: boolean;
  /** Default sampling temperature applied to all models on this machine. */
  temperature?: number;
  /** Default context length (best-effort; fully effective on Ollama). */
  numCtx?: number;
  models?: MachineModelPref[];
}

/** Capabilities a model advertises (via Ollama /api/show). */
export type ModelCapability = 'tools' | 'vision' | 'thinking' | 'completion' | 'insert' | 'embedding';

export interface ModelInfo {
  /** Model id sent to the API (e.g. "qwen2.5-coder:32b"). */
  id: string;
  /** Unique selection key: `${machineId}:${id}` — the same model id can exist on several machines. */
  key: string;
  /** Human-readable label shown in the picker. */
  label: string;
  provider: Provider;
  /** OpenAI-compatible base URL ending in /v1. */
  endpoint: string;
  apiKey?: string;
  temperature?: number;
  numCtx?: number;
  /** Model's advertised max context length (vLLM `max_model_len`, Ollama /api/show), if known. */
  contextLength?: number;
  /** Advertised capabilities (Ollama only); undefined = unknown. */
  capabilities?: ModelCapability[];
  machineId?: string;
  machineName?: string;
}

export interface ToolCallRef {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** OpenAI-style multimodal content parts (text + base64 image URLs). */
export interface ContentPartText {
  type: 'text';
  text: string;
}
export interface ContentPartImage {
  type: 'image_url';
  image_url: { url: string };
}
export type ContentPart = ContentPartText | ContentPartImage;
export type MessageContent = string | ContentPart[];

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: MessageContent;
  tool_calls?: ToolCallRef[];
  tool_call_id?: string;
  name?: string;
}

/** Plain-text view of a message's content (image parts become placeholders). */
export function messageText(content: MessageContent): string {
  if (typeof content === 'string') {
    return content;
  }
  return content.map((p) => (p.type === 'text' ? p.text : '[image]')).join('\n');
}

export interface ToolSchema {
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
}

/** How the user answers a clarifying question from the agent. */
export type QuestionType = 'single' | 'multiple' | 'text';

/** Compact summary of a file change, used to render diff cards. */
export interface DiffSummary {
  added: number;
  removed: number;
  /** Preview lines prefixed with '+', '-', ' ' (context) or '~' (note). */
  preview: string[];
}

/** A durable "key outcome" remembered across agent sessions (per project). */
export interface MemoryEntry {
  id: string;
  /** Session that produced this memory (auto memories only). */
  sessionId?: string;
  createdAt: number;
  updatedAt: number;
  title: string;
  summary: string;
  /** Files touched, for quick reference. */
  files: string[];
  /** 'auto' = distilled from a session, 'agent' = explicitly saved by the model. */
  source: 'auto' | 'agent';
}

/** A single rendered item in a conversation transcript. */
export type DisplayItem =
  | { kind: 'user'; text: string; checkpointId?: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; name: string; args: string; ok: boolean; content: string; filePath?: string; diff?: DiffSummary }
  | { kind: 'question'; question: string; qtype: QuestionType; options: string[]; answer: string };

/** Lightweight metadata used to render the session history list. */
export interface SessionMeta {
  id: string;
  title: string;
  updatedAt: number;
  addedLines: number;
  removedLines: number;
  changedFiles: number;
  /** Human-readable model/agent the chat ran with (e.g. "qwen2.5-coder:32b"). */
  modelLabel?: string;
  /** Machine that served the model (e.g. "Mac Studio"). */
  machineName?: string;
  /** Whether the chat ran in agent or plain chat mode. */
  mode?: ChatMode;
}

/** One entry of the agent's visible task plan. */
export interface PlanItem {
  text: string;
  status: 'pending' | 'active' | 'done';
}

/** A file, folder, editor selection, terminal capture, or imported handoff attached to enrich the next message. */
export interface AttachmentMeta {
  path: string;
  name: string;
  kind: 'file' | 'folder' | 'selection' | 'terminal' | 'handoff';
  /** Inline content (selection / terminal / handoff kinds). */
  content?: string;
  /** Human-readable label, e.g. "main.ts:12-40". */
  label?: string;
}

/** Messages sent from the webview UI to the extension host. */
export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'refreshModels' }
  | { type: 'sendMessage'; text: string; modelKey: string; mode: ChatMode }
  | { type: 'cancel' }
  | { type: 'newChat' }
  | { type: 'listSessions' }
  | { type: 'loadSession'; id: string }
  | { type: 'deleteSession'; id: string }
  /** Tab context menu "Close other chats" — deletes every session except keepId (host confirms). */
  | { type: 'deleteOtherSessions'; keepId: string }
  | { type: 'getMachines' }
  | { type: 'testMachine'; machine: Machine }
  | { type: 'saveMachine'; machine: Machine }
  | { type: 'deleteMachine'; id: string }
  | { type: 'attachPick' }
  // URIs dropped from the VS Code Explorer (text/uri-list) onto the chat.
  | { type: 'attachDropped'; uris: string[] }
  | { type: 'removeAttachment'; path: string }
  | { type: 'compact' }
  | { type: 'toolDecision'; id: string; approved: boolean; always?: boolean }
  | { type: 'questionResponse'; id: string; answer: string }
  | { type: 'listMemories' }
  | { type: 'deleteMemory'; id: string }
  | { type: 'clearMemories' }
  | { type: 'openFile'; path: string }
  // Host-owned job queue.
  | { type: 'queueAdd'; text: string }
  | { type: 'queueSet'; items: string[] }
  /** Runs a queued job immediately, interrupting the current run if one is active. */
  | { type: 'queueRunNow'; index: number }
  // Checkpoints / message editing.
  | { type: 'restoreCheckpoint'; checkpointId: string }
  | { type: 'retryLast' }
  | { type: 'continueRun' }
  // Long-running command control.
  | { type: 'killProcess'; id: string }
  // @-mention autocomplete.
  | { type: 'mentionQuery'; token: string; query: string }
  /** Changes the autonomy preset (safe | balanced | autopilot). */
  | { type: 'setAutonomy'; value: string }
  /** An image pasted from the clipboard into the composer. */
  | { type: 'attachImage'; dataBase64: string; mime: string }
  // Review-changes flow.
  | { type: 'getReview' }
  | { type: 'revertFile'; path: string }
  | { type: 'revertAll' }
  /** Stages the session's changed files and commits with a generated message. */
  | { type: 'commitChanges' }
  /** Runs the in-product benchmark against one model of a machine. */
  | { type: 'benchmarkModel'; machineId: string; modelId: string }
  /** Requests the context-usage breakdown for the popup. */
  | { type: 'getContextDetail' }
  /** Empty state asks the host to diagnose the first-run setup. */
  | { type: 'diagnoseSetup' }
  /** One-click first-run actions (pull a coder model / build the index). */
  | { type: 'setupAction'; action: 'pullCoder' | 'buildIndex' }
  /** Starts the batch run over all queued jobs (overnight mode). */
  | { type: 'queueRunAll' }
  /** Opens the native diff view: checkpoint original vs. current disk state. */
  | { type: 'openDiff'; path: string }
  /** Requests the per-session network log (privacy report). */
  | { type: 'getNetworkLog' }
  /** Applies the post-benchmark setup recommendation. */
  | { type: 'applyBenchSetup'; dailyKey?: string; utilityKey?: string; autocompleteModel?: string }
  /** The webview gained/lost keyboard focus (powers the focus-toggle command). */
  | { type: 'viewFocus'; focused: boolean };

/** Messages sent from the extension host to the webview UI. */
export type HostToWebview =
  | { type: 'models'; models: ModelInfo[]; selectedKey: string | undefined }
  /** The host accepted a user message and started the run (renders the bubble). */
  | { type: 'userMessage'; text: string; checkpointId?: string }
  | { type: 'assistantStart' }
  | { type: 'assistantDelta'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'assistantEnd' }
  /** Final cleaned assistant text (embedded tool-call JSON stripped) — replaces the streamed bubble. */
  | { type: 'assistantFinal'; text: string }
  | { type: 'toolCall'; id: string; name: string; args: string }
  | { type: 'toolProgress'; id: string; chunk: string }
  | { type: 'toolResult'; id: string; ok: boolean; content: string; filePath?: string; diff?: DiffSummary }
  | { type: 'approvalRequest'; id: string; name: string; args: string; diff?: DiffSummary; filePath?: string }
  | { type: 'questionRequest'; id: string; question: string; qtype: QuestionType; options: string[] }
  | { type: 'status'; text: string }
  | { type: 'error'; text: string; canRetry?: boolean }
  | { type: 'busy'; busy: boolean }
  | { type: 'cleared' }
  | { type: 'sessions'; sessions: SessionMeta[]; currentId: string | undefined }
  // `mode` lets the UI restore the Agent/Chat toggle when reopening a chat.
  | { type: 'sessionLoaded'; items: DisplayItem[]; mode?: ChatMode }
  | { type: 'machines'; machines: Machine[] }
  | { type: 'machineTestResult'; machineId: string; ok: boolean; models: string[]; contextLength?: number; error?: string }
  | { type: 'attachments'; items: AttachmentMeta[] }
  | { type: 'context'; usedTokens: number; budgetTokens: number }
  | { type: 'memories'; entries: MemoryEntry[] }
  | { type: 'stats'; tokensPerSecond?: number; completionTokens: number; estimated: boolean }
  | { type: 'queue'; items: string[] }
  | { type: 'stepLimit' }
  /** Prefills the composer (after a checkpoint restore / message edit). */
  | { type: 'composerSet'; text: string }
  | { type: 'mentionResults'; token: string; files: string[] }
  /** The agent's current task plan (empty array hides the card). */
  | { type: 'plan'; items: PlanItem[] }
  /** Host-side config the UI mirrors (autonomy preset, optional brand accent color). */
  | { type: 'config'; autonomy: string; accentColor?: string }
  /** All net file changes of this session vs. its checkpoints. */
  | { type: 'review'; files: ReviewFile[] }
  /** Stored benchmark scores per model key + optional just-finished/failed run. */
  | { type: 'benchmarks'; entries: Record<string, BenchmarkScores>; runningKey?: string; error?: string }
  /** Token breakdown for the context popup. */
  | { type: 'contextDetail'; parts: Array<{ label: string; tokens: number }>; total: number; budget: number }
  /** First-run diagnosis for the guided empty state. */
  | { type: 'setupStatus'; status: SetupStatus }
  /** Hosts contacted during this session (privacy report). */
  | { type: 'networkLog'; entries: NetworkLogEntry[] }
  /** Setup recommendation computed from stored benchmark scores. */
  | { type: 'benchSetup'; advice: BenchSetupAdvice };

/** Scores of the in-product model benchmark (percentages; fp lower = better). */
export interface BenchmarkScores {
  tool: number;
  edit: number;
  judge: number;
  fp: number;
  avgMs: number;
  at: number;
}

/** One changed file in the review view. */
export interface ReviewFile {
  path: string;
  /** File did not exist at session start (was created by the agent). */
  created: boolean;
  /** File existed but was deleted. */
  deleted: boolean;
  diff: DiffSummary;
}

/** First-run diagnosis rendered in the empty state when no models are found. */
export interface SetupStatus {
  ollamaUrl: string;
  ollamaReachable: boolean;
  /** At least one coder-ish chat model is available. */
  hasCoder: boolean;
  /** A semantic index exists for this workspace. */
  hasIndex: boolean;
  indexEnabled: boolean;
  /** Model id currently being pulled by the one-click install, if any. */
  pulling?: string;
}

/** One contacted host in the per-session privacy report. */
export interface NetworkLogEntry {
  host: string;
  purposes: string[];
  count: number;
}

/** Post-benchmark setup recommendation with one-click apply. */
export interface BenchSetupAdvice {
  daily?: { key: string; label: string };
  utility?: { key: string; label: string };
  autocomplete?: { model: string; label: string };
}
