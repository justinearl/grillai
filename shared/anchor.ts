import type { DiffFile, DiffLine } from './types';

/** All lines of a file's diff in display order; a thread is anchored to a range of these. */
export function flatten(file: DiffFile): DiffLine[] {
  return file.hunks.flatMap((h) => h.lines);
}

const lineNo = (l: DiffLine) => l.newNo ?? l.oldNo ?? 0;

/**
 * Find where a thread's lines sit in the current diff of its file.
 * Lines match on type and content, so a thread follows its code when line
 * numbers shift. Returns null when the content is gone: the thread is stale.
 */
export function locate(flat: DiffLine[], lines: DiffLine[]): { start: number; end: number } | null {
  const n = lines.length;
  if (n === 0) return null;
  let best = -1;
  let bestDistance = Infinity;
  for (let i = 0; i + n <= flat.length; i++) {
    let match = true;
    for (let k = 0; k < n; k++) {
      if (flat[i + k].type !== lines[k].type || flat[i + k].content !== lines[k].content) {
        match = false;
        break;
      }
    }
    if (!match) continue;
    const distance =
      Math.abs(lineNo(flat[i]) - lineNo(lines[0])) + (flat[i].newNo === lines[0].newNo ? 0 : 0.5);
    if (distance < bestDistance) {
      best = i;
      bestDistance = distance;
    }
  }
  return best < 0 ? null : { start: best, end: best + n - 1 };
}

const label = (l: DiffLine) => (l.newNo != null ? `${l.newNo}` : `${l.oldNo} (old)`);

/** "line 12", "lines 12-18", "line 7 (old)" */
export function rangeLabel(lines: DiffLine[]): string {
  if (lines.length === 0) return '';
  const first = lines[0];
  const last = lines[lines.length - 1];
  if (lines.length === 1) return `line ${label(first)}`;
  return `lines ${label(first)}-${label(last)}`;
}

const SIGN = { insert: '+', delete: '-', context: ' ' } as const;

/** The lines as a unified-diff snippet. */
export function snippet(lines: DiffLine[]): string {
  return lines.map((l) => `${SIGN[l.type]}${l.content}`).join('\n');
}
