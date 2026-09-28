import { afterEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_DEPS } from '../src/deps';
import { hostInterfacesFromRequirements } from '../src/host-interface';
import { renderWorldWit, runtimeRequirementsFromJavaScript } from '../src/wit';
import * as clocks from './memory-wasi-clocks';
import { resetMemorySockets, resolveAddresses, TcpSocket, UdpSocket } from './memory-wasi-sockets';

mock.module('wasi:sockets/types@0.3.0', () => ({ TcpSocket, UdpSocket }));
mock.module('wasi:sockets/ip-name-lookup@0.3.0', () => ({ resolveAddresses }));
mock.module('wasi:clocks/monotonic-clock@0.3.0', () => clocks);

// Deliberately reversible framing for transport contract tests, NOT a TLS implementation.
const transform = (bytes: Uint8Array) => Uint8Array.from(bytes, (byte) => byte ^ 0xff);
let names: string[] = [];
let handshake: () => Promise<unknown> = async () => ({ tag: 'ok' });
let completion: () => Promise<unknown> = async () => ({ tag: 'ok' });
class Connector {
  receiveSet = false;
  sendSet = false;
  send(input: AsyncIterable<Uint8Array>) {
    this.sendSet = true;
    return [this.translate(input), completion()];
  }
  receive(input: AsyncIterable<Uint8Array>) {
    this.receiveSet = true;
    return [this.translate(input), completion()];
  }
  async *translate(input: AsyncIterable<Uint8Array>) {
    for await (const chunk of input) yield transform(chunk);
  }
  static async connect(connector: Connector, name: string) {
    expect(connector.receiveSet && connector.sendSet).toBe(true);
    names.push(name);
    return handshake();
  }
}
mock.module('wasi:tls/client@0.3.0-draft', () => ({ Connector }));

const net = await import('../src/node-compat/net');
const tls = await import('../src/node-compat/tls');
const https = await import('../src/node-compat/https');
const http = await import('../src/node-compat/http');
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  resetMemorySockets();
  names = [];
  handshake = async () => ({ tag: 'ok' });
  completion = async () => ({ tag: 'ok' });
});

function echoServer() {
  const server = net.createServer((socket) => socket.on('data', (data) => socket.write(data)));
  server.listen(0, '127.0.0.1');
  return server;
}

