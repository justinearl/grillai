import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { expandable } from '../shared/expand';
import type { AiReviewState, DiffFile, DiffLine, ReviewPayload, Thread } from '../shared/types';
import { runClaude, type AgentRun } from './agent';
import { openBrowser } from './browser';
import { Store, type ReviewRow } from './db';
import { GitError, fileLines, getDiff, repoInfo, resolveRepo } from './git';
import { fullPrompt } from './prompt';
import { REVIEW_SCHEMA, REVIEW_SYSTEM_PROMPT, findFile, inDiff, parseReview, placeFinding, reviewPrompt } from './review';

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function parseArgs(argv: string[]) {
  let repo = process.env.GRILLAI_REPO ?? process.cwd();
  let port = Number(process.env.GRILLAI_PORT ?? 4477);
  let open = !['0', 'false', 'no'].includes((process.env.GRILLAI_OPEN ?? '').toLowerCase());
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' || argv[i] === '-p') port = Number(argv[++i]);
    else if (argv[i] === '--no-open') open = false;
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: grillai [path-to-repo] [--port 4477] [--no-open]');
      process.exit(0);
    } else if (!argv[i].startsWith('-')) repo = argv[i];
  }
  return { repo: path.resolve(repo), port, open };
}

const args = parseArgs(process.argv.slice(2));
let repo: string;
try {
  repo = await resolveRepo(args.repo);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const store = new Store();
/** Last diff served per review, so agent prompts can include the file's diff. */
const diffCache = new Map<number, { mergeBase: string; files: DiffFile[] }>();
/** Agent runs in flight, by thread id. */
const live = new Map<number, { text: string; activity: string; run: AgentRun | null; cancelled: boolean }>();

/** AI reviews of a whole change in flight, by review id. */
const aiRuns = new Map<number, { activity: string; run: AgentRun | null; cancelled: boolean }>();

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const hostOf = (value: string) => {
  try {
    return new URL(value.includes('://') ? value : `http://${value}`).hostname;
  } catch {
    return '';
  }
};

const app = express();
// Only this machine's browser may talk to the API: blocks other sites and DNS rebinding.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!LOCAL_HOSTS.has(hostOf(req.headers.host ?? '')) || (origin && !LOCAL_HOSTS.has(hostOf(origin)))) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  next();
});
app.use(express.json({ limit: '5mb' }));

function withLive(thread: Thread): Thread {
  const l = live.get(thread.id);
  return l ? { ...thread, running: true, live: { text: l.text, activity: l.activity } } : thread;
}

function reviewOf(id: unknown): ReviewRow {
  const review = store.getReview(Number(id));
  if (!review || review.repoPath !== repo) throw new HttpError(404, 'Review not found');
  return review;
}

function threadOf(id: unknown): { thread: Thread; review: ReviewRow } {
  const thread = store.getThread(Number(id));
  if (!thread) throw new HttpError(404, 'Thread not found');
  return { thread, review: reviewOf(thread.reviewId) };
}

function askAgent(threadId: number, review: ReviewRow): void {
  if (live.has(threadId)) return;
  const state = { text: '', activity: 'Starting Claude', run: null as AgentRun | null, cancelled: false };
  live.set(threadId, state);

  const attempt = (resume: string | null) => {
    const thread = store.getThread(threadId)!;
    const question = thread.messages[thread.messages.length - 1];
    const cached = diffCache.get(review.id);
    const prompt = resume
      ? question.body
      : fullPrompt({
          base: review.base,
          target: review.target,
          mergeBase: cached?.mergeBase ?? review.base,
          file: thread.file,
          lines: thread.lines,
          fileDiff: cached?.files.find((f) => f.path === thread.file) ?? null,
          messages: thread.messages,
        });
    state.run = runClaude({
      cwd: repo,
      prompt,
      resume,
      onText: (t) => (state.text = t),
      onActivity: (a) => {
        state.activity = a;
        state.text = '';
      },
    });
    return state.run.done;
  };

  (async () => {
    const session = store.getSession(threadId);
    try {
      let result;
      try {
        result = await attempt(session);
      } catch (err) {
        // A session can be gone (cleaned up, other machine): start over with the thread as context.
        if (!session || state.cancelled) throw err;
        state.text = '';
        result = await attempt(null);
      }
      if (store.getThread(threadId)) {
        store.addMessage(threadId, 'agent', result.text.trim() || '(empty answer)');
        store.setSession(threadId, result.sessionId);
      }
    } catch (err) {
      if (store.getThread(threadId)) {
        store.addMessage(threadId, 'agent', state.cancelled ? 'Cancelled.' : (err as Error).message, true);
      }
    } finally {
      live.delete(threadId);
    }
  })();
}

