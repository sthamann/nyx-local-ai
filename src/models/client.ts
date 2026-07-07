import type { ChatMessage, ToolSchema } from '../types';

export interface StreamHandlers {
  onDelta: (text: string) => void;
  /** Reasoning/thinking text (from a `reasoning_content` field or <think> tags). */
  onReasoning?: (text: string) => void;
}

export interface ChatParams {
  endpoint: string;
  apiKey?: string;
  model: string;
  messages: ChatMessage[];
  tools?: ToolSchema[];
  signal?: AbortSignal;
  /**
   * Many local models (e.g. qwen2.5-coder via Ollama) emit tool calls as a raw
   * JSON object in the assistant content instead of the OpenAI `tool_calls`
   * field. When enabled, such content is detected, suppressed from the visible
   * stream, and converted into tool calls.
   */
  extractToolCallsFromContent?: boolean;
  /** Valid tool names, used to avoid misreading a plain JSON answer as a call. */
  toolNames?: string[];
  /** Sampling temperature (applies to all OpenAI-compatible endpoints). */
  temperature?: number;
  /** Generation cap sent as `max_tokens` (guards against runaway generations). */
  maxTokens?: number;
  /** Ollama-only context length, sent via `options.num_ctx`. */
  ollamaNumCtx?: number;
  /**
   * Aborts the stream when the model gets stuck in a degenerate repetition loop
   * (e.g. "cache cache cache …"). Small local models fall into these; the
   * `max_tokens` cap alone lets them spew for minutes before stopping.
   */
  detectRepetition?: boolean;
}

export interface ParsedToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface StreamStats {
  /** Number of generated tokens (from server usage, or estimated from length). */
  completionTokens: number;
  /** Prompt tokens reported by the server, if any — exact context usage. */
  promptTokens?: number;
  /** Generation time in ms (first token → done), used for tok/s. */
  generationMs: number;
  /** Generation speed in tokens per second. */
  tokensPerSecond?: number;
  /** True when the token count is estimated rather than reported by the server. */
  estimated: boolean;
}

export interface AssistantResult {
  content: string;
  toolCalls: ParsedToolCall[];
  stats: StreamStats;
  /** True when the stream was cut short because the model was looping (#repetition guard). */
  stoppedForRepetition: boolean;
}

function randomId(): string {
  return `call_${Math.random().toString(36).slice(2, 10)}`;
}

function stripFences(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

/**
 * Best-effort repair of the sloppy JSON local models tend to emit: single
 * quotes, trailing commas, Python literals. Only used after strict parsing fails.
 */
export function repairJson(text: string): string {
  let s = text.trim();
  // Python-style literals outside of strings.
  s = s.replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null');
  // Trailing commas before a closing bracket.
  s = s.replace(/,\s*([}\]])/g, '$1');
  return s;
}

export function parseJsonLoose(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    // continue with repairs
  }
  try {
    return JSON.parse(repairJson(text));
  } catch {
    return undefined;
  }
}

function toParsedCalls(data: unknown, toolNames?: string[]): ParsedToolCall[] | null {
  const items = Array.isArray(data) ? data : [data];
  const calls: ParsedToolCall[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const record = item as Record<string, unknown>;
    const name = record.name ?? record.tool ?? record.function;
    if (typeof name !== 'string') {
      continue;
    }
    if (toolNames && toolNames.length > 0 && !toolNames.includes(name)) {
      return null;
    }
    const rawArgs = record.arguments ?? record.parameters ?? record.args ?? {};
    const argString = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs);
    calls.push({ id: randomId(), name, arguments: argString });
  }
  return calls.length > 0 ? calls : null;
}

/** Attempts to read tool calls that a model embedded as JSON in its content. */
function parseToolCallsFromContent(content: string, toolNames?: string[]): ParsedToolCall[] | null {
  const text = stripFences(content);
  if (!(text.startsWith('{') || text.startsWith('['))) {
    return null;
  }
  const data = parseJsonLoose(text);
  if (data === undefined) {
    return null;
  }
  return toParsedCalls(data, toolNames);
}

