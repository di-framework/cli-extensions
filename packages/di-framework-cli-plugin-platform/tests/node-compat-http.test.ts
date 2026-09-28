import { afterEach, describe, expect, it, mock } from 'bun:test';
import { createHash as nodeCreateHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_DEPS } from '../src/deps';
import {
  CHUNKED_END,
  ChunkedDecoder,
  concatChunks,
  encodeChunk,
  headerValue,
  indexOfHeaderEnd,
  parseHttpHeaders,
  parseHttpRequest,
  parseHttpResponse,
  serializeHeaders,
  serializeHttpResponse,
} from '../src/node-compat/http-parser';
import * as clock from './memory-wasi-clocks';
import { getRandomBytes, resetMemoryRandom } from './memory-wasi-random';
import {
  nameRecords,
  resetMemorySockets,
  resolveAddresses,
  TcpSocket,
  UdpSocket,
} from './memory-wasi-sockets';

mock.module('wasi:clocks/monotonic-clock@0.3.0', () => clock);

mock.module('wasi:sockets/types@0.3.0', () => ({ TcpSocket, UdpSocket }));
mock.module('wasi:sockets/ip-name-lookup@0.3.0', () => ({ resolveAddresses }));
mock.module('wasi:random/random@0.3.0', () => ({ getRandomBytes }));

const { createConnection, createServer: createNetServer } = await import('../src/node-compat/net');
const { Agent, METHODS, STATUS_CODES, createServer, get, globalAgent, maxHeaderSize, request } =
  await import('../src/node-compat/http');

afterEach(() => {
  resetMemorySockets();
  resetMemoryRandom();
  nameRecords.clear();
});

