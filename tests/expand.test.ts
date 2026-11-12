import { describe, expect, it } from 'vitest';
import { flatten } from '../shared/anchor';
import { expandFile, findContextLines, hunkBounds } from '../shared/expand';
import type { DiffFile, DiffLine } from '../shared/types';
import { parseDiff } from '../server/git';

// old file: l1..l30; new file: l5 changed, a line added after l20
const oldLines = Array.from({ length: 30 }, (_, i) => `l${i + 1}`);
const content = [...oldLines];
content[4] = 'L5';
content.splice(20, 0, 'added');

const raw = `diff --git a/f.txt b/f.txt
index 111..222 100644
--- a/f.txt
+++ b/f.txt
@@ -2,7 +2,7 @@ l1
 l2
 l3
 l4
-l5
+L5
 l6
 l7
 l8
@@ -18,6 +18,7 @@ l17
 l18
 l19
 l20
+added
 l21
 l22
 l23
`;
const file: DiffFile = parseDiff(raw)[0];
const none = new Set<number>();

describe('hunkBounds', () => {
  it('reads ranges, including zero counts and omitted counts', () => {
    expect(hunkBounds('@@ -2,7 +2,7 @@ x')).toEqual({ oldStart: 2, newStart: 2, oldNext: 9, newNext: 9 });
    expect(hunkBounds('@@ -5,0 +6,2 @@')).toEqual({ oldStart: 6, newStart: 6, oldNext: 6, newNext: 8 });
    expect(hunkBounds('@@ -3 +3 @@')).toEqual({ oldStart: 3, newStart: 3, oldNext: 4, newNext: 4 });
    expect(hunkBounds('nope')).toBeNull();
  });
});

describe('expandFile', () => {
  it('marks the gaps before content is loaded', () => {
    const view = expandFile(file, null, none);
    expect(view.hunks.map((h) => h.gapBefore)).toEqual([{ from: 1, to: 1 }, { from: 9, to: 17 }]);
    expect(view.tailGap).toEqual({ from: 25, to: null });
    expect(flatten(view)).toEqual(flatten(file));
  });

  it('knows the real tail once content is loaded', () => {
    expect(expandFile(file, content, none).tailGap).toEqual({ from: 25, to: 31 });
  });

  it('merges revealed lines into the neighbouring hunks with correct numbers', () => {
    const view = expandFile(file, content, new Set([1, 9, 10, 16, 17, 25]));
    expect(view.hunks.length).toBe(2);
    expect(view.hunks[0].gapBefore).toBeNull();
    expect(view.hunks[0].lines[0]).toEqual({ type: 'context', content: 'l1', oldNo: 1, newNo: 1 });
    expect(view.hunks[0].lines.slice(-2).map((l) => l.content)).toEqual(['l9', 'l10']);
    expect(view.hunks[1].gapBefore).toEqual({ from: 11, to: 15 });
    expect(view.hunks[1].lines.slice(0, 2)).toEqual([
      { type: 'context', content: 'l16', oldNo: 16, newNo: 16 },
      { type: 'context', content: 'l17', oldNo: 17, newNo: 17 },
    ]);
    // after the added line, old numbers trail new numbers by one
    expect(view.hunks[1].lines.at(-1)).toEqual({ type: 'context', content: 'l24', oldNo: 24, newNo: 25 });
    expect(view.tailGap).toEqual({ from: 26, to: 31 });
  });

  it('joins everything into one hunk when a whole gap is revealed, and can show an island', () => {
    const all = new Set(Array.from({ length: 31 }, (_, i) => i + 1));
    const full = expandFile(file, content, all);
    expect(full.hunks.length).toBe(1);
    expect(full.tailGap).toBeNull();
    expect(flatten(full).filter((l) => l.type !== 'delete').map((l) => l.content)).toEqual(content);

    const island = expandFile(file, content, new Set([12, 13]));
    expect(island.hunks.map((h) => h.gapBefore)).toEqual([{ from: 1, to: 1 }, { from: 9, to: 11 }, { from: 14, to: 17 }]);
    expect(island.hunks[1].lines.map((l) => l.content)).toEqual(['l12', 'l13']);
    expect(island.hunks.map((h) => h.header.slice(0, 9))).toEqual(['@@ -2,7 +', '', '@@ -18,6 ']);
    expect(expandFile(file, content, new Set([16, 17])).hunks[1].header).toContain('@@ -18,6');
  });

  it('shows no tail when the diff already reaches the end of the file', () => {
    const short = parseDiff(`diff --git a/s.txt b/s.txt
--- a/s.txt
+++ b/s.txt
@@ -1,3 +1,3 @@
 a
-b
+B
 c
`)[0];
    const view = expandFile(short, null, none);
    expect(view.tailGap).toBeNull();
    expect(view.hunks[0].gapBefore).toBeNull();
  });

  it('leaves added and deleted files alone', () => {
    const added = { ...file, status: 'added' as const };
    expect(expandFile(added, content, new Set([1]))).toBe(added);
  });
});

describe('findContextLines', () => {
  const line = (c: string, n: number): DiffLine => ({ type: 'context', content: c, oldNo: n, newNo: n });
  it('finds lines at their numbers, after a shift, or not at all', () => {
    expect(findContextLines(content, [line('l12', 12), line('l13', 13)])).toEqual([12, 13]);
    expect(findContextLines(content, [line('l12', 15), line('l13', 16)])).toEqual([12, 13]);
    expect(findContextLines(content, [line('gone', 12)])).toBeNull();
    expect(findContextLines(content, [{ type: 'insert', content: 'added', oldNo: null, newNo: 21 }])).toBeNull();
  });
});
