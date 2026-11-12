import { memo, useMemo, useState } from 'react';
import type { DiffFile } from '../../shared/types';

interface Node {
  name: string;
  path: string;
  file?: DiffFile;
  children: Node[];
}

function buildTree(files: DiffFile[]): Node[] {
  const root: Node = { name: '', path: '', children: [] };
  for (const file of files) {
    const parts = file.path.split('/');
    let node = root;
    parts.forEach((part, i) => {
      const p = parts.slice(0, i + 1).join('/');
      let child = node.children.find((c) => c.path === p && !c.file === i < parts.length - 1);
      if (!child) {
        child = { name: part, path: p, children: [] };
        if (i === parts.length - 1) child.file = file;
        node.children.push(child);
      }
      node = child;
    });
  }
  // GitLab-style: fold chains of single-child directories into one row.
  const fold = (n: Node): Node => {
    let cur = n;
    while (!cur.file && cur.children.length === 1 && !cur.children[0].file) {
      const only = cur.children[0];
      cur = { name: `${cur.name}/${only.name}`, path: only.path, children: only.children };
    }
    cur.children = cur.children
      .map(fold)
      .sort((a, b) => Number(!!a.file) - Number(!!b.file) || a.name.localeCompare(b.name));
    return cur;
  };
  return fold({ ...root, name: '' }).children;
}

interface Props {
  files: DiffFile[];
  viewed: Set<string>;
  threadCounts: Map<string, number>;
  onSelect: (path: string) => void;
}

export const FileTree = memo(function FileTree({ files, viewed, threadCounts, onSelect }: Props) {
  const [filter, setFilter] = useState('');
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const tree = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return buildTree(q ? files.filter((f) => f.path.toLowerCase().includes(q)) : files);
  }, [files, filter]);

  const render = (node: Node, depth: number): JSX.Element => {
    const pad = { paddingLeft: 8 + depth * 14 };
    if (node.file) {
      const f = node.file;
      const count = threadCounts.get(f.path) ?? 0;
      return (
        <button
          key={'f:' + node.path}
          className={`tree-row tree-file ${viewed.has(f.path) ? 'is-viewed' : ''}`}
          style={pad}
          title={f.path}
          onClick={() => onSelect(f.path)}
        >
          <span className={`status-dot status-${f.status}`} />
          <span className="tree-name">{node.name}</span>
          {count > 0 && <span className="tree-threads" title={`${count} unresolved`}>{count}</span>}
          <span className="tree-stats">
            {f.added > 0 && <span className="add">+{f.added}</span>}
            {f.deleted > 0 && <span className="del">−{f.deleted}</span>}
          </span>
        </button>
      );
    }
    const isClosed = closed.has(node.path);
    return (
      <div key={'d:' + node.path}>
        <button
          className="tree-row tree-dir"
          style={pad}
          onClick={() =>
            setClosed((s) => {
              const n = new Set(s);
              n.has(node.path) ? n.delete(node.path) : n.add(node.path);
              return n;
            })
          }
        >
          <span className={`chevron ${isClosed ? '' : 'open'}`}>›</span>
          <span className="tree-name">{node.name}</span>
        </button>
        {!isClosed && node.children.map((c) => render(c, depth + 1))}
      </div>
    );
  };

  return (
    <aside className="tree">
      <input
        className="tree-filter"
        placeholder="Filter files"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div className="tree-list">
        {tree.map((n) => render(n, 0))}
        {tree.length === 0 && <div className="tree-empty">No files</div>}
      </div>
    </aside>
  );
});
