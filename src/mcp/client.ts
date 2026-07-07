import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';

/** One configured MCP server (stdio via command, or HTTP via url). */
export interface McpServerConfig {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface McpToolInfo {
  server: string;
  name: string;
  description: string;
  inputSchema: unknown;
}

interface JsonRpcResponse {
  id?: number | string;
  result?: any;
  error?: { code: number; message: string };
  method?: string;
}

const PROTOCOL_VERSION = '2025-03-26';
const INIT_TIMEOUT_MS = 15000;
const LIST_TIMEOUT_MS = 15000;
const CALL_TIMEOUT_MS = 120000;

/**
 * Reads MCP server definitions from Cursor's config files (global
 * `~/.cursor/mcp.json` + workspace `.cursor/mcp.json`) merged with the
 * `nyx.mcpServers` setting. Workspace entries win over global ones.
 */
export async function loadMcpConfigs(
  workspaceRoot: string | undefined,
  settingServers: Record<string, unknown> | undefined,
): Promise<McpServerConfig[]> {
  const byName = new Map<string, McpServerConfig>();

  const addFile = async (file: string): Promise<void> => {
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch {
      return;
    }
    try {
      const data = JSON.parse(raw) as { mcpServers?: Record<string, any> };
      for (const [name, cfg] of Object.entries(data.mcpServers ?? {})) {
        if (!cfg || typeof cfg !== 'object') {
          continue;
        }
        byName.set(name, {
          name,
          command: typeof cfg.command === 'string' ? cfg.command : undefined,
          args: Array.isArray(cfg.args) ? cfg.args.map(String) : undefined,
          env: cfg.env && typeof cfg.env === 'object' ? cfg.env : undefined,
          url: typeof cfg.url === 'string' ? cfg.url : undefined,
          headers: cfg.headers && typeof cfg.headers === 'object' ? cfg.headers : undefined,
        });
      }
    } catch {
      // Malformed config — skip silently, matching Cursor's tolerance.
    }
  };

  await addFile(path.join(os.homedir(), '.cursor', 'mcp.json'));
  if (workspaceRoot) {
    await addFile(path.join(workspaceRoot, '.cursor', 'mcp.json'));
  }
  for (const [name, cfg] of Object.entries(settingServers ?? {})) {
    if (cfg && typeof cfg === 'object') {
      const c = cfg as Record<string, any>;
      byName.set(name, {
        name,
        command: typeof c.command === 'string' ? c.command : undefined,
        args: Array.isArray(c.args) ? c.args.map(String) : undefined,
        env: c.env && typeof c.env === 'object' ? c.env : undefined,
        url: typeof c.url === 'string' ? c.url : undefined,
        headers: c.headers && typeof c.headers === 'object' ? c.headers : undefined,
      });
    }
  }
  return [...byName.values()].filter((c) => c.command || c.url);
}

/** Extracts readable text from an MCP tools/call result. */
function contentToText(result: any): string {
  if (!result) {
    return '';
  }
  if (Array.isArray(result.content)) {
    const parts: string[] = [];
    for (const item of result.content) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      if (item.type === 'text' && typeof item.text === 'string') {
        parts.push(item.text);
      } else if (item.type === 'resource' && item.resource?.text) {
        parts.push(String(item.resource.text));
      } else if (item.type === 'image') {
        parts.push('[image result omitted]');
      }
    }
    return parts.join('\n');
  }
  return typeof result === 'string' ? result : JSON.stringify(result);
}

/** A single MCP server connection (stdio or streamable HTTP). */
class McpConnection {
  private proc?: ChildProcess;
  private nextId = 1;
  private readonly pending = new Map<number | string, { resolve: (r: JsonRpcResponse) => void; timer: NodeJS.Timeout }>();
  private stdoutBuffer = '';
  private sessionId?: string;
  private initialized = false;

  constructor(
    readonly config: McpServerConfig,
    private readonly onLog: (text: string) => void,
  ) {}

  get name(): string {
    return this.config.name;
  }