describe('host TLS client', () => {
  it('buffers application writes until verification, and supports end before connect', async () => {
    let release!: (result: unknown) => void;
    handshake = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const server = echoServer();
    const socket = tls.connect({
      port: server.address()?.port ?? 0,
      host: '127.0.0.1',
      servername: 'example.test',
    });
    const received: string[] = [];
    socket.on('data', (bytes) => received.push(Buffer.from(bytes).toString()));
    socket.end('secret');
    await tick();
    expect(socket.authorized).toBe(false);
    expect(received).toEqual([]);
    const done = new Promise((resolve) => socket.once('close', resolve));
    release({ tag: 'ok' });
    await done;
    expect(received).toEqual(['secret']);
    expect(names).toEqual(['example.test']);
    server.close();
  });

  it('upgrades an existing TCP connection and emits secureConnect after connect', async () => {
    const server = echoServer();
    const raw = net.createConnection(server.address()?.port ?? 0, '127.0.0.1');
    await new Promise((resolve) => raw.once('connect', resolve));
    const events: string[] = [];
    const socket = tls.connect({ socket: raw, servername: 'localhost' }, () =>
      events.push('secureConnect'),
    );
    socket.on('connect', () => events.push('connect'));
    const data = new Promise((resolve) => socket.once('data', resolve));
    socket.write('hello');
    expect(Buffer.from((await data) as Uint8Array).toString()).toBe('hello');
    expect(events).toEqual(['connect', 'secureConnect']);
    expect(socket.authorized).toBe(true);
    socket.destroy();
    expect(raw.destroyed).toBe(true);
    server.close();
  });

  it('rejects failed verification without sending application data', async () => {
    handshake = async () => ({
      tag: 'err',
      val: { toDebugString: () => 'certificate hostname mismatch' },
    });
    let received = false;
    const server = net.createServer((peer) =>
      peer.on('data', () => {
        received = true;
      }),
    );
    server.listen(0, '127.0.0.1');
    const socket = tls.connect(server.address()?.port ?? 0, '127.0.0.1');
    let secure = false;
    socket.on('secureConnect', () => {
      secure = true;
    });
    const error = new Promise<Error>((resolve) => socket.once('error', resolve));
    socket.write('never send this');
    expect((await error).message).toContain('hostname mismatch');
    expect(socket.authorized).toBe(false);
    expect(socket.authorizationError).not.toBeNull();
    expect(socket.destroyed).toBe(true);
    expect(secure || received).toBe(false);
    server.close();
  });

  it('observes transform completion failures and cancellation during handshake', async () => {
    const server = echoServer();
    let release!: (result: unknown) => void;
    handshake = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const socket = tls.connect(server.address()?.port ?? 0, '127.0.0.1');
    let secure = false;
    socket.on('secureConnect', () => {
      secure = true;
    });
    await tick();
    socket.destroy();
    release({ tag: 'ok' });
    await tick();
    expect(secure).toBe(false);
    handshake = async () => ({ tag: 'ok' });
    completion = async () => ({ tag: 'err', val: 'bad TLS record' });
    const failed = tls.connect(server.address()?.port ?? 0, '127.0.0.1');
    const error = await new Promise<Error>((resolve) => failed.once('error', resolve));
    expect(error.message).toContain('bad TLS record');
    expect(failed.destroyed).toBe(true);
    server.close();
  });

  it('rejects unsupported security controls explicitly', () => {
    for (const option of [
      { rejectUnauthorized: false },
      { ca: 'custom' },
      { key: 'key' },
      { checkServerIdentity: () => undefined },
      { ALPNProtocols: ['h2'] },
      { minVersion: 'TLSv1.3' },
    ])
      expect(() => tls.connect({ port: 443, ...option })).toThrow('not supported');
    expect(() => tls.createServer()).toThrow('TLS servers');
    expect(() => https.createServer()).toThrow('HTTPS servers');
    expect(() => new https.Agent({ rejectUnauthorized: false })).toThrow();
    expect(() => new tls.Server()).toThrow();
    expect(() => new https.Server()).toThrow();
    expect(() => tls.createSecureContext()).toThrow();
    const socket = tls.connect({ port: 443 });
    for (const operation of [
      () => socket.connect(443),
      () => socket.getPeerCertificate(),
      () => socket.getCipher(),
      () => socket.getProtocol(),
      () => socket.getSession(),
      () => socket.renegotiate(),
    ])
      expect(operation).toThrow('not supported');
    socket.destroy();
  });

  it('reports binding error payloads and emits inactivity timeouts', async () => {
    const server = echoServer();
    handshake = async () => {
      throw Object.assign(new Error('binding error'), {
        payload: { toDebugString: () => 'certificate expired' },
      });
    };
    const failed = tls.connect(server.address()?.port ?? 0, { host: '127.0.0.1' });
    const error = await new Promise<Error>((resolve) => failed.once('error', resolve));
    expect(error.message).toContain('certificate expired');
    handshake = async () => ({ tag: 'ok' });
    const socket = tls.connect(server.address()?.port ?? 0, '127.0.0.1');
    await new Promise((resolve) => socket.once('secureConnect', resolve));
    await new Promise<void>((resolve) => socket.setTimeout(5, resolve));
    socket.setTimeout(0);
    expect(socket.destroyed).toBe(false); // Timeouts notify; the caller chooses cancellation.
    socket.destroy();
    server.close();
  });
});

