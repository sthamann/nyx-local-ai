import * as vscode from 'vscode';
import * as path from 'node:path';
import { convertImageBytes, convertMedia, mediaKind, type MediaOptions } from '../context/media';
import { extractImageUrls, extractUrls, fetchPage, htmlToText } from '../context/web';
import { wrapUntrusted } from '../agent/tools';
import type { AttachmentMeta } from '../types';

const TOTAL_CAP = 60000;
const PAGE_TEXT_CAP = 12000;
const IMAGES_PER_PAGE = 2;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;

export interface BuiltContext {
  text: string;
  /** Base64 data URLs for vision-capable models. */
  images: string[];
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function mimeForExt(ext: string): string {
  const map: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
  return map[ext.toLowerCase()] ?? 'image/png';
}

function toDataUrl(bytes: Uint8Array, ext: string): string {
  return `data:${mimeForExt(ext)};base64,${Buffer.from(bytes).toString('base64')}`;
}

async function listFolder(uri: vscode.Uri): Promise<string> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(uri);
    return entries
      .slice(0, 200)
      .map(([n, t]) => `${t === vscode.FileType.Directory ? '[dir] ' : '[file]'} ${n}`)
      .join('\n');
  } catch (e) {
    return `[Could not list: ${errText(e)}]`;
  }
}

/**
 * Converts the pending attachments into a context block. When the active model
 * is vision-capable, images are passed through natively as data URLs instead
 * of being described by the local vision model.
 */
export async function buildAttachmentContext(
  attachments: AttachmentMeta[],
  media: MediaOptions,
  modelSupportsVision: boolean,
): Promise<BuiltContext> {
  if (attachments.length === 0) {
    return { text: '', images: [] };
  }
  const parts: string[] = [];
  const images: string[] = [];
  let total = 0;

  for (const att of attachments) {
    if (total >= TOTAL_CAP) {
      break;
    }
    if (att.kind === 'selection') {
      const block = `Attached editor selection (${att.label ?? att.name}):\n\`\`\`\n${att.content ?? ''}\n\`\`\``;
      parts.push(block);
      total += block.length;
      continue;
    }
    if (att.kind === 'terminal') {
      const block = `Output of the user's integrated terminal "${att.name}":\n\`\`\`\n${att.content ?? ''}\n\`\`\``;
      parts.push(block);
      total += block.length;
      continue;
    }
    if (att.kind === 'handoff') {
      const block = `Imported handoff (a prior conversation/notes the user brought over from another assistant — treat it as context, continue the work):\n\n${att.content ?? ''}`;
      parts.push(block);
      total += block.length;
      continue;
    }
    const uri = vscode.Uri.file(att.path);
    if (att.kind === 'folder') {
      const block = `Attached folder: ${att.path}\n${await listFolder(uri)}`;
      parts.push(block);
      total += block.length;
      continue;
    }
    const kind = mediaKind(att.name);
    if (kind === 'image' && modelSupportsVision) {
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        images.push(toDataUrl(bytes, path.extname(att.name).slice(1)));
        parts.push(`Attached image: ${att.path} (passed to you directly — describe/use it as needed)`);
      } catch (e) {
        parts.push(`Attached image (${att.path}):\n[Could not read: ${errText(e)}]`);
      }
      continue;
    }
    if (kind) {
      try {
        const converted = await convertMedia(att.path, kind, media);
        const block = `Attached ${kind} (${att.path}):\n${converted}`;
        parts.push(block);
        total += block.length;
      } catch (e) {
        parts.push(`Attached ${kind} (${att.path}):\n[Conversion failed: ${errText(e)}]`);
      }
      continue;
    }
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      let text = new TextDecoder().decode(bytes);
      if (text.length > 20000) {
        text = `${text.slice(0, 20000)}\n… [truncated]`;
      }
      const block = `Attached file: ${att.path}\n\`\`\`\n${text}\n\`\`\``;
      parts.push(block);
      total += block.length;
    } catch (e) {
      parts.push(`Attached file: ${att.path}\n[Could not read: ${errText(e)}]`);
    }
  }
  return { text: `The user attached the following context:\n\n${parts.join('\n\n')}`, images };
}

// ---- @-mentions ----

