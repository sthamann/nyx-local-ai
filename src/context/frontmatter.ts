export interface Frontmatter {
  data: Record<string, string | boolean | string[]>;
  body: string;
}

/** Minimal YAML-frontmatter parser for `.mdc` / `SKILL.md` files. */
export function parseFrontmatter(text: string): Frontmatter {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { data: {}, body: text.trim() };
  }
  const data: Record<string, string | boolean | string[]> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) {
      continue;
    }
    const key = line.slice(0, idx).trim();
    const raw = line.slice(idx + 1).trim();
    if (!key) {
      continue;
    }
    if (raw === 'true' || raw === 'false') {
      data[key] = raw === 'true';
    } else if (raw.startsWith('[') && raw.endsWith(']')) {
      data[key] = raw
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    } else {
      data[key] = raw.replace(/^["']|["']$/g, '');
    }
  }
  return { data, body: match[2].trim() };
}
