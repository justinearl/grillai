import { flatten } from '../shared/anchor';
import { expandFile, expandable } from '../shared/expand';
import { WORKTREE, type DiffFile, type DiffLine, type Severity } from '../shared/types';

export const REVIEW_SYSTEM_PROMPT = `You are the code reviewer inside grillai, a local code review tool. You review a whole set of changes, usually written by another AI agent, on behalf of a human who will read your findings next to the diff and pass them on to the agent that does the fixes.

How to review:
- Understand what the change is trying to do, then check that it does it. Read the surrounding code, callers and tests in the repository; do not judge from the diff alone.
- Look for: bugs and wrong logic, unhandled edge cases and error paths, security problems, broken callers or contracts, concurrency and data-loss risks, missing or wrong tests for changed behaviour.
- Look for the typical failures of AI-written code: calls to functions or options that do not exist, stubbed or placeholder implementations presented as done, errors swallowed to make something pass, tests weakened or deleted, unrelated changes, duplicated code where a helper already exists, and comments or docs that no longer match the code.
- Report only findings you have checked and would stand behind. No praise, no style nitpicks a formatter would settle, no speculation you could have verified by reading the code. A short list of real problems beats a long list of maybes. An empty list is a valid result.

How to report:
- Each finding points at the lines it is about: line numbers in the NEW version of the file (side "new"), or in the old version for code that was deleted (side "old"). Point at changed lines where you can, and keep the range tight.
- "file" is the path exactly as given in the list of changed files.
- severity: "high" for bugs, security problems or data loss; "medium" for likely problems and missing handling; "low" for minor improvements.
- title: one line naming the problem. body: Markdown saying what is wrong, why it matters, and what should change. Refer to other code as path:line.
- summary: a few sentences in Markdown on what the change does and your overall verdict.

You are read-only. Do not modify, create or delete files.`;

export const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          start_line: { type: 'integer' },
          end_line: { type: 'integer' },
          side: { type: 'string', enum: ['new', 'old'] },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          title: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['file', 'start_line', 'end_line', 'side', 'severity', 'title', 'body'],
      },
    },
  },
  required: ['summary', 'findings'],
};

export interface Finding {
  file: string;
  startLine: number;
  endLine: number;
  side: 'new' | 'old';
  severity: Severity;
  title: string;
  body: string;
}

/** Validate what the model returned; drops anything malformed. */
export function parseReview(output: unknown): { summary: string; findings: Finding[] } {
  const o = (output ?? {}) as Record<string, unknown>;
  const findings: Finding[] = [];
  for (const raw of Array.isArray(o.findings) ? o.findings : []) {
    const f = (raw ?? {}) as Record<string, unknown>;
    const start = Number(f.start_line);
    const end = Number(f.end_line);
    if (typeof f.file !== 'string' || !Number.isFinite(start) || typeof f.body !== 'string') continue;
    findings.push({
      file: f.file,
      startLine: Math.min(start, Number.isFinite(end) ? end : start),
      endLine: Math.max(start, Number.isFinite(end) ? end : start),
      side: f.side === 'old' ? 'old' : 'new',
      severity: f.severity === 'high' || f.severity === 'low' ? f.severity : 'medium',
      title: typeof f.title === 'string' ? f.title.trim() : '',
      body: f.body.trim(),
    });
  }
  return { summary: typeof o.summary === 'string' ? o.summary.trim() : '', findings };
}

const SIGN = { insert: '+', delete: '-', context: ' ' } as const;
const MAX_DIFF_CHARS = 200_000;
const MAX_RANGE = 200;

function diffText(file: DiffFile): string {
  const out: string[] = [];
  for (const h of file.hunks) {
    out.push(h.header);
    for (const l of h.lines) {
      out.push(`${String(l.oldNo ?? '').padStart(5)} ${String(l.newNo ?? '').padStart(5)} ${SIGN[l.type]}${l.content}`);
    }
  }
  return out.join('\n');
}

