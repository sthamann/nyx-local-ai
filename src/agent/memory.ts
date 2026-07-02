import type { Memento } from 'vscode';
import { stripSpecialTokens } from '../models/client';
import type { MemoryEntry } from '../types';

const KEY = 'nyx.memories.v1';
const MAX_ENTRIES = 80;

function randomId(): string {
  return `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function firstLine(text: string, max: number): string {
  const line = text.split('\n').find((l) => l.trim().length > 0) ?? text;
  const clean = line.trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function scoreEntry(entry: MemoryEntry, words: string[]): number {
  const haystack = `${entry.title} ${entry.title} ${entry.summary} ${entry.files.join(' ')}`.toLowerCase();
  let score = 0;
  for (const word of words) {
    let idx = haystack.indexOf(word);
    while (idx >= 0) {
      score++;
      idx = haystack.indexOf(word, idx + word.length);
    }
  }
  return score;
}

function formatFull(entry: MemoryEntry): string {
  const when = new Date(entry.updatedAt).toLocaleString();
  const files = entry.files.length > 0 ? `\n  files: ${entry.files.join(', ')}` : '';
  return `- [${when}] ${entry.title}\n  ${entry.summary}${files}`;
}

/**
 * Project-scoped long-term memory of key outcomes from past agent sessions.
 * Backed by the workspace Memento so it stays tied to this project.
 */
export class MemoryStore {
  private migrated = false;

  constructor(private readonly state: Memento) {}

  all(): MemoryEntry[] {
    // Copy the entries: Memento returns its internal cached objects, and
    // mutating those in place would leak through every other caller.
    const entries = this.state.get<MemoryEntry[]>(KEY, []).map((e) => ({ ...e }));
    // One-time scrub: memories written by older versions can contain leaked
    // model special tokens (DSML fragments). Left in place they poison every
    // future prompt via the digest, and the model starts imitating the junk.
    if (!this.migrated) {
      this.migrated = true;
      let dirty = false;
      for (const entry of entries) {
        const title = stripSpecialTokens(entry.title);
        const summary = stripSpecialTokens(entry.summary);
        if (title !== entry.title || summary !== entry.summary) {
          entry.title = title.trim() || 'Session';
          entry.summary = summary.trim() || '(cleaned: contained leaked model tokens)';
          dirty = true;
        }
      }
      if (dirty) {
        void this.state.update(KEY, entries);
      }
    }
    return entries;
  }

  private async write(entries: MemoryEntry[]): Promise<void> {
    const trimmed = entries
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_ENTRIES)
      .map((e) => ({ ...e, title: stripSpecialTokens(e.title), summary: stripSpecialTokens(e.summary) }));
    await this.state.update(KEY, trimmed);
  }

  /** Creates or refreshes the auto-memory for a session (one per session). */
  async upsertAuto(sessionId: string, title: string, summary: string, files: string[]): Promise<void> {
    const entries = this.all();
    const now = Date.now();
    const idx = entries.findIndex((e) => e.source === 'auto' && e.sessionId === sessionId);
    if (idx >= 0) {
      entries[idx] = { ...entries[idx], title, summary, files, updatedAt: now };
    } else {
      entries.push({ id: randomId(), sessionId, createdAt: now, updatedAt: now, title, summary, files, source: 'auto' });
    }
    await this.write(entries);
  }

  /** Records a memory explicitly requested by the agent. */
  async saveAgent(title: string, summary: string, files: string[] = []): Promise<MemoryEntry> {
    const now = Date.now();
    const entry: MemoryEntry = { id: randomId(), createdAt: now, updatedAt: now, title, summary, files, source: 'agent' };
    await this.write([entry, ...this.all()]);
    return entry;
  }

  async remove(id: string): Promise<void> {
    await this.write(this.all().filter((e) => e.id !== id));
  }

  async clear(): Promise<void> {
    await this.state.update(KEY, []);
  }

  /** Ranked search; empty query returns the most recent entries. */
  search(query: string | undefined, limit: number, excludeSessionId?: string): MemoryEntry[] {
    let entries = this.all().filter((e) => !(excludeSessionId && e.sessionId === excludeSessionId));
    const q = (query ?? '').trim().toLowerCase();
    if (q) {
      const words = q.split(/\s+/).filter(Boolean);
      entries = entries
        .map((e) => ({ e, s: scoreEntry(e, words) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s || b.e.updatedAt - a.e.updatedAt)
        .map((x) => x.e);
    } else {
      entries = entries.slice().sort((a, b) => b.updatedAt - a.updatedAt);
    }
    return entries.slice(0, Math.max(1, limit));
  }

  /** Full-text block for the recall_memory tool. */
  formatRecall(query: string | undefined, limit: number, excludeSessionId?: string): string {
    const list = this.search(query, limit, excludeSessionId);
    if (list.length === 0) {
      return query && query.trim() ? `No past work found matching "${query}".` : 'No memories stored yet.';
    }
    return list.map(formatFull).join('\n\n');
  }

  /** Compact digest injected into the system prompt of new sessions. */
  digest(limit: number, excludeSessionId?: string): string {
    const list = this.search(undefined, limit, excludeSessionId);
    if (list.length === 0) {
      return '';
    }
    const lines = list.map((e) => {
      const files = e.files.length > 0 ? ` (files: ${e.files.slice(0, 6).join(', ')})` : '';
      return `• ${e.title}${files}\n  ${firstLine(e.summary, 180)}`;
    });
    return [
      '[Project memory — key outcomes from earlier sessions in this workspace]',
      ...lines,
      '(Call recall_memory to search past work in detail; call save_memory to record durable new outcomes.)',
    ].join('\n');
  }
}