describe('node:http overlay', () => {
  it('frames explicitly chunked client bodies, including empty bodies, exactly once', async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      expect(req.headers['content-length']).toBeUndefined();
      const chunks: Uint8Array[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        seen.push(body);
        res.end(body);
      });
    });
    server.listen(0, '127.0.0.1');
    try {
      for (const body of ['hello wasm', '']) {
        const received = await new Promise<string>((resolve, reject) => {
          const req = request(
            {
              host: '127.0.0.1',
              port: server.address()?.port,
              method: 'POST',
              headers: { 'transfer-encoding': 'chunked', 'content-length': '999' },
            },
            (res) => {
              const chunks: Uint8Array[] = [];
              res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
              res.on('end', () => resolve(Buffer.concat(chunks).toString()));
            },
          );
          req.on('error', reject);
          req.write('');
          req.write(body.slice(0, 3));
          req.end(body.slice(3));
          req.flush();
        });
        expect(received).toBe(body);
      }
      expect(seen).toEqual(['hello wasm', '']);
    } finally {
      server.close();
    }
  });
  it('decodes chunk extensions and trailers at every split, preserving following messages', () => {
    const wire = Buffer.from('3;foo=bar\r\nabc\r\n2\r\nde\r\n0\r\nX-Trailer: yes\r\n\r\n');
    for (let split = 0; split < wire.length; split++) {
      const decoder = new ChunkedDecoder();
      const chunks: Uint8Array[] = [];
      const push = (bytes: Uint8Array) => chunks.push(bytes);
      expect(decoder.write(wire.subarray(0, split), push)).toBeUndefined();
      const rest = decoder.write(Buffer.concat([wire.subarray(split), Buffer.from('NEXT')]), push);
      expect(Buffer.concat(chunks).toString()).toBe('abcde');
      expect(Buffer.from(rest ?? []).toString()).toBe('NEXT');
    }
    for (const invalid of [
      'z\r\n',
      '1\r\naXX',
      'ffffffffffffffff\r\n',
      'a'.repeat(16385),
      `${'a'.repeat(16385)}\r\n`,
    ]) {
      expect(() => new ChunkedDecoder().write(Buffer.from(invalid), () => {})).toThrow();
    }
  });

  it('reads streamed responses from the HTTP overlay', async () => {
    const server = createServer((_req, res) => {
      res.write('hello');
      res.end(' world');
    });
    server.listen(0, '127.0.0.1');
    const body = await new Promise<string>((resolve, reject) => {
      get({ host: '127.0.0.1', port: server.address()?.port }, (res) => {
        const chunks: Uint8Array[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => resolve(Buffer.concat(chunks).toString()));
      }).on('error', reject);
    });
    expect(body).toBe('hello world');
    server.close();
  });

  it('rejects malformed chunked bodies on both sides of a connection', async () => {
    const server = createServer();
    server.listen(0, '127.0.0.1');
    const serverError = new Promise<Error>((resolve) => server.once('error', resolve));
    const socket = createConnection({ host: '127.0.0.1', port: server.address()?.port ?? 0 });
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    socket.write('POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\nz\r\n');
    expect((await serverError).message).toBe('Invalid chunk size');
    socket.destroy();
    server.close();

    const rawServer = createNetServer((peer) => {
      peer.once('data', () =>
        peer.write('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nz\r\n'),
      );
    });
    rawServer.listen(0, '127.0.0.1');
    const error = await new Promise<Error>((resolve) => {
      get({ host: '127.0.0.1', port: rawServer.address()?.port }).once('error', resolve);
    });
    expect(error.message).toBe('Invalid chunk size');
    rawServer.close();
  });

  it('reads fragmented chunked requests and preserves a following request', async () => {
    const received: string[] = [];
    let done!: () => void;
    const complete = new Promise<void>((resolve) => {
      done = resolve;
    });
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += Buffer.from(chunk).toString();
      });
      req.on('end', () => {
        received.push(body);
        res.end('ok');
        if (received.length === 2) done();
      });
    });
    server.listen(0, '127.0.0.1');
    const socket = createConnection({ host: '127.0.0.1', port: server.address()?.port ?? 0 });
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    socket.write('POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\nContent-Length: 0\r\n\r\n3\r');
    await new Promise((resolve) => setTimeout(resolve, 0));
    socket.write('\nabc\r\n0\r\nTrailer: value\r\n\r\nGET / HTTP/1.1\r\n\r\n');
    await complete;
    expect(received).toEqual(['abc', '']);
    socket.destroy();
    server.close();
  });

  it('serves GET and POST over the TCP overlay and reports address() after listen', async () => {
    const server = createServer((req, res) => {
      if (req.method === 'GET') {
        res.statusCode = 200;
        res.end('hello');
        return;
      }
      const chunks: Uint8Array[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        res.statusCode = 200;
        res.end(Buffer.concat(chunks));
      });
    });
    server.listen(0, '127.0.0.1');
    const info = server.address();
    expect(info).not.toBeNull();
    const port = info?.port ?? 0;
    expect(port).toBeGreaterThan(0);

    const getBody = await new Promise<string>((resolve, reject) => {
      const req = get({ host: '127.0.0.1', port, path: '/' }, (res) => {
        const chunks: Uint8Array[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => resolve(Buffer.concat(chunks).toString()));
      });
      req.once('error', reject);
    });
    expect(getBody).toBe('hello');

    const postBody = await new Promise<string>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/', method: 'POST' }, (res) => {
        const chunks: Uint8Array[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => resolve(Buffer.concat(chunks).toString()));
      });
      req.once('error', reject);
      req.end('payload');
    });
    expect(postBody).toBe('payload');
    expect(STATUS_CODES[426]).toBe('Upgrade Required');
    server.close();
  });

  it('emits upgrade with leftover head bytes', async () => {
    const server = createServer((_req, res) => {
      res.statusCode = 404;
      res.end('Not found');
    });
    server.listen(0, '127.0.0.1');
    const port = server.address()?.port ?? 0;
    const upgraded = new Promise<{ url: string; head: string }>((resolve) => {
      server.on('upgrade', (req, socket, head) => {
        resolve({ url: req.url, head: Buffer.from(head).toString() });
        socket.end();
      });
    });
    const client = createConnection({ host: '127.0.0.1', port });
    await new Promise<void>((resolve, reject) => {
      client.once('connect', () => resolve());
      client.once('error', reject);
    });
    client.write(
      'GET /chat HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nextra',
    );
    expect(await upgraded).toEqual({ url: '/chat', head: 'extra' });
    server.close();
  });

  it('parses a 101 upgrade response on http.request', async () => {
    const raw = createNetServer((socket) => {
      socket.on('data', () => {
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nleftover',
        );
      });
    });
    raw.listen(0, '127.0.0.1');
    const port = raw.address()?.port ?? 0;
    const upgraded = await new Promise<{ status: number; head: string }>((resolve, reject) => {
      const req = request({
        host: '127.0.0.1',
        port,
        path: '/',
        headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
      });
      req.on('upgrade', (res, _socket, head) => {
        resolve({ status: res.statusCode, head: Buffer.from(head).toString() });
      });
      req.once('error', reject);
      req.end();
    });
    expect(upgraded).toEqual({ status: 101, head: 'leftover' });
    raw.close();
  });

  it('covers parser helpers, headers, and chunked encoding', () => {
    expect(concatChunks(new Uint8Array([1]), new Uint8Array([2]))).toEqual(new Uint8Array([1, 2]));
    expect(indexOfHeaderEnd(new Uint8Array([1, 2, 3]))).toBe(-1);
    expect(parseHttpHeaders('')).toEqual({ headers: {}, rawHeaders: [] });
    expect(
      parseHttpHeaders('X-A: 1\r\nX-A: 2\r\nSet-Cookie: a\r\nSet-Cookie: b\r\nbadline'),
    ).toEqual({
      headers: { 'x-a': '1, 2', 'set-cookie': ['a', 'b'] },
      rawHeaders: ['X-A', '1', 'X-A', '2', 'Set-Cookie', 'a', 'Set-Cookie', 'b'],
    });
    expect(() => parseHttpRequest(new TextEncoder().encode('NOTHTTP\r\n\r\n'))).toThrow(
      /Invalid HTTP request line/,
    );
    expect(() => parseHttpResponse(new TextEncoder().encode('NOTHTTP\r\n\r\n'))).toThrow(
      /Invalid HTTP response line/,
    );
    expect(headerValue({ 'set-cookie': ['a', 'b'] }, 'Set-Cookie')).toBe('a, b');
    expect(serializeHeaders({ 'set-cookie': ['a', 'b'], accept: 'text/plain' })).toContain(
      'set-cookie: a',
    );
    expect(new TextDecoder().decode(serializeHttpResponse(204, '', {}))).toContain('204 OK');
    expect(encodeChunk(new Uint8Array([65]))[0]).toBe('1'.charCodeAt(0));
    expect(CHUNKED_END.length).toBeGreaterThan(0);
    expect(METHODS).toContain('GET');
    expect(maxHeaderSize).toBeGreaterThan(0);
    expect(globalAgent).toBeInstanceOf(Agent);
    globalAgent.destroy();
  });

  it('uses writeHead, chunked bodies, timeouts, and URL forms', async () => {
    const server = createServer({}, (req, res) => {
      if (req.url === '/head') {
        res.writeHead(204, 'No Content', { 'X-Empty': '1' });
        res.end();
        return;
      }
      if (req.url === '/headers') {
        res.setHeader('X-A', ['1', '2']);
        expect(res.getHeader('x-a')).toEqual(['1', '2']);
        res.removeHeader('x-a');
        res.setHeader('Content-Length', '7');
        res.writeHead(201, { 'X-B': 'yes' });
        res.end('created');
        return;
      }
      if (req.url === '/chunked') {
        res.write('chunk', 'utf8');
        res.end('end');
        return;
      }
      if (req.url === '/close') {
        res.setHeader('Connection', 'close');
        res.end('bye');
        return;
      }
      if (req.url === '/post') {
        const chunks: Uint8Array[] = [];
        req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        req.on('end', () => res.end(Buffer.concat(chunks)));
        return;
      }
      res.statusCode = 200;
      res.end('ok');
    });
    server.listen(0, '127.0.0.1');
    const port = server.address()?.port ?? 0;
    const read = (url: string, method = 'GET', body?: string) =>
      new Promise<string>((resolve, reject) => {
        const req = request(new URL(url), { method }, (res) => {
          const chunks: Uint8Array[] = [];
          res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          res.on('end', () => resolve(Buffer.concat(chunks).toString()));
        });
        req.once('error', reject);
        if (body !== undefined) req.end(body);
        else req.end();
      });
    expect(await read(`http://127.0.0.1:${port}/`)).toBe('ok');
    expect(await read(`http://127.0.0.1:${port}/headers`)).toBe('created');
    const chunked = createConnection({ host: '127.0.0.1', port });
    const chunkedBody = await new Promise<string>((resolve, reject) => {
      const chunks: string[] = [];
      chunked.once('connect', () => {
        chunked.write('GET /chunked HTTP/1.1\r\nHost: localhost\r\n\r\n');
      });
      chunked.on('data', (chunk) => {
        chunks.push(Buffer.from(chunk).toString());
        if (chunks.join('').includes('0\r\n\r\n')) resolve(chunks.join(''));
      });
      chunked.once('error', reject);
    });
    expect(chunkedBody).toContain('transfer-encoding: chunked');
    expect(chunkedBody).toContain('chunk');
    expect(chunkedBody).toContain('end');
    chunked.end();
    expect(await read(`http://127.0.0.1:${port}/close`)).toBe('bye');
    expect(await read(`http://127.0.0.1:${port}/post`, 'POST', 'xyz')).toBe('xyz');
    const head = await new Promise<number>((resolve, reject) => {
      const req = get(`http://127.0.0.1:${port}/head`, (res) => resolve(res.statusCode));
      req.once('error', reject);
    });
    expect(head).toBe(204);
    const withCallback = await new Promise<string>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port, path: '/', headers: { 'X-Skip': undefined } },
        (res) => {
          const chunks: Uint8Array[] = [];
          res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          res.on('end', () => resolve(Buffer.concat(chunks).toString()));
        },
      );
      req.setHeader('X-Array', ['a', 'b']);
      expect(req.getHeader('x-array')).toEqual(['a', 'b']);
      req.write('ignored-for-get');
      req.once('error', reject);
      req.end(() => undefined);
    });
    expect(withCallback).toBe('ok');
    server.close();
  });

  it('handles split POST bodies, HTTP/1.0, write-after-end, and abort', async () => {
    const server = createServer((req, res) => {
      req.setTimeout(0, () => undefined);
      res.setTimeout(0, () => undefined);
      if (req.httpVersion === '1.0') {
        res.end('v10');
        return;
      }
      const chunks: Uint8Array[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        res.setHeader('Content-Length', '5');
        res.write('hello');
        const after = res.write('x');
        expect(typeof after).toBe('boolean');
        res.end();
        res.end(() => undefined);
        res.write('late', (error) => {
          expect(error?.message).toMatch(/write after end/);
        });
        res.write('late');
      });
    });
    server.listen(0, '127.0.0.1');
    const port = server.address()?.port ?? 0;
    const client = createConnection({ host: '127.0.0.1', port });
    await new Promise<void>((resolve, reject) => {
      client.once('connect', resolve);
      client.once('error', reject);
    });
    const body = await new Promise<string>((resolve) => {
      const chunks: string[] = [];
      client.on('data', (chunk) => {
        chunks.push(Buffer.from(chunk).toString());
        if (chunks.join('').includes('hello')) resolve(chunks.join(''));
      });
      client.write('POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 5\r\n\r\nhe');
      queueMicrotask(() => client.write('llo'));
    });
    expect(body).toContain('hello');
    const v10 = createConnection({ host: '127.0.0.1', port });
    const v10Body = await new Promise<string>((resolve, reject) => {
      const chunks: string[] = [];
      v10.once('connect', () => v10.write('GET / HTTP/1.0\r\nHost: localhost\r\n\r\n'));
      v10.on('data', (chunk) => {
        chunks.push(Buffer.from(chunk).toString());
        if (chunks.join('').includes('v10')) resolve(chunks.join(''));
      });
      v10.once('error', reject);
    });
    expect(v10Body).toContain('v10');
    const aborted = request({ host: '127.0.0.1', port, path: '/' });
    aborted.abort();
    aborted.destroy();
    aborted.setTimeout(1, () => undefined);
    const custom = request({
      host: '127.0.0.1',
      port,
      path: '/',
      createConnection: (options) => {
        return createConnection({ host: String(options.host), port: Number(options.port) });
      },
    });
    const failed = request({
      host: '127.0.0.1',
      port,
      path: '/',
      createConnection: (_options, callback) => {
        callback?.(new Error('connect failed'), undefined as never);
        return undefined as never;
      },
    });
    failed.once('error', () => undefined);
    custom.end();
    await new Promise<void>((resolve) => custom.once('response', () => resolve()));
    const oversized = createConnection({ host: '127.0.0.1', port });
    await new Promise<void>((resolve, reject) => {
      oversized.once('connect', resolve);
      oversized.once('error', reject);
    });
    oversized.write(
      `GET / HTTP/1.1\r\nHost: localhost\r\nX-Big: ${'a'.repeat(maxHeaderSize)}\r\n\r\n`,
    );
    const invalid = createConnection({ host: '127.0.0.1', port });
    await new Promise<void>((resolve, reject) => {
      invalid.once('connect', resolve);
      invalid.once('error', reject);
    });
    server.once('error', () => undefined);
    invalid.write('INVALID\r\n\r\n');
    expect(server.ref()).toBe(server);
    expect(server.unref()).toBe(server);
    server.close();
    v10.end();
    client.end();
  });

  it('destroys upgrades without a listener and parses a split client response', async () => {
    const silent = createServer();
    silent.listen(0, '127.0.0.1');
    const silentPort = silent.address()?.port ?? 0;
    const upgrader = createConnection({ host: '127.0.0.1', port: silentPort });
    await new Promise<void>((resolve, reject) => {
      upgrader.once('connect', resolve);
      upgrader.once('error', reject);
    });
    upgrader.write(
      'GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
    );
    const raw = createNetServer((socket) => {
      socket.once('data', () => {
        socket.write('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhe');
        queueMicrotask(() => socket.write('llo'));
      });
    });
    raw.listen(0, '127.0.0.1');
    const port = raw.address()?.port ?? 0;
    const body = await new Promise<string>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/' }, (res) => {
        const chunks: Uint8Array[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => resolve(Buffer.concat(chunks).toString()));
      });
      req.once('error', reject);
      req.end();
    });
    expect(body).toBe('hello');
    const rawBad = createNetServer((socket) => {
      socket.once('data', () => socket.write('NOTHTTP\r\n\r\n'));
    });
    rawBad.listen(0, '127.0.0.1');
    const badPort = rawBad.address()?.port ?? 0;
    const bad = await new Promise<Error>((resolve) => {
      const req = request({ host: '127.0.0.1', port: badPort, path: '/' });
      req.once('error', resolve);
      req.end();
    });
    expect(bad.message).toMatch(/Invalid HTTP response line/);
    silent.close();
    raw.close();
    rawBad.close();
    upgrader.end();
  });
});