function aiState(reviewId: number): AiReviewState {
  const run = aiRuns.get(reviewId);
  return { running: !!run, activity: run?.activity ?? '', latest: store.latestAiReview(reviewId) };
}

/** Review the whole change with Claude; each finding becomes a thread on the lines it is about. */
async function runAiReview(review: ReviewRow): Promise<void> {
  const state = { activity: 'Reading the diff', run: null as AgentRun | null, cancelled: false };
  aiRuns.set(review.id, state);
  try {
    const diff = await getDiff(repo, review.base, review.target);
    diffCache.set(review.id, diff);
    if (diff.files.length === 0) throw new Error('There are no changes to review.');
    if (state.cancelled) throw new Error('Cancelled.');
    state.activity = 'Starting Claude';
    state.run = runClaude({
      cwd: repo,
      prompt: reviewPrompt({ base: review.base, target: review.target, mergeBase: diff.mergeBase, files: diff.files }),
      systemPrompt: REVIEW_SYSTEM_PROMPT,
      jsonSchema: REVIEW_SCHEMA,
      onText: () => {},
      onActivity: (a) => (state.activity = a),
    });
    const result = await state.run.done;
    let output = result.structured;
    if (output == null) {
      try {
        output = JSON.parse(result.text);
      } catch {
        throw new Error('Claude did not return its findings in the expected format. Run the review again.');
      }
    }
    const { summary, findings } = parseReview(output);

    state.activity = 'Placing findings';
    store.deleteUnansweredAiThreads(review.id);
    const unplaced: string[] = [];
    let placed = 0;
    for (const f of findings) {
      const file = findFile(diff.files, f.file, repo);
      const text = f.title ? `**${f.title}**\n\n${f.body}` : f.body;
      let lines: DiffLine[] | null = null;
      if (file) {
        const content =
          expandable(file) && !inDiff(file, f) ? await fileLines(repo, review.target, file.path).catch(() => null) : null;
        lines = placeFinding(file, content, f);
      }
      if (file && lines) {
        const id = store.createThread(review.id, file.path, lines, 'ai', f.severity);
        store.addMessage(id, 'agent', text);
        placed++;
      } else {
        unplaced.push(`- **${f.file}:${f.startLine}** (${f.severity}) ${text.replace(/\n+/g, ' ')}`);
      }
    }
    const body = [summary || 'No summary.'];
    if (unplaced.length > 0) body.push('', 'Findings on code outside this diff:', '', ...unplaced);
    store.addAiReview(review.id, body.join('\n'), placed + unplaced.length);
  } catch (err) {
    store.addAiReview(review.id, state.cancelled ? 'The review was stopped.' : (err as Error).message, 0, true);
  } finally {
    aiRuns.delete(review.id);
  }
}

function cleanLines(input: unknown): DiffLine[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 2000) throw new HttpError(400, 'Invalid line selection');
  return input.map((l) => {
    if (!l || !['context', 'insert', 'delete'].includes(l.type) || typeof l.content !== 'string') {
      throw new HttpError(400, 'Invalid line selection');
    }
    return {
      type: l.type,
      content: l.content,
      oldNo: typeof l.oldNo === 'number' ? l.oldNo : null,
      newNo: typeof l.newNo === 'number' ? l.newNo : null,
    };
  });
}

function bodyText(input: unknown): string {
  if (typeof input !== 'string' || !input.trim()) throw new HttpError(400, 'Message is empty');
  return input.trim();
}

app.get('/api/repo', async (_req, res) => {
  res.json(await repoInfo(repo));
});

app.get('/api/review', async (req, res) => {
  const base = String(req.query.base ?? '');
  const target = String(req.query.target ?? '');
  if (!base || !target) throw new HttpError(400, 'base and target are required');
  const diff = await getDiff(repo, base, target);
  const review = store.getOrCreateReview(repo, base, target);
  diffCache.set(review.id, diff);
  const payload: ReviewPayload = {
    review: { id: review.id, base, target },
    mergeBase: diff.mergeBase,
    files: diff.files,
    threads: store.listThreads(review.id).map(withLive),
    viewed: store.getViewed(review.id),
    aiReview: aiState(review.id),
  };
  res.json(payload);
});

