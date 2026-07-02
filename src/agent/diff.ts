import type { DiffSummary } from '../types';

const PREVIEW_BUDGET = 12;

/**
 * Produces a compact line-level diff summary by trimming the common prefix and
 * suffix, then treating the remaining middle as removed/added lines. Good enough
 * for display; not a full Myers diff.
 */
export function summarizeDiff(before: string | undefined, after: string): DiffSummary {
  const beforeLines = before === undefined ? [] : before.split('\n');
  const afterLines = after.split('\n');

  let start = 0;
  while (start < beforeLines.length && start < afterLines.length && beforeLines[start] === afterLines[start]) {
    start++;
  }
  let endB = beforeLines.length - 1;
  let endA = afterLines.length - 1;
  while (endB >= start && endA >= start && beforeLines[endB] === afterLines[endA]) {
    endB--;
    endA--;
  }

  const removed = beforeLines.slice(start, endB + 1);
  const added = afterLines.slice(start, endA + 1);

  const preview: string[] = [];
  for (const line of removed) {
    if (preview.length >= PREVIEW_BUDGET) {
      break;
    }
    preview.push(`-${line}`);
  }
  for (const line of added) {
    if (preview.length >= PREVIEW_BUDGET) {
      break;
    }
    preview.push(`+${line}`);
  }

  const totalChanged = removed.length + added.length;
  if (totalChanged > preview.length) {
    preview.push(`~ … ${totalChanged - preview.length} more changed line(s)`);
  }

  return { added: added.length, removed: removed.length, preview };
}
