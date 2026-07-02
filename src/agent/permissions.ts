export type PermissionPolicy = 'allow' | 'ask' | 'deny';

/** One-switch autonomy presets layered under the per-tool overrides. */
export type Autonomy = 'safe' | 'balanced' | 'autopilot';

/** Balanced = the long-standing defaults: reads free, mutations ask. */
const BALANCED: Record<string, PermissionPolicy> = {
  read_file: 'allow',
  list_dir: 'allow',
  search_files: 'allow',
  semantic_search: 'allow',
  find_files: 'allow',
  file_outline: 'allow',
  find_symbol: 'allow',
  find_references: 'allow',
  get_diagnostics: 'allow',
  fetch_url: 'allow',
  web_search: 'allow',
  recall_memory: 'allow',
  save_memory: 'allow',
  read_rule: 'allow',
  use_skill: 'allow',
  ask_user: 'allow',
  set_plan: 'allow',
  wait: 'allow',
  check_process: 'allow',
  kill_process: 'allow',
  browser_snapshot: 'allow',
  browser_screenshot: 'allow',
  browser_close: 'allow',
  browser_navigate: 'ask',
  browser_click: 'ask',
  browser_type: 'ask',
  http_request: 'ask',
  format_file: 'allow',
  write_file: 'ask',
  edit_file: 'ask',
  delete_file: 'ask',
  rename_file: 'ask',
  run_command: 'ask',
  run_script: 'ask',
};

/** Safe: everything that leaves the editor or touches the network asks too. */
const SAFE_ADJUSTMENTS: Record<string, PermissionPolicy> = {
  fetch_url: 'ask',
  web_search: 'ask',
  browser_snapshot: 'ask',
  browser_screenshot: 'ask',
  save_memory: 'ask',
};

/**
 * Autopilot: edits and commands run without prompts (checkpoints + backups are
 * the safety net); deleting files stays confirmed.
 */
const AUTOPILOT_ADJUSTMENTS: Record<string, PermissionPolicy> = {
  write_file: 'allow',
  edit_file: 'allow',
  rename_file: 'allow',
  run_command: 'allow',
  run_script: 'allow',
  browser_navigate: 'allow',
  browser_click: 'allow',
  browser_type: 'allow',
  http_request: 'allow',
};

function normalize(value: unknown): PermissionPolicy | undefined {
  return value === 'allow' || value === 'ask' || value === 'deny' ? value : undefined;
}

function autonomyDefault(name: string, autonomy: Autonomy): PermissionPolicy | undefined {
  switch (autonomy) {
    case 'safe':
      return SAFE_ADJUSTMENTS[name] ?? BALANCED[name];
    case 'balanced':
      return BALANCED[name];
    case 'autopilot':
      return AUTOPILOT_ADJUSTMENTS[name] ?? BALANCED[name];
    default: {
      const exhaustive: never = autonomy;
      void exhaustive;
      return undefined;
    }
  }
}

/**
 * Resolves the effective policy for a tool. Explicit user overrides always
 * win, then the autonomy preset's defaults, then a wildcard, then a safe
 * fallback. MCP tools are named `mcp:<server>/<tool>` and can be governed
 * per-tool or per-server; on autopilot they run without prompts.
 */
export function resolvePolicy(name: string, overrides: Record<string, unknown>, autonomy: Autonomy = 'balanced'): PermissionPolicy {
  const direct = normalize(overrides[name]);
  if (direct) {
    return direct;
  }
  if (name.startsWith('mcp:')) {
    const server = name.slice(4).split('/')[0];
    const perServer = normalize(overrides[`mcp:${server}`]);
    if (perServer) {
      return perServer;
    }
    return autonomy === 'autopilot' ? 'allow' : 'ask';
  }
  const preset = autonomyDefault(name, autonomy);
  if (preset) {
    return preset;
  }
  const wildcard = normalize(overrides['*']);
  if (wildcard) {
    return wildcard;
  }
  return 'ask';
}
