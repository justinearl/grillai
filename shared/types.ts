/** Value of `target` meaning "the current state of the working tree". */
export const WORKTREE = 'WORKTREE';

export type LineType = 'context' | 'insert' | 'delete';

export interface DiffLine {
  type: LineType;
  content: string;
  oldNo: number | null;
  newNo: number | null;
}

/** A run of unchanged lines the diff does not show; new-side line numbers, inclusive. */
export interface Gap {
  from: number;
  /** null: up to the end of the file, whose length is not known yet. */
  to: number | null;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
  /** Hidden lines above this hunk (set by expandFile). */
  gapBefore?: Gap | null;
}

export type FileStatus = 'added' | 'deleted' | 'renamed' | 'modified';

export interface DiffFile {
  path: string;
  oldPath: string | null;
  status: FileStatus;
  binary: boolean;
  tooBig: boolean;
  added: number;
  deleted: number;
  /** Hash of this file's diff; a "viewed" mark only holds while it is unchanged. */
  hash: string;
  hunks: DiffHunk[];
  /** Hidden lines after the last hunk (set by expandFile). */
  tailGap?: Gap | null;
}

export interface Message {
  id: number;
  role: 'user' | 'agent';
  body: string;
  error: boolean;
  createdAt: string;
}

export type Severity = 'high' | 'medium' | 'low';

export interface Thread {
  id: number;
  reviewId: number;
  file: string;
  /** 'ai': a finding from an AI review of the whole change. */
  origin: 'user' | 'ai';
  severity: Severity | null;
  /** The selected lines as they were when the thread was started. */
  lines: DiffLine[];
  resolved: boolean;
  createdAt: string;
  messages: Message[];
  /** True while the agent is working on an answer. */
  running: boolean;
  live?: { text: string; activity: string };
}

export interface RepoInfo {
  path: string;
  name: string;
  currentBranch: string | null;
  branches: string[];
  defaultBase: string | null;
}

/** The AI review of the whole change: whether one is running, and the last result. */
export interface AiReviewState {
  running: boolean;
  activity: string;
  latest: {
    id: number;
    summary: string;
    error: boolean;
    findings: number;
    createdAt: string;
  } | null;
}

export interface ReviewPayload {
  review: { id: number; base: string; target: string };
  mergeBase: string;
  files: DiffFile[];
  threads: Thread[];
  /** file path -> diff hash at the time it was marked viewed */
  viewed: Record<string, string>;
  aiReview: AiReviewState;
}