/** Finds a balanced JSON object starting at `start` ('{'), tolerant of strings. */
function scanJsonObject(text: string, start: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') {
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

export interface EmbeddedCallsResult {
  calls: ParsedToolCall[];
  /** The content with the embedded call blocks removed (surrounding prose kept). */
  strippedContent: string;
}

/**
 * Detects tool calls embedded *inside* prose, e.g.
 * "I'll read the file now: ```json {"name":"read_file",...}```".
 * Only JSON objects whose `name` is a known tool are treated as calls; the
 * surrounding prose is preserved as the visible assistant text.
 */
export function extractEmbeddedToolCalls(content: string, toolNames?: string[]): EmbeddedCallsResult | null {
  if (!toolNames || toolNames.length === 0) {
    return null;
  }
  const calls: ParsedToolCall[] = [];
  const removals: Array<{ start: number; end: number }> = [];

  // Pass 1: fenced ```json blocks anywhere in the message.
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  let fm: RegExpExecArray | null;
  while ((fm = fenceRe.exec(content))) {
    const inner = fm[1].trim();
    if (!inner.startsWith('{') && !inner.startsWith('[')) {
      continue;
    }
    const data = parseJsonLoose(inner);
    const parsed = data === undefined ? null : toParsedCalls(data, toolNames);
    if (parsed && parsed.length > 0) {
      calls.push(...parsed);
      removals.push({ start: fm.index, end: fm.index + fm[0].length });
    }
  }

  // Pass 2: bare {"name": "<tool>" ...} objects outside of fences.
  if (calls.length === 0) {
    const bareRe = /\{\s*["']?(?:name|tool|function)["']?\s*:/g;
    let bm: RegExpExecArray | null;
    while ((bm = bareRe.exec(content))) {
      const json = scanJsonObject(content, bm.index);
      if (!json) {
        continue;
      }
      const data = parseJsonLoose(json);
      const parsed = data === undefined ? null : toParsedCalls(data, toolNames);
      if (parsed && parsed.length > 0) {
        calls.push(...parsed);
        removals.push({ start: bm.index, end: bm.index + json.length });
        bareRe.lastIndex = bm.index + json.length;
      }
    }
  }

  if (calls.length === 0) {
    return null;
  }
  let stripped = '';
  let cursor = 0;
  for (const r of removals.sort((a, b) => a.start - b.start)) {
    stripped += content.slice(cursor, r.start);
    cursor = r.end;
  }
  stripped += content.slice(cursor);
  return { calls, strippedContent: stripped.trim() };
}

// ---- DeepSeek DSML tool calls (V3.2 "function_calls" / V4 "tool_calls") ----
//
// DeepSeek V3.2/V4 emit tool calls as DSML markup. When the serving gateway
// has no DSML parser configured, the raw block arrives inside the assistant
// content:
//   <｜DSML｜tool_calls>
//   <｜DSML｜invoke name="read_file">
//   <｜DSML｜parameter name="path" string="true">src/a.ts</｜DSML｜parameter>
//   </｜DSML｜invoke>
//   </｜DSML｜tool_calls>
// `string="true"` means raw string; `string="false"` means JSON value.

const DSML_BAR = '\uFF5C'; // fullwidth ｜ used by DeepSeek special tokens

/**
 * Matches DSML markup starting anywhere — opening or closing form, fullwidth
 * or ASCII pipes, with optional stray spaces from detokenization.
 */
const DSML_MARKER_RE = new RegExp(`<\\/?\\s?[|${DSML_BAR}]\\s?DSML`, 'i');

/** Normalizes ASCII-pipe / spaced variants to the canonical fullwidth form. */
function normalizeDsml(text: string): string {
  return text
    .replace(new RegExp(`<\\s?[|${DSML_BAR}]\\s?DSML\\s?[|${DSML_BAR}]\\s?`, 'g'), `<${DSML_BAR}DSML${DSML_BAR}`)
    .replace(new RegExp(`<\\/\\s?[|${DSML_BAR}]\\s?DSML\\s?[|${DSML_BAR}]\\s?`, 'g'), `</${DSML_BAR}DSML${DSML_BAR}`);
}

/**
 * Removes model special tokens that must never survive into transcripts,
 * tool results, or memory: DSML markup fragments (even orphan closing tags)
 * and DeepSeek control tokens like <｜end▁of▁sentence｜>. Leaked tokens are
 * dangerous beyond looks — once stored (e.g. in project memory) they poison
 * future prompts and the model starts imitating the broken pattern.
 */
export function stripSpecialTokens(text: string): string {
  if (!text || !(text.includes(DSML_BAR) || /DSML/i.test(text) || text.includes('\u2581'))) {
    return text;
  }
  let s = normalizeDsml(text);
  // Fullwidth-bar special tokens: <｜…｜> and </｜…｜…> (name + optional suffix).
  s = s.replace(new RegExp(`<\\/?${DSML_BAR}[^${DSML_BAR}\\n]{0,60}${DSML_BAR}[^<>\\n]{0,40}>`, 'g'), '');
  // ASCII DSML leftovers.
  s = s.replace(/<\/?\s?\|\s?DSML\s?\|[^<>\n]{0,40}>/gi, '');
  // ASCII variants of DeepSeek control tokens (▁ = U+2581).
  s = s.replace(/<\|[^|<>\n]{0,60}\|>/g, (m) => (/\u2581|DSML|sentence/i.test(m) ? '' : m));
  return s;
}

/**
 * Parses DSML tool-call blocks out of assistant content. Returns the calls and
 * the content with the blocks (and stray DeepSeek special tokens) removed.
 */
export function parseDsmlToolCalls(content: string): EmbeddedCallsResult | null {
  if (!content.includes('DSML')) {
    return null;
  }
  const text = normalizeDsml(content);
  const blockRe = new RegExp(
    `<${DSML_BAR}DSML${DSML_BAR}(?:tool_calls|function_calls)>([\\s\\S]*?)(?:</${DSML_BAR}DSML${DSML_BAR}(?:tool_calls|function_calls)>|$)`,
    'g',
  );

  const parseInvokes = (block: string): ParsedToolCall[] => {
    const out: ParsedToolCall[] = [];
    const invokeRe = new RegExp(
      `<${DSML_BAR}DSML${DSML_BAR}invoke\\s+name="([^"]+)"\\s*>([\\s\\S]*?)(?:</${DSML_BAR}DSML${DSML_BAR}invoke>|$)`,
      'g',
    );
    let im: RegExpExecArray | null;
    while ((im = invokeRe.exec(block))) {
      const args: Record<string, unknown> = {};
      const paramRe = new RegExp(
        `<${DSML_BAR}DSML${DSML_BAR}parameter\\s+name="([^"]+)"(?:\\s+string="(true|false)")?\\s*>([\\s\\S]*?)</${DSML_BAR}DSML${DSML_BAR}parameter>`,
        'g',
      );
      let pm: RegExpExecArray | null;
      while ((pm = paramRe.exec(im[2]))) {
        const [, key, isString, raw] = pm;
        if (isString === 'false') {
          const parsed = parseJsonLoose(raw.trim());
          args[key] = parsed === undefined ? raw.trim() : parsed;
        } else {
          args[key] = raw;
        }
      }
      out.push({ id: randomId(), name: im[1], arguments: JSON.stringify(args) });
    }
    return out;
  };

  const calls: ParsedToolCall[] = [];
  let stripped = '';
  let cursor = 0;
  let bm: RegExpExecArray | null;
  while ((bm = blockRe.exec(text))) {
    stripped += text.slice(cursor, bm.index);
    cursor = bm.index + bm[0].length;
    calls.push(...parseInvokes(bm[1]));
  }
  stripped += text.slice(cursor);

  // Fallback: invoke blocks without the outer tool_calls wrapper (some
  // gateways split the block between reasoning and content).
  if (calls.length === 0) {
    calls.push(...parseInvokes(text));
    if (calls.length === 0) {
      return null;
    }
    stripped = text.replace(
      new RegExp(`<${DSML_BAR}DSML${DSML_BAR}invoke\\s[\\s\\S]*?(?:</${DSML_BAR}DSML${DSML_BAR}invoke>|$)`, 'g'),
      '',
    );
  }
  return { calls, strippedContent: stripSpecialTokens(stripped).trim() };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Splits `a="x", b=[1,2], c="y,z"` on top-level commas, respecting quotes/brackets. */
function splitTopLevelArgs(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      cur += ch;
      if (ch === quote && inner[i - 1] !== '\\') {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '[' || ch === '{' || ch === '(') {
      depth++;
    } else if (ch === ']' || ch === '}' || ch === ')') {
      depth--;
    }
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim().length > 0) {
    parts.push(cur);
  }
  return parts;
}

/** Coerces a Python/JS-ish literal (string, array, number, bool, null) into a value. */
function parseArgValue(raw: string): unknown {
  const t = raw.trim();
  if (t.length === 0) {
    return '';
  }
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t
      .slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'")
      .replace(/\\\\/g, '\\');
  }
  if (t.startsWith('[') || t.startsWith('{')) {
    const parsed = parseJsonLoose(t) ?? parseJsonLoose(t.replace(/'/g, '"'));
    return parsed === undefined ? t : parsed;
  }
  if (t === 'true' || t === 'True') {
    return true;
  }
  if (t === 'false' || t === 'False') {
    return false;
  }
  if (t === 'null' || t === 'None') {
    return null;
  }
  const num = Number(t);
  if (!Number.isNaN(num)) {
    return num;
  }
  return t;
}

/**
 * Parses a Python/JS-style function call that a model emitted as plain text,
 * e.g. `ask_user(question="…", type="text")`. Only matches known tool names and
 * only when the whole message is a single call, to avoid false positives.
 */
export function parseFunctionCallsFromContent(content: string, toolNames?: string[]): ParsedToolCall[] | null {
  if (!toolNames || toolNames.length === 0) {
    return null;
  }
  const text = stripFences(content).trim();
  const names = toolNames.map(escapeRegExp).join('|');
  const match = text.match(new RegExp(`^(${names})\\s*\\(([\\s\\S]*)\\)[\\s.]*$`));
  if (!match) {
    return null;
  }
  const args: Record<string, unknown> = {};
  for (const part of splitTopLevelArgs(match[2].trim())) {
    const eq = part.indexOf('=');
    if (eq < 0) {
      continue;
    }
    const key = part.slice(0, eq).trim();
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
      continue;
    }
    args[key] = parseArgValue(part.slice(eq + 1));
  }
  return [{ id: randomId(), name: match[1], arguments: JSON.stringify(args) }];
}

/** True while `lead` is a plain identifier that could still grow into `knownTool(`. */
function couldBeToolCallPrefix(lead: string, toolNames?: string[]): boolean {
  if (!toolNames || toolNames.length === 0 || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(lead)) {
    return false;
  }
  return toolNames.some((name) => name === lead || name.startsWith(lead));
}

/** True when `lead` already begins with `knownTool(`. */
function startsWithToolCall(lead: string, toolNames?: string[]): boolean {
  if (!toolNames || toolNames.length === 0) {
    return false;
  }
  const match = lead.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/);
  return match ? toolNames.includes(match[1]) : false;
}

// ---- Runaway-repetition guard ----
//
// Small local models frequently collapse into degenerate loops — the same word
// or phrase over and over ("cache cache cache …", or a line repeated verbatim).
// The `max_tokens` cap eventually stops them, but at ~50 tok/s that is minutes
// of garbage. We watch the accumulated content and cut the stream the moment
// the tail is overwhelmingly repetitive. Thresholds are deliberately high so
// normal (even list-heavy) answers never trip it; short answers are exempt.

/** Below this length we never judge — short answers can be legitimately terse. */
const REPEAT_MIN_LEN = 1200;
/** Only the trailing window is inspected, so early prose can't dilute the signal. */
const REPEAT_TAIL = 1600;

/**
 * Detects a runaway repetition loop in generated text. Two independent signals:
 *  A) a short unit repeated back-to-back at the tail's end (verbatim loops), and
 *  B) a single whitespace token dominating the tail (word-level loops like
 *     "cache cache cache" whose surrounding words still vary).
 */
export function isRunawayRepetition(text: string): boolean {
  if (text.length < REPEAT_MIN_LEN) {
    return false;
  }
  const tail = text.slice(-REPEAT_TAIL);
  const n = tail.length;

  // Signal A: unit of length 1..200 repeated consecutively at the very end.
  for (let u = 1; u <= Math.min(200, n >> 2); u++) {
    const unit = tail.slice(n - u);
    if (unit.trim().length === 0) {
      continue; // ignore runs of pure whitespace
    }
    let count = 1;
    let pos = n - u;
    while (pos - u >= 0 && tail.slice(pos - u, pos) === unit) {
      count++;
      pos -= u;
    }
    if (count >= 12 && count * u >= 300) {
      return true;
    }
  }

  // Signal B: one token accounts for at least half of a long tail.
  const tokens = tail.split(/\s+/).filter(Boolean);
  if (tokens.length >= 100) {
    const freq = new Map<string, number>();
    let max = 0;
    for (const t of tokens) {
      const c = (freq.get(t) ?? 0) + 1;
      freq.set(t, c);
      if (c > max) {
        max = c;
      }
    }
    if (max / tokens.length >= 0.5) {
      return true;
    }
  }

  return false;
}

/**
 * Calls an OpenAI-compatible /chat/completions endpoint with streaming enabled,
 * incrementally reporting assistant text while accumulating any tool calls.
 */
export async function streamChat(params: ChatParams, handlers: StreamHandlers): Promise<AssistantResult> {
  const url = `${params.endpoint.replace(/\/$/, '')}/chat/completions`;
  const body: Record<string, unknown> = {
    model: params.model,
    messages: params.messages,
    stream: true,
  };
  if (params.tools && params.tools.length > 0) {
    body.tools = params.tools;
    body.tool_choice = 'auto';
  }
  if (typeof params.temperature === 'number') {
    body.temperature = params.temperature;
  }
  if (typeof params.maxTokens === 'number' && params.maxTokens > 0) {
    body.max_tokens = params.maxTokens;
  }
  if (typeof params.ollamaNumCtx === 'number') {
    body.options = { num_ctx: params.ollamaNumCtx };
  }
  // Ask OpenAI-compatible servers to include token usage in the final chunk.
  body.stream_options = { include_usage: true };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(params.apiKey ? { Authorization: `Bearer ${params.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal: params.signal,
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    const err = new Error(`Model request failed (${res.status} ${res.statusText}). ${detail}`.trim());
    (err as { status?: number }).status = res.status;
    throw err;
  }

  const extract = params.extractToolCallsFromContent === true;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  const structuredTools: Record<number, ParsedToolCall> = {};

  const startedAt = Date.now();
  let firstTokenAt = 0;
  let usageCompletion: number | undefined;
  let usagePrompt: number | undefined;

  // Runaway-repetition guard: re-scan the tail periodically (not every delta).
  let stoppedForRepetition = false;
  let lastRepeatCheckLen = 0;
  const maybeCheckRepetition = (): void => {
    if (!params.detectRepetition || stoppedForRepetition || content.length < REPEAT_MIN_LEN) {
      return;
    }
    if (content.length - lastRepeatCheckLen < 300) {
      return;
    }
    lastRepeatCheckLen = content.length;
    if (isRunawayRepetition(content)) {
      stoppedForRepetition = true;
    }
  };
  const markFirst = (): void => {
    if (firstTokenAt === 0) {
      firstTokenAt = Date.now();
    }
  };

  // Streaming suppression state (agent mode only).
  let decided = false;
  let suppress = false;
  // Small carry so DSML markers split across chunks are still caught (#a).
  // Marker forms: <｜DSML｜, </｜DSML｜, <|DSML|, </|DSML| (± stray spaces).
  const DSML_CARRY = 10;
  let emitCarry = '';

  /** Emits visible text, cutting the stream the moment DSML markup starts. */
  const emitVisible = (piece: string): void => {
    if (!extract) {
      handlers.onDelta(piece);
      return;
    }
    const scan = emitCarry + piece;
    const match = DSML_MARKER_RE.exec(scan);
    if (match) {
      if (match.index > 0) {
        handlers.onDelta(scan.slice(0, match.index));
      }
      emitCarry = '';
      suppress = true; // hide the rest; the DSML block is parsed after the stream
      return;
    }
    // Always hold back a small tail so a marker split across chunks can't slip out.
    const keep = Math.min(DSML_CARRY, scan.length);
    if (scan.length - keep > 0) {
      handlers.onDelta(scan.slice(0, scan.length - keep));
    }
    emitCarry = scan.slice(scan.length - keep);
  };

  /** Flushes the held-back tail once the stream is finished (no marker found). */
  const flushEmitCarry = (): void => {
    if (emitCarry && !suppress) {
      handlers.onDelta(stripSpecialTokens(emitCarry));
    }
    emitCarry = '';
  };

  // Reasoning ("thinking") can arrive either as a dedicated streaming field
  // (`reasoning_content` on DeepSeek, `reasoning` elsewhere) or inline as
  // <think>…</think> tags mixed into the content. We surface both separately.
  const emitReasoning = (piece: string): void => {
    if (piece) {
      handlers.onReasoning?.(piece);
    }
  };

  let inThink = false;
  let tagCarry = '';
  const OPEN_THINK = '<think>';
  const CLOSE_THINK = '</think>';
  /** Length of the longest suffix of `text` that is a prefix of `tag` (split-tag guard). */
  const danglingTag = (text: string, tag: string): number => {
    const max = Math.min(text.length, tag.length - 1);
    for (let n = max; n > 0; n--) {
      if (tag.startsWith(text.slice(text.length - n))) {
        return n;
      }
    }
    return 0;
  };

  const handleContentDelta = (piece: string): void => {
    content += piece;
    maybeCheckRepetition();
    if (!extract) {
      handlers.onDelta(piece);
      return;
    }
    if (decided) {
      if (!suppress) {
        emitVisible(piece);
      }
      return;
    }
    const lead = content.replace(/^\s+/, '');
    if (lead.length === 0) {
      return; // still leading whitespace, keep waiting
    }
    // Keep buffering while the lead might still become a `knownTool(` call.
    if (!lead.includes('(') && lead.length < 60 && !lead.includes('\n') && couldBeToolCallPrefix(lead, params.toolNames)) {
      return;
    }
    decided = true;
    if (lead.startsWith('{') || lead.startsWith('[') || lead.startsWith('```')) {
      suppress = true; // looks like an embedded JSON tool call, hold it back
    } else if (startsWithToolCall(lead, params.toolNames)) {
      suppress = true; // looks like a function-style tool call (e.g. ask_user(...))
    } else {
      suppress = false;
      emitVisible(content); // flush what we buffered, then stream live
    }
  };

  /** Splits streamed content into <think> reasoning vs. real answer content. */
  const routeContent = (piece: string): void => {
    let text = tagCarry + piece;
    tagCarry = '';
    while (text.length > 0) {
      if (inThink) {
        const close = text.indexOf(CLOSE_THINK);
        if (close === -1) {
          const keep = danglingTag(text, CLOSE_THINK);
          emitReasoning(text.slice(0, text.length - keep));
          tagCarry = text.slice(text.length - keep);
          return;
        }
        emitReasoning(text.slice(0, close));
        text = text.slice(close + CLOSE_THINK.length);
        inThink = false;
      } else {
        const open = text.indexOf(OPEN_THINK);
        if (open === -1) {
          const keep = danglingTag(text, OPEN_THINK);
          if (text.length - keep > 0) {
            handleContentDelta(text.slice(0, text.length - keep));
          }
          tagCarry = text.slice(text.length - keep);
          return;
        }
        if (open > 0) {
          handleContentDelta(text.slice(0, open));
        }
        text = text.slice(open + OPEN_THINK.length);
        inThink = true;
      }
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });

    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line.startsWith('data:')) {
        continue;
      }
      const payload = line.slice(5).trim();
      if (payload === '' || payload === '[DONE]') {
        continue;
      }
      let json: any;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      if (json?.usage) {
        if (typeof json.usage.completion_tokens === 'number') {
          usageCompletion = json.usage.completion_tokens;
        }
        if (typeof json.usage.prompt_tokens === 'number') {
          usagePrompt = json.usage.prompt_tokens;
        }
      }
      const delta = json?.choices?.[0]?.delta;
      if (!delta) {
        continue;
      }
      const reasoningPiece =
        (typeof delta.reasoning_content === 'string' && delta.reasoning_content) ||
        (typeof delta.reasoning === 'string' && delta.reasoning) ||
        '';
      if (reasoningPiece) {
        markFirst();
        emitReasoning(reasoningPiece);
      }
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        markFirst();
        routeContent(delta.content);
      }
      if (Array.isArray(delta.tool_calls)) {
        markFirst();
        for (const tc of delta.tool_calls) {
          const index: number = typeof tc.index === 'number' ? tc.index : 0;
          const acc = structuredTools[index] ?? (structuredTools[index] = { id: randomId(), name: '', arguments: '' });
          if (tc.id) {
            acc.id = tc.id;
          }
          if (tc.function?.name) {
            acc.name = tc.function.name;
          }
          if (tc.function?.arguments) {
            acc.arguments += tc.function.arguments;
          }
        }
      }
    }

    // The model is looping — stop reading and keep the partial content.
    if (stoppedForRepetition) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }

  // Flush any leftover partial-tag buffer once the stream ends.
  if (tagCarry) {
    if (inThink) {
      emitReasoning(tagCarry);
    } else {
      handleContentDelta(tagCarry);
    }
    tagCarry = '';
  }
  flushEmitCarry();

  let toolCalls = Object.keys(structuredTools)
    .map(Number)
    .sort((a, b) => a - b)
    .map((k) => structuredTools[k])
    .filter((t) => t.name.length > 0);

  let outContent = content;

  if (toolCalls.length === 0 && extract) {
    const parsed =
      parseToolCallsFromContent(content, params.toolNames) ?? parseFunctionCallsFromContent(content, params.toolNames);
    if (parsed) {
      toolCalls = parsed;
      outContent = '';
    } else {
      // DeepSeek DSML markup, then generic calls embedded in prose.
      const dsml = parseDsmlToolCalls(content);
      const embedded = dsml ?? extractEmbeddedToolCalls(content, params.toolNames);
      if (embedded) {
        toolCalls = embedded.calls;
        outContent = embedded.strippedContent;
      } else if (suppress) {
        // We held content back expecting a tool call, but it was plain text.
        handlers.onDelta(stripSpecialTokens(content));
      }
    }
  } else if (toolCalls.length > 0 && suppress) {
    outContent = '';
  }

  // Never let special tokens (orphan DSML tags, <｜end▁of▁sentence｜>, …) survive
  // into the transcript — persisted junk poisons future prompts and memory.
  if (extract) {
    outContent = stripSpecialTokens(outContent);
  }

  const generationMs = Math.max(1, Date.now() - (firstTokenAt || startedAt));
  const completionTokens = usageCompletion ?? Math.round(content.length / 4);
  const stats: StreamStats = {
    completionTokens,
    promptTokens: usagePrompt,
    generationMs,
    tokensPerSecond: completionTokens > 0 ? completionTokens / (generationMs / 1000) : undefined,
    estimated: usageCompletion === undefined,
  };

  return { content: outContent, toolCalls, stats, stoppedForRepetition };
}
