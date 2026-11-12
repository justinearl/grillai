import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDiff, repoInfo, resolveRepo } from '../server/git';
import { fullPrompt } from '../server/prompt';
import { WORKTREE } from '../shared/types';

let repo: string;
const sh = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: repo });
const write = (file: string, content: string) => writeFileSync(path.join(repo, file), content);

beforeAll(() => {
  repo = mkdtempSync(path.join(os.tmpdir(), 'grillai-test-'));
  sh('init', '-q', '-b', 'main');
  write('a.txt', 'one\ntwo\nthree\n');
  write('gone.txt', 'bye\n');
  sh('add', '-A');
  sh('commit', '-qm', 'init');
  sh('checkout', '-qb', 'feature');
  write('a.txt', 'one\nTWO\nthree\n');
  sh('rm', '-q', 'gone.txt');
  sh('commit', '-qam', 'change');
  // main moves on: must not show up in the review of feature
  sh('checkout', '-q', 'main');
  write('main-only.txt', 'x\n');
  sh('add', '-A');
  sh('commit', '-qm', 'main moves');
  sh('checkout', '-q', 'feature');
  // uncommitted work
  write('a.txt', 'one\nTWO\nthree\nfour\n');
  write('new file.txt', 'hello\nworld');
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe('git', () => {
  it('describes the repo', async () => {
    expect(await resolveRepo(repo)).toBe(await resolveRepo(path.join(repo)));
    const info = await repoInfo(repo);
    expect(info.currentBranch).toBe('feature');
    expect(info.branches.sort()).toEqual(['feature', 'main']);
    expect(info.defaultBase).toBe('main');
  });

  it('diffs branch against branch from the merge base', async () => {
    const { files } = await getDiff(repo, 'main', 'feature');
    expect(files.map((f) => [f.path, f.status])).toEqual([['a.txt', 'modified'], ['gone.txt', 'deleted']]);
    const a = files[0];
    expect(a.added).toBe(1);
    expect(a.deleted).toBe(1);
    expect(a.hunks[0].lines).toEqual([
      { type: 'context', content: 'one', oldNo: 1, newNo: 1 },
      { type: 'delete', content: 'two', oldNo: 2, newNo: null },
      { type: 'insert', content: 'TWO', oldNo: null, newNo: 2 },
      { type: 'context', content: 'three', oldNo: 3, newNo: 3 },
    ]);
  });

  it('includes uncommitted and untracked files for the working tree', async () => {
    const { files } = await getDiff(repo, 'main', WORKTREE);
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ['a.txt', 'modified'], ['gone.txt', 'deleted'], ['new file.txt', 'added'],
    ]);
    expect(files[0].added).toBe(2);
    expect(files[2].hunks[0].lines.map((l) => l.content)).toEqual(['hello', 'world']);
  });

  it('changes a file hash only when its diff changes', async () => {
    const before = (await getDiff(repo, 'main', WORKTREE)).files;
    write('new file.txt', 'hello\nworld\nagain\n');
    const after = (await getDiff(repo, 'main', WORKTREE)).files;
    expect(after[0].hash).toBe(before[0].hash);
    expect(after[2].hash).not.toBe(before[2].hash);
  });

  it('rejects unknown and option-like refs', async () => {
    await expect(getDiff(repo, 'nope', WORKTREE)).rejects.toThrow(/Unknown branch/);
    await expect(getDiff(repo, '--output=/tmp/x', WORKTREE)).rejects.toThrow(/Invalid ref/);
  });
});

describe('fullPrompt', () => {
  it('carries the selection, the file diff and earlier discussion', async () => {
    const { files, mergeBase } = await getDiff(repo, 'main', WORKTREE);
    const lines = files[0].hunks[0].lines.slice(1, 3);
    const msg = (id: number, role: 'user' | 'agent', body: string) => ({ id, role, body, error: false, createdAt: '' });
    const text = fullPrompt({
      base: 'main', target: WORKTREE, mergeBase, file: 'a.txt', lines, fileDiff: files[0],
      messages: [msg(1, 'user', 'Why caps?'), msg(2, 'agent', 'Style.'), msg(3, 'user', 'Which style guide?')],
    });
    expect(text).toContain(`git diff ${mergeBase}`);
    expect(text).toContain('`a.txt`, lines 2 (old)-2');
    expect(text).toContain('+TWO');
    expect(text).toContain('You: Style.');
    expect(text.trim().endsWith('Which style guide?')).toBe(true);
  });
});
