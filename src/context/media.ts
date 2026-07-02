import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createWorker } from 'tesseract.js';
import { extractText, getDocumentProxy } from 'unpdf';

export type MediaKind = 'image' | 'pdf';

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);
const MAX_MEDIA_CHARS = 8000;

export interface MediaOptions {
  /** Ollama host that runs the local vision model, e.g. http://localhost:11434 */
  visionUrl: string;
  /** Vision model id (e.g. "moondream"); empty disables image description. */
  visionModel: string;
  /** Pull the vision model automatically on first use if it is missing. */
  autoInstall: boolean;
  /** Run OCR (tesseract.js) on images in addition to the vision description. */
  enableOcr: boolean;
  /** Directory where tesseract caches its language data for offline use. */
  cachePath: string;
  onStatus?: (text: string) => void;
}

export function mediaKind(pathOrName: string): MediaKind | null {
  const ext = pathOrName.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'pdf') {
    return 'pdf';
  }
  return IMAGE_EXTS.has(ext) ? 'image' : null;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function cap(text: string): string {
  return text.length > MAX_MEDIA_CHARS ? `${text.slice(0, MAX_MEDIA_CHARS)}\n… [truncated]` : text;
}

/** Converts an image or PDF into text the agent can reason about. */
export async function convertMedia(absPath: string, kind: MediaKind, opts: MediaOptions): Promise<string> {
  return kind === 'pdf' ? convertPdf(absPath) : convertImage(absPath, opts);
}

/** Describes in-memory image bytes (e.g. downloaded from a URL) via a temp file. */
export async function convertImageBytes(bytes: Uint8Array, ext: string, opts: MediaOptions): Promise<string> {
  const safeExt = IMAGE_EXTS.has(ext.toLowerCase()) ? ext.toLowerCase() : 'png';
  const tmp = path.join(os.tmpdir(), `nyx-img-${Date.now()}-${Math.random().toString(36).slice(2)}.${safeExt}`);
  await fs.writeFile(tmp, bytes);
  try {
    return await convertImage(tmp, opts);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

async function convertPdf(absPath: string): Promise<string> {
  try {
    const buf = new Uint8Array(await fs.readFile(absPath));
    const pdf = await getDocumentProxy(buf);
    const { text, totalPages } = await extractText(pdf, { mergePages: true });
    const clean = (text ?? '').trim();
    if (clean.length < 8) {
      return `[PDF: ${totalPages} page(s), no extractable text layer — likely scanned. Attach a page as an image to use OCR/vision.]`;
    }
    return `PDF text (${totalPages} page(s)):\n${cap(clean)}`;
  } catch (e) {
    return `[Could not read PDF: ${msg(e)}]`;
  }
}

async function convertImage(absPath: string, opts: MediaOptions): Promise<string> {
  const parts: string[] = [];

  if (opts.visionModel) {
    try {
      const desc = (await describeImage(absPath, opts)).trim();
      if (desc) {
        parts.push(`Image description (${opts.visionModel}):\n${desc}`);
      }
    } catch (e) {
      parts.push(`[Vision model failed: ${msg(e)}]`);
    }
  }

  if (opts.enableOcr) {
    try {
      const text = (await ocrImage(absPath, opts.cachePath)).trim();
      if (text) {
        parts.push(`Text in image (OCR):\n${cap(text)}`);
      }
    } catch (e) {
      parts.push(`[OCR failed: ${msg(e)}]`);
    }
  }

  return parts.length > 0 ? parts.join('\n\n') : '[No text or description could be extracted from the image.]';
}

async function ocrImage(absPath: string, cachePath: string): Promise<string> {
  await fs.mkdir(cachePath, { recursive: true }).catch(() => undefined);
  const worker = await createWorker('eng', 1, { cachePath });
  try {
    const { data } = await worker.recognize(absPath);
    return data.text;
  } finally {
    await worker.terminate();
  }
}

async function describeImage(absPath: string, opts: MediaOptions): Promise<string> {
  const host = opts.visionUrl.replace(/\/+$/, '');
  await ensureModel(host, opts.visionModel, opts.autoInstall, opts.onStatus);
  const b64 = Buffer.from(await fs.readFile(absPath)).toString('base64');
  opts.onStatus?.(`Describing image with ${opts.visionModel}…`);
  const res = await fetch(`${host}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: opts.visionModel,
      prompt:
        'Describe this image in detail for a software developer. Cover the layout, UI elements, diagrams or plots, and summarize any visible text.',
      images: [b64],
      stream: false,
    }),
  });
  if (!res.ok) {
    throw new Error(`vision HTTP ${res.status}`);
  }
  const data = (await res.json()) as { response?: string };
  return data.response ?? '';
}

async function ensureModel(host: string, model: string, autoInstall: boolean, onStatus?: (t: string) => void): Promise<void> {
  const tags = await fetch(`${host}/api/tags`)
    .then((r) => (r.ok ? (r.json() as Promise<{ models?: Array<{ name?: string; model?: string }> }>) : { models: [] }))
    .catch(() => ({ models: [] as Array<{ name?: string; model?: string }> }));
  const have = (tags.models ?? []).some(
    (m) => m.name === model || m.model === model || m.name?.startsWith(`${model}:`),
  );
  if (have) {
    return;
  }
  if (!autoInstall) {
    throw new Error(`vision model "${model}" is not installed and auto-install is disabled`);
  }
  onStatus?.(`Installing vision model ${model} (one-time download)…`);
  await pullModel(host, model, onStatus);
}

async function pullModel(host: string, model: string, onStatus?: (t: string) => void): Promise<void> {
  const res = await fetch(`${host}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: model, stream: true }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`pull HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let lastPct = -1;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      const j = JSON.parse(line) as { error?: string; total?: number; completed?: number };
      if (j.error) {
        throw new Error(j.error);
      }
      if (j.total && j.completed) {
        const pct = Math.floor((j.completed / j.total) * 100);
        if (pct !== lastPct && pct % 10 === 0) {
          onStatus?.(`Pulling ${model}: ${pct}%`);
          lastPct = pct;
        }
      }
    }
  }
  onStatus?.(`Vision model ${model} ready.`);
}