  async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }
    if (this.config.command) {
      this.startStdio();
    }
    const result = await this.request(
      'initialize',
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'nyx-local-ai', version: '0.28.1' },
      },
      INIT_TIMEOUT_MS,
    );
    if (result.error) {
      throw new Error(`initialize failed: ${result.error.message}`);
    }
    await this.notify('notifications/initialized', {});
    this.initialized = true;
  }

  async listTools(): Promise<McpToolInfo[]> {
    await this.ensureInitialized();
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const res = await this.request('tools/list', cursor ? { cursor } : {}, LIST_TIMEOUT_MS);
      if (res.error) {
        throw new Error(`tools/list failed: ${res.error.message}`);
      }
      for (const t of res.result?.tools ?? []) {
        if (t && typeof t.name === 'string') {
          tools.push({
            server: this.name,
            name: t.name,
            description: typeof t.description === 'string' ? t.description : '',
            inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
          });
        }
      }
      cursor = res.result?.nextCursor;
      if (!cursor) {
        break;
      }
    }
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; content: string }> {
    await this.ensureInitialized();
    const res = await this.request('tools/call', { name, arguments: args }, CALL_TIMEOUT_MS);
    if (res.error) {
      return { ok: false, content: `MCP error: ${res.error.message}` };
    }
    const text = contentToText(res.result);
    const isError = res.result?.isError === true;
    return { ok: !isError, content: text || (isError ? '(tool reported an error)' : '(empty result)') };
  }

  dispose(): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
    }
    this.pending.clear();
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        // already gone
      }
      this.proc = undefined;
    }
    this.initialized = false;
  }

  // ---- stdio transport ----

  private startStdio(): void {
    if (this.proc) {
      return;
    }
    const proc = spawn(this.config.command as string, this.config.args ?? [], {
      env: { ...process.env, ...(this.config.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;
    proc.stdout?.on('data', (data: Buffer) => this.onStdout(data.toString()));
    proc.stderr?.on('data', (data: Buffer) => this.onLog(`[${this.name}] ${data.toString().trim()}`));
    proc.on('error', (e) => this.failAll(`server process error: ${e.message}`));
    proc.on('close', () => {
      this.failAll('server process exited');
      this.proc = undefined;
      this.initialized = false;
    });
  }

  private onStdout(text: string): void {
    this.stdoutBuffer += text;
    let idx: number;
    while ((idx = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, idx).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
      if (!line) {
        continue;
      }
      try {
        this.handleMessage(JSON.parse(line) as JsonRpcResponse);
      } catch {
        // Non-JSON noise on stdout — ignore.
      }
    }
  }

  private handleMessage(msg: JsonRpcResponse): void {
    if (msg.id === undefined || msg.id === null) {
      return; // notification from server
    }
    const entry = this.pending.get(msg.id);
    if (entry) {
      clearTimeout(entry.timer);
      this.pending.delete(msg.id);
      entry.resolve(msg);
    }
  }

  private failAll(reason: string): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.resolve({ id, error: { code: -1, message: reason } });
    }
  }

  // ---- request plumbing (both transports) ----

  private async request(method: string, params: unknown, timeoutMs: number): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const message = { jsonrpc: '2.0', id, method, params };
    if (this.config.command) {
      return new Promise<JsonRpcResponse>((resolve) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          resolve({ id, error: { code: -2, message: `timeout after ${timeoutMs}ms (${method})` } });
        }, timeoutMs);
        this.pending.set(id, { resolve, timer });
        this.proc?.stdin?.write(`${JSON.stringify(message)}\n`);
      });
    }
    return this.httpRequest(message, timeoutMs);
  }

  private async notify(method: string, params: unknown): Promise<void> {
    const message = { jsonrpc: '2.0', method, params };
    if (this.config.command) {
      this.proc?.stdin?.write(`${JSON.stringify(message)}\n`);
      return;
    }
    await this.httpRequest(message, 5000, true).catch(() => undefined);
  }

  /** Streamable-HTTP transport: POST JSON-RPC; response is JSON or an SSE stream. */
  private async httpRequest(message: Record<string, unknown>, timeoutMs: number, isNotification = false): Promise<JsonRpcResponse> {
    const url = this.config.url as string;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
          ...(this.config.headers ?? {}),
        },
        body: JSON.stringify(message),
        signal: controller.signal,
      });
      const session = res.headers.get('mcp-session-id');
      if (session) {
        this.sessionId = session;
      }
      if (isNotification) {
        return {};
      }
      if (!res.ok) {
        return { error: { code: res.status, message: `HTTP ${res.status} ${res.statusText}` } };
      }
      const contentType = res.headers.get('content-type') ?? '';
      if (contentType.includes('text/event-stream')) {
        return await this.readSseResponse(res, message.id as number);
      }
      const body = await res.text();
      return body ? (JSON.parse(body) as JsonRpcResponse) : {};
    } catch (e) {
      const msg = e instanceof Error ? (e.name === 'AbortError' ? 'timed out' : e.message) : String(e);
      return { error: { code: -3, message: msg } };
    } finally {
      clearTimeout(timer);
    }
  }

  private async readSseResponse(res: Response, id: number): Promise<JsonRpcResponse> {
    if (!res.body) {
      return { error: { code: -4, message: 'empty SSE body' } };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) {
          continue;
        }
        try {
          const msg = JSON.parse(line.slice(5).trim()) as JsonRpcResponse;
          if (msg.id === id) {
            void reader.cancel().catch(() => undefined);
            return msg;
          }
        } catch {
          // keep reading
        }
      }
    }
    return { error: { code: -5, message: 'SSE stream ended without a response' } };
  }
}

