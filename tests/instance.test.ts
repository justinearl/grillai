import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { findInstance, listenOnFirstFree, portsFrom } from '../server/instance';

const servers: http.Server[] = [];
afterAll(() => servers.forEach((s) => s.close()));

/** A server on a free port that answers every request with this body. */
async function serve(body: string, status = 200): Promise<number> {
  const server = http.createServer((_req, res) => res.writeHead(status, { 'content-type': 'application/json' }).end(body));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

describe('findInstance', () => {
  it('finds the grillai that is reviewing the repo', async () => {
    const other = await serve(JSON.stringify({ path: '/code/other', name: 'other' }));
    const mine = await serve(JSON.stringify({ path: '/code/mine', name: 'mine' }));
    expect(await findInstance('/code/mine', [other, mine])).toBe(mine);
    expect(await findInstance('/code/nobody', [other, mine])).toBeNull();
  });

  it('ignores free ports and servers that are not grillai', async () => {
    const html = await serve('<html>hello</html>');
    const failing = await serve(JSON.stringify({ path: '/code/mine' }), 500);
    const free = await serve('{}');
    servers.pop()!.close();
    expect(await findInstance('/code/mine', [html, failing, free])).toBeNull();
  });
});

describe('listenOnFirstFree', () => {
  it('skips ports that are taken', async () => {
    const taken = await serve('{}');
    const { server, port } = await listenOnFirstFree((_req, res) => res.end('ok'), portsFrom(taken));
    servers.push(server);
    expect(port).toBeGreaterThan(taken);
    expect(port).toBeLessThan(taken + 20);
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe('ok');
  });

  it('fails when the only port allowed is taken', async () => {
    const taken = await serve('{}');
    await expect(listenOnFirstFree(() => {}, [taken])).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });
});