describe('bundled node:http overlay', () => {
  it('keeps wasi:sockets imports external and echoes HTTP in the guest bundle', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wasmcloud-http-bundle-'));
    const adapterPath = join(root, 'adapter.ts');
    const entryPath = join(root, 'entry.ts');
    const outFile = join(root, 'dist', 'component.js');
    writeFileSync(
      adapterPath,
      "import application from 'virtual:di-framework-application';\nexport const handler = application;\n",
    );
    writeFileSync(
      entryPath,
      `
import { createServer, get } from 'node:http';

export default async function echo(): Promise<string> {
  const server = createServer((_req, res) => {
    res.statusCode = 200;
    res.end('ok');
  });
  server.listen(0, '127.0.0.1');
  const port = server.address()?.port ?? 0;
  const body = await new Promise<string>((resolve, reject) => {
    const req = get({ host: '127.0.0.1', port, path: '/' }, (res) => {
      const chunks: Uint8Array[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve(Buffer.concat(chunks).toString()));
    });
    req.once('error', reject);
  });
  server.close();
  return body;
}
`,
    );
    await DEFAULT_DEPS.bundler({ adapterPath, entryPath, outFile });
    const source = await Bun.file(outFile).text();
    expect(source).toContain('wasi:sockets/types@0.3.0');
    expect(source).not.toContain('wasi:random/random@0.3.0');
    const bundled = await import(pathToFileURL(outFile).href);
    expect(await bundled.handler()).toBe('ok');
  });

  it('bundles a WebSocket accept-key handshake over node:http', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wasmcloud-ws-http-bundle-'));
    const adapterPath = join(root, 'adapter.ts');
    const entryPath = join(root, 'entry.ts');
    const outFile = join(root, 'dist', 'component.js');
    writeFileSync(
      adapterPath,
      "import application from 'virtual:di-framework-application';\nexport const handler = application;\n",
    );
    writeFileSync(
      entryPath,
      `
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export default async function handshake(): Promise<string> {
  const server = createServer((_req, res) => {
    res.statusCode = 404;
    res.end('Not found');
  });
  server.on('upgrade', (req, socket) => {
    const key = String(req.headers['sec-websocket-key'] ?? '');
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ' +
        accept +
        '\\r\\n\\r\\n',
    );
    socket.end();
  });
  server.listen(0, '127.0.0.1');
  const port = server.address()?.port ?? 0;
  const client = createConnection({ host: '127.0.0.1', port });
  const response = await new Promise<string>((resolve, reject) => {
    client.once('connect', () => {
      client.write(
        'GET / HTTP/1.1\\r\\nHost: localhost\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\\r\\n\\r\\n',
      );
    });
    client.on('data', (chunk) => resolve(Buffer.from(chunk).toString()));
    client.once('error', reject);
  });
  server.close();
  return response;
}
`,
    );
    await DEFAULT_DEPS.bundler({ adapterPath, entryPath, outFile });
    const source = await Bun.file(outFile).text();
    expect(source).toContain('wasi:sockets/types@0.3.0');
    const bundled = await import(pathToFileURL(outFile).href);
    const response = await bundled.handler();
    expect(response).toContain('101 Switching Protocols');
    expect(response).toContain(
      `Sec-WebSocket-Accept: ${nodeCreateHash('sha1').update('dGhlIHNhbXBsZSBub25jZQ==258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')}`,
    );
  });
});
