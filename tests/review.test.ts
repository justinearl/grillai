import { describe, expect, it } from 'vitest';
import { parseDiff } from '../server/git';
import { findFile, inDiff, parseReview, placeFinding, reviewPrompt, type Finding } from '../server/review';

const file = parseDiff(`diff --git a/src/f.txt b/src/f.txt
--- a/src/f.txt
+++ b/src/f.txt
@@ -4,7 +4,7 @@
 l4
 l5
 l6
-l7
+L7
 l8
 l9
 l10
`)[0];
const content = Array.from({ length: 20 }, (_, i) => (i === 6 ? 'L7' : `l${i + 1}`));
const finding = (startLine: number, endLine: number, side: 'new' | 'old' = 'new'): Finding => ({
  file: 'src/f.txt', startLine, endLine, side, severity: 'high', title: 't', body: 'b',
});

describe('parseReview', () => {
  it('keeps valid findings, normalises the rest', () => {
    const { summary, findings } = parseReview({
      summary: ' ok ',
      findings: [
        { file: 'a', start_line: 9, end_line: 3, side: 'old', severity: 'high', title: 'T', body: 'B' },
        { file: 'a', start_line: 2, body: 'B', severity: 'weird' },
        { file: 1, start_line: 2, body: 'B' },
        { file: 'a', body: 'no line' },
      ],
    });
    expect(summary).toBe('ok');
    expect(findings.map((f) => [f.startLine, f.endLine, f.side, f.severity])).toEqual([
      [3, 9, 'old', 'high'], [2, 2, 'new', 'medium'],
    ]);
    expect(parseReview(null)).toEqual({ summary: '', findings: [] });
  });
});

describe('placeFinding', () => {
  it('anchors on lines of the diff', () => {
    expect(placeFinding(file, null, finding(7, 8))!.map((l) => l.content)).toEqual(['L7', 'l8']);
    expect(placeFinding(file, null, finding(7, 7, 'old'))).toEqual([{ type: 'delete', content: 'l7', oldNo: 7, newNo: null }]);
    expect(inDiff(file, finding(7, 8))).toBe(true);
  });

  it('reaches lines outside the hunks through the file content', () => {
    expect(inDiff(file, finding(15, 16))).toBe(false);
    expect(placeFinding(file, null, finding(15, 16))).toBeNull();
    expect(placeFinding(file, content, finding(15, 16))).toEqual([
      { type: 'context', content: 'l15', oldNo: 15, newNo: 15 },
      { type: 'context', content: 'l16', oldNo: 16, newNo: 16 },
    ]);
    // a range that starts in the diff and runs past it
    expect(placeFinding(file, content, finding(9, 12))!.map((l) => l.newNo)).toEqual([9, 10, 11, 12]);
    expect(placeFinding(file, content, finding(90, 95))).toBeNull();
  });
});

describe('findFile and reviewPrompt', () => {
  it('matches paths the model may decorate', () => {
    expect(findFile([file], './src/f.txt', '/repo')).toBe(file);
    expect(findFile([file], 'b/src/f.txt', '/repo')).toBe(file);
    expect(findFile([file], '/repo/src/f.txt', '/repo')).toBe(file);
    expect(findFile([file], 'other.txt', '/repo')).toBeNull();
  });

  it('lists the files and carries the numbered diff', () => {
    const text = reviewPrompt({ base: 'main', target: 'feat', mergeBase: 'abc123', files: [file] });
    expect(text).toContain('git diff abc123 feat');
    expect(text).toContain('- src/f.txt (modified, +1 -1)');
    expect(text).toMatch(/\s+7 \+L7/);
    expect(text).toContain('git show feat:<path>');
  });
});
