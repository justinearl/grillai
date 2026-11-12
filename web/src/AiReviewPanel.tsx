import { useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AiReviewState, Severity, Thread } from '../../shared/types';

interface Props {
  state: AiReviewState;
  threads: Thread[];
  onStop: () => void;
}

const SEVERITIES: Severity[] = ['high', 'medium', 'low'];

/** Status and summary of the AI review of the whole change; its findings are threads in the diff below. */
export function AiReviewPanel({ state, threads, onStop }: Props) {
  const [open, setOpen] = useState(true);
  const { running, latest } = state;
  const findings = threads.filter((t) => t.origin === 'ai');
  const openCount = (s: Severity) => findings.filter((t) => t.severity === s && !t.resolved).length;

  return (
    <section className={`ai-panel ${!running && latest?.error ? 'is-error' : ''}`}>
      <div className="ai-panel-head">
        <button className="icon-btn" onClick={() => setOpen((o) => !o)} title={open ? 'Collapse' : 'Expand'}>
          <span className={`chevron ${open ? 'open' : ''}`}>›</span>
        </button>
        <h3>AI review</h3>
        {running ? (
          <>
            <span className="working">
              <span className="spinner" />
              {state.activity || 'Working'}
            </span>
            <span className="spacer" />
            <button className="btn small" onClick={onStop}>
              Stop
            </button>
          </>
        ) : (
          latest && (
            <>
              <span className="muted">
                {new Date(latest.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
              </span>
              {!latest.error && (
                <span className="muted">
                  {latest.findings === 0 ? 'No findings' : `${latest.findings} finding${latest.findings === 1 ? '' : 's'}`}
                </span>
              )}
              {SEVERITIES.map(
                (s) =>
                  openCount(s) > 0 && (
                    <span key={s} className={`badge sev-${s}`}>
                      {openCount(s)} {s} open
                    </span>
                  ),
              )}
            </>
          )
        )}
      </div>
      {open && !running && latest && (
        <div className="ai-panel-body md">
          <Markdown remarkPlugins={[remarkGfm]}>{latest.summary}</Markdown>
        </div>
      )}
    </section>
  );
}
