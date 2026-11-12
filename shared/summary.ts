import { rangeLabel, snippet } from './anchor';
import { WORKTREE, type Thread } from './types';

export interface SummaryThread {
  thread: Thread;
  stale: boolean;
}

export interface SummaryOptions {
  base: string;
  target: string;
  includeAgent: boolean;
}

export const targetLabel = (target: string) => (target === WORKTREE ? 'working tree' : target);

/**
 * The review as one block of text to paste into another agent:
 * every unresolved thread with its file, lines, code and discussion.
 */
export function buildSummary(items: SummaryThread[], opts: SummaryOptions): string {
  const open = items.filter((i) => !i.thread.resolved);
  const head = `# Code review feedback: ${targetLabel(opts.target)} compared to ${opts.base}`;
  if (open.length === 0) return `${head}\n\nNo unresolved threads.\n`;

  const out: string[] = [
    head,
    '',
    `There are ${open.length} unresolved review thread${open.length === 1 ? '' : 's'}. ` +
      'Each one names a file and lines, shows the code as a diff snippet, and gives the discussion. ' +
      'Address each thread.',
  ];
  open.forEach(({ thread, stale }, i) => {
    const severity = thread.severity ? `, ${thread.severity} severity` : '';
    out.push('', `## ${i + 1}. ${thread.file} (${rangeLabel(thread.lines)}${severity})`);
    if (stale) out.push('', '_Note: this code has changed since the thread was started._');
    out.push('', '```diff', snippet(thread.lines), '```', '');
    // The first message of an AI review thread is the finding itself: it always stays.
    const messages = thread.messages.filter(
      (m, index) => !m.error && (m.role === 'user' || opts.includeAgent || (thread.origin === 'ai' && index === 0)),
    );
    for (const m of messages) {
      out.push(`**${m.role === 'user' ? 'Reviewer' : 'Assistant'}:** ${m.body.trim()}`, '');
    }
    while (out[out.length - 1] === '') out.pop();
  });
  return out.join('\n') + '\n';
}
