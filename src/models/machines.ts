import * as vscode from 'vscode';
import type { Machine } from '../types';

interface LegacyEndpoint {
  name?: string;
  url?: string;
  apiKey?: string;
}

const SECRET_PREFIX = 'nyx.apiKey.';

/** Built-in localhost machines plus any legacy `customEndpoints`. */
function defaultMachines(cfg: vscode.WorkspaceConfiguration): Machine[] {
  const ollamaUrl = cfg.get<string>('ollamaUrl') ?? 'http://localhost:11434';
  const lmStudioUrl = cfg.get<string>('lmStudioUrl') ?? 'http://localhost:1234';
  const legacy = cfg.get<LegacyEndpoint[]>('customEndpoints') ?? [];

  const machines: Machine[] = [
    { id: 'ollama-local', name: 'Ollama (localhost)', hardware: 'This machine', type: 'ollama', url: ollamaUrl, enabled: true },
    { id: 'lmstudio-local', name: 'LM Studio (localhost)', hardware: 'This machine', type: 'lmstudio', url: lmStudioUrl, enabled: true },
  ];
  legacy.forEach((e, i) => {
    if (e.url) {
      machines.push({ id: `legacy-${i}`, name: e.name ?? e.url, type: 'openai', url: e.url, apiKey: e.apiKey, enabled: true });
    }
  });
  return machines;
}

/**
 * Manages the configured machines. Non-secret fields live in the `nyx.machines`
 * setting; API keys live in the editor's SecretStorage (never in settings, so
 * they are not synced or committed in plain text).
 */
export class MachineStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  /** Machines without secrets (safe to show in the UI). */
  getMachines(): Machine[] {
    const cfg = vscode.workspace.getConfiguration('nyx');
    const persisted = cfg.get<Machine[]>('machines');
    const machines = persisted && persisted.length > 0 ? persisted : defaultMachines(cfg);
    return machines.map((m) => ({ ...m }));
  }

  /** Machines for the webview: apiKey stripped, hasApiKey flag set. */
  async getMachinesForUi(): Promise<Machine[]> {
    const machines = this.getMachines();
    return Promise.all(
      machines.map(async (m) => {
        const secret = await this.secrets.get(SECRET_PREFIX + m.id);
        const { apiKey, ...rest } = m;
        return { ...rest, hasApiKey: Boolean(secret || apiKey) };
      }),
    );
  }

  /**
   * Machines with API keys resolved from SecretStorage. Legacy plaintext keys
   * found in settings are migrated into SecretStorage on the way.
   */
  async getMachinesWithSecrets(): Promise<Machine[]> {
    const machines = this.getMachines();
    let migrated = false;
    for (const m of machines) {
      if (m.apiKey) {
        await this.secrets.store(SECRET_PREFIX + m.id, m.apiKey);
        migrated = true;
        continue;
      }
      const secret = await this.secrets.get(SECRET_PREFIX + m.id);
      if (secret) {
        m.apiKey = secret;
      }
    }
    if (migrated) {
      await this.write(machines);
    }
    return machines;
  }

  /** Persists machines to settings, always stripping secrets first. */
  private async write(machines: Machine[]): Promise<void> {
    const sanitized = machines.map((m) => {
      const { apiKey, hasApiKey, ...rest } = m;
      void apiKey;
      void hasApiKey;
      return rest;
    });
    await vscode.workspace.getConfiguration('nyx').update('machines', sanitized, vscode.ConfigurationTarget.Global);
  }

  async save(machine: Machine): Promise<void> {
    if (!machine.id) {
      machine.id = `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    }
    if (machine.apiKey) {
      await this.secrets.store(SECRET_PREFIX + machine.id, machine.apiKey);
    } else if (machine.hasApiKey === false) {
      // The user explicitly cleared the key in the editor.
      await this.secrets.delete(SECRET_PREFIX + machine.id);
    }
    const list = this.getMachines();
    const idx = list.findIndex((m) => m.id === machine.id);
    if (idx >= 0) {
      list[idx] = machine;
    } else {
      list.push(machine);
    }
    await this.write(list);
  }

  async remove(id: string): Promise<void> {
    await this.secrets.delete(SECRET_PREFIX + id);
    await this.write(this.getMachines().filter((m) => m.id !== id));
  }
}
