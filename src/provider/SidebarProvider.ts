import * as vscode from 'vscode';
import * as os from 'node:os';
import { discoverModels, probeMachine } from '../models/discovery';
import { MachineStore } from '../models/machines';
import { AgentSession, generateSessionTitle } from '../agent/agent';
import { parameterBillions } from '../agent/toolSchemas';
import { runBenchmark } from '../eval/benchmark';
import { streamChat, stripSpecialTokens } from '../models/client';
import type { BenchmarkScores } from '../types';
import { CheckpointStore } from '../agent/checkpoints';
import { MemoryStore } from '../agent/memory';
import { ProcessManager } from '../agent/processes';
import { resolvePolicy } from '../agent/permissions';
import type { Autonomy } from '../agent/permissions';
import { buildRulesSection, loadRules } from '../context/rules';
import { buildSkillsSection, loadSkills } from '../context/skills';
import type { SkillMeta } from '../context/skills';
import { executeTool } from '../agent/tools';
import type { ToolContext, ToolProfile } from '../agent/tools';
import { buildAttachmentContext, buildMentionContext, buildUrlContext } from './context';
import { summarizeDiff } from '../agent/diff';
import { SessionStore } from './SessionStore';
import type { StoredSession } from './SessionStore';
import { loadMcpConfigs, McpManager } from '../mcp/client';
import { BrowserManager, cleanupBrowserShots } from '../agent/browser';
import { embedTexts, INCLUDE_GLOB, SemanticIndex } from '../context/semanticIndex';
import type { SemanticOptions } from '../context/semanticIndex';
import { resolveHelperUrl } from '../models/hosts';
import { extractUrls } from '../context/web';
import { mediaKind, pullModel } from '../context/media';
import type { MediaOptions } from '../context/media';
import { NetworkLog } from './networkLog';
import { computeBenchAdvice, routeByBenchmarks } from '../eval/routing';
import { captureActiveTerminal } from '../context/terminal';
import { buildRepoMap } from '../context/repoMap';
import { warmKeepAlive } from '../models/warm';
import type {
  AttachmentMeta,
  ChatMode,
  DiffSummary,
  DisplayItem,
  HostToWebview,
  ModelInfo,
  PlanItem,
  QuestionType,
  ReviewFile,
  WebviewToHost,
} from '../types';

const QUEUE_KEY = 'nyx.queue.v1';
/** URI scheme of the virtual documents serving checkpoint originals for vscode.diff. */
const ORIGINAL_SCHEME = 'nyx-original';

