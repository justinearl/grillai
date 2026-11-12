import { describe, expect, it } from 'vitest';
import { locate, rangeLabel, snippet } from '../shared/anchor';
import { buildSummary } from '../shared/summary';
import { WORKTREE, type DiffLine, type Thread } from '../shared/types';

const ctx = (content: string, n: number): DiffLine => ({ type: 'context', content, oldNo: n, newNo: n });
const ins = (content: string, n: number): DiffLine => ({ type: 'insert', content, oldNo: null, newNo: n });
const del = (content: string, n: number): DiffLine => ({ type: 'delete', content, oldNo: n, newNo: null });

describe('locate', () => {
  const flat = [ctx('a', 1), del('b', 2), ins('B', 2), ins('c', 3), ctx('d', 3), ins('c', 5)];

  it('finds lines at their original position', () => {
    expect(locate(flat, [ins('B', 2), ins('c', 3)])).toEqual({ start: 2, end: 3 });
  });

  it('follows lines whose numbers shifted', () => {
    expect(locate(flat, [ins('B', 40), ins('c', 41)])).toEqual({ start: 2, end: 3 });
  });

  it('picks the occurrence closest to the original line number', () => {
    expect(locate(flat, [ins('c', 5)])).toEqual({ start: 5, end: 5 });
    expect(locate(flat, [ins('c', 3)])).toEqual({ start: 3, end: 3 });
  });

  it('reports stale when the content is gone or changed type', () => {
    expect(locate(flat, [ins('zzz', 2)])).toBeNull();
    expect(locate(flat, [ctx('B', 2)])).toBeNull();
    expect(locate(flat, [])).toBeNull();
    expect(locate([], [ins('B', 2)])).toBeNull();
  });
});

describe('labels', () => {
  it('describes ranges', () => {
    expect(rangeLabel([ins('x', 7)])).toBe('line 7');
    expect(rangeLabel([del('x', 7)])).toBe('line 7 (old)');
    expect(rangeLabel([del('x', 7), ins('y', 7), ins('z', 8)])).toBe('lines 7 (old)-8');
    expect(snippet([del('x', 7), ins('y', 7), ctx('z', 8)])).toBe('-x\n+y\n z');
  });
});

describe('buildSummary', () => {
  const thread = (id: number, resolved: boolean): Thread => ({
    id, reviewId: 1, origin: 'user', severity: null, file: `src/f${id}.ts`, lines: [ins('const x = 1;', 4)], resolved, running: false,
    createdAt: '', messages: [
      { id: 1, role: 'user', body: 'Why a constant?', error: false, createdAt: '' },
      { id: 2, role: 'agent', body: 'It is never reassigned.', error: false, createdAt: '' },
      { id: 3, role: 'agent', body: 'boom', error: true, createdAt: '' },
    ],
  });

  it('lists only unresolved threads with file, lines, code and discussion', () => {
    const text = buildSummary(
      [{ thread: thread(1, false), stale: true }, { thread: thread(2, true), stale: false }],
      { base: 'main', target: WORKTREE, includeAgent: true },
    );
    expect(text).toContain('working tree compared to main');
    expect(text).toContain('## 1. src/f1.ts (line 4)');
    expect(text).toContain('+const x = 1;');
    expect(text).toContain('**Reviewer:** Why a constant?');
    expect(text).toContain('**Assistant:** It is never reassigned.');
    expect(text).toContain('has changed since');
    expect(text).not.toContain('f2.ts');
    expect(text).not.toContain('boom');
  });

  it('can leave out agent answers and handles an empty review', () => {
    const text = buildSummary([{ thread: thread(1, false), stale: false }], { base: 'main', target: 'feat', includeAgent: false });
    expect(text).not.toContain('Assistant');
    expect(buildSummary([], { base: 'main', target: 'feat', includeAgent: true })).toContain('No unresolved threads');
  });

  it('always keeps the finding of an AI review thread and names its severity', () => {
    const ai: Thread = {
      ...thread(3, false), origin: 'ai', severity: 'high',
      messages: [
        { id: 1, role: 'agent', body: '**Off by one**\n\nLoop skips the last item.', error: false, createdAt: '' },
        { id: 2, role: 'user', body: 'Agreed, fix it.', error: false, createdAt: '' },
        { id: 3, role: 'agent', body: 'Extra detail.', error: false, createdAt: '' },
      ],
    };
    const text = buildSummary([{ thread: ai, stale: false }], { base: 'main', target: 'feat', includeAgent: false });
    expect(text).toContain('(line 4, high severity)');
    expect(text).toContain('Loop skips the last item.');
    expect(text).toContain('Agreed, fix it.');
    expect(text).not.toContain('Extra detail.');
  });
});
