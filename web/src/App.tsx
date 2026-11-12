import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flatten, locate } from '../../shared/anchor';
import { EXPAND_STEP, expandFile, expandable, findContextLines } from '../../shared/expand';
import type { SummaryThread } from '../../shared/summary';
import { WORKTREE, type AiReviewState, type DiffFile, type DiffLine, type Gap, type RepoInfo, type ReviewPayload, type Thread } from '../../shared/types';
import { api } from './api';
import { FileDiff, type FileThreads, type Range } from './FileDiff';
import { FileTree } from './FileTree';
import { SummaryModal } from './SummaryModal';
import { ThreadView, type ThreadActions } from './ThreadView';
import { AiReviewPanel } from './AiReviewPanel';

type Mode = 'inline' | 'split';
interface FileRange extends Range {
  file: string;
}

const params = new URLSearchParams(location.search);
const EMPTY: ReadonlySet<number> = new Set();

function RefSelect(props: { value: string; branches: string[]; worktree?: boolean; onChange: (v: string) => void }) {
  const known = props.branches.includes(props.value) || (props.worktree && props.value === WORKTREE);
  return (
    <select
      className="ref-select"
      value={props.value}
      onChange={(e) => {
        if (e.target.value === '__other') {
          const ref = prompt('Branch, tag or commit to compare:')?.trim();
          if (ref) props.onChange(ref);
        } else {
          props.onChange(e.target.value);
        }
      }}
    >
      {props.worktree && <option value={WORKTREE}>Working tree (current state)</option>}
      {!known && props.value && <option value={props.value}>{props.value}</option>}
      {props.branches.map((b) => (
        <option key={b} value={b}>
          {b}
        </option>
      ))}
      <option value="__other">Other ref…</option>
    </select>
  );
}

