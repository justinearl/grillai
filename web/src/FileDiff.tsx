import { Fragment, memo, useMemo, useState } from 'react';
import { rangeLabel } from '../../shared/anchor';
import { EXPAND_STEP } from '../../shared/expand';
import type { DiffFile, DiffLine, Gap, Thread } from '../../shared/types';
import { highlightLine, languageOf } from './highlight';
import { Composer, ThreadView, type ThreadActions } from './ThreadView';

export interface Range {
  start: number;
  end: number;
}

export interface FileThreads {
  /** Threads by the flat index of the last line they cover. */
  anchored: Map<number, Thread[]>;
  stale: Thread[];
}

interface Props {
  file: DiffFile;
  flat: DiffLine[];
  mode: 'inline' | 'split';
  collapsed: boolean;
  viewed: boolean;
  threads: FileThreads | undefined;
  /** Lines being dragged over or commented on. */
  selection: Range | null;
  /** Range with an open "new thread" form. */
  draft: Range | null;
  actions: ThreadActions;
  onToggleCollapse: (path: string) => void;
  onToggleViewed: (file: DiffFile, viewed: boolean) => void;
  onDragStart: (path: string, idx: number, extend: boolean) => void;
  onDragOver: (path: string, idx: number) => void;
  onDraftSubmit: (body: string, ask: boolean) => Promise<void>;
  onDraftCancel: () => void;
  /** Reveal hidden lines: all of the gap, its first lines ("top") or its last ("bottom"). */
  onExpand: (file: DiffFile, gap: Gap, how: 'all' | 'top' | 'bottom') => void;
}

const SIGN = { insert: '+', delete: '-', context: ' ' } as const;

interface SplitRow {
  left: number | null;
  right: number | null;
}

/** Pair each run of deletions with the insertions that follow it, as GitLab's side-by-side view does. */
function splitRows(lines: DiffLine[], offset: number): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].type === 'context') {
      rows.push({ left: offset + i, right: offset + i });
      i++;
      continue;
    }
    const dels: number[] = [];
    const ins: number[] = [];
    while (i < lines.length && lines[i].type === 'delete') dels.push(offset + i++);
    while (i < lines.length && lines[i].type === 'insert') ins.push(offset + i++);
    for (let k = 0; k < Math.max(dels.length, ins.length); k++) {
      rows.push({ left: dels[k] ?? null, right: ins[k] ?? null });
    }
  }
  return rows;
}

