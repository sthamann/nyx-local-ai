import * as vscode from 'vscode';

/** Per-feature URL settings that can override the shared helper host. */
export type HelperUrlSetting = 'visionOllamaUrl' | 'embeddingOllamaUrl' | 'autocompleteOllamaUrl';

/**
 * Resolves the host for helper workloads (vision, embeddings, autocomplete).
 *
 * One "helper host" concept instead of three separate URL settings:
 * `nyx.helperOllamaUrl` covers all helpers and defaults to the main Ollama
 * (`nyx.ollamaUrl`). The legacy per-feature settings keep working as explicit
 * overrides for existing users — soft migration, no breaking change.
 */
export function resolveHelperUrl(feature: HelperUrlSetting): string {
  const cfg = vscode.workspace.getConfiguration('nyx');
  const inspected = cfg.inspect<string>(feature);
  const explicit = inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
  if (explicit && explicit.trim()) {
    return explicit.trim();
  }
  return (cfg.get<string>('helperOllamaUrl') || cfg.get<string>('ollamaUrl') || 'http://localhost:11434').trim();
}