describe('HTTPS over host TLS', () => {
  it('reports a TLS stream failure after the request is sent exactly once', async () => {
    let fail!: (result: unknown) => void;
    const done = new Promise((resolve) => {
      fail = resolve;
    });
    completion = () => done;
    const server = net.createServer((peer) =>
      peer.once('data', () => fail({ tag: 'err', val: 'record failure' })),
    );
    server.listen(0, '127.0.0.1');
    const req = https.get({ host: '127.0.0.1', port: server.address()?.port });
    const errors: Error[] = [];
    req.on('error', (error) => errors.push(error));
    await new Promise((resolve) => req.once('error', resolve));
    await tick();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('record failure');
    server.close();
  });

  it('reads close-delimited responses and reports truncated responses', async () => {
    for (const [response, expected] of [
      ['HTTP/1.0 200 OK\r\n\r\nclose body', 'close body'],
      ['HTTP/1.1 204 No Content\r\n\r\n', ''],
      ['HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nshort', 'ECONNRESET'],
      ['', 'ECONNRESET'],
    ] as const) {
      const server = net.createServer((peer) =>
        peer.once('data', () => peer.end(transform(Buffer.from(response ?? '')))),
      );
      server.listen(0, '127.0.0.1');
      const actual = await new Promise<string>((resolve) => {
        const req = https.get({ host: '127.0.0.1', port: server.address()?.port }, (res) => {
          let body = '';
          res.on('data', (chunk) => {
            body += Buffer.from(chunk).toString();
          });
          res.on('end', () => resolve(body));
        });
        req.once('error', (error) => resolve(error.code));
      });
      expect(actual).toBe(expected);
      server.close();
    }
  });

  it('sends HTTP/1.1 only over the TLS transform and preserves request/response semantics', async () => {
    let wire = '';
    let decoded = '';
    const server = net.createServer((peer) =>
      peer.on('data', (data) => {
        wire += Buffer.from(data).toString();
        decoded += Buffer.from(transform(data)).toString();
        if (decoded.endsWith('body'))
          peer.end(
            transform(
              Buffer.from(
                'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nok\r\n0\r\n\r\n',
              ),
            ),
          );
      }),
    );
    server.listen(0, '127.0.0.1');
    const body = await new Promise<string>((resolve, reject) => {
      const req = https.request(
        `https://127.0.0.1:${server.address()?.port ?? 0}/test?q=1`,
        { method: 'POST', servername: 'localhost' },
        (res) => {
          let text = '';
          res.on('data', (data) => {
            text += Buffer.from(data).toString();
          });
          res.on('end', () => resolve(text));
        },
      );
      req.on('error', reject);
      req.end('body');
    });
    expect(body).toBe('ok');
    expect(decoded).toContain('POST /test?q=1 HTTP/1.1');
    expect(decoded).toContain('content-length: 4');
    expect(wire).not.toContain('POST');
    expect(names).toEqual(['localhost']);
    server.close();
  });

  it('rejects insecure URLs and connection factories, preserves port defaults and Agent settings', async () => {
    expect(() => https.get('http://localhost')).toThrow('Expected "https:"');
    expect(() => http.get('https://localhost')).toThrow('Expected "http:"');
    const req = https.request('https://localhost/path', {
      agent: new https.Agent({ servername: 'custom.test' }),
    });
    expect(req.port).toBe(443);
    expect(req.getHeader('host')).toBe('localhost');
    req.destroy();
    const unsafe = https.get({ host: 'localhost', createConnection: () => new net.Socket() });
    const error = await new Promise<Error>((resolve) => unsafe.once('error', resolve));
    expect(error.message).toContain('without a TLSSocket');
  });

  it('uses Agent connection defaults and invokes its callback only after verification', async () => {
    const server = echoServer();
    const agent = new https.Agent({ servername: 'agent.test' });
    const connected = new Promise<InstanceType<typeof tls.TLSSocket>>((resolve, reject) => {
      agent
        .createConnection({ host: '127.0.0.1', port: server.address()?.port }, (error, socket) => {
          if (error) reject(error);
          else resolve(socket);
        })
        .on('error', reject);
    });
    const socket = await connected;
    expect(socket.authorized).toBe(true);
    expect(names).toEqual(['agent.test']);
    socket.destroy();
    server.close();
  });

  it('bundles aliases and adds TLS to the generated WIT only when imported', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wasmcloud-tls-'));
    try {
      const adapterPath = join(root, 'adapter.ts');
      const entryPath = join(root, 'entry.ts');
      const outFile = join(root, 'dist', 'bundle.js');
      writeFileSync(
        adapterPath,
        "export { default as handler } from 'virtual:di-framework-application';",
      );
      writeFileSync(
        entryPath,
        "import tls from 'tls'; import https from 'node:https'; export default () => [tls.connect, https.request];",
      );
      await DEFAULT_DEPS.bundler({ adapterPath, entryPath, outFile });
      const source = await Bun.file(outFile).text();
      const requirements = runtimeRequirementsFromJavaScript(source);
      expect(requirements.find((r) => r.package === 'wasi:tls')?.interfaces).toEqual([
        'client',
        'types',
      ]);
      expect(hostInterfacesFromRequirements(requirements)).toEqual([]);
      expect(renderWorldWit('test', '1.0.0', requirements)).toContain(
        'import wasi:tls/client@0.3.0-draft;',
      );
      expect(runtimeRequirementsFromJavaScript('export const x = 1')).toEqual([]);
      const bundled = await import(pathToFileURL(outFile).href);
      expect(bundled.handler().every((fn: unknown) => typeof fn === 'function')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
