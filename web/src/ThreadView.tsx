import { memo, useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { rangeLabel } from '../../shared/anchor';
import type { DiffLine, Thread } from '../../shared/types';

export interface ThreadActions {
  reply: (threadId: number, body: string, ask: boolean) => Promise<void>;
  resolve: (threadId: number, resolved: boolean) => void;
  remove: (threadId: number) => void;
  cancel: (threadId: number) => void;
}

const SIGN = { insert: '+', delete: '-', context: ' ' } as const;

export function Snippet({ lines }: { lines: DiffLine[] }) {
  return (
    <pre className="snippet">
      {lines.map((l, i) => (
        <div key={i} className={`snippet-line ${l.type}`}>
          {SIGN[l.type]}
          {l.content}
        </div>
      ))}
    </pre>
  );
}

interface ComposerProps {
  placeholder: string;
  autoFocus?: boolean;
  disabled?: boolean;
  onSubmit: (body: string, ask: boolean) => Promise<void>;
  onCancel?: () => void;
}

/** Text box with the two ways to post: ask Claude, or just leave a note. */
export function Composer({ placeholder, autoFocus, disabled, onSubmit, onCancel }: ComposerProps) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus) ref.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  const submit = async (ask: boolean) => {
    if (!text.trim() || busy || disabled) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(text, ask);
      setText('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="composer">
      <textarea
        ref={ref}
        value={text}
        placeholder={placeholder}
        rows={3}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit(true);
          } else if (e.key === 'Escape' && !text.trim() && onCancel) {
            onCancel();
          }
        }}
      />
      {error && <div className="composer-error">{error}</div>}
      <div className="composer-actions">
        <button className="btn primary" disabled={!text.trim() || busy || disabled} onClick={() => void submit(true)}>
          Ask Claude
        </button>
        <button className="btn" disabled={!text.trim() || busy || disabled} onClick={() => void submit(false)}>
          Add note
        </button>
        {onCancel && (
          <button className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
        <span className="composer-hint">Ctrl+Enter asks Claude</span>
      </div>
    </div>
  );
}

interface Props {
  thread: Thread;
  stale: boolean;
  /** Show the file path (for threads whose file left the diff). */
  showFile?: boolean;
  actions: ThreadActions;
}

export const ThreadView = memo(function ThreadView({ thread, stale, showFile, actions }: Props) {
  const [open, setOpen] = useState(!thread.resolved);
  const [replying, setReplying] = useState(false);
  const wasResolved = useRef(thread.resolved);

  useEffect(() => {
    if (wasResolved.current !== thread.resolved) {
      wasResolved.current = thread.resolved;
      setOpen(!thread.resolved);
    }
  }, [thread.resolved]);

  return (
    <div
      className={`thread ${thread.resolved ? 'is-resolved' : ''} ${stale ? 'is-stale' : ''}`}
      id={`thread-${thread.id}`}
    >
      <div className="thread-head">
        <button className="thread-toggle" onClick={() => setOpen((o) => !o)}>
          <span className={`chevron ${open ? 'open' : ''}`}>›</span>
          <span className="thread-where">
            {showFile ? `${thread.file}, ` : ''}
            {rangeLabel(thread.lines)}
          </span>
        </button>
        {thread.origin === 'ai' && <span className="badge ai">AI review</span>}
        {thread.severity && <span className={`badge sev-${thread.severity}`}>{thread.severity}</span>}
        {stale && (
          <span className="badge stale" title="The code this thread was started on has changed">
            Stale
          </span>
        )}
        {thread.resolved && <span className="badge resolved">Resolved</span>}
        <span className="spacer" />
        <button className="btn small" onClick={() => actions.resolve(thread.id, !thread.resolved)}>
          {thread.resolved ? 'Unresolve' : 'Resolve thread'}
        </button>
        <button
          className="btn small ghost danger"
          title="Delete thread"
          onClick={() => {
            if (confirm('Delete this thread and its discussion?')) actions.remove(thread.id);
          }}
        >
          Delete
        </button>
      </div>
      {open && (
        <div className="thread-body">
          {stale && <Snippet lines={thread.lines} />}
          {thread.messages.map((m) => (
            <div key={m.id} className={`msg msg-${m.role} ${m.error ? 'msg-error' : ''}`}>
              <div className={`avatar avatar-${m.role}`}>{m.role === 'user' ? 'You' : 'C'}</div>
              <div className="msg-main">
                <div className="msg-meta">
                  <strong>{m.role === 'user' ? 'You' : 'Claude'}</strong>
                  <span>{new Date(m.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</span>
                </div>
                <div className="md">
                  <Markdown remarkPlugins={[remarkGfm]}>{m.body}</Markdown>
                </div>
              </div>
            </div>
          ))}
          {thread.running && (
            <div className="msg msg-agent">
              <div className="avatar avatar-agent">C</div>
              <div className="msg-main">
                <div className="msg-meta">
                  <strong>Claude</strong>
                  <span className="working">
                    <span className="spinner" />
                    {thread.live?.text ? 'Answering' : thread.live?.activity || 'Thinking'}
                  </span>
                  <button className="btn small ghost" onClick={() => actions.cancel(thread.id)}>
                    Stop
                  </button>
                </div>
                {thread.live?.text && (
                  <div className="md">
                    <Markdown remarkPlugins={[remarkGfm]}>{thread.live.text}</Markdown>
                  </div>
                )}
              </div>
            </div>
          )}
          {!thread.running &&
            (replying ? (
              <Composer
                placeholder="Reply…"
                autoFocus
                onCancel={() => setReplying(false)}
                onSubmit={async (body, ask) => {
                  await actions.reply(thread.id, body, ask);
                  setReplying(false);
                }}
              />
            ) : (
              <button className="reply-stub" onClick={() => setReplying(true)}>
                Reply…
              </button>
            ))}
        </div>
      )}
    </div>
  );
});
