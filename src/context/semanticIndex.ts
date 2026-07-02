import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface SemanticOptions {
  /** Host that serves (and if needed downloads) the embedding model. */
  embeddingUrl: string;
  /** Embedding model id, e.g. "nomic-embed-text". */
  embeddingModel: string;
  autoInstall: boolean;
  /** Max files to index (default 2500, `nyx.indexMaxFiles`). */
  maxFiles?: number;
  /** Max chunks to keep in the index (default 12000, `nyx.indexMaxChunks`). */
  maxChunks?: number;
  onStatus?: (text: string) => void;
}

export interface SearchHit {
  file: string;
  startLine: number;
  endLine: number;
  score: number;
  preview: string;
}

interface StoredChunk {
  file: string;
  startLine: number;
  endLine: number;
  /** Int8-quantized embedding (base64) + scale for cosine ranking. */
  vec: string;
  scale: number;
}

interface StoredIndex {
  version: 1;
  model: string;
  /** file → content hash (size:mtime). */
  files: Record<string, string>;
  chunks: StoredChunk[];
}

const CHUNK_LINES = 48;
const CHUNK_OVERLAP = 8;
const MAX_FILES = 2500;
const MAX_FILE_BYTES = 200000;
const MAX_CHUNKS = 12000;
const EMBED_BATCH = 16;
export const INCLUDE_GLOB = '**/*.{ts,tsx,js,jsx,mjs,cjs,py,rb,go,rs,java,kt,swift,c,h,cpp,hpp,cs,php,twig,vue,svelte,html,css,scss,less,json,yaml,yml,toml,md,mdx,sql,sh,zsh,bash,graphql,proto,xml,ini,env.example,Dockerfile}';
const EXCLUDE_GLOB = '**/{node_modules,.git,dist,out,build,.next,.venv,.cache,vendor,coverage}/**';

function quantize(vec: number[]): { b64: string; scale: number } {
  let max = 1e-9;
  for (const v of vec) {
    const a = Math.abs(v);
    if (a > max) {
      max = a;
    }
  }
  const scale = max / 127;
  const bytes = new Int8Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    bytes[i] = Math.max(-127, Math.min(127, Math.round(vec[i] / scale)));
  }
  return { b64: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64'), scale };
}

