import type { Machine, MachineType, ModelCapability, ModelInfo, Provider } from '../types';

export interface ProbeResult {
  ok: boolean;
  models: string[];
  /** Largest advertised context length among the discovered models, if reported. */
  contextLength?: number;
  error?: string;
}

function stripSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function ollamaHost(url: string): string {
  return stripSlash(url).replace(/\/v1$/, '');
}

/** Base URL used for OpenAI-compatible /chat/completions calls (ends in /v1). */
function apiBase(machine: Machine): string {
  if (machine.type === 'ollama') {
    return `${ollamaHost(machine.url)}/v1`;
  }
  const base = stripSlash(machine.url);
  return base.endsWith('/v1') ? base : `${base}/v1`;
}

interface DiscoveredModel {
  id: string;
  contextLength?: number;
  capabilities?: ModelCapability[];
}

type ModelParser = (data: any) => DiscoveredModel[];

const parseOllamaTags: ModelParser = (data) =>
  Array.isArray(data?.models)
    ? data.models
        .map((m: any): DiscoveredModel | null => (typeof m?.name === 'string' ? { id: m.name } : null))
        .filter((m: DiscoveredModel | null): m is DiscoveredModel => m !== null)
    : [];

const parseOpenAiModels: ModelParser = (data) =>
  Array.isArray(data?.data)
    ? data.data
        .map((m: any): DiscoveredModel | null =>
          typeof m?.id === 'string'
            ? { id: m.id, contextLength: typeof m?.max_model_len === 'number' ? m.max_model_len : undefined }
            : null,
        )
        .filter((m: DiscoveredModel | null): m is DiscoveredModel => m !== null)
    : [];

interface DiscoverCandidate {
  url: string;
  parse: ModelParser;
}

/**
 * Candidate model-listing endpoints to try, in priority order. We probe both the
 * native Ollama API (/api/tags) and the OpenAI-compatible one (/v1/models) so a
 * server that only exposes one of them (e.g. a DGX gateway on :8888/v1) still works
 * regardless of the declared connection type.
 */
