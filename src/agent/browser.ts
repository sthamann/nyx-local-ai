import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';

const NAV_TIMEOUT_MS = 25000;
const MAX_SNAPSHOT_ELEMENTS = 80;
const MAX_TEXT_CHARS = 6000;

/**
 * Headless browser automation on the user's installed Chrome/Edge via
 * playwright-core (no bundled browser download). One page per session;
 * interactive elements get numeric refs that click/type address.
 */
export class BrowserManager {
  private browser: Browser | undefined;
  private page: Page | undefined;
  private refCount = 0;

  constructor(private readonly executablePathSetting: () => string | undefined) {}

  private async ensurePage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) {
      return this.page;
    }
    if (!this.browser || !this.browser.isConnected()) {
      this.browser = await this.launch();
    }
    this.page = await this.browser.newPage({ viewport: { width: 1280, height: 900 } });
    this.page.setDefaultTimeout(NAV_TIMEOUT_MS);
    return this.page;
  }

  private async launch(): Promise<Browser> {
    const explicit = this.executablePathSetting();
    const attempts: Array<{ channel?: 'chrome' | 'msedge'; executablePath?: string }> = explicit
      ? [{ executablePath: explicit }]
      : [{ channel: 'chrome' }, { channel: 'msedge' }];
    let lastError: unknown;
    for (const attempt of attempts) {
      try {
        return await chromium.launch({ headless: true, ...attempt });
      } catch (e) {
        lastError = e;
      }
    }
    throw new Error(
      `Could not launch a browser (${lastError instanceof Error ? lastError.message.split('\n')[0] : String(lastError)}). ` +
        'Install Google Chrome or Microsoft Edge, or set nyx.browserExecutable to a Chromium binary.',
    );
  }

  async navigate(url: string): Promise<string> {
    if (!/^https?:\/\//i.test(url)) {
      throw new Error('Only http(s) URLs are allowed.');
    }
    const page = await this.ensurePage();
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await page.waitForLoadState('load', { timeout: 8000 }).catch(() => undefined);
    const status = response?.status();
    return `Opened ${page.url()}${status ? ` (HTTP ${status})` : ''} — "${await page.title()}"\n\n${await this.snapshot()}`;
  }

  /** Text + interactive-element summary. Refs stay valid until the next snapshot/navigation. */
  async snapshot(): Promise<string> {
    const page = await this.ensurePage();
    this.refCount = 0;
    const result = await page.evaluate((maxElements) => {
      // Runs in the page: annotate interactive elements with data-nyx-ref.
      document.querySelectorAll('[data-nyx-ref]').forEach((el) => el.removeAttribute('data-nyx-ref'));
      const interactive = Array.from(
        document.querySelectorAll<HTMLElement>('a[href], button, input, textarea, select, [role="button"], [onclick]'),
      ).filter((el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      });
      const elements: string[] = [];
      interactive.slice(0, maxElements).forEach((el, i) => {
        el.setAttribute('data-nyx-ref', String(i + 1));
        const tag = el.tagName.toLowerCase();
        const type = el.getAttribute('type');
        const label =
          (el as HTMLInputElement).placeholder ||
          el.getAttribute('aria-label') ||
          el.textContent?.trim().replace(/\s+/g, ' ').slice(0, 80) ||
          el.getAttribute('href')?.slice(0, 80) ||
          '';
        elements.push(`[${i + 1}] <${tag}${type ? ` type=${type}` : ''}> ${label}`);
      });
      const text = (document.body?.innerText ?? '').replace(/\n{3,}/g, '\n\n');
      return { title: document.title, url: location.href, text, elements, total: interactive.length };
    }, MAX_SNAPSHOT_ELEMENTS);
    this.refCount = Math.min(result.total, MAX_SNAPSHOT_ELEMENTS);
    const textPart = result.text.length > MAX_TEXT_CHARS ? `${result.text.slice(0, MAX_TEXT_CHARS)}\n… [truncated]` : result.text;
    return [
      `Page: ${result.title} (${result.url})`,
      '',
      '## Interactive elements (use the [ref] number with browser_click / browser_type)',
      result.elements.join('\n') || '(none found)',
      result.total > MAX_SNAPSHOT_ELEMENTS ? `… ${result.total - MAX_SNAPSHOT_ELEMENTS} more not listed` : '',
      '',
      '## Page text',
      textPart,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private async byRef(ref: number): Promise<string> {
    if (!Number.isInteger(ref) || ref < 1 || ref > Math.max(this.refCount, 1)) {
      throw new Error(`Invalid ref ${ref}. Take a browser_snapshot first and use one of its [ref] numbers.`);
    }
    return `[data-nyx-ref="${ref}"]`;
  }

  async click(ref: number): Promise<string> {
    const page = await this.ensurePage();
    await page.click(await this.byRef(ref), { timeout: 8000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => undefined);
    return `Clicked [${ref}].\n\n${await this.snapshot()}`;
  }

  async type(ref: number, text: string, submit: boolean): Promise<string> {
    const page = await this.ensurePage();
    const selector = await this.byRef(ref);
    await page.fill(selector, text, { timeout: 8000 });
    if (submit) {
      await page.press(selector, 'Enter');
      await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => undefined);
    }
    return `Typed into [${ref}]${submit ? ' and pressed Enter' : ''}.\n\n${await this.snapshot()}`;
  }

  /** Saves a screenshot and returns its path (caller can run it through the vision pipeline). */
  async screenshot(): Promise<{ file: string; bytes: Uint8Array }> {
    const page = await this.ensurePage();
    const file = path.join(os.tmpdir(), `nyx-browser-${Date.now()}.png`);
    const bytes = await page.screenshot({ path: file, fullPage: false });
    return { file, bytes: new Uint8Array(bytes) };
  }

  async close(): Promise<string> {
    await this.dispose();
    return 'Browser closed.';
  }

  async dispose(): Promise<void> {
    try {
      await this.page?.close();
      await this.browser?.close();
    } catch {
      // already gone
    }
    this.page = undefined;
    this.browser = undefined;
  }
}

/** Removes stale screenshot temp files older than a day (best effort). */
export async function cleanupBrowserShots(): Promise<void> {
  try {
    const dir = os.tmpdir();
    const names = await fs.readdir(dir);
    const cutoff = Date.now() - 86400000;
    await Promise.all(
      names
        .filter((n) => n.startsWith('nyx-browser-') && n.endsWith('.png'))
        .map(async (n) => {
          const file = path.join(dir, n);
          const stat = await fs.stat(file).catch(() => undefined);
          if (stat && stat.mtimeMs < cutoff) {
            await fs.rm(file, { force: true }).catch(() => undefined);
          }
        }),
    );
  } catch {
    // best effort
  }
}
