import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const tool = path.resolve(__dirname, '../tools/grillai-sheet');
const fixture = path.resolve(__dirname, 'fixtures/sample.xlsx');
const sheet = (args: string[], cwd?: string) => execFileSync(tool, args, { cwd, encoding: 'utf8' });

const temp: string[] = [];
afterAll(() => temp.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe('grillai-sheet', () => {
  it('prints every sheet, one row per line', () => {
    const out = sheet([fixture]).split('\n');
    expect(out[0]).toBe('## Sheet "Payins" (last row 6)');
    expect(out[1]).toBe('1\tProduct\tRemit Value\tReference\tDate');
    expect(out).toContain('## Sheet "Notes & more" (last row 3)');
  });

  it('keeps blank rows, gaps and empty leading cells visible', () => {
    const out = sheet([fixture, '--sheet', 'Payins']).split('\n');
    expect(out[2]).toBe('2\t(blank row)');
    // row 5 does not exist in the file; the totals row has no Product
    expect(out[5]).toBe('6\t\t3.5\tTRUE');
  });

  it('reads shared, rich and inline strings, and shows date cells as dates', () => {
    const out = sheet([fixture, '--sheet', 'Payins']).split('\n');
    expect(out[3]).toBe('3\tVoucher\t1\t20260917103436\t2026-09-17 10:34:00');
    // 2.5 has a custom number format that is not a date
    expect(out[4]).toBe('4\tTom & Jerry\t2.5\t\t2026-09-17');
  });

  it('pages through rows and keeps each row on one line', () => {
    const out = sheet([fixture, '--sheet', 'Notes & more', '--from', '2', '--rows', '1']).split('\n');
    expect(out[1]).toBe('2\ttwo\\nlines');
    expect(out[2]).toBe('... 1 more rows. Continue with --from 3');
    expect(sheet([fixture, '--sheet', 'Notes & more'])).toContain('1\ta b\t7');
  });

  it('reads a file from another commit without touching the working tree', () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), 'grillai-sheet-'));
    temp.push(repo);
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: repo });
    git('init', '-q', '-b', 'main');
    copyFileSync(fixture, path.join(repo, 'data.xlsx'));
    git('add', '-A');
    git('commit', '-qm', 'add sheet');
    git('rm', '-q', 'data.xlsx');
    git('commit', '-qm', 'remove sheet');
    expect(sheet(['HEAD~1:data.xlsx'], repo)).toContain('3\tVoucher\t1\t20260917103436');
  });

  it('fails with a clear message on bad input', () => {
    const run = (...args: string[]) => spawnSync(tool, args, { encoding: 'utf8' });
    expect(run('missing.xlsx')).toMatchObject({ status: 1, stderr: 'grillai-sheet: no such file: missing.xlsx\n' });
    expect(run(path.resolve(__dirname, '../package.json')).stderr).toContain('not an .xlsx file');
    expect(run(fixture, '--sheet', 'Nope').stderr).toContain('Sheets: Payins, Notes & more');
    expect(run('--output', 'x').status).toBe(1);
  });
});