export interface McpWireTool {
  /** Name offered to the model (sanitized, e.g. "mcp_codebase-memory-mcp_search_code"). */
  wireName: string;
  server: string;
  tool: string;
  /** Permission key: `mcp:<server>/<tool>`. */
  permissionKey: string;
  description: string;
  inputSchema: unknown;
}

function wireNameFor(server: string, tool: string): string {
  const raw = `mcp_${server}_${tool}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  return raw.length > 64 ? raw.slice(0, 64) : raw;
}

/**
 * Manages all configured MCP servers: lazy connections, a cached tool
 * inventory, and tool-call routing.
 */
export class McpManager {
  private readonly connections = new Map<string, McpConnection>();
  private tools: McpWireTool[] = [];
  private loading: Promise<void> | undefined;
  private lastError = new Map<string, string>();

  constructor(private readonly onLog: (text: string) => void) {}

  /** (Re)connects to the configured servers and refreshes the tool inventory. */
  async refresh(configs: McpServerConfig[]): Promise<void> {
    // Drop connections whose config vanished or changed.
    const wanted = new Map(configs.map((c) => [c.name, c]));
    for (const [name, conn] of this.connections) {
      const cfg = wanted.get(name);
      if (!cfg || JSON.stringify(cfg) !== JSON.stringify(conn.config)) {
        conn.dispose();
        this.connections.delete(name);
      }
    }
    for (const cfg of configs) {
      if (!this.connections.has(cfg.name)) {
        this.connections.set(cfg.name, new McpConnection(cfg, this.onLog));
      }
    }
    this.loading = this.loadTools();
    await this.loading;
  }

  private async loadTools(): Promise<void> {
    const all: McpWireTool[] = [];
    await Promise.all(
      [...this.connections.values()].map(async (conn) => {
        try {
          const tools = await conn.listTools();
          this.lastError.delete(conn.name);
          for (const t of tools) {
            all.push({
              wireName: wireNameFor(t.server, t.name),
              server: t.server,
              tool: t.name,
              permissionKey: `mcp:${t.server}/${t.name}`,
              description: t.description,
              inputSchema: t.inputSchema,
            });
          }
        } catch (e) {
          this.lastError.set(conn.name, e instanceof Error ? e.message : String(e));
          this.onLog(`[${conn.name}] tool discovery failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }),
    );
    this.tools = all;
  }

  getTools(): McpWireTool[] {
    return this.tools;
  }

  errors(): Map<string, string> {
    return this.lastError;
  }

  findByWireName(wireName: string): McpWireTool | undefined {
    return this.tools.find((t) => t.wireName === wireName);
  }

  async call(server: string, tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; content: string }> {
    const conn = this.connections.get(server);
    if (!conn) {
      return { ok: false, content: `MCP server "${server}" is not configured.` };
    }
    try {
      return await conn.callTool(tool, args);
    } catch (e) {
      return { ok: false, content: `MCP call failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  disposeAll(): void {
    for (const conn of this.connections.values()) {
      conn.dispose();
    }
    this.connections.clear();
    this.tools = [];
  }
}