export const FileDiff = memo(function FileDiff(props: Props) {
  const { file, flat, mode, collapsed, viewed, threads, selection, draft, actions } = props;
  const lang = useMemo(() => languageOf(file.path), [file.path]);
  const html = useMemo(
    () => (collapsed ? [] : flat.map((l) => highlightLine(l.content, lang))),
    [flat, lang, collapsed],
  );
  // Hovering a thread lights up the lines it is about.
  const [hovered, setHovered] = useState<(Range & { id: number }) | null>(null);
  const hover =
    hovered && threads?.anchored.get(hovered.end)?.some((t) => t.id === hovered.id) ? hovered : null;
  const inRange = (idx: number | null) =>
    idx != null &&
    ((hover && idx >= hover.start && idx <= hover.end) ||
      (selection && idx >= selection.start && idx <= selection.end) ||
      (draft && idx >= draft.start && idx <= draft.end));

  const cols = mode === 'inline' ? 3 : 4;

  const extras = (indexes: (number | null)[]) => {
    const out: JSX.Element[] = [];
    for (const idx of indexes) {
      if (idx == null) continue;
      const list = threads?.anchored.get(idx);
      if (list) {
        out.push(
          <tr key={`t${idx}`} className="thread-row">
            <td colSpan={cols}>
              {list.map((t) => (
                <div
                  key={t.id}
                  className="thread-slot"
                  onMouseEnter={() => setHovered({ id: t.id, start: idx - t.lines.length + 1, end: idx })}
                  onMouseLeave={() => setHovered((h) => (h?.id === t.id ? null : h))}
                >
                  <ThreadView thread={t} stale={false} actions={actions} />
                </div>
              ))}
            </td>
          </tr>,
        );
      }
      if (draft && draft.end === idx) {
        out.push(
          <tr key="draft" className="thread-row">
            <td colSpan={cols}>
              <div className="thread draft">
                <div className="draft-title">
                  New thread on {rangeLabel(flat.slice(draft.start, draft.end + 1))}
                </div>
                <Composer
                  placeholder="Ask about these lines, or leave a note…"
                  autoFocus
                  onSubmit={props.onDraftSubmit}
                  onCancel={props.onDraftCancel}
                />
              </div>
            </td>
          </tr>,
        );
      }
    }
    return out;
  };

  const expander = (gap: Gap, header: string, tail: boolean, key: string) => {
    const count = gap.to == null ? null : gap.to - gap.from + 1;
    const big = count == null || count > EXPAND_STEP;
    return (
      <tr className="hunk expander" key={key}>
        <td colSpan={cols}>
          <div className="expander-inner">
            {big && gap.from > 1 && (
              <button title="Show lines below the code above" onClick={() => props.onExpand(file, gap, 'top')}>
                ↓ {EXPAND_STEP} lines
              </button>
            )}
            <button onClick={() => props.onExpand(file, gap, 'all')}>
              {count == null
                ? 'Show all lines to the end'
                : `Show ${big ? 'all ' : ''}${count} hidden line${count === 1 ? '' : 's'}`}
            </button>
            {big && !tail && (
              <button title="Show lines above the code below" onClick={() => props.onExpand(file, gap, 'bottom')}>
                ↑ {EXPAND_STEP} lines
              </button>
            )}
            {header && <span className="hunk-header">{header}</span>}
          </div>
        </td>
      </tr>
    );
  };
  const tail = file.tailGap ? expander(file.tailGap, '', true, 'tail') : null;

  const gutter = (idx: number, no: number | null, withButton: boolean) => (
    <td
      className="num"
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        props.onDragStart(file.path, idx, e.shiftKey);
      }}
    >
      {withButton && (
        <span className="add-comment" title="Start a thread (drag for several lines)">
          +
        </span>
      )}
      {no ?? ''}
    </td>
  );

  const code = (idx: number, l: DiffLine) => (
    <td className="code">
      <span className="sign">{SIGN[l.type]}</span>
      <span dangerouslySetInnerHTML={{ __html: html[idx] || '&nbsp;' }} />
    </td>
  );

  const renderInline = () => {
    let offset = 0;
    return file.hunks.map((hunk, h) => {
      const start = offset;
      offset += hunk.lines.length;
      return (
        <Fragment key={h}>
          {hunk.gapBefore && expander(hunk.gapBefore, hunk.header, false, 'gap')}
          {hunk.lines.map((l, i) => {
            const idx = start + i;
            return (
              <Fragment key={idx}>
                <tr
                  className={`line ${l.type} ${inRange(idx) ? 'sel' : ''}`}
                  onMouseEnter={() => props.onDragOver(file.path, idx)}
                >
                  {gutter(idx, l.oldNo, true)}
                  {gutter(idx, l.newNo, false)}
                  {code(idx, l)}
                </tr>
                {extras([idx])}
              </Fragment>
            );
          })}
        </Fragment>
      );
    });
  };

  const renderSplit = () => {
    let offset = 0;
    return file.hunks.map((hunk, h) => {
      const rows = splitRows(hunk.lines, offset);
      offset += hunk.lines.length;
      const side = (idx: number | null, which: 'left' | 'right') => {
        if (idx == null) {
          return (
            <>
              <td className="num empty" />
              <td className="code empty" />
            </>
          );
        }
        const l = flat[idx];
        const cls = `${l.type} ${inRange(idx) ? 'sel' : ''}`;
        const g = gutter(idx, which === 'left' ? l.oldNo : l.newNo, true);
        const c = code(idx, l);
        return (
          <>
            <td {...g.props} className={`num ${cls}`} onMouseEnter={() => props.onDragOver(file.path, idx)} />
            <td {...c.props} className={`code ${cls}`} onMouseEnter={() => props.onDragOver(file.path, idx)} />
          </>
        );
      };
      return (
        <Fragment key={h}>
          {hunk.gapBefore && expander(hunk.gapBefore, hunk.header, false, 'gap')}
          {rows.map((row, r) => (
            <Fragment key={r}>
              <tr className="line split-line">
                {side(row.left, 'left')}
                {side(row.right, 'right')}
              </tr>
              {extras(row.left === row.right ? [row.left] : [row.left, row.right])}
            </Fragment>
          ))}
        </Fragment>
      );
    });
  };

  const note = file.binary
    ? 'Binary file, not shown.'
    : file.tooBig
      ? 'This diff is too large to show.'
      : file.hunks.length === 0
        ? file.status === 'renamed'
          ? 'File renamed without changes.'
          : 'No text changes (empty file or mode change).'
        : null;

  return (
    <section className="file" id={`file-${file.path}`}>
      <header className="file-head">
        <button className="icon-btn" onClick={() => props.onToggleCollapse(file.path)} title={collapsed ? 'Expand' : 'Collapse'}>
          <span className={`chevron ${collapsed ? '' : 'open'}`}>›</span>
        </button>
        <span className="file-path">
          {file.oldPath && <span className="old-path">{file.oldPath} → </span>}
          {file.path}
        </span>
        {file.status !== 'modified' && <span className={`badge status-${file.status}`}>{file.status}</span>}
        <button className="icon-btn copy" title="Copy file path" onClick={() => void navigator.clipboard?.writeText(file.path)}>
          ⧉
        </button>
        <span className="spacer" />
        <span className="file-stats">
          <span className="add">+{file.added}</span> <span className="del">−{file.deleted}</span>
        </span>
        <label className="viewed">
          <input type="checkbox" checked={viewed} onChange={(e) => props.onToggleViewed(file, e.target.checked)} />
          Viewed
        </label>
      </header>
      {!collapsed && (
        <div className="file-body">
          {threads && threads.stale.length > 0 && (
            <div className="stale-threads">
              {threads.stale.map((t) => (
                <ThreadView key={t.id} thread={t} stale actions={actions} />
              ))}
            </div>
          )}
          {note ? (
            <div className="file-note">{note}</div>
          ) : (
            <div className="diff-scroll">
              <table className={`diff ${mode}`}>
                {mode === 'inline' ? (
                  <colgroup>
                    <col className="col-num" />
                    <col className="col-num" />
                    <col />
                  </colgroup>
                ) : (
                  <colgroup>
                    <col className="col-num" />
                    <col className="col-half" />
                    <col className="col-num" />
                    <col className="col-half" />
                  </colgroup>
                )}
                <tbody>
                  {mode === 'inline' ? renderInline() : renderSplit()}
                  {tail}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  );
});
