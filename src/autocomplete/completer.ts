import * as vscode from 'vscode';

const PREFIX_CHARS = 4000;
const SUFFIX_CHARS = 1200;
const DEBOUNCE_MS = 250;
const REQUEST_TIMEOUT_MS = 12000;

interface CacheEntry {
  key: string;
  text: string;
}

/**
 * Tab autocomplete via fill-in-the-middle on a small local model.
 *
 * Uses Ollama's native /api/generate with the `suffix` parameter, which
 * renders the model's own FIM template (works with qwen2.5-coder, codellama,
 * starcoder2, codegemma, …). Completions are debounced, cancellable, and
 * cached per document position, so typing stays smooth even on modest
 * hardware.
 */
export class NyxCompletionProvider implements vscode.InlineCompletionItemProvider {
  private lastCache: CacheEntry | undefined;
  private inflight: AbortController | undefined;
  private readonly statusItem: vscode.StatusBarItem;

  constructor() {
    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.statusItem.command = 'nyx.toggleAutocomplete';
    this.updateStatusItem();
  }

  dispose(): void {
    this.inflight?.abort();
    this.statusItem.dispose();
  }

  updateStatusItem(): void {
    const enabled = this.isEnabled();
    this.statusItem.text = enabled ? '$(sparkle) Nyx Tab' : '$(circle-slash) Nyx Tab';
    this.statusItem.tooltip = enabled
      ? `Nyx tab autocomplete: on (${this.config().model}) — click to turn off`
      : 'Nyx tab autocomplete: off — click to turn on';
    this.statusItem.show();
  }

  private isEnabled(): boolean {
    return vscode.workspace.getConfiguration('nyx').get<boolean>('autocompleteEnabled') ?? false;
  }

  private config(): { url: string; model: string; maxTokens: number } {
    const cfg = vscode.workspace.getConfiguration('nyx');
    return {
      url: (cfg.get<string>('autocompleteOllamaUrl') || cfg.get<string>('ollamaUrl') || 'http://localhost:11434').replace(/\/+$/, ''),
      model: cfg.get<string>('autocompleteModel') || 'qwen2.5-coder:7b',
      maxTokens: cfg.get<number>('autocompleteMaxTokens') ?? 160,
    };
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    if (!this.isEnabled() || document.uri.scheme === 'output') {
      return undefined;
    }

    const offset = document.offsetAt(position);
    const text = document.getText();
    const prefix = text.slice(Math.max(0, offset - PREFIX_CHARS), offset);
    const suffix = text.slice(offset, offset + SUFFIX_CHARS);
    if (prefix.trim().length < 3) {
      return undefined;
    }

    const cacheKey = `${document.uri.toString()}::${prefix}::${suffix.slice(0, 100)}`;
    if (this.lastCache?.key === cacheKey) {
      return this.toItems(this.lastCache.text, position);
    }

    // Debounce: wait, and bail out if the user kept typing.
    await new Promise<void>((resolve) => setTimeout(resolve, DEBOUNCE_MS));
    if (token.isCancellationRequested) {
      return undefined;
    }

    // Only one request at a time — newest wins.
    this.inflight?.abort();
    const controller = new AbortController();
    this.inflight = controller;
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    token.onCancellationRequested(() => controller.abort());

    const { url, model, maxTokens } = this.config();
    try {
      const res = await fetch(`${url}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt: prefix,
          suffix,
          stream: false,
          options: {
            num_predict: maxTokens,
            temperature: 0.15,
            // Stop before the model rambles into a second construct.
            stop: ['\n\n\n'],
          },
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        return undefined;
      }
      const data = (await res.json()) as { response?: string };
      let completion = data.response ?? '';
      completion = trimCompletion(completion, suffix);
      if (!completion.trim()) {
        return undefined;
      }
      this.lastCache = { key: cacheKey, text: completion };
      return this.toItems(completion, position);
    } catch {
      return undefined; // aborted or server unavailable — stay silent
    } finally {
      clearTimeout(timer);
      if (this.inflight === controller) {
        this.inflight = undefined;
      }
    }
  }

  private toItems(completion: string, position: vscode.Position): vscode.InlineCompletionItem[] {
    return [new vscode.InlineCompletionItem(completion, new vscode.Range(position, position))];
  }
}

/** Cleans model output: drops trailing rambling and text already present after the cursor. */
function trimCompletion(completion: string, suffix: string): string {
  let out = completion.replace(/\r/g, '');
  // If the model repeated the beginning of the suffix, cut it off.
  const suffixHead = suffix.trimStart().slice(0, 30);
  if (suffixHead.length >= 5) {
    const idx = out.indexOf(suffixHead);
    if (idx >= 0) {
      out = out.slice(0, idx);
    }
  }
  // Cap at 12 lines — inline ghosts longer than that are unusable.
  const lines = out.split('\n');
  if (lines.length > 12) {
    out = lines.slice(0, 12).join('\n');
  }
  return out.replace(/\s+$/, (m) => (m.includes('\n') ? '' : m));
}
