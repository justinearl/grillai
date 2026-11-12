import hljs from 'highlight.js/lib/common';

const EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin',
  swift: 'swift', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php',
  sh: 'bash', bash: 'bash', zsh: 'bash', sql: 'sql', json: 'json', yml: 'yaml', yaml: 'yaml',
  toml: 'ini', ini: 'ini', md: 'markdown', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml',
  css: 'css', scss: 'scss', less: 'less', lua: 'lua', r: 'r', pl: 'perl', m: 'objectivec',
  graphql: 'graphql', gql: 'graphql', diff: 'diff', patch: 'diff',
};
const NAMES: Record<string, string> = { Dockerfile: 'bash', Makefile: 'makefile', Gemfile: 'ruby', Rakefile: 'ruby' };

export function languageOf(path: string): string | null {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const lang = NAMES[name] ?? EXT[name.slice(name.lastIndexOf('.') + 1).toLowerCase()];
  return lang && hljs.getLanguage(lang) ? lang : null;
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Highlighted HTML for one line of code. Lines are highlighted on their own, which is fast and close enough. */
export function highlightLine(content: string, lang: string | null): string {
  if (!lang || content.length > 2000) return escapeHtml(content);
  try {
    return hljs.highlight(content, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(content);
  }
}
