import type { BenchmarkScores, Machine, MachineModelPref, MachineType } from '../src/types';
import { escapeHtml, mmBody } from './dom';
import { post, S } from './state';

let benchmarks: Record<string, BenchmarkScores> = {};
let benchmarkRunning: string | undefined;

/** Stores incoming benchmark results and refreshes the editor's model rows. */
export function onBenchmarks(entries: Record<string, BenchmarkScores>, runningKey?: string, error?: string): void {
  benchmarks = entries;
  benchmarkRunning = runningKey;
  if (error) {
    const status = document.getElementById('mmTestStatus');
    if (status) {
      status.textContent = `Benchmark: ${error}`;
    }
  }
  renderModelRows();
}

function scoreChip(scores: BenchmarkScores | undefined): string {
  if (!scores) {
    return '';
  }
  const title = `tools ${scores.tool}% · edits ${scores.edit}% · judgment ${scores.judge}% · false positives ${scores.fp}% · ${scores.avgMs} ms/request`;
  return `<span class="nyx-bench-chip" title="${escapeHtml(title)}">&#128295;${scores.tool}% &#9998;${scores.edit}% &#129504;${scores.judge}%</span>`;
}

const HARDWARE_PRESETS = ['Mac Studio', 'DGX Spark', 'DGX Spark Cluster', 'GPU Server', 'PC / Workstation', 'Other'];

let editing: Machine | null = null;
let editorDiscovered: string[] = [];
let editorDetectedCtx: number | undefined;

export function isEditing(): boolean {
  return editing !== null;
}

