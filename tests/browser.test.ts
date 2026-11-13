import { describe, expect, it } from 'vitest';
import { openBrowser, openCommands } from '../server/browser';

const url = 'http://localhost:4477';

describe('openCommands', () => {
  it('uses the Windows browser under WSL, with fallbacks', () => {
    const cmds = openCommands(url, { platform: 'linux', wsl: true });
    expect(cmds[0]).toEqual(['rundll32.exe', ['url.dll,FileProtocolHandler', url]]);
    expect(cmds[1][0]).toBe('/mnt/c/Windows/System32/rundll32.exe');
    expect(cmds[2]).toEqual(['xdg-open', [url]]);
  });

  it('uses the native opener elsewhere', () => {
    expect(openCommands(url, { platform: 'linux', wsl: false })).toEqual([['xdg-open', [url]]]);
    expect(openCommands(url, { platform: 'darwin', wsl: false })).toEqual([['open', [url]]]);
    expect(openCommands(url, { platform: 'win32', wsl: false })[0][0]).toBe('rundll32.exe');
  });
});

describe('openBrowser', () => {
  it('moves on to the next command when one is missing, and never throws', async () => {
    const marker = `grillai-open-${process.pid}`;
    openBrowser(url, [
      ['grillai-no-such-command', [url]],
      [process.execPath, ['-e', `require('fs').writeFileSync(require('os').tmpdir() + '/${marker}', process.argv[1])`, url]],
    ]);
    const { existsSync, readFileSync, rmSync } = await import('node:fs');
    const file = (await import('node:os')).tmpdir() + '/' + marker;
    for (let i = 0; i < 100 && !existsSync(file); i++) await new Promise((r) => setTimeout(r, 50));
    expect(readFileSync(file, 'utf8')).toBe(url);
    rmSync(file);
    expect(() => openBrowser(url, [['grillai-no-such-command', []]])).not.toThrow();
  });
});
