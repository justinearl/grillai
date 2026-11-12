import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'diff2html';
import { WORKTREE, type DiffFile, type DiffHunk, type DiffLine, type RepoInfo } from '../shared/types';

const MAX_FILE_LINES = 20000;
const MAX_UNTRACKED_FILES = 300;
const MAX_UNTRACKED_BYTES = 1024 * 1024;
const MAX_CONTENT_BYTES = 5 * 1024 * 1024;

export class GitError extends Error {}

function git(repo: string, args: string[], okCodes: number[] = [0]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=false', ...args],
      {
        cwd: repo,
        maxBuffer: 512 * 1024 * 1024,
        env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' },
      },
      (err, stdout, stderr) => {
        const code = err ? ((err as { code?: unknown }).code ?? -1) : 0;
        if (err && !(typeof code === 'number' && okCodes.includes(code))) {
          reject(new GitError(String(stderr).trim() || err.message));
        } else {
          resolve(String(stdout));
        }
      },
    );
  });
}

export async function resolveRepo(dir: string): Promise<string> {
  try {
    return (await git(dir, ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    throw new GitError(`${dir} is not inside a git repository`);
  }
}

export async function repoInfo(repo: string): Promise<RepoInfo> {
  const refs = (await git(repo, ['for-each-ref', '--sort=-committerdate', '--format=%(refname)', 'refs/heads', 'refs/remotes']))
    .split('\n')
    .filter(Boolean);
  const branches: string[] = [];
  for (const ref of refs) {
    if (ref.startsWith('refs/heads/')) branches.push(ref.slice('refs/heads/'.length));
    else if (ref.startsWith('refs/remotes/') && !ref.endsWith('/HEAD')) branches.push(ref.slice('refs/remotes/'.length));
  }
  let currentBranch: string | null = null;
  try {
    currentBranch = (await git(repo, ['symbolic-ref', '--short', '-q', 'HEAD'])).trim() || null;
  } catch {
    currentBranch = null; // detached HEAD
  }
  const defaultBase =
    ['main', 'master', 'develop', 'origin/main', 'origin/master'].find((b) => branches.includes(b)) ??
    currentBranch ??
    branches[0] ??
    null;
  return { path: repo, name: path.basename(repo), currentBranch, branches, defaultBase };
}

async function commitOf(repo: string, ref: string): Promise<string> {
  if (!ref || ref.startsWith('-')) throw new GitError(`Invalid ref: ${ref}`);
  try {
    return (await git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim();
  } catch {
    throw new GitError(`Unknown branch or commit: ${ref}`);
  }
}

const DIFF_ARGS = ['diff', '--no-color', '--no-ext-diff', '-M', '--src-prefix=a/', '--dst-prefix=b/'];

async function untrackedDiff(repo: string): Promise<{ raw: string; skipped: DiffFile[] }> {
  const files = (await git(repo, ['ls-files', '--others', '--exclude-standard', '-z']))
    .split('\0')
    .filter(Boolean)
    .slice(0, MAX_UNTRACKED_FILES);
  let raw = '';
  const skipped: DiffFile[] = [];
  for (const file of files) {
    const info = await stat(path.join(repo, file)).catch(() => null);
    if (!info || !info.isFile()) continue;
    if (info.size > MAX_UNTRACKED_BYTES) {
      skipped.push({
        path: file, oldPath: null, status: 'added', binary: false, tooBig: true,
        added: 0, deleted: 0, hash: `size:${info.size}:${info.mtimeMs}`, hunks: [],
      });
      continue;
    }
    raw += await git(repo, [...DIFF_ARGS, '--no-index', '--', '/dev/null', file], [0, 1]);
  }
  return { raw, skipped };
}

export function parseDiff(raw: string): DiffFile[] {
  return parse(raw).map((f): DiffFile => {
    const status = f.isNew ? 'added' : f.isDeleted ? 'deleted' : f.isRename ? 'renamed' : 'modified';
    // git ends names that contain spaces with a tab in the ---/+++ lines
    const clean = (name: string) => name.replace(/\t$/, '');
    const filePath = clean(status === 'deleted' ? f.oldName : f.newName);
    let hunks: DiffHunk[] = f.blocks.map((b) => ({
      header: b.header,
      lines: b.lines
        .filter((l) => !l.content.startsWith('\\'))
        .map((l): DiffLine => ({
          type: l.type as DiffLine['type'],
          content: l.content.slice(1).replace(/\r$/, ''),
          oldNo: l.oldNumber ?? null,
          newNo: l.newNumber ?? null,
        })),
    }));
    const hash = createHash('sha1').update(JSON.stringify([f.oldName, f.newName, hunks])).digest('hex');
    const tooBig = hunks.reduce((n, h) => n + h.lines.length, 0) > MAX_FILE_LINES;
    if (tooBig) hunks = [];
    return {
      path: filePath,
      oldPath: status === 'renamed' ? clean(f.oldName) : null,
      status,
      binary: !!f.isBinary,
      tooBig,
      added: f.addedLines,
      deleted: f.deletedLines,
      hash,
      hunks,
    };
  });
}

/** The reviewed (new) version of a file, one entry per line. `file` must come from the review's diff. */
export async function fileLines(repo: string, target: string, file: string): Promise<string[]> {
  let text: string;
  if (target === WORKTREE) {
    const full = path.resolve(repo, file);
    if (!full.startsWith(repo + path.sep)) throw new GitError('Path is outside the repository');
    const info = await stat(full).catch(() => null);
    if (!info || !info.isFile()) throw new GitError(`${file} does not exist in the working tree`);
    if (info.size > MAX_CONTENT_BYTES) throw new GitError(`${file} is too large to expand`);
    text = await readFile(full, 'utf8');
  } else {
    await commitOf(repo, target);
    text = await git(repo, ['show', `${target}:${file}`]);
    if (text.length > MAX_CONTENT_BYTES) throw new GitError(`${file} is too large to expand`);
  }
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * The diff GitLab would show for a merge request: changes on `target` since it
 * diverged from `base`. With target = WORKTREE, the current files on disk
 * (staged, unstaged and untracked) stand in for the target branch.
 */
export async function getDiff(repo: string, base: string, target: string): Promise<{ mergeBase: string; files: DiffFile[] }> {
  const baseCommit = await commitOf(repo, base);
  const targetCommit = await commitOf(repo, target === WORKTREE ? 'HEAD' : target);
  let mergeBase = baseCommit;
  try {
    mergeBase = (await git(repo, ['merge-base', baseCommit, targetCommit])).trim() || baseCommit;
  } catch {
    // unrelated histories: compare directly against base
  }
  let files: DiffFile[];
  if (target === WORKTREE) {
    const tracked = await git(repo, [...DIFF_ARGS, mergeBase]);
    const untracked = await untrackedDiff(repo);
    files = [...parseDiff(tracked + untracked.raw), ...untracked.skipped];
  } else {
    files = parseDiff(await git(repo, [...DIFF_ARGS, mergeBase, targetCommit]));
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { mergeBase, files };
}
