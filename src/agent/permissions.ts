export type PermissionPolicy = 'allow' | 'ask' | 'deny';

const DEFAULTS: Record<string, PermissionPolicy> = {
  read_file: 'allow',
  list_dir: 'allow',
  search_files: 'allow',
  semantic_search: 'allow',
  find_files: 'allow',
  get_diagnostics: 'allow',
  fetch_url: 'allow',
  web_search: 'allow',
  recall_memory: 'allow',
  save_memory: 'allow',
  read_rule: 'allow',
  use_skill: 'allow',
  ask_user: 'allow',
  set_plan: 'allow',
  check_process: 'allow',
  kill_process: 'allow',
  browser_snapshot: 'allow',
  browser_screenshot: 'allow',
  browser_close: 'allow',
  browser_navigate: 'ask',
  browser_click: 'ask',
  browser_type: 'ask',
  write_file: 'ask',
  edit_file: 'ask',
  delete_file: 'ask',
  rename_file: 'ask',
  run_command: 'ask',
  run_script: 'ask',
};

function normalize(value: unknown): PermissionPolicy | undefined {
  return value === 'allow' || value === 'ask' || value === 'deny' ? value : undefined;
}

/**
 * Resolves the effective policy for a tool. Overrides win, then built-in
 * defaults, then a wildcard, then a safe fallback. MCP tools are named
 * `mcp:<server>/<tool>` and can be governed per-tool or per-server.
 */
export function resolvePolicy(name: string, overrides: Record<string, unknown>): PermissionPolicy {
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
  }
  if (DEFAULTS[name]) {
    return DEFAULTS[name];
  }
  const wildcard = normalize(overrides['*']);
  if (wildcard) {
    return wildcard;
  }
  return 'ask';
}
