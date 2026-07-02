import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { parseFrontmatter } from './frontmatter';

export interface SkillMeta {
  name: string;
  description: string;
  path: string;
}

const MAX_ENTRIES = 6000;
const MAX_DEPTH = 6;

function globalRoots(): string[] {
  const home = os.homedir();
  return [
    path.join(home, '.cursor', 'skills-cursor'),
    path.join(home, '.claude', 'skills'),
    path.join(home, '.agents', 'skills'),
    path.join(home, '.cursor', 'plugins', 'cache'),
  ];
}

async function scan(dir: vscode.Uri, depth: number, budget: { count: number }, out: Map<string, SkillMeta>): Promise<void> {
  if (depth > MAX_DEPTH || budget.count > MAX_ENTRIES) {
    return;
  }
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(dir);
  } catch {
    return;
  }
  for (const [entryName, type] of entries) {
    budget.count++;
    if (budget.count > MAX_ENTRIES) {
      return;
    }
    if (type === vscode.FileType.Directory) {
      if (entryName === 'node_modules' || entryName === '.git') {
        continue;
      }
      await scan(vscode.Uri.joinPath(dir, entryName), depth + 1, budget, out);
    } else if (entryName === 'SKILL.md') {
      const uri = vscode.Uri.joinPath(dir, entryName);
      const meta = await readSkill(uri);
      if (meta) {
        out.set(meta.name.toLowerCase(), meta);
      }
    }
  }
}

async function readSkill(uri: vscode.Uri): Promise<SkillMeta | undefined> {
  let text: string;
  try {
    text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
  const { data } = parseFrontmatter(text);
  const parentName = uri.path.split('/').slice(-2, -1)[0] ?? 'skill';
  const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : parentName;
  const description = typeof data.description === 'string' ? data.description : firstLine(text);
  return { name, description, path: uri.fsPath };
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim() && !l.startsWith('#') && l !== '---');
  return (line ?? '').slice(0, 200);
}

/** Discovers skills from global skill roots plus the current workspace. */
export async function loadSkills(root: vscode.Uri | undefined): Promise<SkillMeta[]> {
  const out = new Map<string, SkillMeta>();
  const budget = { count: 0 };

  for (const dir of globalRoots()) {
    await scan(vscode.Uri.file(dir), 0, budget, out);
  }
  if (root) {
    await scan(vscode.Uri.joinPath(root, '.cursor', 'skills'), 0, budget, out);
    await scan(vscode.Uri.joinPath(root, '.agents', 'skills'), 0, budget, out);
  }

  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Builds the system-prompt section listing available skills. */
export function buildSkillsSection(skills: SkillMeta[]): string {
  if (skills.length === 0) {
    return '';
  }
  const lines = ['# Available skills (call use_skill with the exact name to load full instructions before use)'];
  for (const skill of skills) {
    lines.push(`- ${skill.name}: ${truncate(skill.description, 160)}`);
  }
  return lines.join('\n');
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