export function App() {
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [base, setBase] = useState(params.get('base') ?? '');
  const [target, setTarget] = useState(params.get('target') ?? WORKTREE);
  const [payload, setPayload] = useState<ReviewPayload | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [viewedMap, setViewedMap] = useState<Record<string, string>>({});
  const [aiReview, setAiReview] = useState<AiReviewState | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [mode, setMode] = useState<Mode>(() => (localStorage.getItem('grillai.mode') === 'split' ? 'split' : 'inline'));
  const [selection, setSelection] = useState<FileRange | null>(null);
  const [draft, setDraft] = useState<FileRange | null>(null);
  const [showSummary, setShowSummary] = useState(false);
  const [showTree, setShowTree] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const drag = useRef<{ file: string; anchor: number } | null>(null);
  const selectionRef = useRef<FileRange | null>(null);
  const draftRef = useRef<FileRange | null>(null);
  draftRef.current = draft;
  const payloadRef = useRef<ReviewPayload | null>(null);
  payloadRef.current = payload;
  const jumpIndex = useRef(-1);

  useEffect(() => {
    api
      .repo()
      .then((r) => {
        setRepo(r);
        document.title = `${r.name} · grillai`;
        setBase((b) => b || r.defaultBase || '');
      })
      .catch((e) => setError(e.message));
  }, []);

  const load = useCallback(
    async (quiet = false) => {
      if (!base || !target) return;
      if (!quiet) setLoading(true);
      try {
        const p = await api.review(base, target);
        setPayload(p);
        setThreads(p.threads);
        setViewedMap(p.viewed);
        setAiReview(p.aiReview);
        setError(null);
      } catch (e) {
        setError((e as Error).message);
        if (!quiet) setPayload(null);
      } finally {
        if (!quiet) setLoading(false);
      }
    },
    [base, target],
  );

  useEffect(() => {
    if (!base) return;
    history.replaceState(null, '', `?base=${encodeURIComponent(base)}&target=${encodeURIComponent(target)}`);
    setDraft(null);
    setCollapsed({});
    void load();
  }, [base, target, load]);

  // The code may have changed while you were in another window: refresh on return.
  useEffect(() => {
    const onFocus = () => {
      if (!draftRef.current && !drag.current) void load(true);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  const reviewId = payload?.review.id;
  const anyRunning = threads.some((t) => t.running);
  useEffect(() => {
    if (!anyRunning || reviewId == null) return;
    const timer = setInterval(() => {
      api.threads(reviewId).then(setThreads).catch(() => {});
    }, 1000);
    return () => clearInterval(timer);
  }, [anyRunning, reviewId]);

  // While an AI review runs, follow its progress; when it ends, pick up its findings.
  const aiRunning = !!aiReview?.running;
  useEffect(() => {
    if (!aiRunning || reviewId == null) return;
    const timer = setInterval(() => {
      api
        .aiReview(reviewId)
        .then((state) => {
          setAiReview(state);
          if (!state.running) void load(true);
        })
        .catch(() => {});
    }, 1000);
    return () => clearInterval(timer);
  }, [aiRunning, reviewId, load]);

  const startAiReview = () => {
    if (reviewId == null || aiRunning) return;
    const replaceable = threads.filter((t) => t.origin === 'ai' && !t.messages.some((m) => m.role === 'user')).length;
    if (
      replaceable > 0 &&
      !confirm(
        `Run the AI review again? The ${replaceable} finding${replaceable === 1 ? '' : 's'} from the last AI review that you have not replied to will be replaced.`,
      )
    ) {
      return;
    }
    api.startAiReview(reviewId).then(setAiReview).catch((e) => setError(e.message));
  };
  const stopAiReview = () => {
    if (reviewId != null) api.cancelAiReview(reviewId).catch(() => {});
  };

  useEffect(() => {
    const up = () => {
      if (!drag.current) return;
      drag.current = null;
      setDraft(selectionRef.current);
      selectionRef.current = null;
      setSelection(null);
    };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, []);

  const rawFiles = payload?.files ?? [];
  // Hidden lines the reader expanded, and the file contents they come from.
  // Both are tied to a file's diff hash: when the diff changes they start over.
  const [contents, setContents] = useState<Record<string, { hash: string; lines: string[] }>>({});
  const [revealed, setRevealed] = useState<Record<string, { hash: string; lines: ReadonlySet<number> }>>({});
  const contentsRef = useRef(contents);
  contentsRef.current = contents;
  const fetching = useRef(new Map<string, Promise<string[]>>());
  const expandCache = useRef(new Map<string, { raw: DiffFile; content: unknown; lines: unknown; view: DiffFile }>());

  const files = useMemo(
    () =>
      rawFiles.map((raw) => {
        const c = contents[raw.path];
        const r = revealed[raw.path];
        const content = c && c.hash === raw.hash ? c.lines : null;
        const lines = r && r.hash === raw.hash ? r.lines : EMPTY;
        const hit = expandCache.current.get(raw.path);
        if (hit && hit.raw === raw && hit.content === content && hit.lines === lines) return hit.view;
        const view = expandFile(raw, content, lines);
        expandCache.current.set(raw.path, { raw, content, lines, view });
        return view;
      }),
    [rawFiles, contents, revealed],
  );
  const filesRef = useRef(files);
  filesRef.current = files;

  const ensureContent = useCallback(async (file: DiffFile): Promise<string[]> => {
    const have = contentsRef.current[file.path];
    if (have && have.hash === file.hash) return have.lines;
    const p = payloadRef.current;
    if (!p) throw new Error('No review loaded');
    const key = `${p.review.id}:${file.path}:${file.hash}`;
    let pending = fetching.current.get(key);
    if (!pending) {
      pending = api.fileLines(p.review.id, file.path).then((r) => r.lines);
      fetching.current.set(key, pending);
      pending.finally(() => fetching.current.delete(key)).catch(() => {});
    }
    const lines = await pending;
    setContents((c) => ({ ...c, [file.path]: { hash: file.hash, lines } }));
    return lines;
  }, []);

  const reveal = useCallback((file: DiffFile, numbers: number[]) => {
    setRevealed((r) => {
      const prev = r[file.path];
      const set = new Set(prev && prev.hash === file.hash ? prev.lines : []);
      for (const n of numbers) set.add(n);
      return { ...r, [file.path]: { hash: file.hash, lines: set } };
    });
  }, []);

  const onExpand = useCallback(
    async (file: DiffFile, gap: Gap, how: 'all' | 'top' | 'bottom') => {
      try {
        const lines = await ensureContent(file);
        const end = gap.to ?? lines.length;
        let from = gap.from;
        let to = end;
        if (how === 'top') to = Math.min(end, from + EXPAND_STEP - 1);
        if (how === 'bottom') from = Math.max(gap.from, end - EXPAND_STEP + 1);
        const numbers: number[] = [];
        for (let n = from; n <= to; n++) numbers.push(n);
        reveal(file, numbers);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [ensureContent, reveal],
  );
  const flats = useMemo(() => new Map(files.map((f) => [f.path, flatten(f)])), [files]);

  const located = useMemo(() => {
    const byFile = new Map<string, FileThreads>();
    const orphans: Thread[] = [];
    const stale = new Set<number>();
    const position = new Map<number, number>();
    const shown: Thread[] = [];
    for (const original of threads) {
      let t = original;
      const flat = flats.get(t.file);
      if (!flat) {
        orphans.push(t);
        stale.add(t.id);
        shown.push(t);
        continue;
      }
      let entry = byFile.get(t.file);
      if (!entry) byFile.set(t.file, (entry = { anchored: new Map(), stale: [] }));
      const loc = locate(flat, t.lines);
      if (!loc) {
        entry.stale.push(t);
        stale.add(t.id);
        position.set(t.id, -1);
      } else {
        // Show the thread with today's line numbers: its code may have moved.
        t = { ...t, lines: flat.slice(loc.start, loc.end + 1) };
        const list = entry.anchored.get(loc.end) ?? [];
        list.push(t);
        entry.anchored.set(loc.end, list);
        position.set(t.id, loc.end);
      }
      shown.push(t);
    }
    const fileOrder = new Map(files.map((f, i) => [f.path, i]));
    const ordered = shown.sort(
      (a, b) =>
        (fileOrder.get(a.file) ?? -1) - (fileOrder.get(b.file) ?? -1) ||
        (position.get(a.id) ?? -1) - (position.get(b.id) ?? -1) ||
        a.id - b.id,
    );
    const counts = new Map<string, number>();
    for (const t of threads) if (!t.resolved) counts.set(t.file, (counts.get(t.file) ?? 0) + 1);
    return { byFile, orphans, stale, ordered, counts };
  }, [threads, flats, files]);

  // A thread started on expanded lines needs them expanded again after a reload.
  const triedReveal = useRef(new Set<string>());
  useEffect(() => {
    for (const t of threads) {
      if (!located.stale.has(t.id)) continue;
      const file = files.find((f) => f.path === t.file);
      if (!file || !expandable(file)) continue;
      const key = `${t.id}:${file.hash}`;
      if (triedReveal.current.has(key)) continue;
      triedReveal.current.add(key);
      ensureContent(file)
        .then((lines) => {
          const numbers = findContextLines(lines, t.lines);
          if (numbers) reveal(file, numbers);
        })
        .catch(() => {});
    }
  }, [threads, files, located, ensureContent, reveal]);

  const unresolved = useMemo(() => located.ordered.filter((t) => !t.resolved), [located]);
  const summaryItems: SummaryThread[] = useMemo(
    () => located.ordered.map((t) => ({ thread: t, stale: located.stale.has(t.id) })),
    [located],
  );

  const viewedSet = useMemo(
    () => new Set(files.filter((f) => viewedMap[f.path] === f.hash).map((f) => f.path)),
    [files, viewedMap],
  );

  const upsert = useCallback((t: Thread) => {
    setThreads((list) => (list.some((x) => x.id === t.id) ? list.map((x) => (x.id === t.id ? t : x)) : [...list, t]));
  }, []);

  const actions: ThreadActions = useMemo(
    () => ({
      reply: async (id, body, ask) => upsert(await api.reply(id, body, ask)),
      resolve: (id, resolved) => {
        api.resolve(id, resolved).then(upsert).catch((e) => setError(e.message));
      },
      remove: (id) => {
        api
          .remove(id)
          .then(() => setThreads((list) => list.filter((t) => t.id !== id)))
          .catch((e) => setError(e.message));
      },
      cancel: (id) => {
        api.cancel(id).catch(() => {});
      },
    }),
    [upsert],
  );

  const onDragStart = useCallback((file: string, idx: number, extend: boolean) => {
    const d = draftRef.current;
    if (extend && d && d.file === file) {
      setDraft({ file, start: Math.min(d.start, idx), end: Math.max(d.end, idx) });
      return;
    }
    drag.current = { file, anchor: idx };
    selectionRef.current = { file, start: idx, end: idx };
    setSelection(selectionRef.current);
    setDraft(null);
  }, []);

  const onDragOver = useCallback((file: string, idx: number) => {
    const d = drag.current;
    if (!d || d.file !== file) return;
    selectionRef.current = { file, start: Math.min(d.anchor, idx), end: Math.max(d.anchor, idx) };
    setSelection(selectionRef.current);
  }, []);

  const onDraftSubmit = useCallback(
    async (body: string, ask: boolean) => {
      const d = draftRef.current;
      const p = payloadRef.current;
      if (!d || !p) return;
      const file = filesRef.current.find((f) => f.path === d.file);
      if (!file) return;
      const lines: DiffLine[] = flatten(file).slice(d.start, d.end + 1);
      upsert(await api.createThread(p.review.id, d.file, lines, body, ask));
      setDraft(null);
    },
    [upsert],
  );
  const onDraftCancel = useCallback(() => setDraft(null), []);

  const onToggleCollapse = useCallback(
    (path: string) => setCollapsed((c) => ({ ...c, [path]: !(c[path] ?? viewedRef.current.has(path)) })),
    [],
  );
  const viewedRef = useRef(viewedSet);
  viewedRef.current = viewedSet;

  const onToggleViewed = useCallback((file: DiffFile, viewed: boolean) => {
    const p = payloadRef.current;
    if (!p) return;
    setViewedMap((m) => {
      const next = { ...m };
      if (viewed) next[file.path] = file.hash;
      else delete next[file.path];
      return next;
    });
    setCollapsed((c) => ({ ...c, [file.path]: viewed }));
    api.setViewed(p.review.id, file.path, viewed ? file.hash : null).catch((e) => setError(e.message));
  }, []);

  const scrollToFile = useCallback((path: string) => {
    setCollapsed((c) => ({ ...c, [path]: false }));
    requestAnimationFrame(() => document.getElementById(`file-${path}`)?.scrollIntoView({ block: 'start' }));
  }, []);

  const jump = () => {
    if (unresolved.length === 0) return;
    jumpIndex.current = (jumpIndex.current + 1) % unresolved.length;
    const t = unresolved[jumpIndex.current];
    setCollapsed((c) => ({ ...c, [t.file]: false }));
    setTimeout(() => {
      const el = document.getElementById(`thread-${t.id}`);
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el?.classList.add('flash');
      setTimeout(() => el?.classList.remove('flash'), 1200);
    }, 60);
  };

  const changeMode = (m: Mode) => {
    setMode(m);
    localStorage.setItem('grillai.mode', m);
  };

  const totals = useMemo(
    () => files.reduce((a, f) => ({ added: a.added + f.added, deleted: a.deleted + f.deleted }), { added: 0, deleted: 0 }),
    [files],
  );

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">grillai</span>
        {repo && <span className="repo" title={repo.path}>{repo.name}</span>}
        {repo && (
          <div className="compare">
            <span>Review</span>
            <RefSelect value={target} branches={repo.branches} worktree onChange={setTarget} />
            <span>against</span>
            <RefSelect value={base} branches={repo.branches} onChange={setBase} />
          </div>
        )}
      </header>

      <div className="subbar">
        <button className="icon-btn" title={showTree ? 'Hide file tree' : 'Show file tree'} onClick={() => setShowTree((s) => !s)}>
          ☰
        </button>
        <span className="tab">
          Changes <span className="count">{files.length}</span>
        </span>
        <span className="totals">
          <span className="add">+{totals.added}</span> <span className="del">−{totals.deleted}</span>
        </span>
        <span className="viewed-count">
          {viewedSet.size}/{files.length} viewed
        </span>
        <span className="spacer" />
        <span className={`unresolved ${unresolved.length ? 'has' : ''}`}>
          {unresolved.length === 0
            ? threads.length
              ? 'All threads resolved'
              : 'No threads yet'
            : `${unresolved.length} unresolved thread${unresolved.length === 1 ? '' : 's'}`}
          {unresolved.length > 0 && (
            <button className="icon-btn" title="Go to next unresolved thread" onClick={jump}>
              ↓
            </button>
          )}
        </span>
        <div className="segmented">
          <button className={mode === 'inline' ? 'on' : ''} onClick={() => changeMode('inline')}>
            Inline
          </button>
          <button className={mode === 'split' ? 'on' : ''} onClick={() => changeMode('split')}>
            Side-by-side
          </button>
        </div>
        <button className="btn" onClick={() => void load()} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
        <button
          className="btn"
          onClick={startAiReview}
          disabled={!payload || aiRunning || rawFiles.length === 0}
          title="Have Claude review the whole change and post its findings as threads"
        >
          {aiRunning ? 'AI review running…' : 'AI review'}
        </button>
        <button className="btn primary" onClick={() => setShowSummary(true)}>
          Review summary
        </button>
      </div>

      {error && (
        <div className="banner error">
          {error}
          <button className="icon-btn" onClick={() => setError(null)}>
            ✕
          </button>
        </div>
      )}

      <div className="layout">
        {showTree && payload && (
          <FileTree files={files} viewed={viewedSet} threadCounts={located.counts} onSelect={scrollToFile} />
        )}
        <main className="files">
          {!payload && loading && <div className="empty">Loading diff…</div>}
          {!payload && !loading && !error && repo && !base && (
            <div className="empty">This repository has no branches to compare against yet.</div>
          )}
          {payload && aiReview && (aiReview.running || aiReview.latest) && (
            <AiReviewPanel state={aiReview} threads={threads} onStop={stopAiReview} />
          )}
          {payload && located.orphans.length > 0 && (
            <section className="orphans">
              <h3>Threads on files that are no longer in this diff</h3>
              {located.orphans.map((t) => (
                <ThreadView key={t.id} thread={t} stale showFile actions={actions} />
              ))}
            </section>
          )}
          {payload && files.length === 0 && (
            <div className="empty">
              No changes between <strong>{target === WORKTREE ? 'the working tree' : target}</strong> and{' '}
              <strong>{base}</strong>.
            </div>
          )}
          {files.map((f) => (
            <FileDiff
              key={f.path}
              file={f}
              flat={flats.get(f.path)!}
              mode={mode}
              collapsed={collapsed[f.path] ?? viewedSet.has(f.path)}
              viewed={viewedSet.has(f.path)}
              threads={located.byFile.get(f.path)}
              selection={selection?.file === f.path ? selection : null}
              draft={draft?.file === f.path ? draft : null}
              actions={actions}
              onToggleCollapse={onToggleCollapse}
              onToggleViewed={onToggleViewed}
              onDragStart={onDragStart}
              onDragOver={onDragOver}
              onDraftSubmit={onDraftSubmit}
              onDraftCancel={onDraftCancel}
              onExpand={onExpand}
            />
          ))}
        </main>
      </div>

      {showSummary && payload && (
        <SummaryModal items={summaryItems} base={base} target={target} onClose={() => setShowSummary(false)} />
      )}
    </div>
  );
}
