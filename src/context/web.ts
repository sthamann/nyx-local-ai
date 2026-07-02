const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface FetchedPage {
  contentType: string;
  html?: string;
  text?: string;
  bytes?: Uint8Array;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  euro: '€',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (match, code: string) => {
    if (code.startsWith('#')) {
      const num = code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isNaN(num) ? match : String.fromCodePoint(num);
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? match;
  });
}

/** Extracts unique http(s) URLs from free text. */
export function extractUrls(text: string): string[] {
  const matches = text.match(/\bhttps?:\/\/[^\s<>()"'`\]]+/gi) ?? [];
  const cleaned = matches.map((u) => u.replace(/[.,;:!?)\]}>]+$/, ''));
  return [...new Set(cleaned)];
}

/** Converts an HTML document into readable plain text. */
export function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<\/(p|div|h[1-6]|li|tr|section|article|header|footer|ul|ol|table|blockquote)>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/[ \t\f\v\r]+/g, ' ');
  s = s.replace(/\n[ \t]+/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/** Resolves a possibly-relative URL against a base. */
export function resolveUrl(base: string, src: string): string {
  try {
    return new URL(src, base).href;
  } catch {
    return src;
  }
}

/** Finds candidate content image URLs on a page (og:image first, then <img>). */
export function extractImageUrls(html: string, baseUrl: string): string[] {
  const urls: string[] = [];
  const og = html.match(/<meta[^>]+(?:property|name)=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  if (og) {
    urls.push(og[1]);
  }
  const imgRe = /<img[^>]+src=["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = imgRe.exec(html))) {
    urls.push(m[1]);
  }
  const resolved = urls
    .map((u) => resolveUrl(baseUrl, u))
    .filter((u) => /^https?:\/\//i.test(u))
    .filter((u) => !u.startsWith('data:') && !/\.svg(\?|#|$)/i.test(u));
  return [...new Set(resolved)];
}

function decodeDuckHref(href: string): string {
  let h = href;
  if (h.startsWith('//')) {
    h = `https:${h}`;
  }
  try {
    const u = new URL(h, 'https://duckduckgo.com');
    return u.searchParams.get('uddg') ?? u.href;
  } catch {
    return href;
  }
}

/** Parses DuckDuckGo's HTML results page into structured results. */
export function parseDuckDuckGo(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const linkRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) && results.length < 12) {
    results.push({ url: decodeDuckHref(m[1]), title: htmlToText(m[2]), snippet: '' });
  }
  const snippetRe = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippets: string[] = [];
  let s: RegExpExecArray | null;
  while ((s = snippetRe.exec(html))) {
    snippets.push(htmlToText(s[1]));
  }
  results.forEach((r, i) => {
    r.snippet = snippets[i] ?? '';
  });
  return results.filter((r) => r.url && r.title);
}

/** Fetches a URL and classifies the response as html, text, or binary image. */
export async function fetchPage(url: string, timeoutMs = 20000): Promise<FetchedPage> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('html') || contentType.includes('xhtml')) {
    return { contentType, html: await res.text() };
  }
  if (contentType.startsWith('image/')) {
    return { contentType, bytes: new Uint8Array(await res.arrayBuffer()) };
  }
  if (contentType.startsWith('text/') || contentType.includes('json') || contentType.includes('xml') || contentType === '') {
    return { contentType, text: await res.text() };
  }
  return { contentType };
}

/** Runs a DuckDuckGo search and returns formatted results. */
export async function webSearch(query: string, timeoutMs = 20000): Promise<SearchResult[]> {
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`search HTTP ${res.status}`);
  }
  return parseDuckDuckGo(await res.text());
}