function candidateEndpoints(machine: Machine): DiscoverCandidate[] {
  const base = stripSlash(machine.url);
  const host = base.replace(/\/v1$/, '');
  const v1 = base.endsWith('/v1') ? base : `${host}/v1`;
  const ollama: DiscoverCandidate = { url: `${host}/api/tags`, parse: parseOllamaTags };
  const openai: DiscoverCandidate = { url: `${v1}/models`, parse: parseOpenAiModels };
  const ordered = machine.type === 'ollama' ? [ollama, openai] : [openai, ollama];
  const seen = new Set<string>();
  return ordered.filter((c) => {
    if (seen.has(c.url)) {
      return false;
    }
    seen.add(c.url);
    return true;
  });
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function providerOf(type: MachineType): Provider {
  switch (type) {
    case 'ollama':
      return 'ollama';
    case 'lmstudio':
      return 'lmstudio';
    case 'openai':
      return 'custom';
    default: {
      const exhaustive: never = type;
      return exhaustive;
    }
  }
}

async function fetchJson(
  url: string,
  apiKey: string | undefined,
  timeoutMs: number,
  init?: { method?: string; body?: string },
): Promise<{ ok: boolean; data?: any; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: init?.method ?? 'GET',
      body: init?.body,
      signal: controller.signal,
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status} ${res.statusText}` };
    }
    return { ok: true, data: await res.json() };
  } catch (e) {
    const msg = e instanceof Error ? (e.name === 'AbortError' ? 'Timed out' : e.message) : String(e);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

// ---- Ollama model details (/api/show): capabilities + true context length ----

interface ModelDetails {
  capabilities?: ModelCapability[];
  contextLength?: number;
}

const KNOWN_CAPABILITIES: ModelCapability[] = ['tools', 'vision', 'thinking', 'completion', 'insert', 'embedding'];
const detailsCache = new Map<string, ModelDetails>();

/** Fetches capabilities and context length for one Ollama model (cached per host+model). */
async function ollamaModelDetails(host: string, model: string, apiKey: string | undefined): Promise<ModelDetails> {
  const cacheKey = `${host}::${model}`;
  const cached = detailsCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const { ok, data } = await fetchJson(`${host}/api/show`, apiKey, 3000, {
    method: 'POST',
    body: JSON.stringify({ model }),
  });
  const details: ModelDetails = {};
  if (ok && data) {
    if (Array.isArray(data.capabilities)) {
      details.capabilities = data.capabilities.filter((c: unknown): c is ModelCapability =>
        KNOWN_CAPABILITIES.includes(c as ModelCapability),
      );
    }
    const info = data.model_info;
    if (info && typeof info === 'object') {
      for (const [key, value] of Object.entries(info as Record<string, unknown>)) {
        if (key.endsWith('.context_length') && typeof value === 'number') {
          details.contextLength = value;
          break;
        }
      }
    }
  }
  detailsCache.set(cacheKey, details);
  return details;
}

async function probeModels(
  machine: Machine,
  timeoutMs: number,
): Promise<{ ok: boolean; models: DiscoveredModel[]; error?: string }> {
  if (!machine.url.trim()) {
    return { ok: false, models: [], error: 'No URL provided.' };
  }
  const candidates = candidateEndpoints(machine);
  let lastError: string | undefined;
  let reachedEmpty = false;
  for (const candidate of candidates) {
    const { ok, data, error } = await fetchJson(candidate.url, machine.apiKey, timeoutMs);
    if (!ok) {
      lastError = error;
      continue;
    }
    const models = candidate.parse(data);
    if (models.length > 0) {
      const sorted = [...models].sort((a, b) => a.id.localeCompare(b.id));
      // Enrich Ollama models with capabilities + true context length.
      if (candidate.parse === parseOllamaTags) {
        const host = ollamaHost(machine.url);
        await Promise.all(
          sorted.map(async (m) => {
            const details = await ollamaModelDetails(host, m.id, machine.apiKey);
            m.capabilities = details.capabilities;
            m.contextLength = m.contextLength ?? details.contextLength;
          }),
        );
      }
      return { ok: true, models: sorted };
    }
    reachedEmpty = true;
  }
  if (reachedEmpty) {
    return { ok: true, models: [] };
  }
  const tried = candidates.map((c) => pathOf(c.url)).join(', ');
  return { ok: false, models: [], error: `${lastError ?? 'Unreachable'} (tried ${tried})` };
}

/** Probes one machine and returns the model ids it serves (for the test UI). */
export async function probeMachine(machine: Machine, timeoutMs = 4000): Promise<ProbeResult> {
  const result = await probeModels(machine, timeoutMs);
  const contextLength = result.models.reduce<number>(
    (max, m) => (typeof m.contextLength === 'number' && m.contextLength > max ? m.contextLength : max),
    0,
  );
  return {
    ok: result.ok,
    models: result.models.map((m) => m.id),
    contextLength: contextLength > 0 ? contextLength : undefined,
    error: result.error,
  };
}

function machineToModels(machine: Machine, discovered: DiscoveredModel[]): ModelInfo[] {
  const prefs = new Map((machine.models ?? []).map((p) => [p.id, p]));
  const endpoint = apiBase(machine);
  const provider = providerOf(machine.type);
  const out: ModelInfo[] = [];
  for (const dm of discovered) {
    const pref = prefs.get(dm.id);
    if (pref && pref.enabled === false) {
      continue;
    }
    out.push({
      id: dm.id,
      key: `${machine.id}:${dm.id}`,
      label: pref?.alias?.trim() || dm.id,
      provider,
      endpoint,
      apiKey: machine.apiKey,
      temperature: machine.temperature,
      numCtx: machine.numCtx,
      contextLength: dm.contextLength,
      capabilities: dm.capabilities,
      machineId: machine.id,
      machineName: machine.name,
    });
  }
  return out;
}

/**
 * Probes every enabled machine and returns the union of available models.
 * Unreachable machines are skipped silently.
 */
export async function discoverModels(machines: Machine[]): Promise<ModelInfo[]> {
  const enabled = machines.filter((m) => m.enabled !== false);
  const results = await Promise.all(enabled.map((m) => probeModels(m, 2000)));

  const models: ModelInfo[] = [];
  enabled.forEach((machine, i) => {
    const result = results[i];
    if (result.ok) {
      models.push(...machineToModels(machine, result.models));
    }
  });

  const seen = new Set<string>();
  return models.filter((m) => {
    if (seen.has(m.key)) {
      return false;
    }
    seen.add(m.key);
    return true;
  });
}
