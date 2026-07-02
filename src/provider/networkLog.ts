import type { NetworkLogEntry } from '../types';

/**
 * Per-session network log backing the privacy report: which hosts were
 * contacted, why, and how often — so the "no cloud calls" promise is
 * verifiable at runtime. In-memory only; never persisted or transmitted.
 */
export class NetworkLog {
  private readonly hosts = new Map<string, { purposes: Set<string>; count: number }>();

  /** Records one contact with a host (accepts full URLs or bare host:port). */
  record(rawUrl: string | undefined, purpose: string): void {
    if (!rawUrl) {
      return;
    }
    let host: string;
    try {
      host = new URL(rawUrl.includes('://') ? rawUrl : `http://${rawUrl}`).host;
    } catch {
      return;
    }
    if (!host) {
      return;
    }
    const entry = this.hosts.get(host) ?? { purposes: new Set<string>(), count: 0 };
    entry.purposes.add(purpose);
    entry.count++;
    this.hosts.set(host, entry);
  }

  /** Extracts contacted hosts from network-facing tool calls. */
  recordToolCall(name: string, rawArgs: string, embeddingUrl: string | undefined): void {
    if (name === 'web_search') {
      this.record('https://html.duckduckgo.com', 'web search');
      return;
    }
    if (name === 'semantic_search') {
      this.record(embeddingUrl, 'embeddings');
      return;
    }
    if (name !== 'fetch_url' && name !== 'http_request' && name !== 'browser_navigate') {
      return;
    }
    try {
      const args = JSON.parse(rawArgs) as Record<string, unknown>;
      const purpose = name === 'fetch_url' ? 'fetch_url tool' : name === 'http_request' ? 'http_request tool' : 'browser';
      this.record(String(args.url ?? ''), purpose);
    } catch {
      // unparsable args — nothing to record
    }
  }

  entries(): NetworkLogEntry[] {
    return [...this.hosts.entries()]
      .map(([host, e]) => ({ host, purposes: [...e.purposes].sort(), count: e.count }))
      .sort((a, b) => b.count - a.count);
  }

  clear(): void {
    this.hosts.clear();
  }
}
