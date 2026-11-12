import type { DiffFile, DiffHunk, DiffLine, Gap } from './types';

/** Lines revealed per click on an "expand" arrow. */
export const EXPAND_STEP = 20;

/** Only files with a new side and visible hunks have hidden lines to reveal. */
export function expandable(file: DiffFile): boolean {
  return (file.status === 'modified' || file.status === 'renamed') && !file.binary && !file.tooBig && file.hunks.length > 0;
}

interface Bounds {
  oldStart: number;
  newStart: number;
  /** First line number after the hunk, on each side. */
  oldNext: number;
  newNext: number;
}

/** Line ranges of a hunk, read from its "@@ -a,b +c,d @@" header. */
export function hunkBounds(header: string): Bounds | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
  if (!m) return null;
  const oldCount = m[2] === undefined ? 1 : Number(m[2]);
  const newCount = m[4] === undefined ? 1 : Number(m[4]);
  // With a count of 0, git names the line *before* the change.
  const oldStart = oldCount === 0 ? Number(m[1]) + 1 : Number(m[1]);
  const newStart = newCount === 0 ? Number(m[3]) + 1 : Number(m[3]);
  return { oldStart, newStart, oldNext: oldStart + oldCount, newNext: newStart + newCount };
}

/**
 * The file's diff with hidden unchanged lines filled in.
 * `content` is the new version of the file, one entry per line (null when not
 * loaded yet); `revealed` holds the new-side line numbers the reader expanded.
 * Each returned hunk says which lines are still hidden above it (`gapBefore`),
 * and `tailGap` covers the end of the file.
 */
export function expandFile(file: DiffFile, content: string[] | null, revealed: ReadonlySet<number>): DiffFile {
  if (!expandable(file)) return file;
  const bounds = file.hunks.map((h) => hunkBounds(h.header));
  if (bounds.some((b) => !b)) return file;

  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let pendingGap: Gap | null = null;

  const show = (lines: DiffLine[], header: string) => {
    if (lines.length === 0) return;
    if (current && !pendingGap) {
      current.lines.push(...lines);
      // revealed lines that lead into a hunk take that hunk's header
      if (!current.header) current.header = header;
    } else {
      current = { header, lines: [...lines], gapBefore: pendingGap };
      hunks.push(current);
      pendingGap = null;
    }
  };
  const hide = (from: number, to: number | null) => {
    if (to != null && from > to) return;
    pendingGap = pendingGap ? { from: pendingGap.from, to } : { from, to };
  };
  /** Walk the unchanged lines from..to; oldNo = newNo + delta. */
  const gap = (from: number, to: number, delta: number) => {
    let n = from;
    while (n <= to) {
      const isRevealed = content != null && revealed.has(n);
      let end = n;
      while (end + 1 <= to && (content != null && revealed.has(end + 1)) === isRevealed) end++;
      if (isRevealed) {
        const lines: DiffLine[] = [];
        for (let k = n; k <= end; k++) lines.push({ type: 'context', content: content![k - 1] ?? '', oldNo: k + delta, newNo: k });
        show(lines, '');
      } else {
        hide(n, end);
      }
      n = end + 1;
    }
  };

  let newCursor = 1;
  file.hunks.forEach((hunk, i) => {
    const b = bounds[i]!;
    gap(newCursor, b.newStart - 1, b.oldStart - b.newStart);
    show(hunk.lines, hunk.header);
    newCursor = b.newNext;
  });

  const last = bounds[bounds.length - 1]!;
  let tailGap: Gap | null = null;
  if (content == null) {
    // git shows 3 lines of context; fewer after the last change means the file ends there.
    const lines = file.hunks[file.hunks.length - 1].lines;
    let trailing = 0;
    while (trailing < lines.length && lines[lines.length - 1 - trailing].type === 'context') trailing++;
    if (trailing >= 3) tailGap = { from: newCursor, to: null };
  } else {
    gap(newCursor, content.length, last.oldNext - last.newNext);
    tailGap = pendingGap;
  }
  return { ...file, hunks, tailGap };
}

/**
 * Where a thread's unchanged lines are in the new file, so they can be
 * revealed again after a reload. Tries the recorded line numbers first, then
 * the nearest shift at which every line matches. Null when they are gone.
 */
export function findContextLines(content: string[], lines: DiffLine[]): number[] | null {
  const ctx = lines.filter((l) => l.type === 'context' && l.newNo != null);
  if (ctx.length === 0) return null;
  const fits = (d: number) => ctx.every((l) => content[l.newNo! + d - 1] === l.content);
  for (let step = 0; step <= content.length; step++) {
    for (const d of step === 0 ? [0] : [step, -step]) {
      if (fits(d)) return ctx.map((l) => l.newNo! + d);
    }
  }
  return null;
}