function dotQuantized(a: Int8Array, b: Int8Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

/**
 * A fully local semantic code index: files are chunked, embedded through a
 * local Ollama embedding model, quantized to int8, and persisted in the
 * extension's workspace storage. No cloud, no external services.
 */
export class SemanticIndex {
  private index: StoredIndex | undefined;
  private decoded: Int8Array[] = [];
  private building: Promise<string> | undefined;

  constructor(
    private readonly storageDir: string,
    private readonly workspaceRoot: () => vscode.Uri | undefined,
  ) {}

  private get indexFile(): string {
    return path.join(this.storageDir, 'semantic-index.json');
  }

  private async loadFromDisk(): Promise<void> {
    if (this.index) {
      return;
    }
    try {
      const raw = await fs.readFile(this.indexFile, 'utf8');
      const data = JSON.parse(raw) as StoredIndex;
      if (data.version === 1) {
        this.index = data;
        // Int8Array-from-Uint8Array converts per element with ToInt8 (modulo),
        // which equals a raw byte reinterpretation — exactly what we stored.
        this.decoded = data.chunks.map((c) => new Int8Array(Buffer.from(c.vec, 'base64')));
      }
    } catch {
      this.index = undefined;
    }
  }

  private async saveToDisk(): Promise<void> {
    if (!this.index) {
      return;
    }
    await fs.mkdir(this.storageDir, { recursive: true });
    await fs.writeFile(this.indexFile, JSON.stringify(this.index));
  }

  /** Builds or incrementally updates the index. Returns a status summary. */
  async ensureIndex(opts: SemanticOptions, force = false): Promise<string> {
    if (this.building) {
      return this.building;
    }
    this.building = this.doEnsure(opts, force).finally(() => {
      this.building = undefined;
    });
    return this.building;
  }

  private async doEnsure(opts: SemanticOptions, force: boolean): Promise<string> {
    const root = this.workspaceRoot();
    if (!root) {
      throw new Error('No workspace folder is open.');
    }
    await this.loadFromDisk();
    if (force || !this.index || this.index.model !== opts.embeddingModel) {
      this.index = { version: 1, model: opts.embeddingModel, files: {}, chunks: [] };
      this.decoded = [];
    }
    await ensureEmbeddingModel(opts);

    const maxFiles = Math.max(1, opts.maxFiles ?? MAX_FILES);
    const maxChunks = Math.max(1, opts.maxChunks ?? MAX_CHUNKS);
    const uris = await vscode.workspace.findFiles(INCLUDE_GLOB, EXCLUDE_GLOB, maxFiles);
    const seen = new Set<string>();
    const toEmbed: Array<{ file: string; hash: string; chunks: Array<{ startLine: number; endLine: number; text: string }> }> = [];

    for (const uri of uris) {
      const rel = vscode.workspace.asRelativePath(uri);
      seen.add(rel);
      let stat: vscode.FileStat;
      try {
        stat = await vscode.workspace.fs.stat(uri);
      } catch {
        continue;
      }
      if (stat.size > MAX_FILE_BYTES) {
        continue;
      }
      const hash = `${stat.size}:${stat.mtime}`;
      if (this.index.files[rel] === hash) {
        continue;
      }
      let text: string;
      try {
        text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      } catch {
        continue;
      }
      if (text.includes('\u0000')) {
        continue; // binary
      }
      toEmbed.push({ file: rel, hash, chunks: chunkFile(text) });
    }

    // Drop chunks of removed/changed files.
    const changed = new Set(toEmbed.map((f) => f.file));
    const removed = Object.keys(this.index.files).filter((f) => !seen.has(f));
    if (changed.size > 0 || removed.length > 0) {
      const drop = new Set([...changed, ...removed]);
      const keptPairs = this.index.chunks
        .map((c, i) => ({ c, v: this.decoded[i] }))
        .filter(({ c }) => !drop.has(c.file));
      this.index.chunks = keptPairs.map((p) => p.c);
      this.decoded = keptPairs.map((p) => p.v);
      for (const f of removed) {
        delete this.index.files[f];
      }
    }

    const totalChunks = toEmbed.reduce((n, f) => n + f.chunks.length, 0);
    if (totalChunks === 0) {
      return `Index up to date (${this.index.chunks.length} chunks, ${Object.keys(this.index.files).length} files).`;
    }

    opts.onStatus?.(`Indexing ${toEmbed.length} file(s), ${totalChunks} chunks with ${opts.embeddingModel}…`);
    let done = 0;
    for (const fileEntry of toEmbed) {
      for (let i = 0; i < fileEntry.chunks.length; i += EMBED_BATCH) {
        if (this.index.chunks.length >= maxChunks) {
          break;
        }
        const batch = fileEntry.chunks.slice(i, i + EMBED_BATCH);
        const inputs = batch.map((c) => `search_document: ${fileEntry.file}\n${c.text}`);
        const vectors = await embed(opts, inputs);
        for (let j = 0; j < batch.length; j++) {
          const q = quantize(vectors[j]);
          this.index.chunks.push({
            file: fileEntry.file,
            startLine: batch[j].startLine,
            endLine: batch[j].endLine,
            vec: q.b64,
            scale: q.scale,
          });
          this.decoded.push(new Int8Array(Buffer.from(q.b64, 'base64')));
        }
        done += batch.length;
        if (done % (EMBED_BATCH * 4) === 0) {
          opts.onStatus?.(`Indexing… ${done}/${totalChunks} chunks`);
        }
      }
      this.index.files[fileEntry.file] = fileEntry.hash;
    }
    await this.saveToDisk();
    // Surface capped coverage so users know the index is partial and how to widen it.
    const warnings: string[] = [];
    if (uris.length >= maxFiles) {
      warnings.push(`file limit reached (${maxFiles}) — raise nyx.indexMaxFiles to cover more of the workspace`);
    }
    if (this.index.chunks.length >= maxChunks) {
      warnings.push(`chunk limit reached (${maxChunks}) — raise nyx.indexMaxChunks to index everything`);
    }
    const warnText = warnings.length > 0 ? ` ⚠ ${warnings.join('; ')}.` : '';
    if (warnText) {
      opts.onStatus?.(`Semantic index:${warnText}`);
    }
    return `Indexed ${toEmbed.length} file(s) (${done} chunks; total ${this.index.chunks.length}).${warnText}`;
  }

  /** Semantic search over the index (auto-builds/refreshes it first). */
  async search(query: string, limit: number, opts: SemanticOptions): Promise<SearchHit[]> {
    await this.ensureIndex(opts);
    if (!this.index || this.index.chunks.length === 0) {
      return [];
    }
    const [queryVec] = await embed(opts, [`search_query: ${query}`]);
    const q = quantize(queryVec);
    const qVec = new Int8Array(Buffer.from(q.b64, 'base64'));

    const scored = this.index.chunks.map((chunk, i) => ({
      chunk,
      score: dotQuantized(qVec, this.decoded[i]) * q.scale * chunk.scale,
    }));
    scored.sort((a, b) => b.score - a.score);

    const hits: SearchHit[] = [];
    const perFile = new Map<string, number>();
    const root = this.workspaceRoot();
    for (const { chunk, score } of scored) {
      if (hits.length >= limit) {
        break;
      }
      // At most 2 hits per file so results cover the codebase.
      const count = perFile.get(chunk.file) ?? 0;
      if (count >= 2) {
        continue;
      }
      perFile.set(chunk.file, count + 1);
      let preview = '';
      if (root) {
        try {
          const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, chunk.file));
          const lines = new TextDecoder().decode(bytes).split('\n');
          preview = lines
            .slice(chunk.startLine - 1, Math.min(chunk.startLine + 5, chunk.endLine))
            .join('\n')
            .slice(0, 400);
        } catch {
          preview = '';
        }
      }
      hits.push({ file: chunk.file, startLine: chunk.startLine, endLine: chunk.endLine, score, preview });
    }
    return hits;
  }

  stats(): { files: number; chunks: number } {
    return { files: Object.keys(this.index?.files ?? {}).length, chunks: this.index?.chunks.length ?? 0 };
  }

  /** True once an index exists (in memory or on disk) — used by the live watcher. */
  async hasIndex(): Promise<boolean> {
    await this.loadFromDisk();
    return (this.index?.chunks.length ?? 0) > 0;
  }
}

