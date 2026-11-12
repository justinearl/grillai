import { useMemo, useState } from 'react';
import { buildSummary, type SummaryThread } from '../../shared/summary';

interface Props {
  items: SummaryThread[];
  base: string;
  target: string;
  onClose: () => void;
}

export function SummaryModal({ items, base, target, onClose }: Props) {
  const [includeAgent, setIncludeAgent] = useState(true);
  const [copied, setCopied] = useState(false);
  const text = useMemo(() => buildSummary(items, { base, target, includeAgent }), [items, base, target, includeAgent]);
  const open = items.filter((i) => !i.thread.resolved).length;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const el = document.querySelector<HTMLTextAreaElement>('.summary-text');
      el?.select();
      document.execCommand('copy');
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Review summary">
        <div className="modal-head">
          <h2>Review summary</h2>
          <span className="muted">
            {open} unresolved thread{open === 1 ? '' : 's'}, ready to paste into another agent
          </span>
          <span className="spacer" />
          <button className="icon-btn" onClick={onClose} title="Close">
            ✕
          </button>
        </div>
        <textarea className="summary-text" readOnly value={text} spellCheck={false} />
        <div className="modal-foot">
          <label className="check">
            <input type="checkbox" checked={includeAgent} onChange={(e) => setIncludeAgent(e.target.checked)} />
            Include Claude's answers
          </label>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Close
          </button>
          <button className="btn primary" onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy to clipboard'}
          </button>
        </div>
      </div>
    </div>
  );
}
