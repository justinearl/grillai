#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../dist/server/index.mjs', import.meta.url));
if (!existsSync(entry)) {
  console.error('grillai is not built yet. Run `npm run build` in the grillai folder first.');
  process.exit(1);
}
// node:sqlite still prints an "experimental" warning on Node 22; it is noise here.
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  if (String(warning).includes('SQLite')) return;
  emitWarning.call(process, warning, ...rest);
};
await import(entry);