interface Chunk {
  startLine: number;
  endLine: number;
  text: string;
}

const MIN_UNIT_LINES = 10;
const MAX_UNIT_LINES = 90;

/**
 * Matches the start of a code unit (function/class/method definitions) across
 * the common languages, at top or shallow nesting level.
 */
const BOUNDARY_RE =
  /^\s{0,4}(?:export\s+|default\s+|public\s+|private\s+|protected\s+|internal\s+|static\s+|abstract\s+|final\s+|async\s+)*(?:function[\s*]|class\s|interface\s|enum\s|namespace\s|trait\s|struct\s|impl[\s<]|module\s|object\s|def\s|fn\s|func\s|sub\s|proc\s|type\s+\w+\s*(?:=|\{)|(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?(?:\(|function)|@\w+|#\[)/;

/** Markdown/plain-text section boundary. */
const HEADING_RE = /^#{1,4}\s|^={3,}\s*$|^-{3,}\s*$/;

/**
 * Structure-aware chunking: splits at function/class/section boundaries so a
 * chunk usually holds one coherent unit (much better retrieval than fixed
 * windows), merges tiny units into their neighbor, and windows oversized units.
 * Falls back to fixed windows when a file exposes no recognizable structure.
 */
export function chunkFile(text: string): Chunk[] {
  const lines = text.split('\n');
  const boundaries: number[] = [0];
  for (let i = 1; i < lines.length; i++) {
    if (BOUNDARY_RE.test(lines[i]) || HEADING_RE.test(lines[i])) {
      boundaries.push(i);
    }
  }
  if (boundaries.length < 3) {
    return windowChunks(lines, 0, lines.length);
  }

  // Build units between boundaries, merging units smaller than MIN_UNIT_LINES.
  const units: Array<{ start: number; end: number }> = [];
  for (let b = 0; b < boundaries.length; b++) {
    const start = boundaries[b];
    const end = b + 1 < boundaries.length ? boundaries[b + 1] : lines.length;
    const prev = units[units.length - 1];
    if (prev && (end - start < MIN_UNIT_LINES || prev.end - prev.start < MIN_UNIT_LINES) && end - prev.start <= MAX_UNIT_LINES) {
      prev.end = end;
    } else {
      units.push({ start, end });
    }
  }

  const chunks: Chunk[] = [];
  for (const unit of units) {
    if (unit.end - unit.start > MAX_UNIT_LINES) {
      chunks.push(...windowChunks(lines, unit.start, unit.end));
      continue;
    }
    const body = lines.slice(unit.start, unit.end).join('\n').trim();
    if (body.length > 20) {
      chunks.push({ startLine: unit.start + 1, endLine: unit.end, text: body.slice(0, 4000) });
    }
  }
  return chunks;
}

function windowChunks(lines: string[], from: number, to: number): Chunk[] {
  const chunks: Chunk[] = [];
  for (let start = from; start < to; start += CHUNK_LINES - CHUNK_OVERLAP) {
    const end = Math.min(to, start + CHUNK_LINES);
    const body = lines.slice(start, end).join('\n').trim();
    if (body.length > 20) {
      chunks.push({ startLine: start + 1, endLine: end, text: body.slice(0, 4000) });
    }
    if (end >= to) {
      break;
    }
  }
  return chunks;
}

/** Hosts that answered the Ollama /api/embed probe with 404 — use /v1/embeddings directly. */
const openAiEmbedHosts = new Set<string>();

/**
 * Embeds texts through the local host. Tries Ollama's native `/api/embed`
 * first; when the host doesn't speak it (LM Studio, llama.cpp server, vLLM),
 * falls back to the OpenAI-compatible `/v1/embeddings` endpoint.
 */
async function embed(opts: SemanticOptions, inputs: string[]): Promise<number[][]> {
  const host = opts.embeddingUrl.replace(/\/+$/, '');
  if (!openAiEmbedHosts.has(host)) {
    const res = await fetch(`${host}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: opts.embeddingModel, input: inputs }),
      signal: AbortSignal.timeout(120000),
    }).catch(() => undefined);
    if (res?.ok) {
      const data = (await res.json()) as { embeddings?: number[][] };
      if (Array.isArray(data.embeddings) && data.embeddings.length === inputs.length) {
        return data.embeddings;
      }
      throw new Error('embedding server returned no vectors');
    }
    if (res) {
      if (res.status !== 404 && res.status !== 405) {
        throw new Error(`embedding request failed: HTTP ${res.status}`);
      }
      // The host answered but doesn't speak /api/embed — remember that.
      openAiEmbedHosts.add(host);
    }
    // Network failure: fall through to /v1/embeddings once without caching,
    // so a transient Ollama outage doesn't permanently switch the path.
  }
  return embedOpenAi(host, opts.embeddingModel, inputs);
}

/** OpenAI-compatible embeddings path for LM Studio / llama.cpp / vLLM hosts. */
async function embedOpenAi(host: string, model: string, inputs: string[]): Promise<number[][]> {
  const base = host.endsWith('/v1') ? host : `${host}/v1`;
  const res = await fetch(`${base}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: inputs }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) {
    throw new Error(`embedding request failed: HTTP ${res.status} (tried /api/embed and /v1/embeddings)`);
  }
  const data = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
  const vectors = (data.data ?? []).map((d) => d.embedding).filter((v): v is number[] => Array.isArray(v));
  if (vectors.length !== inputs.length) {
    throw new Error('embedding server returned no vectors');
  }
  return vectors;
}

/** Public embedding entry point, reused by the memory store's semantic recall. */
export function embedTexts(opts: SemanticOptions, inputs: string[]): Promise<number[][]> {
  return embed(opts, inputs);
}

/** Cosine similarity of two float vectors (0 when either is empty). */
export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) {
    return 0;
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
}

async function ensureEmbeddingModel(opts: SemanticOptions): Promise<void> {
  const host = opts.embeddingUrl.replace(/\/+$/, '');
  const probe = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(5000) }).catch(() => undefined);
  if (!probe || !probe.ok) {
    // Not an Ollama host (LM Studio, llama.cpp, vLLM) — nothing to pull here;
    // the /v1/embeddings fallback surfaces real errors at embed time.
    return;
  }
  const tags = (await probe.json().catch(() => ({}))) as { models?: Array<{ name?: string }> };
  const have = (tags.models ?? []).some((m) => m.name === opts.embeddingModel || m.name?.startsWith(`${opts.embeddingModel}:`));
  if (have) {
    return;
  }
  if (!opts.autoInstall) {
    throw new Error(`Embedding model "${opts.embeddingModel}" is not installed (ollama pull ${opts.embeddingModel}).`);
  }
  opts.onStatus?.(`Downloading embedding model ${opts.embeddingModel} (one-time)…`);
  const res = await fetch(`${host}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: opts.embeddingModel, stream: false }),
  });
  if (!res.ok) {
    throw new Error(`could not pull ${opts.embeddingModel}: HTTP ${res.status}`);
  }
  opts.onStatus?.(`Embedding model ${opts.embeddingModel} ready.`);
}
