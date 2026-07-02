import * as vscode from 'vscode';
import { parseFrontmatter } from './frontmatter';

export interface RuleMeta {
  name: string;
  description: string;
  globs: string[];
  alwaysApply: boolean;
  body: string;
  source: string;
}

function toGlobs(value: string | boolean | string[] | undefined): string[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    return value.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

async function readText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

async function collectMdc(dir: vscode.Uri, out: RuleMeta[]): Promise<void> {
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(dir);
  } catch {
    return;
  }
  for (const [entryName, type] of entries) {
    const child = vscode.Uri.joinPath(dir, entryName);
    if (type === vscode.FileType.Directory) {
      await collectMdc(child, out);
    } else if (entryName.endsWith('.mdc')) {
      const text = await readText(child);
      if (text === undefined) {
        continue;
      }
      const { data, body } = parseFrontmatter(text);
      out.push({
        name: entryName.replace(/\.mdc$/, ''),
        description: typeof data.description === 'string' ? data.description : '',
        globs: toGlobs(data.globs),
        alwaysApply: data.alwaysApply === true,
        body,
        source: child.fsPath,
      });
    }
  }
}

async function addPlainRule(root: vscode.Uri, fileName: string, out: RuleMeta[]): Promise<void> {
  const uri = vscode.Uri.joinPath(root, fileName);
  const text = await readText(uri);
  if (text === undefined || !text.trim()) {
    return;
  }
  out.push({
    name: fileName,
    description: 'Project-wide instructions',
    globs: [],
    alwaysApply: true,
    body: text.trim(),
    source: uri.fsPath,
  });
}

/** Loads project rules from `.cursor/rules/*.mdc`, `AGENTS.md` and `.cursorrules`. */
export async function loadRules(root: vscode.Uri | undefined): Promise<RuleMeta[]> {
  if (!root) {
    return [];
  }
  const rules: RuleMeta[] = [];
  await collectMdc(vscode.Uri.joinPath(root, '.cursor', 'rules'), rules);
  await addPlainRule(root, 'AGENTS.md', rules);
  await addPlainRule(root, '.cursorrules', rules);
  return rules;
}

/** Builds the system-prompt section describing the available rules. */
export function buildRulesSection(rules: RuleMeta[]): string {
  if (rules.length === 0) {
    return '';
  }
  const always = rules.filter((r) => r.alwaysApply);
  const optional = rules.filter((r) => !r.alwaysApply);
  const parts: string[] = [];

  if (always.length > 0) {
    parts.push('# Project rules (always apply)');
    for (const rule of always) {
      parts.push(`## ${rule.name}\n${rule.body}`);
    }
  }
  if (optional.length > 0) {
    parts.push('# Additional project rules (call read_rule to load full text before relevant work)');
    for (const rule of optional) {
      const scope = rule.globs.length > 0 ? ` (applies to: ${rule.globs.join(', ')})` : '';
      parts.push(`- ${rule.name}: ${rule.description || 'no description'}${scope}`);
    }
  }
  return parts.join('\n\n');
}
