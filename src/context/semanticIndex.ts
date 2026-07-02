import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface SemanticOptions {
  /** Ollama host that serves (and if needed downloads) the embedding model. */
  embeddingUrl: string;
  /** Embedding model id, e.g. "nomic-embed-text". */
  embeddingModel: string;
  autoInstall: boolean;
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
const INCLUDE_GLOB = '**/*.{ts,tsx,js,jsx,mjs,cjs,py,rb,go,rs,java,kt,swift,c,h,cpp,hpp,cs,php,twig,vue,svelte,html,css,scss,less,json,yaml,yml,toml,md,mdx,sql,sh,zsh,bash,graphql,proto,xml,ini,env.example,Dockerfile}';
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

    const uris = await vscode.workspace.findFiles(INCLUDE_GLOB, EXCLUDE_GLOB, MAX_FILES);
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
        if (this.index.chunks.length >= MAX_CHUNKS) {
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
    return `Indexed ${toEmbed.length} file(s) (${done} chunks; total ${this.index.chunks.length}).`;
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
}

function chunkFile(text: string): Array<{ startLine: number; endLine: number; text: string }> {
  const lines = text.split('\n');
  const chunks: Array<{ startLine: number; endLine: number; text: string }> = [];
  for (let start = 0; start < lines.length; start += CHUNK_LINES - CHUNK_OVERLAP) {
    const end = Math.min(lines.length, start + CHUNK_LINES);
    const body = lines.slice(start, end).join('\n').trim();
    if (body.length > 20) {
      chunks.push({ startLine: start + 1, endLine: end, text: body.slice(0, 4000) });
    }
    if (end >= lines.length) {
      break;
    }
  }
  return chunks;
}

async function embed(opts: SemanticOptions, inputs: string[]): Promise<number[][]> {
  const host = opts.embeddingUrl.replace(/\/+$/, '');
  const res = await fetch(`${host}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: opts.embeddingModel, input: inputs }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) {
    throw new Error(`embedding request failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { embeddings?: number[][] };
  if (!Array.isArray(data.embeddings) || data.embeddings.length !== inputs.length) {
    throw new Error('embedding server returned no vectors');
  }
  return data.embeddings;
}

async function ensureEmbeddingModel(opts: SemanticOptions): Promise<void> {
  const host = opts.embeddingUrl.replace(/\/+$/, '');
  const tags = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(5000) })
    .then((r) => (r.ok ? (r.json() as Promise<{ models?: Array<{ name?: string }> }>) : { models: [] }))
    .catch(() => ({ models: [] as Array<{ name?: string }> }));
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