// The new version of one changed file, for "show more lines" between hunks.
app.get('/api/reviews/:id/file', async (req, res) => {
  const review = reviewOf(req.params.id);
  const file = String(req.query.path ?? '');
  let diff = diffCache.get(review.id);
  if (!diff) {
    diff = await getDiff(repo, review.base, review.target);
    diffCache.set(review.id, diff);
  }
  if (!diff.files.some((f) => f.path === file)) throw new HttpError(404, 'File is not part of this review');
  res.json({ lines: await fileLines(repo, review.target, file) });
});

app.get('/api/reviews/:id/ai-review', (req, res) => {
  res.json(aiState(reviewOf(req.params.id).id));
});

app.post('/api/reviews/:id/ai-review', (req, res) => {
  const review = reviewOf(req.params.id);
  if (aiRuns.has(review.id)) throw new HttpError(409, 'An AI review is already running');
  void runAiReview(review);
  res.json(aiState(review.id));
});

app.post('/api/reviews/:id/ai-review/cancel', (req, res) => {
  const review = reviewOf(req.params.id);
  const run = aiRuns.get(review.id);
  if (run) {
    run.cancelled = true;
    run.run?.kill();
  }
  res.json({ ok: true });
});

app.get('/api/reviews/:id/threads', (req, res) => {
  const review = reviewOf(req.params.id);
  res.json(store.listThreads(review.id).map(withLive));
});

app.post('/api/reviews/:id/threads', (req, res) => {
  const review = reviewOf(req.params.id);
  const file = String(req.body.file ?? '');
  if (!file) throw new HttpError(400, 'file is required');
  const lines = cleanLines(req.body.lines);
  const body = bodyText(req.body.body);
  const id = store.createThread(review.id, file, lines);
  store.addMessage(id, 'user', body);
  if (req.body.ask) askAgent(id, review);
  res.json(withLive(store.getThread(id)!));
});

app.post('/api/threads/:id/messages', (req, res) => {
  const { thread, review } = threadOf(req.params.id);
  if (live.has(thread.id)) throw new HttpError(409, 'Claude is still answering in this thread');
  store.addMessage(thread.id, 'user', bodyText(req.body.body));
  if (req.body.ask) askAgent(thread.id, review);
  res.json(withLive(store.getThread(thread.id)!));
});

app.post('/api/threads/:id/cancel', (req, res) => {
  const { thread } = threadOf(req.params.id);
  const l = live.get(thread.id);
  if (l) {
    l.cancelled = true;
    l.run?.kill();
  }
  res.json({ ok: true });
});

app.patch('/api/threads/:id', (req, res) => {
  const { thread } = threadOf(req.params.id);
  store.setResolved(thread.id, !!req.body.resolved);
  res.json(withLive(store.getThread(thread.id)!));
});

app.delete('/api/threads/:id', (req, res) => {
  const { thread } = threadOf(req.params.id);
  const l = live.get(thread.id);
  if (l) {
    l.cancelled = true;
    l.run?.kill();
  }
  store.deleteThread(thread.id);
  res.json({ ok: true });
});

app.put('/api/reviews/:id/viewed', (req, res) => {
  const review = reviewOf(req.params.id);
  const file = String(req.body.file ?? '');
  if (!file) throw new HttpError(400, 'file is required');
  store.setViewed(review.id, file, typeof req.body.hash === 'string' ? req.body.hash : null);
  res.json({ ok: true });
});

app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));

const webDir = [
  fileURLToPath(new URL('../web', import.meta.url)),
  fileURLToPath(new URL('../dist/web', import.meta.url)),
].find((d) => existsSync(path.join(d, 'assets')));
if (webDir) {
  app.use(express.static(webDir));
  app.get(/.*/, (_req, res) => res.sendFile(path.join(webDir, 'index.html')));
}

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  const status = err instanceof HttpError ? err.status : err instanceof GitError ? 400 : 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: err.message });
});

const server = app.listen(args.port, '127.0.0.1', () => {
  console.log(`grillai is reviewing ${repo}`);
  console.log(webDir ? `Open http://localhost:${args.port}` : `API on http://localhost:${args.port} (web UI is served by vite in dev)`);
  if (webDir && args.open) openBrowser(`http://localhost:${args.port}`);
});
server.on('error', (err: NodeJS.ErrnoException) => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${args.port} is in use. Pick another with --port.` : err.message);
  process.exit(1);
});

const shutdown = () => {
  for (const l of live.values()) l.run?.kill();
  for (const r of aiRuns.values()) r.run?.kill();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
