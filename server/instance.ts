import http from 'node:http';

/** How many ports above the first one grillai will try or search. */
export const PORT_SPAN = 20;

export const portsFrom = (first: number): number[] => Array.from({ length: PORT_SPAN }, (_, i) => first + i);

/** The repo a grillai on this port is reviewing, or null if nothing (or something else) is there. */
async function repoOn(port: number): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/repo`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { path?: unknown };
    return typeof body.path === 'string' ? body.path : null;
  } catch {
    return null;
  }
}

/** The port of a grillai that is already reviewing this repo, if one is running. */
export async function findInstance(repo: string, ports: number[]): Promise<number | null> {
  const found = await Promise.all(ports.map(async (port) => ((await repoOn(port)) === repo ? port : null)));
  return found.find((port) => port != null) ?? null;
}

function listenOn(handler: http.RequestListener, port: number): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

/** Listen on the first free port of the list. Fails with the last port's error when all are taken. */
export async function listenOnFirstFree(
  handler: http.RequestListener,
  ports: number[],
): Promise<{ server: http.Server; port: number }> {
  let lastError: unknown = new Error('No port to listen on');
  for (const port of ports) {
    try {
      return { server: await listenOn(handler, port), port };
    } catch (err) {
      lastError = err;
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') break;
    }
  }
  throw lastError;
}
