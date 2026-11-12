import { rangeLabel } from '../shared/anchor';
import { WORKTREE, type DiffFile, type DiffLine, type Message } from '../shared/types';

export const SYSTEM_PROMPT = `You are answering questions inside grillai, a local code review tool. The reviewer is reading a diff, usually of changes another AI agent made, and has selected some lines to ask you about.

- Answer the question about the selected lines. Lead with the answer, then the reasoning that supports it.
- Investigate before answering: read the surrounding code, callers and tests in the repository rather than guessing from the snippet.
- If the change is wrong, risky or incomplete, say so plainly and say what should change. The reviewer will pass your findings on to the agent that does the fixes.
- You are read-only. Do not modify, create or delete files, and do not offer to.
- Reply in Markdown. Refer to code as path:line. Keep it as short as the question allows.`;

const SIGN = { insert: '+', delete: '-', context: ' ' } as const;
const MAX_DIFF_LINES = 400;

function numbered(lines: DiffLine[]): string {
  return lines
    .map((l) => `${String(l.oldNo ?? '').padStart(5)} ${String(l.newNo ?? '').padStart(5)} ${SIGN[l.type]}${l.content}`)
    .join('\n');
}

function fileDiffText(file: DiffFile): string {
  const out: string[] = [];
  for (const h of file.hunks) {
    out.push(h.header);
    out.push(numbered(h.lines));
  }
  const lines = out.join('\n').split('\n');
  if (lines.length <= MAX_DIFF_LINES) return lines.join('\n');
  return lines.slice(0, MAX_DIFF_LINES).join('\n') + `\n... (${lines.length - MAX_DIFF_LINES} more lines, run the git diff command above to see them)`;
}

export interface PromptContext {
  base: string;
  target: string;
  mergeBase: string;
  file: string;
  lines: DiffLine[];
  fileDiff: DiffFile | null;
  /** The thread so far; the last message is the question to answer. */
  messages: Message[];
}

/** The opening prompt of a thread's session, carrying everything the agent needs to orient itself. */
export function fullPrompt(ctx: PromptContext): string {
  const worktree = ctx.target === WORKTREE;
  const diffCmd = worktree ? `git diff ${ctx.mergeBase}` : `git diff ${ctx.mergeBase} ${ctx.target}`;
  const out: string[] = [
    worktree
      ? `I am reviewing the current state of the working tree (uncommitted changes included) against the branch \`${ctx.base}\`. The files on disk are the version under review.`
      : `I am reviewing the branch \`${ctx.target}\` against \`${ctx.base}\`. The files on disk may be a different branch: read the reviewed version with \`git show ${ctx.target}:<path>\`.`,
    `The full diff under review is \`${diffCmd}\` (untracked files are part of the review too).`,
    '',
    `My question is about \`${ctx.file}\`, ${rangeLabel(ctx.lines)}. Columns are old line number, new line number, then the diff line:`,
    '',
    '```',
    numbered(ctx.lines),
    '```',
  ];
  if (ctx.fileDiff && ctx.fileDiff.hunks.length > 0) {
    out.push('', `For context, the diff of \`${ctx.file}\` in this review:`, '', '```', fileDiffText(ctx.fileDiff), '```');
  }
  const earlier = ctx.messages.slice(0, -1).filter((m) => !m.error);
  if (earlier.length > 0) {
    out.push('', 'The discussion on these lines so far:', '');
    for (const m of earlier) out.push(`${m.role === 'user' ? 'Me' : 'You'}: ${m.body.trim()}`, '');
  }
  out.push('', earlier.length > 0 ? 'My new message:' : 'My question:', '', ctx.messages[ctx.messages.length - 1].body.trim());
  return out.join('\n');
}
