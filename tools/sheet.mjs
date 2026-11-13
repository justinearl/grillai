// Prints the rows of an Excel file (.xlsx) as text, so the review agent can read
// spreadsheets without unzipping anything to disk. Read-only, no dependencies.
//
//   grillai-sheet <path>            a file on disk
//   grillai-sheet <ref>:<path>      a file on another branch or commit
//   options: --sheet <name>  --from <row>  --rows <count>
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const DEFAULT_ROWS = 500;

/** The files inside a zip archive, by name. */
export function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0xffff; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not an .xlsx file (no zip directory found)');
  const count = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);
  if (pos === 0xffffffff) throw new Error('zip64 archives are not supported');
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) throw new Error('corrupt zip directory');
    const method = buf.readUInt16LE(pos + 10);
    const size = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const local = buf.readUInt32LE(pos + 42);
    const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen);
    entries.set(name, () => {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data);
      throw new Error(`unsupported zip compression (${method}) for ${name}`);
    });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decode(s) {
  return s
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
      if (e[0] !== '#') return ENTITIES[e] ?? m;
      return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    })
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function attr(tag, name) {
  const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(tag);
  return m ? decode(m[1]) : null;
}

/** All the text in a string item, without phonetic hints. */
function richText(xml) {
  let out = '';
  for (const m of xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g)) {
    out += decode(m[1] ?? '');
  }
  return out;
}

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

/** For each cell style, whether its number format shows a date or time. */
function dateStyles(xml) {
  if (!xml) return [];
  const custom = new Map();
  for (const m of xml.matchAll(/<numFmt\b([^>]*)>/g)) {
    const code = (attr(m[1], 'formatCode') ?? '').replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
    custom.set(Number(attr(m[1], 'numFmtId')), /[dmyhs]/i.test(code));
  }
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml);
  if (!xfs) return [];
  return [...xfs[1].matchAll(/<xf\b([^>]*)>/g)].map((m) => {
    const id = Number(attr(m[1], 'numFmtId') ?? 0);
    return custom.get(id) ?? BUILTIN_DATE_FORMATS.has(id);
  });
}

const pad = (n, width = 2) => String(n).padStart(width, '0');

/** An Excel date serial as text: a date, a date and time, or just a time. */
function serialToText(serial, date1904) {
  const d = new Date(Math.round((serial - (date1904 ? 24107 : 25569)) * 86400) * 1000);
  const date = `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  if (serial < 1) return time;
  return time === '00:00:00' ? date : `${date} ${time}`;
}

function columnIndex(ref) {
  let n = 0;
  for (const ch of ref) {
    if (ch < 'A' || ch > 'Z') break;
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1;
}

function parseSheet(xml, strings, isDate, date1904) {
  const rows = [];
  let rowNo = 0;
  let hasDates = false;
  for (const r of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    rowNo = Number(attr(r[1], 'r')) || rowNo + 1;
    const cells = [];
    let col = -1;
    for (const c of (r[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attr(c[1], 'r');
      col = ref ? columnIndex(ref) : col + 1;
      const body = c[2] ?? '';
      const type = attr(c[1], 't');
      const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body);
      const raw = v ? decode(v[1]) : '';
      let text = raw;
      if (type === 's') text = strings[Number(raw)] ?? '';
      else if (type === 'inlineStr') text = richText(body);
      else if (type === 'b') text = raw === '1' ? 'TRUE' : 'FALSE';
      else if (!type || type === 'n') {
        if (raw !== '' && isDate[Number(attr(c[1], 's') ?? 0)] && Number.isFinite(Number(raw))) {
          text = serialToText(Number(raw), date1904);
          hasDates = true;
        }
      }
      if (text !== '') cells[col] = text;
    }
    rows.push({ number: rowNo, cells: Array.from(cells, (x) => x ?? '') });
  }
  return { rows, hasDates };
}

/** Every sheet of a workbook as rows of cell text. */
export function readWorkbook(buf) {
  const zip = unzip(buf);
  const text = (name) => (zip.has(name) ? zip.get(name)().toString('utf8') : null);
  const workbook = text('xl/workbook.xml');
  if (!workbook) throw new Error('not an .xlsx file (no workbook inside)');

  const targets = new Map();
  for (const m of (text('xl/_rels/workbook.xml.rels') ?? '').matchAll(/<Relationship\b([^>]*)>/g)) {
    const target = attr(m[1], 'Target') ?? '';
    targets.set(attr(m[1], 'Id'), target.startsWith('/') ? target.slice(1) : `xl/${target}`);
  }
  const strings = [...(text('xl/sharedStrings.xml') ?? '').matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)].map((m) =>
    richText(m[1] ?? ''),
  );
  const isDate = dateStyles(text('xl/styles.xml'));
  const date1904 = /<workbookPr\b[^>]*\bdate1904="(1|true)"/.test(workbook);

  const sheets = [];
  for (const m of workbook.matchAll(/<sheet\b([^>]*)>/g)) {
    const xml = text(targets.get(attr(m[1], 'r:id')) ?? '');
    if (xml == null) continue;
    sheets.push({ name: attr(m[1], 'name') ?? '', ...parseSheet(xml, strings, isDate, date1904) });
  }
  return sheets;
}

/** One line per row: the row number, then the cells separated by tabs. */
export function formatSheets(sheets, { sheet = null, from = 1, rows = DEFAULT_ROWS } = {}) {
  const picked = sheet == null ? sheets : sheets.filter((s) => s.name === sheet);
  if (picked.length === 0) {
    throw new Error(`no sheet named "${sheet}". Sheets: ${sheets.map((s) => s.name).join(', ')}`);
  }
  const out = [];
  for (const s of picked) {
    const last = s.rows.length > 0 ? s.rows[s.rows.length - 1].number : 0;
    out.push(`## Sheet "${s.name}" (last row ${last})`);
    const wanted = s.rows.filter((r) => r.number >= from);
    for (const r of wanted.slice(0, rows)) {
      const cells = r.cells.map((c) => c.replace(/\t/g, ' ').replace(/\r?\n/g, '\\n'));
      out.push(cells.length > 0 ? `${r.number}\t${cells.join('\t')}` : `${r.number}\t(blank row)`);
    }
    if (wanted.length > rows) {
      out.push(`... ${wanted.length - rows} more rows. Continue with --from ${wanted[rows].number}`);
    }
    if (s.hasDates) {
      out.push('(Values like 2026-01-31 or 2026-01-31 10:30:00 are real date cells, shown in that form whatever format the file displays them in. Other dates are plain text.)');
    }
    out.push('');
  }
  return out.join('\n');
}

function load(target) {
  if (existsSync(target)) return readFileSync(target);
  if (!target.includes(':')) throw new Error(`no such file: ${target}`);
  try {
    return execFileSync('git', ['show', target], { maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    throw new Error(String(err.stderr || err.message).trim());
  }
}

function main(argv) {
  const opts = {};
  let target = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sheet') opts.sheet = argv[++i];
    else if (a === '--from' || a === '--rows') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) throw new Error(`${a} needs a whole number above 0`);
      opts[a.slice(2)] = n;
    } else if (a.startsWith('-') || target != null) {
      throw new Error('Usage: grillai-sheet <path | ref:path> [--sheet <name>] [--from <row>] [--rows <count>]');
    } else target = a;
  }
  if (target == null) throw new Error('Usage: grillai-sheet <path | ref:path> [--sheet <name>] [--from <row>] [--rows <count>]');
  process.stdout.write(formatSheets(readWorkbook(load(target)), opts));
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`grillai-sheet: ${err.message}`);
    process.exit(1);
  }
}