interface ApprovalDecision {
  approved: boolean;
  always: boolean;
}

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'nyx.chatView';
  /** View type of the optional editor-tab host ("Open Nyx in Editor Tab"). */
  public static readonly panelViewType = 'nyx.chatPanel';

  private view?: vscode.WebviewView;
  /** Editor-tab host; the same UI, broadcast alongside the sidebar view. */
  private panel?: vscode.WebviewPanel;
  /** Whether any Nyx webview currently holds keyboard focus (for the focus toggle). */
  private webviewFocused = false;
  private readonly session = new AgentSession();
  private readonly checkpoints = new CheckpointStore();
  private readonly processes = new ProcessManager();
  private readonly machines: MachineStore;
  private readonly sessions: SessionStore;
  private readonly mcp: McpManager;
  private readonly semanticIndex: SemanticIndex;
  private readonly browser: BrowserManager;
  private models: ModelInfo[] = [];
  private skillsCache: SkillMeta[] = [];
  private selectedKey: string | undefined;
  private abort?: AbortController;
  private readonly pendingApprovals = new Map<string, (decision: ApprovalDecision) => void>();
  private readonly pendingQuestions = new Map<string, (answer: string) => void>();
  /** Tools the user approved with "Always allow" for this chat session. */
  private readonly sessionAllow = new Set<string>();

  private currentSessionId: string | undefined;
  private currentDisplay: DisplayItem[] = [];
  private addedLines = 0;
  private removedLines = 0;
  private readonly changedFiles = new Set<string>();
  private attachments: AttachmentMeta[] = [];
  private currentTitle: string | undefined;
  private currentTitleAuto = false;
  private currentModelKey: string | undefined;
  private currentModelId: string | undefined;
  private currentModelLabel: string | undefined;
  private currentMachineName: string | undefined;
  private currentMode: ChatMode | undefined;
  private readonly memory: MemoryStore;

  private busy = false;
  private stopRequested = false;
  private lastUserText: string | undefined;
  private currentPlan: PlanItem[] = [];
  /** Active fix-until-green loop (started via "/grind <command>"). */
  private grind: { command: string; iteration: number; max: number } | undefined;
  /** Active batch run over the job queue (overnight mode) with per-job stats. */
  private batch:
    | {
        startedAt: number;
        verify: string;
        jobs: Array<{ text: string; startedAt: number; endedAt?: number; ok?: boolean; addedBefore: number; removedBefore: number }>;
      }
    | undefined;
  /** Per-session network log for the privacy report. */
  private readonly networkLog = new NetworkLog();
  /** Last file-backed editor, for the active-file auto-context (the webview steals focus). */
  private lastEditor: vscode.TextEditor | undefined;
  /** Model id currently downloading via the first-run one-click pull. */
  private pullingModel: string | undefined;
  /** Dedupe guard so the memory distillation runs once per new session state. */
  private lastMemoryCapture: string | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.memory = new MemoryStore(context.workspaceState);
    this.machines = new MachineStore(context.secrets);
    this.sessions = new SessionStore(context.storageUri ?? context.globalStorageUri, context.workspaceState);
    this.mcp = new McpManager((text) => console.log(`[nyx mcp] ${text}`));
    this.semanticIndex = new SemanticIndex(
      (context.storageUri ?? context.globalStorageUri).fsPath,
      () => this.workspaceRoot(),
    );
    this.browser = new BrowserManager(
      () => vscode.workspace.getConfiguration('nyx').get<string>('browserExecutable') || undefined,
    );
    void cleanupBrowserShots();
    this.watchForIndexUpdates();
    // Memory recall rides on the same local embedding host as the code index;
    // the store falls back to keyword ranking when the host is unavailable.
    this.memory.setEmbedder(async (inputs) => {
      const opts = this.semanticOptions();
      if (!opts) {
        throw new Error('semantic indexing is disabled');
      }
      return embedTexts(opts, inputs);
    });
    this.lastEditor = vscode.window.activeTextEditor?.document.uri.scheme === 'file' ? vscode.window.activeTextEditor : undefined;
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor && editor.document.uri.scheme === 'file') {
          this.lastEditor = editor;
        }
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('nyx.accentColor')) {
          this.postConfig();
        }
      }),
      // Serves checkpoint originals as virtual documents for the native diff view.
      vscode.workspace.registerTextDocumentContentProvider(ORIGINAL_SCHEME, {
        provideTextDocumentContent: async (uri) => {
          const key = decodeURIComponent(uri.query);
          const originals = this.checkpoints.originals();
          if (originals.has(key)) {
            return originals.get(key) ?? '';
          }
          // No snapshot recorded (yet) — mirror the disk state so the diff is empty.
          const root = this.workspaceRoot();
          const fileUri = key.startsWith('/') || !root ? vscode.Uri.file(key) : vscode.Uri.joinPath(root, key);
          try {
            return new TextDecoder().decode(await vscode.workspace.fs.readFile(fileUri));
          } catch {
            return '';
          }
        },
      }),
    );
  }

  dispose(): void {
    this.processes.killAll();
    this.mcp.disposeAll();
    void this.browser.dispose();
    this.indexWatcher?.dispose();
    if (this.indexDebounce) {
      clearTimeout(this.indexDebounce);
    }
  }

  private indexWatcher: vscode.FileSystemWatcher | undefined;
  private indexDebounce: ReturnType<typeof setTimeout> | undefined;

  /**
   * Live incremental indexing: once an index exists, file changes trigger a
   * debounced background update (hash-checked, so only changed files are
   * re-embedded). Without an existing index this stays completely idle.
   */
  private watchForIndexUpdates(): void {
    if (!this.workspaceRoot()) {
      return;
    }
    this.indexWatcher = vscode.workspace.createFileSystemWatcher(INCLUDE_GLOB);
    const schedule = (): void => {
      if (this.indexDebounce) {
        clearTimeout(this.indexDebounce);
      }
      this.indexDebounce = setTimeout(() => {
        void this.refreshIndexIfBuilt();
      }, 8000);
    };
    this.indexWatcher.onDidChange(schedule);
    this.indexWatcher.onDidCreate(schedule);
    this.indexWatcher.onDidDelete(schedule);
  }

  private async refreshIndexIfBuilt(): Promise<void> {
    const opts = this.semanticOptions();
    if (!opts || this.busy || !(await this.semanticIndex.hasIndex())) {
      return;
    }
    try {
      // Silent background update; only hash-changed files are re-embedded.
      await this.semanticIndex.ensureIndex({ ...opts, onStatus: undefined });
    } catch {
      // Embedding host offline etc. — the next explicit search will surface it.
    }
  }

  private semanticOptions(): SemanticOptions | undefined {
    const cfg = vscode.workspace.getConfiguration('nyx');
    if (!(cfg.get<boolean>('semanticIndexEnabled') ?? true) || !this.workspaceRoot()) {
      return undefined;
    }
    return {
      embeddingUrl: resolveHelperUrl('embeddingOllamaUrl'),
      embeddingModel: cfg.get<string>('embeddingModel') || 'nomic-embed-text',
      autoInstall: cfg.get<boolean>('autoInstallVisionModel') ?? true,
      maxFiles: cfg.get<number>('indexMaxFiles') ?? 2500,
      maxChunks: cfg.get<number>('indexMaxChunks') ?? 12000,
      onStatus: (t) => this.post({ type: 'status', text: t }),
    };
  }

  /** Builds/updates the semantic index (command + first-use path). */
  async buildSemanticIndex(force = false): Promise<void> {
    const opts = this.semanticOptions();
    if (!opts) {
      void vscode.window.showInformationMessage('Nyx: semantic indexing is disabled or no workspace is open.');
      return;
    }
    this.networkLog.record(opts.embeddingUrl, 'embeddings');
    try {
      const summary = await this.semanticIndex.ensureIndex(opts, force);
      this.post({ type: 'status', text: summary });
      void vscode.window.showInformationMessage(`Nyx: ${summary}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.post({ type: 'error', text: `Semantic index: ${msg}` });
    }
  }

  /** Reconnects MCP servers from Cursor's mcp.json files + nyx.mcpServers. */
  private async refreshMcp(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('nyx');
    if (!(cfg.get<boolean>('mcpEnabled') ?? true)) {
      this.mcp.disposeAll();
      return;
    }
    const configs = await loadMcpConfigs(this.workspaceRoot()?.fsPath, cfg.get<Record<string, unknown>>('mcpServers'));
    await this.mcp.refresh(configs);
    const tools = this.mcp.getTools();
    const errors = this.mcp.errors();
    if (tools.length > 0 || errors.size > 0) {
      const errNote = errors.size > 0 ? ` (${[...errors.keys()].join(', ')} unreachable)` : '';
      this.post({ type: 'status', text: `MCP: ${tools.length} tool(s) from ${new Set(tools.map((t) => t.server)).size} server(s)${errNote}.` });
    }
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    view.webview.html = this.getHtml(view.webview);
    view.webview.onDidReceiveMessage((message: WebviewToHost) => {
      void this.handle(message);
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        view.badge = undefined;
      }
    });
  }

  /** Opens (or reveals) Nyx as a full editor tab — next to Cursor's own agent pane. */
  openInEditor(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      SidebarProvider.panelViewType,
      'Nyx',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
      },
    );
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'icon.svg');
    panel.webview.html = this.getHtml(panel.webview);
    panel.webview.onDidReceiveMessage((message: WebviewToHost) => {
      void this.handle(message);
    });
    panel.onDidDispose(() => {
      this.panel = undefined;
    });
    this.panel = panel;
  }

  /**
   * One-key world switch: jumps into Nyx when it isn't focused, back to the
   * editor when it is. Focus state is reported by the webviews themselves.
   */
  async toggleFocus(): Promise<void> {
    if (this.webviewFocused) {
      this.webviewFocused = false;
      if (this.panel?.active) {
        // Nyx *is* the active editor — move to the next group (or stay if none).
        await vscode.commands.executeCommand('workbench.action.focusNextGroup');
      } else {
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
      }
      return;
    }
    if (this.panel) {
      this.panel.reveal(undefined, false);
      return;
    }
    await vscode.commands.executeCommand(`${SidebarProvider.viewId}.focus`);
  }

  private post(message: HostToWebview): void {
    void this.view?.webview.postMessage(message);
    void this.panel?.webview.postMessage(message);
  }

  /** Shows a badge on the view icon when a run finishes while Nyx is hidden. */
  private notifyDone(): void {
    if (this.view && !this.view.visible) {
      this.view.badge = { value: 1, tooltip: 'Nyx finished a task' };
    }
  }

  async refreshModels(): Promise<void> {
    this.post({ type: 'status', text: 'Scanning for local models…' });
    const machines = await this.machines.getMachinesWithSecrets();
    const [models, skills] = await Promise.all([
      discoverModels(machines),
      loadSkills(this.workspaceRoot()),
      this.refreshMcp().catch(() => undefined),
    ]);
    this.models = models;
    this.skillsCache = skills;
    const stillValid = this.selectedKey && this.models.some((m) => m.key === this.selectedKey);
    if (!stillValid) {
      const coder = this.models.find((m) => /coder|code/i.test(m.id));
      this.selectedKey = coder?.key ?? this.models[0]?.key;
    }
    this.post({ type: 'models', models: this.models, selectedKey: this.selectedKey });
  }

  newChat(): void {
    this.cancelRun();
    this.session.reset();
    this.checkpoints.clear();
    this.sessionAllow.clear();
    this.currentSessionId = undefined;
    this.currentDisplay = [];
    this.addedLines = 0;
    this.removedLines = 0;
    this.changedFiles.clear();
    this.attachments = [];
    this.currentTitle = undefined;
    this.currentTitleAuto = false;
    this.currentModelKey = undefined;
    this.currentModelId = undefined;
    this.currentModelLabel = undefined;
    this.currentMachineName = undefined;
    this.currentMode = undefined;
    this.lastUserText = undefined;
    this.grind = undefined;
    this.batch = undefined;
    this.networkLog.clear();
    this.lastMemoryCapture = undefined;
    this.currentPlan = [];
    this.post({ type: 'plan', items: [] });
    this.setQueue([]);
    this.post({ type: 'cleared' });
    this.post({ type: 'context', usedTokens: 0, budgetTokens: 0 });
    this.postAttachments();
    this.postSessions();
  }

  /** Adds files/folders (from the explorer or a picker) as context for the next message. */
  async attachUris(uris: vscode.Uri[]): Promise<void> {
    for (const uri of uris) {
      let kind: 'file' | 'folder' = 'file';
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        kind = stat.type === vscode.FileType.Directory ? 'folder' : 'file';
      } catch {
        continue;
      }
      if (!this.attachments.some((a) => a.path === uri.fsPath)) {
        this.attachments.push({ path: uri.fsPath, name: uri.path.split('/').pop() ?? uri.fsPath, kind });
      }
    }
    this.postAttachments();
    await vscode.commands.executeCommand('nyx.chatView.focus');
  }

  /** Attaches the current editor selection (Cmd+Alt+L / "Add selection to Nyx"). */
  async attachSelection(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showInformationMessage('Nyx: no active editor.');
      return;
    }
    const sel = editor.selection;
    const doc = editor.document;
    const range = sel.isEmpty ? undefined : new vscode.Range(sel.start, sel.end);
    const text = range ? doc.getText(range) : doc.getText();
    const name = doc.uri.path.split('/').pop() ?? doc.fileName;
    const label = range ? `${name}:${sel.start.line + 1}-${sel.end.line + 1}` : name;
    const key = `${doc.uri.fsPath}#${label}`;
    if (!this.attachments.some((a) => a.path === key)) {
      this.attachments.push({ path: key, name, kind: 'selection', content: text, label });
    }
    this.postAttachments();
    await vscode.commands.executeCommand('nyx.chatView.focus');
  }

  /**
   * Imports a conversation/context from the clipboard (e.g. a Cursor chat)
   * as an attachment for the next message — the reverse of the handoff copy.
   */
  async importHandoff(): Promise<void> {
    const text = (await vscode.env.clipboard.readText()).trim();
    if (!text) {
      void vscode.window.showInformationMessage('Nyx: the clipboard is empty — copy a conversation or notes first.');
      return;
    }
    const capped = text.length > 40000 ? `${text.slice(0, 40000)}\n… [truncated]` : text;
    const key = `handoff#${Date.now()}`;
    this.attachments = this.attachments.filter((a) => a.kind !== 'handoff');
    this.attachments.push({
      path: key,
      name: 'Handoff',
      kind: 'handoff',
      content: capped,
      label: `Handoff (${Math.round(text.length / 1000)}k chars)`,
    });
    this.postAttachments();
    this.post({ type: 'status', text: 'Handoff imported from the clipboard — it rides along with your next message.' });
    await vscode.commands.executeCommand('nyx.chatView.focus');
  }

  /** Attaches the active integrated terminal's visible output to the next message. */
  async attachTerminal(): Promise<void> {
    const capture = await captureActiveTerminal();
    if (!capture) {
      void vscode.window.showInformationMessage('Nyx: no integrated terminal is open.');
      return;
    }
    if (!capture.text) {
      void vscode.window.showInformationMessage(`Nyx: terminal "${capture.name}" has no visible output.`);
      return;
    }
    const key = `terminal#${capture.name}`;
    this.attachments = this.attachments.filter((a) => a.path !== key);
    this.attachments.push({
      path: key,
      name: capture.name,
      kind: 'terminal',
      content: capture.text,
      label: `Terminal: ${capture.name}`,
    });
    this.postAttachments();
    await vscode.commands.executeCommand('nyx.chatView.focus');
  }

  private async handle(message: WebviewToHost): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.sessions.init();
        this.postConfig();
        await this.refreshModels();
        this.postSessions();
        await this.postMachines();
        this.postMemories();
        this.postQueue();
        // A second host (editor tab) can connect mid-session — sync it up.
        if (this.currentDisplay.length > 0) {
          this.post({ type: 'sessionLoaded', items: this.currentDisplay, mode: this.currentMode });
        }
        if (this.busy) {
          this.post({ type: 'busy', busy: true });
        }
        this.postAttachments();
        return;
      case 'viewFocus':
        this.webviewFocused = message.focused;
        return;
      case 'refreshModels':
        await this.refreshModels();
        return;
      case 'getMachines':
        await this.postMachines();
        this.postBenchmarks();
        return;
      case 'testMachine': {
        const withSecret = { ...message.machine };
        if (!withSecret.apiKey && withSecret.hasApiKey) {
          const resolved = (await this.machines.getMachinesWithSecrets()).find((m) => m.id === withSecret.id);
          withSecret.apiKey = resolved?.apiKey;
        }
        const result = await probeMachine(withSecret);
        this.post({ type: 'machineTestResult', machineId: message.machine.id, ok: result.ok, models: result.models, contextLength: result.contextLength, error: result.error });
        return;
      }
      case 'saveMachine':
        await this.machines.save(message.machine);
        await this.refreshModels();
        await this.postMachines();
        return;
      case 'deleteMachine':
        await this.machines.remove(message.id);
        await this.refreshModels();
        await this.postMachines();
        return;
      case 'attachPick':
        await this.attachViaDialog();
        return;
      case 'attachDropped': {
        const uris: vscode.Uri[] = [];
        for (const raw of message.uris) {
          try {
            uris.push(vscode.Uri.parse(raw, true));
          } catch {
            // Ignore malformed entries (e.g. plain text that isn't a URI).
          }
        }
        if (uris.length > 0) {
          await this.attachUris(uris);
        }
        return;
      }
      case 'removeAttachment':
        this.attachments = this.attachments.filter((a) => a.path !== message.path);
        this.postAttachments();
        return;
      case 'compact':
        await this.compactNow();
        return;
      case 'newChat':
        this.newChat();
        return;
      case 'listSessions':
        this.postSessions();
        return;
      case 'loadSession':
        await this.loadSession(message.id);
        return;
      case 'deleteSession':
        await this.deleteSession(message.id);
        return;
      case 'deleteOtherSessions':
        await this.deleteOtherSessions(message.keepId);
        return;
      case 'cancel':
        this.stopRequested = true;
        this.grind = undefined;
        this.batch = undefined;
        this.cancelRun();
        return;
      case 'toolDecision': {
        const resolver = this.pendingApprovals.get(message.id);
        if (resolver) {
          resolver({ approved: message.approved, always: message.always === true });
          this.pendingApprovals.delete(message.id);
        }
        return;
      }
      case 'questionResponse': {
        const resolver = this.pendingQuestions.get(message.id);
        if (resolver) {
          resolver(message.answer);
          this.pendingQuestions.delete(message.id);
        }
        return;
      }
      case 'listMemories':
        this.postMemories();
        return;
      case 'deleteMemory':
        await this.memory.remove(message.id);
        this.postMemories();
        return;
      case 'clearMemories':
        await this.memory.clear();
        this.postMemories();
        return;
      case 'openFile':
        await this.openFile(message.path);
        return;
      case 'sendMessage':
        await this.onSend(message.text, message.modelKey, message.mode);
        return;
      case 'queueAdd':
        this.setQueue([...this.getQueue(), message.text]);
        return;
      case 'queueSet':
        this.setQueue(message.items);
        return;
      case 'queueRunNow':
        await this.runQueuedNow(message.index);
        return;
      case 'restoreCheckpoint':
        await this.restoreCheckpoint(message.checkpointId, { resend: false });
        return;
      case 'retryLast':
        await this.retryLast();
        return;
      case 'continueRun':
        await this.onSend('Continue where you left off.', this.currentModelKey ?? this.selectedKey ?? '', this.currentMode ?? 'agent');
        return;
      case 'killProcess':
        this.processes.kill(message.id);
        return;
      case 'mentionQuery':
        await this.handleMentionQuery(message.token, message.query);
        return;
      case 'setAutonomy': {
        const value = message.value === 'safe' || message.value === 'autopilot' ? message.value : 'balanced';
        await vscode.workspace.getConfiguration('nyx').update('autonomy', value, vscode.ConfigurationTarget.Global);
        this.postConfig();
        this.post({ type: 'status', text: `Autonomy: ${value}` });
        return;
      }
      case 'attachImage':
        await this.attachPastedImage(message.dataBase64, message.mime);
        return;
      case 'getReview':
        await this.postReview();
        return;
      case 'revertFile': {
        const ok = await this.checkpoints.restoreFile(message.path, this.workspaceRoot());
        this.post({ type: 'status', text: ok ? `Reverted ${message.path}.` : `Could not revert ${message.path}.` });
        await this.postReview();
        return;
      }
      case 'revertAll': {
        let reverted = 0;
        for (const [file] of this.checkpoints.originals()) {
          if (await this.checkpoints.restoreFile(file, this.workspaceRoot())) {
            reverted++;
          }
        }
        this.post({ type: 'status', text: `Reverted ${reverted} file(s) to the session start.` });
        await this.postReview();
        return;
      }
      case 'commitChanges':
        await this.commitSessionChanges();
        return;
      case 'benchmarkModel':
        await this.benchmarkModel(message.machineId, message.modelId);
        return;
      case 'getContextDetail': {
        const model = this.findModel(this.selectedKey) ?? this.models[0];
        const breakdown = this.session.breakdown();
        this.post({
          type: 'contextDetail',
          parts: [
            { label: 'System prompt + rules/skills/memory', tokens: breakdown.system },
            { label: 'Conversation (you + Nyx)', tokens: breakdown.conversation },
            { label: 'Tool results', tokens: breakdown.toolResults },
          ],
          total: this.session.estimateTokens(),
          budget: this.budgetFor(model),
        });
        return;
      }
      case 'diagnoseSetup':
        await this.postSetupStatus();
        return;
      case 'setupAction':
        await this.runSetupAction(message.action);
        return;
      case 'queueRunAll':
        await this.startBatchRun();
        return;
      case 'openDiff':
        await this.openNativeDiff(message.path);
        return;
      case 'getNetworkLog':
        this.postNetworkLog();
        return;
      case 'applyBenchSetup':
        await this.applyBenchSetup(message.dailyKey, message.utilityKey, message.autocompleteModel);
        return;
      default: {
        const exhaustive: never = message;
        void exhaustive;
      }
    }
  }

  // ---- Run lifecycle ----

  /** Aborts the active run and unblocks any pending approval/question waits. */
  private cancelRun(): void {
    this.abort?.abort();
    for (const [id, resolver] of this.pendingApprovals) {
      resolver({ approved: false, always: false });
      this.pendingApprovals.delete(id);
    }
    for (const [id, resolver] of this.pendingQuestions) {
      resolver('');
      this.pendingQuestions.delete(id);
    }
  }

  private autonomy(): Autonomy {
    const value = vscode.workspace.getConfiguration('nyx').get<string>('autonomy');
    return value === 'safe' || value === 'autopilot' ? value : 'balanced';
  }

  private postConfig(): void {
    const accent = (vscode.workspace.getConfiguration('nyx').get<string>('accentColor') ?? '').trim();
    this.post({ type: 'config', autonomy: this.autonomy(), accentColor: accent || undefined });
  }

  private getQueue(): string[] {
    return this.context.workspaceState.get<string[]>(QUEUE_KEY, []);
  }

  private setQueue(items: string[]): void {
    void this.context.workspaceState.update(QUEUE_KEY, items);
    this.post({ type: 'queue', items });
  }

  private postQueue(): void {
    this.post({ type: 'queue', items: this.getQueue() });
  }

  private async drainQueue(): Promise<void> {
    if (this.busy || this.stopRequested) {
      return;
    }
    this.closeBatchJob();
    const queue = this.getQueue();
    if (queue.length === 0) {
      await this.finishBatchIfDone();
      return;
    }
    const [next, ...rest] = queue;
    this.setQueue(rest);
    if (this.batch) {
      this.batch.jobs.push({ text: next, startedAt: Date.now(), addedBefore: this.addedLines, removedBefore: this.removedLines });
      if (this.batch.verify) {
        // The grind loop verifies the command after this job's agent turn and
        // feeds failures back until it passes (or the iteration cap is hit).
        const max = Math.max(1, vscode.workspace.getConfiguration('nyx').get<number>('grindMaxIterations') ?? 8);
        this.grind = { command: this.batch.verify, iteration: 0, max };
      }
    }
    await this.onSend(next, this.currentModelKey ?? this.selectedKey ?? '', this.currentMode ?? 'agent');
  }

  /**
   * Runs one queued job right now. If a run is in progress it is aborted first
   * (so a stuck/looping turn can be jumped) — the queued message then starts on
   * its own. Batch/grind loops are cleared so they don't resume behind it.
   */
  private async runQueuedNow(index: number): Promise<void> {
    const queue = this.getQueue();
    if (index < 0 || index >= queue.length) {
      return;
    }
    const text = queue[index];
    const rest = queue.slice();
    rest.splice(index, 1);
    this.setQueue(rest);

    if (this.busy) {
      this.stopRequested = true;
      this.grind = undefined;
      this.batch = undefined;
      this.cancelRun();
      // Let the aborted run unwind (its finally persists state) before restarting.
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    this.stopRequested = false;
    await this.onSend(text, this.currentModelKey ?? this.selectedKey ?? '', this.currentMode ?? 'agent');
  }

  // ---- Batch runs over the queue (overnight mode with a morning report) ----

  /** Marks the most recent batch job as finished (verify outcome via `ok`). */
  private closeBatchJob(ok?: boolean): void {
    const job = this.batch?.jobs[this.batch.jobs.length - 1];
    if (job && job.endedAt === undefined) {
      job.endedAt = Date.now();
      if (ok !== undefined) {
        job.ok = ok;
      }
    } else if (job && ok !== undefined && job.ok === undefined) {
      job.ok = ok;
    }
  }

  /** Kicks off a batch run over all queued jobs (webview button or command). */
  async startBatchRun(): Promise<void> {
    if (this.busy) {
      this.post({ type: 'status', text: 'Batch: a job is already running — it will continue through the queue.' });
      return;
    }
    const queue = this.getQueue();
    if (queue.length === 0) {
      this.post({ type: 'status', text: 'Batch: the queue is empty — add jobs first.' });
      return;
    }
    const verify = (vscode.workspace.getConfiguration('nyx').get<string>('batchVerifyCommand') ?? '').trim();
    if (this.autonomy() !== 'autopilot') {
      this.post({
        type: 'status',
        text: 'Batch: autonomy is not 🚀 Autopilot — approval prompts will pause the run while you are away.',
      });
    }
    this.stopRequested = false;
    this.batch = { startedAt: Date.now(), verify, jobs: [] };
    this.post({
      type: 'status',
      text: `Batch: running ${queue.length} queued job(s)${verify ? ` — each verified with \`${verify}\`` : ''}…`,
    });
    await this.drainQueue();
  }

  /** When the queue is drained, turns the collected stats into a session report. */
  private async finishBatchIfDone(): Promise<void> {
    const batch = this.batch;
    if (!batch || this.busy) {
      return;
    }
    this.batch = undefined;
    if (batch.jobs.length === 0) {
      return;
    }
    const files = await this.collectReview();
    const netAdded = files.reduce((n, f) => n + f.diff.added, 0);
    const netRemoved = files.reduce((n, f) => n + f.diff.removed, 0);
    const minutes = Math.max(1, Math.round((Date.now() - batch.startedAt) / 60000));
    const jobLines = batch.jobs.map((job, i) => {
      const mins = Math.max(1, Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 60000));
      const verdict = job.ok === true ? '✅ verified' : job.ok === false ? '❌ verify failed' : '✔ done';
      return `${i + 1}. ${verdict} · ${mins} min — ${job.text.split('\n')[0].slice(0, 120)}`;
    });
    const fileLines = files.slice(0, 30).map((f) => `- \`${f.path}\` ${f.deleted ? '(deleted)' : `+${f.diff.added} −${f.diff.removed}`}${f.created ? ' (new)' : ''}`);
    const report = [
      `## Batch report — ${batch.jobs.length} job(s) in ~${minutes} min`,
      '',
      ...jobLines,
      '',
      `**Net diff:** ${files.length} file(s), +${netAdded} −${netRemoved}${batch.verify ? ` · verify command: \`${batch.verify}\`` : ''}`,
      ...(fileLines.length > 0 ? ['', ...fileLines] : []),
      '',
      'Open **✎ changed** to review or revert individual files, or **Commit** to ship the changes.',
    ].join('\n');
    this.currentDisplay.push({ kind: 'assistant', text: report });
    this.post({ type: 'assistantStart' });
    this.post({ type: 'assistantDelta', text: report });
    this.post({ type: 'assistantEnd' });
    await this.persistCurrent();
    await this.postReview();
    this.postSessions();
    const passed = batch.jobs.filter((j) => j.ok !== false).length;
    const note = await vscode.window.showInformationMessage(
      `Nyx batch finished: ${passed}/${batch.jobs.length} job(s) completed, net diff +${netAdded} −${netRemoved}.`,
      'Open Nyx',
    );
    if (note === 'Open Nyx') {
      await vscode.commands.executeCommand('nyx.chatView.focus');
    }
  }

  private findModel(key: string | undefined): ModelInfo | undefined {
    return (
      this.models.find((m) => m.key === key) ??
      this.models.find((m) => m.key === this.selectedKey) ??
      // Backward compatibility: old sessions stored a bare model id.
      this.models.find((m) => m.id === key)
    );
  }

  private async openFile(path: string): Promise<void> {
    const root = this.workspaceRoot();
    const uri = path.startsWith('/') || !root ? vscode.Uri.file(path) : vscode.Uri.joinPath(root, path);
    try {
      await vscode.window.showTextDocument(uri, { preview: true });
    } catch (e) {
      this.post({ type: 'error', text: `Could not open ${path}: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  private async onSend(text: string, modelKey: string, mode: ChatMode): Promise<void> {
    if (!text.trim()) {
      // Empty send with a non-empty queue = "start the next job".
      this.stopRequested = false;
      await this.drainQueue();
      return;
    }
    if (this.busy) {
      this.setQueue([...this.getQueue(), text]);
      return;
    }

    // "/grind <command>" starts a fix-until-green loop: after each agent turn
    // the host runs the command itself and feeds failures back until it passes.
    if (text.trimStart().startsWith('/grind ')) {
      const stripped = text.trimStart().slice('/grind '.length);
      const [commandLine, ...goalLines] = stripped.split('\n');
      const command = commandLine.trim();
      if (!command) {
        this.post({ type: 'error', text: 'Usage: /grind <command> — e.g. "/grind npm test".' });
        return;
      }
      const max = Math.max(1, vscode.workspace.getConfiguration('nyx').get<number>('grindMaxIterations') ?? 8);
      this.grind = { command, iteration: 0, max };
      this.post({ type: 'status', text: `Grind: running \`${command}\` to capture the baseline…` });
      const baseline = await this.processes.run(command, { cwd: this.workspaceRoot()?.fsPath, timeoutMs: 300000 });
      if (baseline.ok) {
        this.grind = undefined;
        this.post({ type: 'status', text: `Grind: \`${command}\` already passes — nothing to fix.` });
        return;
      }
      const goal = goalLines.join('\n').trim();
      text =
        `Make \`${command}\` pass. Fix the underlying code (not the tests, unless they are clearly wrong).` +
        (goal ? `\nAdditional context: ${goal}` : '') +
        `\n\nCurrent failing output:\n\`\`\`\n${baseline.output.trim().slice(-4000)}\n\`\`\``;
    }
    const model = this.findModel(modelKey);
    if (!model) {
      this.post({ type: 'error', text: 'No local model found. Start Ollama or LM Studio, then click refresh.' });
      return;
    }
    this.selectedKey = model.key;
    this.networkLog.record(model.endpoint, 'model inference');
    this.ensureSession();
    this.currentModelKey = model.key;
    this.currentModelId = model.id;
    this.currentModelLabel = model.label;
    this.currentMachineName = model.machineName;
    this.currentMode = mode;
    this.lastUserText = text;
    this.stopRequested = false;

    // Warn once when the model doesn't advertise native tool support (#19).
    if (mode === 'agent' && model.capabilities && !model.capabilities.includes('tools')) {
      this.post({ type: 'status', text: `Note: ${model.label} does not advertise tool support — Nyx will parse tool calls from plain text, but a coder/tool-tuned model works better.` });
    }

    // Begin a checkpoint at this user message (#9).
    const checkpointId = this.checkpoints.begin(this.session.getMessages().length);
    this.currentDisplay.push({ kind: 'user', text, checkpointId });
    this.post({ type: 'userMessage', text, checkpointId });

    this.abort = new AbortController();
    this.busy = true;
    this.post({ type: 'busy', busy: true });

    const cfg = vscode.workspace.getConfiguration('nyx');
    const supportsVision = model.capabilities?.includes('vision') === true;
    const media = this.mediaOptions();
    const semanticOpts = this.semanticOptions();

    if (this.attachments.some((a) => a.kind === 'file' && mediaKind(a.name))) {
      this.networkLog.record(media.visionUrl, 'vision/OCR');
    }
    const attachmentCtx = await buildAttachmentContext(this.attachments, media, supportsVision);
    this.attachments = [];
    this.postAttachments();
    const mentionCtx = await buildMentionContext(text, this.workspaceRoots());
    const autoFetch = cfg.get<boolean>('autoFetchUrls') ?? true;
    if (autoFetch) {
      for (const url of extractUrls(text).slice(0, 3)) {
        this.networkLog.record(url, 'user URL auto-fetch');
      }
    }
    const urlCtx = autoFetch
      ? await buildUrlContext(text, media, supportsVision, (t) => this.post({ type: 'status', text: t }))
      : { text: '', images: [] };
    const activeFileCtx = (cfg.get<boolean>('includeActiveFile') ?? true) ? this.buildActiveFileContext(text) : '';
    const extra = [attachmentCtx.text, mentionCtx, urlCtx.text, activeFileCtx].filter(Boolean).join('\n\n---\n\n');
    const finalText = extra ? `${extra}\n\n---\n\n${text}` : text;
    const images = [...attachmentCtx.images, ...urlCtx.images];

    const rules = await loadRules(this.workspaceRoot());
    const memoryEnabled = cfg.get<boolean>('memoryEnabled') ?? true;
    const memoryDigest = memoryEnabled ? this.memory.digest(cfg.get<number>('memoryInject') ?? 5, this.currentSessionId) : '';
    const userAppend = (cfg.get<string>('systemPromptAppend') ?? '').trim();
    // Compact workspace map so (small) models stop guessing where files live; agent mode only.
    const repoMap = mode === 'agent' && (cfg.get<boolean>('repoMap') ?? true) ? await buildRepoMap(this.workspaceRoot()) : '';
    const systemAddon = [repoMap, buildRulesSection(rules), buildSkillsSection(this.skillsCache), memoryDigest, userAppend]
      .filter(Boolean)
      .join('\n\n');
    const overrides = cfg.get<Record<string, unknown>>('toolPermissions') ?? {};
    const budget = this.budgetFor(model);

    let activeToolId: string | undefined;
    const ctx: ToolContext = {
      workspaceRoots: this.workspaceRoots(),
      skills: this.skillsCache,
      rules,
      media,
      backupDir: vscode.Uri.joinPath(this.context.globalStorageUri, 'backups').fsPath,
      signal: this.abort.signal,
      processes: this.processes,
      onProgress: (chunk) => {
        if (activeToolId) {
          this.post({ type: 'toolProgress', id: activeToolId, chunk });
        }
      },
      recordCheckpointFile: (relPath, content) => this.checkpoints.recordFile(relPath, content),
      allowPrivateNetwork: cfg.get<boolean>('allowPrivateNetworkFetch') ?? false,
      semantic: semanticOpts ? { index: this.semanticIndex, options: semanticOpts } : undefined,
      browser: this.browser,
      setPlan: (items) => {
        this.currentPlan = items;
        this.post({ type: 'plan', items });
      },
      memory: {
        recall: (query, limit) => this.memory.formatRecall(query, limit, this.currentSessionId),
        save: (title, summary, files) => {
          void this.memory.saveAgent(title, summary, files).then(() => this.postMemories());
          return `Saved to project memory: ${title}`;
        },
      },
    };

    let assistantBuf = '';
    let aborted = false;
    const pending = new Map<string, { name: string; args: string }>();

    // Benchmark-based routing (opt-in): judgment-best model plans, edit-best executes.
    let planModel = model;
    let executionModel: ModelInfo | undefined;
    if (mode === 'agent' && (cfg.get<boolean>('benchmarkRouting') ?? false)) {
      const route = routeByBenchmarks(this.models, this.getBenchmarks(), model);
      planModel = route.plan;
      executionModel = route.execution;
      if (planModel.key !== model.key || executionModel) {
        this.networkLog.record(planModel.endpoint, 'model inference');
        if (executionModel) {
          this.networkLog.record(executionModel.endpoint, 'model inference');
        }
        this.post({
          type: 'status',
          text: `Benchmark routing: plan/reasoning on ${planModel.label}${executionModel ? `, edits on ${executionModel.label}` : ''}.`,
        });
      }
    }
    const fallbackModels = this.models.filter((m) => m.id === planModel.id && m.key !== planModel.key);
    const executionFallbacks = executionModel
      ? this.models.filter((m) => m.id === executionModel!.id && m.key !== executionModel!.key)
      : undefined;

    // Show the context/token gauge right away so usage is visible during the run.
    this.post({ type: 'context', usedTokens: this.session.estimateTokens(), budgetTokens: budget });

    try {
      await this.session.run(
        finalText,
        {
          model: planModel,
          fallbackModels,
          executionModel,
          executionFallbacks,
          mode,
          ctx,
          systemAddon,
          toolProfile: (cfg.get<string>('toolProfile') as ToolProfile) ?? 'auto',
          compactModel: this.hasExplicitUtilityModel() ? this.utilityModel() : undefined,
          mcpTools: this.mcp.getTools(),
          callMcpTool: (server, tool, mcpArgs) => this.mcp.call(server, tool, mcpArgs),
          resolvePermission: (name) => (this.sessionAllow.has(name) ? 'allow' : resolvePolicy(name, overrides, this.autonomy())),
          grantSessionAllow: (name) => this.sessionAllow.add(name),
          signal: this.abort.signal,
          maxSteps: cfg.get<number>('maxAgentSteps') ?? 25,
          maxOutputTokens: cfg.get<number>('maxOutputTokens') ?? 8192,
          contextBudget: budget,
          compactThreshold: cfg.get<number>('compactThreshold') ?? 0.75,
          images: images.length > 0 ? images : undefined,
        },
        {
          onAssistantStart: () => {
            assistantBuf = '';
            this.post({ type: 'assistantStart' });
          },
          onAssistantDelta: (t) => {
            assistantBuf += t;
            this.post({ type: 'assistantDelta', text: t });
          },
          onReasoning: (t) => this.post({ type: 'reasoning', text: t }),
          onAssistantEnd: (finalRaw) => {
            const finalTrimmed = finalRaw.trim();
            if (finalTrimmed) {
              this.currentDisplay.push({ kind: 'assistant', text: finalTrimmed });
            }
            this.post({ type: 'assistantEnd' });
            // The streamed text can contain embedded tool-call JSON that was
            // only stripped after the stream finished — sync the UI (#4).
            if (finalTrimmed !== assistantBuf.trim()) {
              this.post({ type: 'assistantFinal', text: finalTrimmed });
            }
            this.post({ type: 'context', usedTokens: this.session.estimateTokens(), budgetTokens: budget });
          },
          onToolCall: (id, name, args) => {
            pending.set(id, { name, args });
            activeToolId = id;
            this.networkLog.recordToolCall(name, args, this.semanticOptions()?.embeddingUrl);
            this.post({ type: 'toolCall', id, name, args });
          },
          onToolResult: (id, ok, content, outcome) => {
            activeToolId = undefined;
            const info = pending.get(id);
            this.currentDisplay.push({
              kind: 'tool',
              name: info?.name ?? 'tool',
              args: info?.args ?? '',
              ok,
              content,
              filePath: outcome.filePath,
              diff: outcome.diff,
            });
            if (ok && outcome.diff && outcome.filePath) {
              this.addedLines += outcome.diff.added;
              this.removedLines += outcome.diff.removed;
              this.changedFiles.add(outcome.filePath);
            }
            this.post({ type: 'toolResult', id, ok, content, filePath: outcome.filePath, diff: outcome.diff });
            this.post({ type: 'context', usedTokens: this.session.estimateTokens(), budgetTokens: budget });
          },
          onStatus: (t) => this.post({ type: 'status', text: t }),
          onStats: (s) =>
            this.post({ type: 'stats', tokensPerSecond: s.tokensPerSecond, completionTokens: s.completionTokens, estimated: s.estimated }),
          onStepLimit: () => this.post({ type: 'stepLimit' }),
          requestApproval: (name, args, preview) => this.requestApproval(name, args, preview),
          askUser: (id, question, qtype, options) => this.askUser(id, question, qtype, options),
        },
      );
    } catch (e) {
      const err = e as { name?: string; message?: string };
      if (err.name === 'AbortError') {
        aborted = true;
        this.post({ type: 'status', text: 'Stopped.' });
      } else {
        this.post({ type: 'error', text: err.message ?? String(e), canRetry: true });
      }
    } finally {
      this.busy = false;
      await this.persistCurrent();
      this.post({ type: 'busy', busy: false });
      this.post({ type: 'context', usedTokens: this.session.estimateTokens(), budgetTokens: budget });
      this.postSessions();
      this.notifyDone();
      // Re-arm Ollama's keep-alive so the model stays loaded between turns.
      const keepAlive = (cfg.get<string>('keepAlive') ?? '30m').trim();
      if (keepAlive && model.provider === 'ollama') {
        this.networkLog.record(model.endpoint, 'model keep-alive');
        void warmKeepAlive(model, keepAlive);
      }
      if (!aborted) {
        void this.maybeGenerateTitle(model);
        if (this.grind) {
          await this.continueGrind();
        } else {
          void this.drainQueue();
        }
      }
    }
  }

  /** One grind iteration: re-run the command; on failure feed the output back. */
  private async continueGrind(): Promise<void> {
    const grind = this.grind;
    if (!grind || this.stopRequested) {
      return;
    }
    grind.iteration++;
    this.post({ type: 'status', text: `Grind ${grind.iteration}/${grind.max}: running \`${grind.command}\`…` });
    const result = await this.processes.run(grind.command, { cwd: this.workspaceRoot()?.fsPath, timeoutMs: 300000 });
    if (result.ok) {
      this.grind = undefined;
      this.closeBatchJob(true);
      this.post({ type: 'status', text: `Grind: \`${grind.command}\` passes after ${grind.iteration} iteration(s) ✅` });
      void this.drainQueue();
      return;
    }
    if (grind.iteration >= grind.max) {
      this.grind = undefined;
      this.closeBatchJob(false);
      this.post({
        type: 'error',
        text: `Grind stopped: \`${grind.command}\` still fails after ${grind.max} iterations. Last output:\n${result.output.trim().slice(-800)}`,
        canRetry: false,
      });
      void this.drainQueue();
      return;
    }
    await this.onSend(
      `\`${grind.command}\` still fails (attempt ${grind.iteration}/${grind.max}). Analyze the NEW output below, fix the remaining problems, and do not repeat changes that did not help.\n\n\`\`\`\n${result.output.trim().slice(-4000)}\n\`\`\``,
      this.currentModelKey ?? this.selectedKey ?? '',
      this.currentMode ?? 'agent',
    );
  }

  // ---- Checkpoints, retry, message editing ----

  /**
   * Restores files + conversation to the given checkpoint. With `resend`, the
   * original message is sent again immediately (retry); otherwise it is placed
   * in the composer for editing.
   */
  private async restoreCheckpoint(checkpointId: string, opts: { resend: boolean }): Promise<void> {
    if (this.busy) {
      this.stopRequested = true;
      this.cancelRun();
      // Let the aborted run unwind (its finally persists state) before rewinding.
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const userIdx = this.currentDisplay.findIndex((d) => d.kind === 'user' && d.checkpointId === checkpointId);
    const userItem = userIdx >= 0 ? (this.currentDisplay[userIdx] as Extract<DisplayItem, { kind: 'user' }>) : undefined;

    const result = await this.checkpoints.restore(checkpointId, this.workspaceRoot());
    if (!result) {
      this.post({ type: 'error', text: 'Checkpoint not found (it may belong to an older session).' });
      return;
    }
    this.session.truncateTo(result.messageIndex);
    if (userIdx >= 0) {
      this.currentDisplay = this.currentDisplay.slice(0, userIdx);
    }
    this.recomputeEditStats();
    await this.persistCurrent();
    this.post({ type: 'sessionLoaded', items: this.currentDisplay, mode: this.currentMode });
    if (result.restored.length > 0) {
      this.post({ type: 'status', text: `Restored ${result.restored.length} file(s) to the checkpoint.` });
    }
    const text = userItem?.text ?? '';
    if (opts.resend && text) {
      await this.onSend(text, this.currentModelKey ?? this.selectedKey ?? '', this.currentMode ?? 'agent');
    } else if (text) {
      this.post({ type: 'composerSet', text });
    }
  }

  /** Re-runs the last user message (after an error), restoring its checkpoint first. */
  private async retryLast(): Promise<void> {
    const lastUser = [...this.currentDisplay].reverse().find((d) => d.kind === 'user');
    if (lastUser && lastUser.kind === 'user' && lastUser.checkpointId) {
      await this.restoreCheckpoint(lastUser.checkpointId, { resend: true });
      return;
    }
    if (this.lastUserText) {
      await this.onSend(this.lastUserText, this.currentModelKey ?? this.selectedKey ?? '', this.currentMode ?? 'agent');
    }
  }

  /**
   * Stages the session's changed files and commits them with a model-generated
   * conventional commit message (written via `git commit -F` — no shell
   * escaping pitfalls).
   */
  private async commitSessionChanges(): Promise<void> {
    const root = this.workspaceRoot();
    const files = [...this.checkpoints.originals().keys()];
    try {
      if (!root) {
        throw new Error('No workspace folder is open.');
      }
      if (files.length === 0) {
        throw new Error('No session changes to commit.');
      }
      const cwd = root.fsPath;
      const run = async (command: string, failMsg: string): Promise<string> => {
        const result = await this.processes.run(command, { cwd, timeoutMs: 30000 });
        if (!result.ok) {
          throw new Error(`${failMsg}: ${result.output.trim().slice(0, 200)}`);
        }
        return result.output;
      };
      await run('git rev-parse --is-inside-work-tree', 'Not a git repository');
      const quoted = files.map((f) => `"${f.replace(/"/g, '\\"')}"`).join(' ');
      await run(`git add -A -- ${quoted}`, 'git add failed');
      const diff = (await run('git diff --cached', 'git diff failed')).slice(0, 9000);
      if (!diff.trim()) {
        throw new Error('Nothing staged — the changes may already be committed.');
      }

      this.post({ type: 'status', text: 'Generating commit message…' });
      const model = this.utilityModel() ?? this.findModel(this.selectedKey) ?? this.models[0];
      if (!model) {
        throw new Error('No model available to generate the commit message.');
      }
      const result = await streamChat(
        {
          endpoint: model.endpoint,
          apiKey: model.apiKey,
          model: model.id,
          messages: [
            {
              role: 'system',
              content:
                'Write a git commit message for the staged diff: one imperative summary line (max 70 chars, conventional-commit style like "fix:", "feat:", "refactor:"), optionally followed by a blank line and 1-3 short body lines. Reply with ONLY the message — no quotes, no markdown fences.',
            },
            { role: 'user', content: `Staged diff:\n\n${diff}` },
          ],
          temperature: 0,
          maxTokens: 200,
          signal: AbortSignal.timeout(60000),
        },
        { onDelta: () => {} },
      );
      const message = stripSpecialTokens(result.content).trim().replace(/^```[a-z]*\n?|```$/g, '').trim();
      if (!message) {
        throw new Error('The model produced an empty commit message.');
      }
      const msgFile = vscode.Uri.joinPath(this.context.globalStorageUri, 'commit-msg.txt');
      await vscode.workspace.fs.writeFile(msgFile, new TextEncoder().encode(message));
      await run(`git commit -F "${msgFile.fsPath}"`, 'git commit failed');
      const hash = (await run('git rev-parse --short HEAD', 'git rev-parse failed')).trim();
      this.post({ type: 'status', text: `Committed ${files.length} file(s) as ${hash}: ${message.split('\n')[0]}` });
    } catch (e) {
      this.post({ type: 'error', text: `Commit failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      await this.postReview();
    }
  }

  /**
   * The model used for utility work (titles, commit messages — and context
   * compaction when configured explicitly). `nyx.utilityModel` may name a
   * model (key or id); empty means auto: the smallest reachable ≤8B model.
   * Undefined = no suitable candidate, callers fall back to the main model.
   */
  private utilityModel(): ModelInfo | undefined {
    const setting = (vscode.workspace.getConfiguration('nyx').get<string>('utilityModel') ?? '').trim();
    if (setting) {
      return this.models.find((m) => m.key === setting) ?? this.models.find((m) => m.id === setting);
    }
    const candidates = this.models
      .filter((m) => !/embed|moondream|whisper/i.test(m.id))
      .map((m) => ({ m, size: parameterBillions(m.id) }))
      .filter((x): x is { m: ModelInfo; size: number } => x.size !== undefined && x.size <= 8)
      .sort((a, b) => a.size - b.size);
    return candidates[0]?.m;
  }

  /** True when the user explicitly pinned a utility model (routes compaction too). */
  private hasExplicitUtilityModel(): boolean {
    return Boolean((vscode.workspace.getConfiguration('nyx').get<string>('utilityModel') ?? '').trim());
  }

  // ---- Model benchmark ----

  private static readonly BENCH_KEY = 'nyx.benchmarks.v1';

  private getBenchmarks(): Record<string, BenchmarkScores> {
    return this.context.globalState.get<Record<string, BenchmarkScores>>(SidebarProvider.BENCH_KEY, {});
  }

  private postBenchmarks(runningKey?: string, error?: string): void {
    this.post({ type: 'benchmarks', entries: this.getBenchmarks(), runningKey, error });
  }

  /** Runs the 9-request in-product benchmark against one model and stores the scores. */
  private async benchmarkModel(machineId: string, modelId: string): Promise<void> {
    const key = `${machineId}:${modelId}`;
    const model = this.models.find((m) => m.key === key);
    if (!model) {
      this.postBenchmarks(undefined, `Model ${modelId} is not reachable right now — run "Test & discover" first.`);
      return;
    }
    this.postBenchmarks(key);
    try {
      const scores = await runBenchmark(model, (t) => this.post({ type: 'status', text: `${model.label}: ${t}` }), AbortSignal.timeout(600000));
      const all = this.getBenchmarks();
      all[key] = scores;
      await this.context.globalState.update(SidebarProvider.BENCH_KEY, all);
      this.postBenchmarks();
      this.post({
        type: 'status',
        text: `Benchmark ${model.label}: tools ${scores.tool}% · edits ${scores.edit}% · judgment ${scores.judge}% · FP ${scores.fp}% · ${scores.avgMs} ms/req`,
      });
      const advice = computeBenchAdvice(this.models, this.getBenchmarks());
      if (advice) {
        this.post({ type: 'benchSetup', advice });
      }
    } catch (e) {
      this.postBenchmarks(undefined, e instanceof Error ? e.message : String(e));
    }
  }

  /** One-click apply of the benchmark recommendation (three settings at once). */
  private async applyBenchSetup(dailyKey?: string, utilityKey?: string, autocompleteModel?: string): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('nyx');
    const applied: string[] = [];
    if (dailyKey) {
      const model = this.findModel(dailyKey);
      if (model) {
        this.selectedKey = model.key;
        this.post({ type: 'models', models: this.models, selectedKey: this.selectedKey });
        applied.push(`daily driver → ${model.label}`);
      }
    }
    if (utilityKey) {
      await cfg.update('utilityModel', utilityKey, vscode.ConfigurationTarget.Global);
      applied.push(`utility model → ${utilityKey}`);
    }
    if (autocompleteModel) {
      await cfg.update('autocompleteModel', autocompleteModel, vscode.ConfigurationTarget.Global);
      applied.push(`autocomplete → ${autocompleteModel}`);
    }
    this.post({ type: 'status', text: applied.length > 0 ? `Setup applied: ${applied.join(' · ')}.` : 'Nothing to apply.' });
  }

  // ---- Guided first-run (empty-state diagnosis + one-click actions) ----

  /** Diagnoses the local setup for the guided empty state. */
  private async postSetupStatus(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('nyx');
    const ollamaUrl = (cfg.get<string>('ollamaUrl') || 'http://localhost:11434').replace(/\/+$/, '');
    const ollamaReachable = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(2500) })
      .then((r) => r.ok)
      .catch(() => false);
    const hasCoder = this.models.some((m) => /coder|code|deepseek|devstral/i.test(m.id));
    const indexEnabled = (cfg.get<boolean>('semanticIndexEnabled') ?? true) && Boolean(this.workspaceRoot());
    const hasIndex = indexEnabled ? await this.semanticIndex.hasIndex() : false;
    this.post({
      type: 'setupStatus',
      status: { ollamaUrl, ollamaReachable, hasCoder, hasIndex, indexEnabled, pulling: this.pullingModel },
    });
  }

  /** Executes a one-click first-run action from the empty state. */
  private async runSetupAction(action: 'pullCoder' | 'buildIndex'): Promise<void> {
    switch (action) {
      case 'buildIndex':
        await this.buildSemanticIndex(false);
        await this.postSetupStatus();
        return;
      case 'pullCoder': {
        if (this.pullingModel) {
          return;
        }
        const model = 'qwen2.5-coder:7b';
        const ollamaUrl = (vscode.workspace.getConfiguration('nyx').get<string>('ollamaUrl') || 'http://localhost:11434').replace(/\/+$/, '');
        this.pullingModel = model;
        await this.postSetupStatus();
        this.post({ type: 'status', text: `Downloading ${model} via Ollama — a one-time download of a few GB…` });
        this.networkLog.record(ollamaUrl, 'model download');
        try {
          await pullModel(ollamaUrl, model, (t) => this.post({ type: 'status', text: t }));
          await this.refreshModels();
        } catch (e) {
          this.post({
            type: 'error',
            text: `Could not pull ${model}: ${e instanceof Error ? e.message : String(e)}. Run "ollama pull ${model}" in a terminal instead.`,
          });
        } finally {
          this.pullingModel = undefined;
          await this.postSetupStatus();
        }
        return;
      }
      default: {
        const exhaustive: never = action;
        void exhaustive;
      }
    }
  }

  private postNetworkLog(): void {
    this.post({ type: 'networkLog', entries: this.networkLog.entries() });
  }

  /** Builds the net session diff: checkpoint originals vs. current disk state. */
  private async collectReview(): Promise<ReviewFile[]> {
    const root = this.workspaceRoot();
    const files: ReviewFile[] = [];
    for (const [relPath, original] of this.checkpoints.originals()) {
      const uri = relPath.startsWith('/') || !root ? vscode.Uri.file(relPath) : vscode.Uri.joinPath(root, relPath);
      let current: string | undefined;
      try {
        current = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      } catch {
        current = undefined;
      }
      if (current === original) {
        continue; // reverted or untouched — no net change
      }
      files.push({
        path: relPath,
        created: original === undefined,
        deleted: original !== undefined && current === undefined,
        diff: summarizeDiff(original, current ?? ''),
      });
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    return files;
  }

  private async postReview(): Promise<void> {
    this.post({ type: 'review', files: await this.collectReview() });
  }

  /** Opens the editor's native diff: checkpoint original vs. current disk state. */
  private async openNativeDiff(relPath: string): Promise<void> {
    const root = this.workspaceRoot();
    const fileUri = relPath.startsWith('/') || !root ? vscode.Uri.file(relPath) : vscode.Uri.joinPath(root, relPath);
    const originalUri = vscode.Uri.from({ scheme: ORIGINAL_SCHEME, path: `/${relPath}`, query: encodeURIComponent(relPath) });
    try {
      await vscode.commands.executeCommand('vscode.diff', originalUri, fileUri, `${relPath} (session start ↔ now)`);
    } catch (e) {
      this.post({ type: 'error', text: `Could not open diff for ${relPath}: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  private recomputeEditStats(): void {
    this.addedLines = 0;
    this.removedLines = 0;
    this.changedFiles.clear();
    for (const item of this.currentDisplay) {
      if (item.kind === 'tool' && item.ok && item.diff && item.filePath) {
        this.addedLines += item.diff.added;
        this.removedLines += item.diff.removed;
        this.changedFiles.add(item.filePath);
      }
    }
  }

  // ---- @-mention autocomplete ----

  private async handleMentionQuery(token: string, query: string): Promise<void> {
    if (!query.trim()) {
      this.post({ type: 'mentionResults', token, files: [] });
      return;
    }
    const glob = `**/*${query.replace(/[{}[\]]/g, '')}*`;
    const exclude = '**/{node_modules,.git,dist,out,build,.next,.venv,.cache}/**';
    try {
      const uris = await vscode.workspace.findFiles(glob, exclude, 20);
      const files = uris.map((u) => vscode.workspace.asRelativePath(u)).sort((a, b) => a.length - b.length);
      this.post({ type: 'mentionResults', token, files });
    } catch {
      this.post({ type: 'mentionResults', token, files: [] });
    }
  }

  /** Auto-names the session after its first exchange (best-effort). */
  private async maybeGenerateTitle(model: ModelInfo): Promise<void> {
    if (this.currentTitleAuto || !this.currentSessionId) {
      return;
    }
    if ((vscode.workspace.getConfiguration('nyx').get<boolean>('autoTitle') ?? true) === false) {
      return;
    }
    const firstUser = this.currentDisplay.find((d) => d.kind === 'user');
    if (!firstUser || firstUser.kind !== 'user' || !firstUser.text.trim()) {
      return;
    }
    const firstAssistant = this.currentDisplay.find((d) => d.kind === 'assistant');
    const assistantText = firstAssistant && firstAssistant.kind === 'assistant' ? firstAssistant.text : '';
    const sessionId = this.currentSessionId;
    try {
      // Titles are utility work — route them to the small model when available.
      const titleModel = this.utilityModel() ?? model;
      const title = await generateSessionTitle(titleModel, firstUser.text, assistantText, AbortSignal.timeout(20000));
      if (title && this.currentSessionId === sessionId) {
        this.currentTitle = title;
        this.currentTitleAuto = true;
        await this.persistCurrent();
        this.postSessions();
      }
    } catch {
      // Keep the fallback title on any failure.
    }
  }

  /**
   * Context budget used for the fullness bar and compaction threshold.
   * Priority: explicit per-machine context length → model's advertised context
   * → configured fallback. The advertised size is used as-is (a 1M model shows
   * a 1M budget); set a per-machine context length to budget less.
   */
  private budgetFor(model?: ModelInfo): number {
    const cfg = vscode.workspace.getConfiguration('nyx');
    const fallback = cfg.get<number>('contextTokens') ?? 16384;
    if (model?.numCtx && model.numCtx > 0) {
      return model.numCtx;
    }
    if (model?.contextLength && model.contextLength > 0) {
      return model.contextLength;
    }
    return fallback;
  }

  private async compactNow(): Promise<void> {
    const model = this.findModel(this.selectedKey) ?? this.models[0];
    if (!model) {
      return;
    }
    const budget = this.budgetFor(model);
    const controller = new AbortController();
    this.post({ type: 'busy', busy: true });
    try {
      const done = await this.session.compact(model, controller.signal, (t) => this.post({ type: 'status', text: t }));
      this.post({ type: 'status', text: done ? 'Context compacted.' : 'Nothing to compact yet.' });
    } catch (e) {
      this.post({ type: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      await this.persistCurrent();
      this.post({ type: 'busy', busy: false });
      this.post({ type: 'context', usedTokens: this.session.estimateTokens(), budgetTokens: budget });
    }
  }

  private requestApproval(
    name: string,
    args: string,
    preview?: { diff?: DiffSummary; filePath?: string },
  ): Promise<ApprovalDecision> {
    const id = `approve_${Math.random().toString(36).slice(2)}`;
    this.post({ type: 'approvalRequest', id, name, args, diff: preview?.diff, filePath: preview?.filePath });
    return new Promise<ApprovalDecision>((resolve) => this.pendingApprovals.set(id, resolve));
  }

  private askUser(id: string, question: string, qtype: QuestionType, options: string[]): Promise<string> {
    this.post({ type: 'questionRequest', id, question, qtype, options });
    return new Promise<string>((resolve) => {
      this.pendingQuestions.set(id, (answer) => {
        this.currentDisplay.push({ kind: 'question', question, qtype, options, answer });
        resolve(answer);
      });
    });
  }

  /**
   * Lightweight auto-context: path + ±30 lines around the cursor of the last
   * active editor. Deliberately small (local models have tight context
   * budgets) and skipped when the file is already @-mentioned.
   */
  private buildActiveFileContext(text: string): string {
    const editor = this.lastEditor;
    if (!editor) {
      return '';
    }
    try {
      const doc = editor.document;
      if (doc.isClosed || doc.uri.scheme !== 'file') {
        return '';
      }
      const rel = vscode.workspace.asRelativePath(doc.uri);
      if (text.includes(`@${rel}`)) {
        return '';
      }
      const line = editor.selection.active.line;
      const start = Math.max(0, line - 30);
      const end = Math.min(doc.lineCount - 1, line + 30);
      const snippet = doc.getText(new vscode.Range(start, 0, end, doc.lineAt(end).text.length)).slice(0, 6000);
      if (!snippet.trim()) {
        return '';
      }
      return `Currently open editor file (auto-context; lines ${start + 1}-${end + 1} around the user's cursor): ${rel}\n\`\`\`\n${snippet}\n\`\`\``;
    } catch {
      return '';
    }
  }

  private workspaceRoot(): vscode.Uri | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri;
  }

  private workspaceRoots(): vscode.Uri[] {
    return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri);
  }

  // ---- Attachments ----

  private postAttachments(): void {
    this.post({ type: 'attachments', items: this.attachments });
  }

  /** Opens the native file/folder picker to attach items (used by the drop zone view). */
  async pickAttachments(): Promise<void> {
    await this.attachViaDialog();
  }

  /** Saves a clipboard-pasted image to storage and attaches it (vision/OCR pipeline applies). */
  private async attachPastedImage(dataBase64: string, mime: string): Promise<void> {
    const ext = mime.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
    const dir = vscode.Uri.joinPath(this.context.globalStorageUri, 'pastes');
    await vscode.workspace.fs.createDirectory(dir).then(undefined, () => undefined);
    const uri = vscode.Uri.joinPath(dir, `pasted-${Date.now()}.${ext}`);
    try {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(dataBase64, 'base64'));
      await this.attachUris([uri]);
      this.post({ type: 'status', text: 'Image attached from clipboard.' });
    } catch (e) {
      this.post({ type: 'error', text: `Could not attach pasted image: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  private async attachViaDialog(): Promise<void> {
    const picks = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: true,
      canSelectMany: true,
      openLabel: 'Attach to Nyx',
    });
    if (picks) {
      await this.attachUris(picks);
    }
  }

  private mediaOptions(): MediaOptions {
    const cfg = vscode.workspace.getConfiguration('nyx');
    return {
      visionUrl: resolveHelperUrl('visionOllamaUrl'),
      visionModel: cfg.get<string>('visionModel') ?? 'moondream',
      autoInstall: cfg.get<boolean>('autoInstallVisionModel') ?? true,
      enableOcr: cfg.get<boolean>('enableOcr') ?? true,
      cachePath: vscode.Uri.joinPath(this.context.globalStorageUri, 'tessdata').fsPath,
      onStatus: (t) => this.post({ type: 'status', text: t }),
    };
  }

  // ---- Machines ----

  private async postMachines(): Promise<void> {
    this.post({ type: 'machines', machines: await this.machines.getMachinesForUi() });
  }

  // ---- Session history ----

  private ensureSession(): void {
    if (!this.currentSessionId) {
      this.currentSessionId = `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      this.currentDisplay = [];
      this.addedLines = 0;
      this.removedLines = 0;
      this.changedFiles.clear();
      this.currentTitle = undefined;
      this.currentTitleAuto = false;
      this.currentModelKey = undefined;
      this.currentModelId = undefined;
      this.currentModelLabel = undefined;
      this.currentMachineName = undefined;
      this.currentMode = undefined;
    }
  }

  private postSessions(): void {
    this.post({ type: 'sessions', sessions: this.sessions.list(), currentId: this.currentSessionId });
  }

  private async persistCurrent(): Promise<void> {
    if (!this.currentSessionId) {
      return;
    }
    const firstUser = this.currentDisplay.find((d) => d.kind === 'user');
    const fallback = firstUser && firstUser.kind === 'user' ? firstUser.text.slice(0, 60) : 'New chat';
    const title = this.currentTitle?.trim() ? this.currentTitle : fallback;
    const record: StoredSession = {
      id: this.currentSessionId,
      title,
      titleAuto: this.currentTitleAuto,
      updatedAt: Date.now(),
      addedLines: this.addedLines,
      removedLines: this.removedLines,
      changedFilePaths: [...this.changedFiles],
      modelMessages: JSON.parse(JSON.stringify(this.session.getMessages())) as StoredSession['modelMessages'],
      display: this.currentDisplay.slice(),
      checkpoints: this.checkpoints.serialize(),
      plan: this.currentPlan,
      modelId: this.currentModelId,
      modelKey: this.currentModelKey,
      modelLabel: this.currentModelLabel,
      machineName: this.currentMachineName,
      mode: this.currentMode,
    };
    await this.sessions.save(record);
    this.captureMemory(title);
  }

  /** Renders the current chat as readable Markdown (export + clipboard handoff). */
  private buildSessionMarkdown(): string | undefined {
    if (this.currentDisplay.length === 0) {
      return undefined;
    }
    const title = this.currentTitle?.trim() || 'nyx-chat';
    const lines: string[] = [
      `# ${title}`,
      '',
      `> Exported from Nyx on ${new Date().toLocaleString()}${this.currentModelLabel ? ` · model: ${this.currentModelLabel}` : ''}${this.currentMachineName ? ` (${this.currentMachineName})` : ''}`,
      '',
    ];
    for (const item of this.currentDisplay) {
      switch (item.kind) {
        case 'user':
          lines.push('## 🧑 You', '', item.text, '');
          break;
        case 'assistant':
          lines.push('## 🌙 Nyx', '', item.text, '');
          break;
        case 'tool': {
          const summary = `${item.ok ? '✓' : '✗'} \`${item.name}\`${item.filePath ? ` — ${item.filePath}` : ''}${item.diff ? ` (+${item.diff.added} −${item.diff.removed})` : ''}`;
          lines.push('<details>', `<summary>${summary}</summary>`, '', '```', item.content.slice(0, 4000), '```', '', '</details>', '');
          break;
        }
        case 'question':
          lines.push(`> ❓ **${item.question}**`, `> ➡ ${item.answer}`, '');
          break;
        default: {
          const exhaustive: never = item;
          void exhaustive;
        }
      }
    }
    return lines.join('\n');
  }

  /** Exports the current chat as a readable Markdown file. */
  async exportCurrentSession(): Promise<void> {
    const markdown = this.buildSessionMarkdown();
    if (!markdown) {
      void vscode.window.showInformationMessage('Nyx: nothing to export — this chat is empty.');
      return;
    }
    const title = this.currentTitle?.trim() || 'nyx-chat';
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'nyx-chat';
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(this.workspaceRoot() ?? vscode.Uri.file(os.homedir()), `${slug}.md`),
      filters: { Markdown: ['md'] },
      saveLabel: 'Export chat',
    });
    if (!target) {
      return;
    }
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(markdown));
    await vscode.window.showTextDocument(target, { preview: true });
  }

  /** Copies the chat as Markdown to the clipboard — instant handoff to Cursor's agent, a PR, or a teammate. */
  async copySessionToClipboard(): Promise<void> {
    const markdown = this.buildSessionMarkdown();
    if (!markdown) {
      void vscode.window.showInformationMessage('Nyx: nothing to copy — this chat is empty.');
      return;
    }
    await vscode.env.clipboard.writeText(markdown);
    void vscode.window.showInformationMessage('Nyx: chat copied to the clipboard as Markdown.');
  }

  /**
   * Inline quick edit (Cmd+K-style): selection + instruction → model rewrite →
   * native diff confirmation → applied through the standard write machinery
   * (checkpoint, backup, WorkspaceEdit) — no chat roundtrip.
   */
  async quickEdit(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      void vscode.window.showInformationMessage('Nyx: select the code you want to change first.');
      return;
    }
    if (this.models.length === 0) {
      await this.refreshModels();
    }
    const model = this.findModel(this.selectedKey) ?? this.models[0];
    if (!model) {
      void vscode.window.showInformationMessage('Nyx: no local model available — start Ollama or LM Studio first.');
      return;
    }
    const instruction = await vscode.window.showInputBox({
      prompt: `Nyx quick edit with ${model.label} — what should change?`,
      placeHolder: 'e.g. add error handling · extract a helper · convert to async/await',
    });
    if (!instruction?.trim()) {
      return;
    }
    const doc = editor.document;
    const selRange = new vscode.Range(editor.selection.start, editor.selection.end);
    const selected = doc.getText(selRange);
    const relPath = vscode.workspace.asRelativePath(doc.uri);
    this.networkLog.record(model.endpoint, 'model inference');
    let replacement: string;
    try {
      replacement = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Nyx: editing ${relPath}…` },
        async () => {
          const result = await streamChat(
            {
              endpoint: model.endpoint,
              apiKey: model.apiKey,
              model: model.id,
              messages: [
                {
                  role: 'system',
                  content:
                    'You rewrite the selected code exactly as instructed. Reply with ONLY the replacement code — no markdown fences, no explanations. Preserve the indentation style of the original.',
                },
                { role: 'user', content: `File: ${relPath}\nInstruction: ${instruction.trim()}\n\nSelected code:\n${selected}` },
              ],
              temperature: 0,
              maxTokens: 4096,
              signal: AbortSignal.timeout(180000),
            },
            { onDelta: () => {} },
          );
          return stripSpecialTokens(result.content).trim().replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '');
        },
      );
    } catch (e) {
      void vscode.window.showErrorMessage(`Nyx quick edit failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (!replacement.trim() || replacement === selected) {
      void vscode.window.showInformationMessage('Nyx: the model produced no change.');
      return;
    }
    const before = doc.getText();
    const after = before.slice(0, doc.offsetAt(selRange.start)) + replacement + before.slice(doc.offsetAt(selRange.end));
    const diff = summarizeDiff(before, after);
    const choice = await vscode.window.showInformationMessage(
      `Apply Nyx quick edit to ${relPath}? (+${diff.added} −${diff.removed})`,
      { modal: true, detail: diff.preview.slice(0, 14).join('\n') },
      'Apply',
    );
    if (choice !== 'Apply') {
      return;
    }
    // Standard edit machinery: checkpoint + backup + WorkspaceEdit + shrink guard.
    this.checkpoints.begin(this.session.getMessages().length);
    const ctx: ToolContext = {
      workspaceRoots: this.workspaceRoots(),
      skills: [],
      rules: [],
      backupDir: vscode.Uri.joinPath(this.context.globalStorageUri, 'backups').fsPath,
      processes: this.processes,
      recordCheckpointFile: (p, content) => this.checkpoints.recordFile(p, content),
    };
    const outcome = await executeTool('write_file', JSON.stringify({ path: relPath, content: after }), ctx);
    if (outcome.ok) {
      void vscode.window.setStatusBarMessage(`Nyx: applied quick edit to ${relPath} (+${diff.added} −${diff.removed})`, 4000);
      await this.postReview();
    } else {
      void vscode.window.showErrorMessage(`Nyx quick edit failed: ${outcome.content}`);
    }
  }

  /**
   * Distills the current session into a project-memory entry. A small
   * utility-model call condenses goal + outcome + gotchas; the heuristic
   * (last assistant answer) remains the offline fallback.
   */
  private captureMemory(title: string): void {
    if (!this.currentSessionId) {
      return;
    }
    const enabled = vscode.workspace.getConfiguration('nyx').get<boolean>('memoryEnabled') ?? true;
    if (!enabled) {
      return;
    }
    const hasAssistant = this.currentDisplay.some((d) => d.kind === 'assistant' && d.text.trim().length > 0);
    if (!hasAssistant && this.changedFiles.size === 0) {
      return;
    }
    const lastAssistant = [...this.currentDisplay].reverse().find((d) => d.kind === 'assistant');
    const userGoals = this.currentDisplay
      .filter((d): d is Extract<DisplayItem, { kind: 'user' }> => d.kind === 'user')
      .map((d) => d.text.trim())
      .filter(Boolean);
    const outcome =
      lastAssistant && lastAssistant.kind === 'assistant' && lastAssistant.text.trim()
        ? lastAssistant.text.trim()
        : userGoals.join(' • ');
    const heuristic = outcome.length > 700 ? `${outcome.slice(0, 700)}…` : outcome;
    // Only re-distill when the transcript actually grew (persistCurrent runs often).
    const fingerprint = `${this.currentSessionId}:${this.currentDisplay.length}`;
    if (this.lastMemoryCapture === fingerprint) {
      return;
    }
    this.lastMemoryCapture = fingerprint;
    void this.distillMemory(this.currentSessionId, title || 'Session', userGoals, heuristic);
  }

  /** Model-based session distillation with the heuristic summary as fallback. */
  private async distillMemory(sessionId: string, title: string, userGoals: string[], fallback: string): Promise<void> {
    let summary = fallback;
    const model = this.utilityModel() ?? this.findModel(this.selectedKey);
    if (model && !this.busy) {
      try {
        const lastAssistant = [...this.currentDisplay].reverse().find((d) => d.kind === 'assistant');
        const context = [
          `User goals:\n${userGoals.join('\n').slice(0, 2000)}`,
          lastAssistant && lastAssistant.kind === 'assistant' ? `Final assistant answer:\n${lastAssistant.text.slice(0, 3000)}` : '',
          this.changedFiles.size > 0 ? `Files changed: ${[...this.changedFiles].slice(0, 12).join(', ')}` : '',
        ]
          .filter(Boolean)
          .join('\n\n');
        const result = await streamChat(
          {
            endpoint: model.endpoint,
            apiKey: model.apiKey,
            model: model.id,
            messages: [
              {
                role: 'system',
                content:
                  'Distill this coding session into a 2-4 sentence memory for future sessions: what was the goal, what was actually done/decided, and any gotcha worth remembering. Plain text only — no markdown, no preamble.',
              },
              { role: 'user', content: context },
            ],
            temperature: 0,
            maxTokens: 220,
            signal: AbortSignal.timeout(45000),
          },
          { onDelta: () => {} },
        );
        const clean = stripSpecialTokens(result.content).trim();
        if (clean) {
          summary = clean.length > 700 ? `${clean.slice(0, 700)}…` : clean;
        }
      } catch {
        // Utility model unavailable — the heuristic summary still lands.
      }
    }
    if (this.currentSessionId !== sessionId) {
      return; // the user switched chats while we were distilling
    }
    await this.memory.upsertAuto(sessionId, title, summary, [...this.changedFiles]);
    this.postMemories();
  }

  private postMemories(): void {
    this.post({ type: 'memories', entries: this.memory.all() });
  }

  private async loadSession(id: string): Promise<void> {
    const stored = await this.sessions.get(id);
    if (!stored) {
      return;
    }
    this.cancelRun();
    this.session.loadMessages(stored.modelMessages);
    this.checkpoints.load(stored.checkpoints);
    this.sessionAllow.clear();
    this.networkLog.clear();
    this.lastMemoryCapture = undefined;
    this.currentSessionId = stored.id;
    this.currentTitle = stored.title;
    this.currentTitleAuto = stored.titleAuto === true;
    this.currentDisplay = stored.display.slice();
    this.addedLines = stored.addedLines;
    this.removedLines = stored.removedLines ?? 0;
    this.changedFiles.clear();
    for (const p of stored.changedFilePaths) {
      this.changedFiles.add(p);
    }
    this.currentModelKey = stored.modelKey ?? stored.modelId;
    this.currentModelId = stored.modelId;
    this.currentModelLabel = stored.modelLabel;
    this.currentMachineName = stored.machineName;
    this.currentMode = stored.mode;
    this.currentPlan = stored.plan ?? [];
    this.post({ type: 'plan', items: this.currentPlan });
    // Re-select the model this chat used, if it is still available, so continuing
    // the conversation keeps the same agent.
    const match = this.findModel(this.currentModelKey);
    if (match) {
      this.selectedKey = match.key;
      this.post({ type: 'models', models: this.models, selectedKey: this.selectedKey });
    }
    this.post({ type: 'sessionLoaded', items: stored.display, mode: stored.mode });
    this.post({ type: 'busy', busy: false });
    const model = this.findModel(this.selectedKey) ?? this.models[0];
    const budget = this.budgetFor(model);
    this.post({ type: 'context', usedTokens: this.session.estimateTokens(), budgetTokens: budget });
    this.postSessions();
  }

  private async deleteSession(id: string): Promise<void> {
    await this.sessions.remove(id);
    if (this.currentSessionId === id) {
      this.newChat();
    } else {
      this.postSessions();
    }
  }

  /** "Close other chats" from the tab context menu. Closing a tab deletes the chat, so confirm first. */
  private async deleteOtherSessions(keepId: string): Promise<void> {
    const others = this.sessions.list().filter((m) => m.id !== keepId);
    if (others.length === 0) {
      return;
    }
    const confirmLabel = 'Delete';
    const choice = await vscode.window.showWarningMessage(
      `Close ${others.length} other chat${others.length === 1 ? '' : 's'}? They are deleted from the history permanently.`,
      { modal: true },
      confirmLabel,
    );
    if (choice !== confirmLabel) {
      return;
    }
    for (const meta of others) {
      await this.sessions.remove(meta.id);
    }
    if (this.currentSessionId && this.currentSessionId !== keepId) {
      // The active chat was among the deleted ones — switch to the kept tab.
      await this.loadSession(keepId);
    } else {
      this.postSessions();
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.css'));
    const katexCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'katex.min.css'));
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${katexCssUri}" rel="stylesheet" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Nyx</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
