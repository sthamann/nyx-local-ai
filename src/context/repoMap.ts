import * as vscode from 'vscode';

const EXCLUDE_GLOB =
  '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/.next/**,**/target/**,**/coverage/**,**/vendor/**,**/__pycache__/**,**/*.min.*,**/*.map,**/*.lock,**/package-lock.json}';
const MAX_SCANNED_FILES = 3000;
const MAX_DIRS = 40;
const MAX_FILES_PER_DIR = 8;
const MAX_CHARS = 1800;
const CACHE_TTL_MS = 5 * 60_000;

let cache: { root: string; at: number; map: string } | undefined;

/** Sort helper: source files first, then alphabetically — the map should lead with code. */
const SOURCE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|vue|svelte|sql|sh)$/i;

function fileSortKey(name: string): string {
  return `${SOURCE_EXT_RE.test(name) ? '0' : '1'}${name.toLowerCase()}`;
}

/**
 * Builds a compact "where is what" map of the workspace: directories with
 * their files, shallow paths first, hard-capped so it costs ~400 tokens.
 * Small local models guess far less about file locations with this in the
 * system context. Cached for a few minutes per workspace root.
 */
export async function buildRepoMap(root: vscode.Uri | undefined): Promise<string> {
  if (!root) {
    return '';
  }
  if (cache && cache.root === root.fsPath && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.map;
  }
  let uris: vscode.Uri[];
  try {
    uris = await vscode.workspace.findFiles('**/*', EXCLUDE_GLOB, MAX_SCANNED_FILES);
  } catch {
    return '';
  }
  const rootPath = root.fsPath.replace(/\/+$/, '');
  const byDir = new Map<string, string[]>();
  for (const uri of uris) {
    if (!uri.fsPath.startsWith(rootPath)) {
      continue;
    }
    const rel = uri.fsPath.slice(rootPath.length + 1).replace(/\\/g, '/');
    if (!rel || rel.startsWith('.')) {
      continue;
    }
    const slash = rel.lastIndexOf('/');
    const dir = slash === -1 ? '.' : rel.slice(0, slash);
    if (dir.split('/').some((part) => part.startsWith('.'))) {
      continue;
    }
    (byDir.get(dir) ?? byDir.set(dir, []).get(dir)!).push(rel.slice(slash + 1));
  }
  if (byDir.size === 0) {
    return '';
  }

  // Shallow directories first, then alphabetically — the top levels carry the structure.
  const dirs = [...byDir.keys()].sort((a, b) => {
    const depthA = a === '.' ? 0 : a.split('/').length;
    const depthB = b === '.' ? 0 : b.split('/').length;
    return depthA - depthB || a.localeCompare(b);
  });

  const lines: string[] = [];
  let omittedDirs = 0;
  for (const dir of dirs) {
    if (lines.length >= MAX_DIRS) {
      omittedDirs++;
      continue;
    }
    const files = byDir.get(dir)!.sort((a, b) => fileSortKey(a).localeCompare(fileSortKey(b)));
    const shown = files.slice(0, MAX_FILES_PER_DIR);
    const more = files.length - shown.length;
    lines.push(`${dir === '.' ? '(root)' : `${dir}/`}: ${shown.join(', ')}${more > 0 ? ` …(+${more})` : ''}`);
  }
  if (omittedDirs > 0) {
    lines.push(`… and ${omittedDirs} more director${omittedDirs === 1 ? 'y' : 'ies'}`);
  }

  let body = lines.join('\n');
  if (body.length > MAX_CHARS) {
    body = `${body.slice(0, MAX_CHARS)}\n… [map truncated]`;
  }
  const map = `## Workspace layout\nDirectories and their files (partial — use list_dir / find_files for details):\n${body}`;
  cache = { root: rootPath, at: Date.now(), map };
  return map;
}