const MENTION_RE = /(?:^|\s)@([\w~][\w./\\~-]*)/g;

/** Extracts @-mentioned workspace paths from a message. */
export function extractMentions(text: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = MENTION_RE.exec(text))) {
    out.push(m[1]);
  }
  return [...new Set(out)];
}

/** Reads @-mentioned files/folders and returns a context block. */
export async function buildMentionContext(text: string, roots: vscode.Uri[]): Promise<string> {
  const mentions = extractMentions(text);
  if (mentions.length === 0 || roots.length === 0) {
    return '';
  }
  const blocks: string[] = [];
  for (const mention of mentions.slice(0, 8)) {
    let resolved: vscode.Uri | undefined;
    let isDir = false;
    for (const root of roots) {
      const candidate = vscode.Uri.joinPath(root, mention);
      try {
        const stat = await vscode.workspace.fs.stat(candidate);
        resolved = candidate;
        isDir = stat.type === vscode.FileType.Directory;
        break;
      } catch {
        // try next root
      }
    }
    if (!resolved) {
      continue;
    }
    if (isDir) {
      blocks.push(`Mentioned folder @${mention}:\n${await listFolder(resolved)}`);
      continue;
    }
    try {
      const bytes = await vscode.workspace.fs.readFile(resolved);
      let content = new TextDecoder().decode(bytes);
      if (content.length > 20000) {
        content = `${content.slice(0, 20000)}\n… [truncated]`;
      }
      blocks.push(`Mentioned file @${mention}:\n\`\`\`\n${content}\n\`\`\``);
    } catch {
      // unreadable (binary?) — skip
    }
  }
  return blocks.length > 0 ? `The user referenced these workspace files with @:\n\n${blocks.join('\n\n')}` : '';
}

// ---- URL auto-fetching ----

export async function buildUrlContext(
  text: string,
  media: MediaOptions,
  modelSupportsVision: boolean,
  onStatus: (t: string) => void,
): Promise<BuiltContext> {
  const urls = extractUrls(text).slice(0, 3);
  if (urls.length === 0) {
    return { text: '', images: [] };
  }
  const blocks: string[] = [];
  const images: string[] = [];

  const describeOrCollect = async (url: string, bytes?: Uint8Array): Promise<string | undefined> => {
    try {
      const data = bytes ?? (await fetchPage(url)).bytes;
      if (!data) {
        return undefined;
      }
      const ext = (url.split('/').pop() ?? '').split(/[?#]/)[0].split('.').pop() ?? 'png';
      if (modelSupportsVision && IMAGE_EXT_RE.test(`.${ext}`)) {
        images.push(toDataUrl(data, ext));
        return '(image passed to the model directly)';
      }
      return await convertImageBytes(data, ext, media);
    } catch {
      return undefined;
    }
  };

  for (const url of urls) {
    try {
      onStatus(`Fetching ${url}…`);
      const page = await fetchPage(url);
      if (page.html) {
        const pageText = htmlToText(page.html).slice(0, PAGE_TEXT_CAP);
        const imageBlocks: string[] = [];
        for (const img of extractImageUrls(page.html, url).slice(0, IMAGES_PER_PAGE)) {
          const desc = await describeOrCollect(img);
          if (desc) {
            imageBlocks.push(`Image ${img}:\n${desc}`);
          }
        }
        const body = `${pageText}${imageBlocks.length > 0 ? `\n\n${imageBlocks.join('\n\n')}` : ''}`;
        blocks.push(wrapUntrusted(url, body));
      } else if (page.bytes && page.contentType.startsWith('image/')) {
        const desc = await describeOrCollect(url, page.bytes);
        blocks.push(`Fetched image ${url}:\n${desc ?? '[Could not describe image.]'}`);
      } else if (page.text) {
        blocks.push(wrapUntrusted(url, page.text.slice(0, PAGE_TEXT_CAP)));
      } else {
        blocks.push(`Fetched ${url}: (unsupported content type ${page.contentType || 'unknown'})`);
      }
    } catch (e) {
      blocks.push(`Could not fetch ${url}: ${errText(e)}`);
    }
  }
  return {
    text: blocks.length > 0 ? `The user referenced URLs. Fetched content:\n\n${blocks.join('\n\n---\n\n')}` : '',
    images,
  };
}
