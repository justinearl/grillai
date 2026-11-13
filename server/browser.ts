import { spawn } from 'node:child_process';
import os from 'node:os';

export interface Host {
  platform: NodeJS.Platform;
  /** Linux running inside Windows (WSL): the browser lives on the Windows side. */
  wsl: boolean;
}

export function currentHost(): Host {
  const linux = process.platform === 'linux';
  return {
    platform: process.platform,
    wsl: linux && (!!process.env.WSL_DISTRO_NAME || os.release().toLowerCase().includes('microsoft')),
  };
}

type Command = [file: string, args: string[]];

/** Ways to open a URL in the default browser, best first. */
export function openCommands(url: string, host: Host): Command[] {
  // rundll32 hands the URL to Windows untouched; `start` and explorer.exe both mangle some URLs.
  const windows: string[] = ['url.dll,FileProtocolHandler', url];
  if (host.wsl) {
    return [
      ['rundll32.exe', windows],
      // Windows folders can be left out of PATH (appendWindowsPath=false in wsl.conf).
      ['/mnt/c/Windows/System32/rundll32.exe', windows],
      ['xdg-open', [url]],
    ];
  }
  if (host.platform === 'win32') return [['rundll32.exe', windows]];
  if (host.platform === 'darwin') return [['open', [url]]];
  return [['xdg-open', [url]]];
}

/**
 * Open a URL in the user's default browser. Never throws and never blocks:
 * if nothing works, the URL printed in the terminal is still there to click.
 */
export function openBrowser(url: string, commands: Command[] = openCommands(url, currentHost())): void {
  const [next, ...rest] = commands;
  if (!next) return;
  const child = spawn(next[0], next[1], { stdio: 'ignore', detached: true });
  child.on('error', () => openBrowser(url, rest));
  child.unref();
}