export function startAdd(): void {
  editing = { id: `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, name: '', type: 'ollama', url: 'http://localhost:11434', enabled: true, models: [] };
  editorDiscovered = [];
  editorDetectedCtx = undefined;
  renderMachines();
}

export function stopEditing(): void {
  editing = null;
}

function typeLabel(type: MachineType): string {
  switch (type) {
    case 'ollama':
      return 'Ollama';
    case 'lmstudio':
      return 'LM Studio';
    case 'openai':
      return 'OpenAI-compatible';
    default: {
      const exhaustive: never = type;
      return exhaustive;
    }
  }
}

export function renderMachines(): void {
  if (editing) {
    renderEditor();
  } else {
    renderMachineList();
  }
}

function renderMachineList(): void {
  mmBody.innerHTML = '';
  if (S.machines.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'nyx-empty';
    empty.textContent = 'No machines configured.';
    mmBody.appendChild(empty);
    return;
  }
  for (const machine of S.machines) {
    mmBody.appendChild(renderMachineCard(machine));
  }
}

function renderMachineCard(machine: Machine): HTMLElement {
  const enabledModels = (machine.models ?? []).filter((m) => m.enabled === false).length;
  const card = document.createElement('div');
  card.className = 'nyx-machine' + (machine.enabled === false ? ' off' : '');
  card.innerHTML = `
    <div class="nyx-machine-top">
      <div class="nyx-machine-title">
        <span class="nyx-machine-dot"></span>
        <span>${escapeHtml(machine.name || '(unnamed)')}</span>
      </div>
      <label class="nyx-switch" title="Enabled">
        <input type="checkbox" data-role="enabled" ${machine.enabled === false ? '' : 'checked'} />
        <span></span>
      </label>
    </div>
    <div class="nyx-machine-meta">${escapeHtml([machine.hardware, typeLabel(machine.type), machine.url].filter(Boolean).join(' · '))}</div>
    <div class="nyx-machine-meta subtle">${enabledModels > 0 ? `${enabledModels} model(s) hidden` : ''}</div>
    <div class="nyx-machine-actions">
      <button class="nyx-btn secondary" type="button" data-role="edit">Edit</button>
      <button class="nyx-btn secondary" type="button" data-role="delete">Delete</button>
    </div>`;
  card.querySelector('[data-role="enabled"]')?.addEventListener('change', (e) => {
    const next: Machine = { ...machine, enabled: (e.target as HTMLInputElement).checked };
    post({ type: 'saveMachine', machine: next });
  });
  card.querySelector('[data-role="edit"]')?.addEventListener('click', () => {
    editing = { ...machine, models: (machine.models ?? []).map((m) => ({ ...m })) };
    editorDiscovered = (machine.models ?? []).map((m) => m.id);
    editorDetectedCtx = undefined;
    renderMachines();
  });
  card.querySelector('[data-role="delete"]')?.addEventListener('click', () => {
    post({ type: 'deleteMachine', id: machine.id });
  });
  return card;
}

function field(label: string, inner: string, hint?: string): string {
  return `<label class="nyx-field"><span class="nyx-field-label">${escapeHtml(label)}</span>${inner}${hint ? `<span class="nyx-field-hint">${escapeHtml(hint)}</span>` : ''}</label>`;
}

const CONTEXT_PRESETS: { value: number; label: string }[] = [
  { value: 4096, label: '4K · 4,096' },
  { value: 8192, label: '8K · 8,192' },
  { value: 16384, label: '16K · 16,384' },
  { value: 32768, label: '32K · 32,768' },
  { value: 65536, label: '64K · 65,536' },
  { value: 131072, label: '128K · 131,072' },
  { value: 262144, label: '256K · 262,144' },
  { value: 524288, label: '512K · 524,288' },
  { value: 1048576, label: '1M · 1,048,576' },
];

export function fmtTokens(n: number): string {
  return n.toLocaleString('en-US');
}

/** Renders the Context length control: Auto / preset sizes / custom, with a live hint. */
function contextLengthField(current: number | undefined): string {
  const isPreset = current != null && CONTEXT_PRESETS.some((p) => p.value === current);
  const selected = current == null || current === 0 ? 'auto' : isPreset ? String(current) : 'custom';
  const options = [
    `<option value="auto"${selected === 'auto' ? ' selected' : ''}>Auto — detect from server</option>`,
    ...CONTEXT_PRESETS.map(
      (p) => `<option value="${p.value}"${selected === String(p.value) ? ' selected' : ''}>${p.label}</option>`,
    ),
    `<option value="custom"${selected === 'custom' ? ' selected' : ''}>Custom…</option>`,
  ].join('');
  const customVal = selected === 'custom' ? String(current) : '';
  const inner = `<select class="nyx-inp" id="mmCtx">${options}</select>` +
    `<input class="nyx-inp" id="mmCtxCustom" type="number" step="1024" min="0" value="${customVal}" placeholder="tokens"${selected === 'custom' ? '' : ' hidden'} />` +
    `<span class="nyx-field-hint" id="mmCtxHint"></span>`;
  return `<label class="nyx-field"><span class="nyx-field-label">Context length</span>${inner}</label>`;
}

/** Updates the Context length hint based on current selection and any detected value. */
function updateCtxHint(): void {
  const sel = document.getElementById('mmCtx') as HTMLSelectElement | null;
  const hint = document.getElementById('mmCtxHint');
  if (!sel || !hint) {
    return;
  }
  if (sel.value === 'auto') {
    hint.textContent = editorDetectedCtx
      ? `Detected ${fmtTokens(editorDetectedCtx)} tokens — used automatically.`
      : 'Uses the model’s advertised size. Run “Test & discover” to detect it.';
  } else if (sel.value === 'custom') {
    hint.textContent = editorDetectedCtx
      ? `Server reports ${fmtTokens(editorDetectedCtx)} tokens max.`
      : 'Enter a token budget. Higher = more history kept, slower per turn.';
  } else {
    const n = Number(sel.value);
    const overshoot = editorDetectedCtx && n > editorDetectedCtx;
    hint.textContent = overshoot
      ? `Warning: above the ${fmtTokens(editorDetectedCtx as number)} tokens the server reported.`
      : `Fixed budget of ${fmtTokens(n)} tokens.`;
  }
}

function renderEditor(): void {
  const m = editing!;
  const opts = HARDWARE_PRESETS.map((p) => `<option value="${escapeHtml(p)}"></option>`).join('');
  const typeOpt = (v: MachineType, label: string): string => `<option value="${v}" ${m.type === v ? 'selected' : ''}>${label}</option>`;
  const keyPlaceholder = m.hasApiKey ? 'saved in secret storage — type to replace' : 'Bearer token';
  mmBody.innerHTML = `
    <div class="nyx-editor">
      ${field('Name', `<input class="nyx-inp" id="mmName" type="text" value="${escapeHtml(m.name)}" placeholder="e.g. 2x DGX Spark Cluster" />`)}
      ${field('Hardware', `<input class="nyx-inp" id="mmHardware" list="mmHwList" value="${escapeHtml(m.hardware ?? '')}" placeholder="e.g. DGX Spark Cluster" /><datalist id="mmHwList">${opts}</datalist>`)}
      ${field('Connection', `<select class="nyx-inp" id="mmType">${typeOpt('ollama', 'Ollama')}${typeOpt('lmstudio', 'LM Studio')}${typeOpt('openai', 'OpenAI-compatible (vLLM, etc.)')}</select>`)}
      ${field('URL / Host', `<input class="nyx-inp" id="mmUrl" type="text" value="${escapeHtml(m.url)}" placeholder="http://192.168.1.50:11434" />`, 'IP or hostname on your local network, with port.')}
      ${field('API key (optional)', `<input class="nyx-inp" id="mmKey" type="password" value="" placeholder="${escapeHtml(keyPlaceholder)}" />`, m.hasApiKey ? 'A key is stored securely. Leave empty to keep it; type a new one to replace it.' : 'Stored in the editor’s secret storage, never in settings.')}
      ${field('Temperature', `<input class="nyx-inp" id="mmTemp" type="number" step="0.1" min="0" max="2" value="${m.temperature ?? ''}" placeholder="default" />`)}
      ${contextLengthField(m.numCtx)}
      <div class="nyx-editor-test">
        <button class="nyx-btn secondary" id="mmTest" type="button">Test & discover models</button>
        <span class="nyx-test-status" id="mmTestStatus"></span>
      </div>
      <div class="nyx-models" id="mmModels"></div>
      <div class="nyx-editor-actions">
        <button class="nyx-btn" id="mmSave" type="button">Save</button>
        <button class="nyx-btn secondary" id="mmCancel" type="button">Cancel</button>
      </div>
    </div>`;

  renderModelRows();
  updateCtxHint();

  const ctxSel = document.getElementById('mmCtx') as HTMLSelectElement | null;
  ctxSel?.addEventListener('change', () => {
    const custom = document.getElementById('mmCtxCustom') as HTMLInputElement | null;
    if (custom) {
      custom.hidden = ctxSel.value !== 'custom';
      if (ctxSel.value === 'custom') {
        custom.focus();
      }
    }
    updateCtxHint();
  });
  document.getElementById('mmCtxCustom')?.addEventListener('input', updateCtxHint);

  (document.getElementById('mmType') as HTMLSelectElement).addEventListener('change', () => {
    const t = (document.getElementById('mmType') as HTMLSelectElement).value as MachineType;
    const url = (document.getElementById('mmUrl') as HTMLInputElement).value.trim();
    if (!url || url === 'http://localhost:11434' || url === 'http://localhost:1234') {
      (document.getElementById('mmUrl') as HTMLInputElement).value = t === 'lmstudio' ? 'http://localhost:1234' : 'http://localhost:11434';
    }
  });
  document.getElementById('mmTest')?.addEventListener('click', () => {
    syncEditor();
    (document.getElementById('mmTestStatus') as HTMLElement).textContent = 'Testing…';
    post({ type: 'testMachine', machine: editing! });
  });
  document.getElementById('mmSave')?.addEventListener('click', () => {
    syncEditor();
    if (!editing!.name.trim() || !editing!.url.trim()) {
      (document.getElementById('mmTestStatus') as HTMLElement).textContent = 'Name and URL are required.';
      return;
    }
    post({ type: 'saveMachine', machine: editing! });
    editing = null;
  });
  document.getElementById('mmCancel')?.addEventListener('click', () => {
    editing = null;
    renderMachines();
  });
}

function renderModelRows(): void {
  const container = document.getElementById('mmModels');
  if (!container) {
    return;
  }
  const prefs = new Map((editing!.models ?? []).map((p) => [p.id, p]));
  if (editorDiscovered.length === 0) {
    container.innerHTML = '<div class="nyx-field-hint">No models discovered yet. Click “Test & discover”.</div>';
    return;
  }
  container.innerHTML = '<div class="nyx-field-label">Models on this machine</div>';
  for (const id of editorDiscovered) {
    const pref = prefs.get(id);
    const benchKey = `${editing!.id}:${id}`;
    const running = benchmarkRunning === benchKey;
    const row = document.createElement('div');
    row.className = 'nyx-model-row';
    row.innerHTML = `
      <label class="nyx-check">
        <input type="checkbox" data-mid="${escapeHtml(id)}" ${pref?.enabled === false ? '' : 'checked'} />
        <span>${escapeHtml(id)}</span>
      </label>
      ${scoreChip(benchmarks[benchKey])}
      <button class="nyx-btn secondary nyx-bench-btn" type="button" data-bench="${escapeHtml(id)}" ${running ? 'disabled' : ''} title="Run the 9-request benchmark (tool calls, edits, bug judgment) against this model">${running ? 'Running…' : 'Benchmark'}</button>
      <input class="nyx-inp small" type="text" data-alias="${escapeHtml(id)}" value="${escapeHtml(pref?.alias ?? '')}" placeholder="alias (optional)" />`;
    row.querySelector('[data-bench]')?.addEventListener('click', (e) => {
      (e.target as HTMLButtonElement).disabled = true;
      (e.target as HTMLButtonElement).textContent = 'Running…';
      post({ type: 'benchmarkModel', machineId: editing!.id, modelId: id });
    });
    container.appendChild(row);
  }
}

function syncEditor(): void {
  if (!editing) {
    return;
  }
  const val = (id: string): string => (document.getElementById(id) as HTMLInputElement | null)?.value.trim() ?? '';
  const num = (id: string): number | undefined => {
    const raw = val(id);
    if (raw === '') {
      return undefined;
    }
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  editing.name = val('mmName');
  editing.hardware = val('mmHardware') || undefined;
  editing.type = ((document.getElementById('mmType') as HTMLSelectElement | null)?.value as MachineType) ?? editing.type;
  editing.url = val('mmUrl');
  // Empty input keeps the stored secret; text replaces it (handled by the host).
  const key = val('mmKey');
  if (key) {
    editing.apiKey = key;
    editing.hasApiKey = true;
  }
  editing.temperature = num('mmTemp');
  const ctxSel = document.getElementById('mmCtx') as HTMLSelectElement | null;
  if (!ctxSel || ctxSel.value === 'auto') {
    editing.numCtx = undefined;
  } else if (ctxSel.value === 'custom') {
    editing.numCtx = num('mmCtxCustom');
  } else {
    editing.numCtx = Number(ctxSel.value);
  }

  const rows = Array.from(document.querySelectorAll('#mmModels [data-mid]')) as HTMLInputElement[];
  if (rows.length > 0) {
    const prefs: MachineModelPref[] = rows.map((cb) => {
      const id = cb.getAttribute('data-mid') ?? '';
      const alias = (document.querySelector(`#mmModels [data-alias="${CSS.escape(id)}"]`) as HTMLInputElement | null)?.value.trim();
      return { id, enabled: cb.checked, alias: alias || undefined };
    });
    editing.models = prefs;
  }
}

/** Applies a machine test result to the open editor. */
export function onMachineTestResult(machineId: string, ok: boolean, models: string[], contextLength?: number, error?: string): void {
  if (!editing || editing.id !== machineId) {
    return;
  }
  const status = document.getElementById('mmTestStatus') as HTMLElement | null;
  if (ok) {
    editorDiscovered = models;
    editorDetectedCtx = contextLength;
    if (status) {
      const ctxNote = contextLength ? ` · context ${fmtTokens(contextLength)}` : '';
      status.textContent = `Found ${models.length} model(s)${ctxNote}.`;
    }
    renderModelRows();
    updateCtxHint();
  } else if (status) {
    status.textContent = `Failed: ${error ?? 'unreachable'}`;
  }
}
