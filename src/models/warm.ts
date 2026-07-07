import type { ModelInfo } from '../types';

/**
 * Re-arms Ollama's model keep-alive timer so the model stays loaded (warm KV
 * cache, no reload before the next turn). Uses the documented preload call:
 * POST /api/generate with a model and keep_alive but no prompt. Called right
 * after a run finishes, when the model is guaranteed loaded — so this returns
 * quickly and never blocks anything (fire-and-forget, best effort).
 */
export async function warmKeepAlive(model: ModelInfo, keepAlive: string): Promise<void> {
  if (model.provider !== 'ollama' || !keepAlive.trim()) {
    return;
  }
  const base = model.endpoint.replace(/\/v1\/?$/, '');
  try {
    await fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(model.apiKey ? { Authorization: `Bearer ${model.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: model.id,
        keep_alive: keepAlive.trim(),
        // Must match the options the chat requests used: Ollama reloads the
        // runner when num_ctx differs, which would evict the warm model.
        ...(typeof model.numCtx === 'number' ? { options: { num_ctx: model.numCtx } } : {}),
      }),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    // Host gone or slow — the next real request will surface any problem.
  }
}