export function reviewPrompt(ctx: { base: string; target: string; mergeBase: string; files: DiffFile[] }): string {
  const worktree = ctx.target === WORKTREE;
  const out: string[] = [
    worktree
      ? `Review the current state of the working tree (uncommitted and untracked files included) against the branch \`${ctx.base}\`. The files on disk are the version under review.`
      : `Review the branch \`${ctx.target}\` against \`${ctx.base}\`. The files on disk may be a different branch: read the reviewed version of a file with \`git show ${ctx.target}:<path>\`.`,
    `The same diff from git: \`git diff ${ctx.mergeBase}${worktree ? '' : ' ' + ctx.target}\`${worktree ? ' (untracked files are not in that output; they are listed below as added)' : ''}.`,
    '',
    `Changed files (${ctx.files.length}):`,
    ...ctx.files.map(
      (f) => `- ${f.path} (${f.status}${f.oldPath ? ` from ${f.oldPath}` : ''}${f.binary ? ', binary' : ''}, +${f.added} -${f.deleted})`,
    ),
    '',
    'The diff follows. Columns are old line number, new line number, then the diff line.',
  ];
  let used = 0;
  const skipped: string[] = [];
  for (const f of ctx.files) {
    if (f.binary) continue;
    const text = f.tooBig ? '' : diffText(f);
    if (!text || used + text.length > MAX_DIFF_CHARS) {
      if (text || f.tooBig) skipped.push(f.path);
      continue;
    }
    used += text.length;
    out.push('', `### ${f.path}`, '```', text, '```');
  }
  if (skipped.length > 0) {
    out.push('', 'These files are part of the review but too large to include here. Read their changes yourself with git or the Read tool:', ...skipped.map((p) => `- ${p}`));
  }
  return out.join('\n');
}

export function findFile(files: DiffFile[], name: string, repo: string): DiffFile | null {
  const clean = name.replace(/^\.\//, '').replace(/^[ab]\//, '');
  const rel = name.startsWith(repo + '/') ? name.slice(repo.length + 1) : null;
  return (
    files.find((f) => f.path === name) ??
    files.find((f) => f.path === clean || f.path === rel) ??
    files.find((f) => f.oldPath === name || f.oldPath === clean) ??
    null
  );
}

/**
 * The diff lines a finding points at, to anchor its thread. Lines outside the
 * diff's hunks are taken from the file content (`content`, the new version).
 * Null when the lines cannot be found.
 */
export function placeFinding(file: DiffFile, content: string[] | null, finding: Finding): DiffLine[] | null {
  const from = Math.max(1, finding.startLine);
  const to = Math.min(finding.endLine, from + MAX_RANGE - 1);
  const old = finding.side === 'old' || file.status === 'deleted';
  let flat = flatten(file);
  if (!old && content && expandable(file)) {
    const wanted = new Set<number>();
    for (let n = from; n <= to; n++) wanted.add(n);
    flat = flatten(expandFile(file, content, wanted));
  }
  const hit = (l: DiffLine) => {
    const no = old ? (l.type === 'insert' ? null : l.oldNo) : l.type === 'delete' ? null : l.newNo;
    return no != null && no >= from && no <= to;
  };
  const first = flat.findIndex(hit);
  if (first < 0) return null;
  let last = first;
  for (let i = first; i < flat.length; i++) if (hit(flat[i])) last = i;
  return flat.slice(first, last + 1);
}

/** True when every line from..to of the new file is already visible in the diff. */
export function inDiff(file: DiffFile, finding: Finding): boolean {
  if (finding.side === 'old' || file.status === 'deleted') return true;
  const have = new Set(flatten(file).map((l) => (l.type === 'delete' ? null : l.newNo)));
  for (let n = finding.startLine; n <= finding.endLine; n++) if (!have.has(n)) return false;
  return true;
}
