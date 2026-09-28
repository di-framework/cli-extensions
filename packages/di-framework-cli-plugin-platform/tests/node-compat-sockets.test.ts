import { afterEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_DEPS } from '../src/deps';
import { hostInterfacesFromRequirements } from '../src/host-interface';
import {
  formatIpSocketAddress,
  ipSocketAddress,
  isIP,
  isIPv4,
  isIPv6,
  parseIpSocketAddress,
  parseIpv4,
  parseIpv6,
} from '../src/node-compat/socket-address';
import { socketRequirementsFromJavaScript } from '../src/wit';
import * as clock from './memory-wasi-clocks';
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

const {
  SocketAddress,
  createConnection,
  createServer,
  isIP: netIsIP,
} = await import('../src/node-compat/net');
const { createSocket } = await import('../src/node-compat/dgram');
const {
  asAsyncIterable,
  errorCodeName,
  firstOfTuple,
  resolveSocketAddress,
  socketError,
  toBytes,
  unwrapAsync,
  unwrapResult,
} = await import('../src/node-compat/wasi-sockets');

afterEach(() => {
  resetMemorySockets();
});

describe('socket addresses', () => {
  it('parses IPv4, compressed IPv6, localhost, and tagged WIT values', () => {
    expect(isIPv4('127.0.0.1')).toBe(true);
    expect(isIPv4('127.0.0.256')).toBe(false);
    expect(isIPv6('::1')).toBe(true);
    expect(isIPv6('::')).toBe(true);
    expect(isIPv6('[::1]')).toBe(true);
    expect(isIPv6('fe80::1')).toBe(true);
    expect(isIPv6('1:2:3:4:5:6:7:8')).toBe(true);
    expect(isIPv6('1:2:3:4:5:6:7:8:9')).toBe(false);
    expect(isIP('127.0.0.1')).toBe(4);
    expect(isIP('::1')).toBe(6);
    expect(isIP('example.test')).toBe(0);
    expect(parseIpv4('10.0.0.1')).toEqual([10, 0, 0, 1]);
    expect(parseIpv6('::')).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(ipSocketAddress('localhost', 80)?.tag).toBe('ipv4');
    expect(ipSocketAddress('localhost', 80, 'ipv6')?.tag).toBe('ipv6');
    expect(ipSocketAddress('', 0, 'ipv4')).toEqual({
      tag: 'ipv4',
      val: { port: 0, address: [0, 0, 0, 0] },
    });
    expect(parseIpSocketAddress({ tag: 'ipv4', val: { port: 9, address: [1, 2, 3, 4] } })).toEqual({
      tag: 'ipv4',
      val: { port: 9, address: [1, 2, 3, 4] },
    });
    expect(
      parseIpSocketAddress({
        tag: 'ipv6',
        val: { port: 1, address: [0, 0, 0, 0, 0, 0, 0, 1], 'flow-info': 2, 'scope-id': 3 },
      }),
    ).toMatchObject({ tag: 'ipv6', val: { port: 1, flowInfo: 2, scopeId: 3 } });
    const ipv6 = ipSocketAddress('::1', 443);
    expect(ipv6?.tag).toBe('ipv6');
    if (ipv6 !== undefined) expect(formatIpSocketAddress(ipv6).family).toBe('IPv6');
    expect(parseIpSocketAddress(null)).toBeUndefined();
    expect(parseIpSocketAddress({ tag: 'ipv4', val: { port: 1, address: [1] } })).toBeUndefined();
    expect(
      parseIpSocketAddress({
        tag: 'ipv6',
        val: { port: 1, address: [0, 0, 0, 0, 0, 0, 0, 70000] },
      }),
    ).toBeUndefined();
    expect(parseIpv6(':::')).toBeUndefined();
    expect(parseIpv6('gggg::')).toBeUndefined();
    expect(parseIpSocketAddress({ tag: 'unix', val: '/tmp.sock' })).toBeUndefined();
  });
});

describe('WASI result helpers', () => {
  it('unwraps ok/err results and maps socket errno', async () => {
    expect(unwrapResult<number>({ tag: 'ok', val: 7 }, 'read')).toBe(7);
    expect(unwrapResult<number>(7, 'read')).toBe(7);
    expect(firstOfTuple([1, 2])).toBe(1);
    expect(firstOfTuple({ res: 3 })).toBe(3);
    expect(firstOfTuple(4)).toBe(4);
    expect(errorCodeName('connection-refused')).toBe('connection-refused');
    expect(errorCodeName({ tag: 'address-in-use' })).toBe('address-in-use');
    expect(errorCodeName(1)).toBe('other');
    const refused = socketError('connection-refused', 'connect', '127.0.0.1', 80);
    expect(refused.code).toBe('ECONNREFUSED');
    expect(toBytes(65)).toEqual(Uint8Array.of(65));
    expect(toBytes('A')).toEqual(Uint8Array.of(65));
    expect(toBytes([66])).toEqual(Uint8Array.of(66));
    expect(toBytes(new Uint8Array([67]))).toEqual(Uint8Array.of(67));
    expect(toBytes(new Uint16Array([1]))).toBeInstanceOf(Uint8Array);
    expect(toBytes({})).toEqual(new Uint8Array());
    expect(await unwrapAsync<number>({ tag: 'ok', val: 8 }, 'read')).toBe(8);
    expect(await Array.fromAsync(asAsyncIterable([1, 2]))).toEqual([1, 2]);
    try {
      asAsyncIterable(1);
      throw new Error('expected throw');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('EINVAL');
    }
    try {
      unwrapResult({ tag: 'err', val: 'address-in-use' }, 'bind');
      throw new Error('expected throw');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('EADDRINUSE');
    }
    nameRecords.set('v6.lookup', [{ tag: 'ipv6', val: [0, 0, 0, 0, 0, 0, 0, 1] }]);
    const v6 = await resolveSocketAddress('v6.lookup', 9, 'ipv6', 'connect');
    expect(v6.tag).toBe('ipv6');
    expect(v6.val.port).toBe(9);
    nameRecords.set('v6-bad.lookup', [{ tag: 'ipv6', val: 'invalid' }]);
    await expect(resolveSocketAddress('v6-bad.lookup', 9, 'ipv6', 'connect')).rejects.toMatchObject(
      {
        code: 'ENOTFOUND',
      },
    );
    nameRecords.set('plain.lookup', ['127.0.0.1']);
    await expect(resolveSocketAddress('plain.lookup', 9, 'ipv4', 'connect')).rejects.toMatchObject({
      code: 'ENOTFOUND',
    });
  });
});

describe('node:net overlay', () => {
  it('echoes bytes between createServer and createConnection', async () => {
    const server = createServer((socket) => {
      socket.on('data', (chunk) => socket.write(chunk));
    });
    server.listen(0, '127.0.0.1');
    const info = server.address();
    expect(info).not.toBeNull();
    const port = info?.port ?? 0;
    expect(port).toBeGreaterThan(0);
    expect(netIsIP('127.0.0.1')).toBe(4);

    const socket = await new Promise<ReturnType<typeof createConnection>>((resolve, reject) => {
      const client = createConnection({ host: '127.0.0.1', port }, () => resolve(client));
      client.once('error', reject);
    });
    const echoed = new Promise<string>((resolve) => {
      socket.on('data', (chunk) => resolve(Buffer.from(chunk).toString()));
    });
    socket.write('ping');
    expect(await echoed).toBe('ping');
    socket.end();
    server.close();
  });

  it('unshifts leftover bytes before the next data listener', async () => {
    const server = createServer((socket) => {
      socket.pause();
      socket.unshift(Buffer.from('head'));
      socket.on('data', (chunk) => socket.write(chunk));
    });
    server.listen(0, '127.0.0.1');
    const port = server.address()?.port ?? 0;
    const client = await new Promise<ReturnType<typeof createConnection>>((resolve, reject) => {
      const connection = createConnection({ host: '127.0.0.1', port }, () => resolve(connection));
      connection.once('error', reject);
    });
    const echoed = new Promise<string>((resolve) => {
      const chunks: string[] = [];
      client.on('data', (chunk) => {
        chunks.push(Buffer.from(chunk).toString());
        if (chunks.join('').includes('headtail')) resolve(chunks.join(''));
      });
    });
    client.write('tail');
    expect(await echoed).toContain('head');
    expect(await echoed).toContain('tail');
    client.end();
    server.close();
  });

  it('emits ECONNREFUSED when nothing is listening', async () => {
    const error = await new Promise<Error>((resolve) => {
      const client = createConnection({ host: '127.0.0.1', port: 1 });
      client.once('error', resolve);
    });
    expect((error as { code?: string }).code).toBe('ECONNREFUSED');
  });

  it('emits EADDRINUSE when the port is taken', async () => {
    const first = createServer();
    first.listen(54321, '127.0.0.1');
    const second = createServer();
    const error = await new Promise<Error>((resolve) => {
      second.once('error', resolve);
      second.listen(54321, '127.0.0.1');
    });
    expect((error as { code?: string }).code).toBe('EADDRINUSE');
    first.close();
  });

  it('resolves a hostname through ip-name-lookup before connecting', async () => {
    nameRecords.set('echo.test', [{ tag: 'ipv4', val: [127, 0, 0, 1] }]);
    const server = createServer((socket) => socket.write('ok'));
    server.listen(0, '127.0.0.1');
    const port = server.address()?.port ?? 0;
    const socket = await new Promise<ReturnType<typeof createConnection>>((resolve, reject) => {
      const client = createConnection({ host: 'echo.test', port }, () => resolve(client));
      client.once('error', reject);
    });
    const data = await new Promise<string>((resolve) => {
      socket.on('data', (chunk) => resolve(Buffer.from(chunk).toString()));
    });
    expect(data).toBe('ok');
    socket.destroy();
    server.close();
  });

  it('supports listen options, no-op socket controls, and write-after-destroy', async () => {
    const connections: Array<ReturnType<typeof createConnection>> = [];
    const server = createServer();
    server.on('connection', (socket) => connections.push(socket));
    server.listen({ port: 0, host: '127.0.0.1' });
    expect(server.ref()).toBe(server);
    expect(server.unref()).toBe(server);
    const port = server.address()?.port ?? 0;
    const socket = createConnection(port, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    expect(socket.setNoDelay(true)).toBe(socket);
    expect(socket.setKeepAlive(true, 1)).toBe(socket);
    expect(socket.setTimeout(0)).toBe(socket);
    expect(socket.ref()).toBe(socket);
    expect(socket.unref()).toBe(socket);
    expect(socket.address()).toMatchObject({ family: 'IPv4' });
    expect(socket.writable).toBe(true);
    expect(socket.readable).toBe(true);
    socket.pause();
    socket.resume();
    socket.destroy();
    expect(socket.writable).toBe(false);
    expect(socket.readable).toBe(false);
    const destroyed = await new Promise<Error>((resolve) => {
      socket.write('late', (error) => {
        if (error) resolve(error);
      });
    });
    expect((destroyed as { code?: string }).code).toBe('EINVAL');
    server.close();
    expect(connections.length).toBeGreaterThan(0);
    expect(new SocketAddress({ address: '127.0.0.1', port: 80 }).family).toBe('ipv4');
    expect(new SocketAddress({ address: '::1', family: 'ipv6', port: 443 }).port).toBe(443);
  });

  it('listens after resolving a hostname', async () => {
    nameRecords.set('listen.test', [{ tag: 'ipv4', val: [127, 0, 0, 1] }]);
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, 'listen.test', resolve);
    });
    expect(server.address()?.address).toBe('127.0.0.1');
    server.close();
  });

  it('connects over an IPv6 name record and fails on an empty lookup', async () => {
    nameRecords.set('v6.test', [{ tag: 'ipv6', val: [0, 0, 0, 0, 0, 0, 0, 1] }]);
    const missing = await new Promise<Error>((resolve) => {
      nameRecords.set('empty.test', []);
      const client = createConnection({ host: 'empty.test', port: 9 });
      client.once('error', resolve);
    });
    expect((missing as { code?: string }).code).toBe('ENOTFOUND');
    const bad = await new Promise<Error>((resolve) => {
      nameRecords.set('bad.test', [{ tag: 'ipv4', val: 'invalid' }]);
      const client = createConnection({ host: 'bad.test', port: 9 });
      client.once('error', resolve);
    });
    expect((bad as { code?: string }).code).toBe('ENOTFOUND');
  });
});

describe('node:dgram overlay', () => {
  it('delivers datagrams with rinfo', async () => {
    const server = createSocket('udp4');
    const client = createSocket('udp4');
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.bind(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    await new Promise<void>((resolve, reject) => {
      client.once('error', reject);
      client.bind(0, '127.0.0.1', () => {
        client.off('error', reject);
        resolve();
      });
    });
    const port = server.address().port;
    const received = new Promise<{ msg: string; port: number }>((resolve) => {
      server.on('message', (msg, rinfo) => {
        resolve({ msg: Buffer.from(msg).toString(), port: rinfo.port });
      });
    });
    client.send(Buffer.from('hello'), port, '127.0.0.1');
    const got = await received;
    expect(got.msg).toBe('hello');
    expect(got.port).toBe(client.address().port);
    server.close();
    client.close();
  });

  it('sends a subarray and accepts a message listener on createSocket', async () => {
    const received = new Promise<string>((resolve) => {
      const server = createSocket('udp4', (msg) => {
        resolve(Buffer.from(msg).toString());
        server.close();
      });
      server.bind(0, '127.0.0.1', () => {
        const client = createSocket({ type: 'udp4' });
        const payload = Buffer.from('xxOK');
        client.send(payload, 2, 2, server.address().port, '127.0.0.1', () => client.close());
      });
    });
    expect(await received).toBe('OK');
  });

  it('binds a hostname, reports EADDRINUSE, and no-ops ref/unref', async () => {
    nameRecords.set('udp.test', [{ tag: 'ipv4', val: [127, 0, 0, 1] }]);
    const first = createSocket('udp4');
    await new Promise<void>((resolve, reject) => {
      first.once('error', reject);
      first.bind(0, 'udp.test', resolve);
    });
    expect(first.ref()).toBe(first);
    expect(first.unref()).toBe(first);
    const second = createSocket('udp4');
    const error = await new Promise<Error>((resolve) => {
      second.once('error', resolve);
      second.bind(first.address().port, '127.0.0.1');
    });
    expect((error as { code?: string }).code).toBe('EADDRINUSE');
    await new Promise<void>((resolve) => first.close(resolve));
  });
});

describe('socket WIT requirements', () => {
  it('detects sockets from bundled JS and keeps them off hostInterfaces', () => {
    expect(socketRequirementsFromJavaScript('export const bundled = true;\n')).toEqual([]);
    const requirements = socketRequirementsFromJavaScript(
      `import { TcpSocket } from "wasi:sockets/types@0.3.0";\nimport { resolveAddresses } from "wasi:sockets/ip-name-lookup@0.3.0";\n`,
    );
    expect(requirements).toEqual([
      expect.objectContaining({
        package: 'wasi:sockets',
        version: '0.3.0',
        interfaces: ['types', 'ip-name-lookup'],
        direction: 'import',
        source: 'node-compat',
      }),
    ]);
    expect(hostInterfacesFromRequirements(requirements)).toEqual([]);
  });
});

describe('bundled node:net overlay', () => {
  it('keeps wasi:sockets imports external and runs a TCP echo', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wasmcloud-net-bundle-'));
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
import { createConnection, createServer } from 'node:net';

export default async function echo(payload: string): Promise<string> {
  const server = createServer((socket) => {
    socket.on('data', (chunk) => socket.write(chunk));
  });
  server.listen(0, '127.0.0.1');
  const port = server.address()?.port ?? 0;
  const socket = await new Promise<ReturnType<typeof createConnection>>((resolve, reject) => {
    const client = createConnection({ host: '127.0.0.1', port }, () => resolve(client));
    client.once('error', reject);
  });
  const result = await new Promise<string>((resolve) => {
    socket.on('data', (chunk) => resolve(Buffer.from(chunk).toString()));
    socket.write(payload);
  });
  socket.end();
  server.close();
  return result;
}
`,
    );
    await DEFAULT_DEPS.bundler({ adapterPath, entryPath, outFile });
    const source = await Bun.file(outFile).text();
    expect(source).toContain('wasi:sockets/types@0.3.0');
    expect(source).toContain('wasi:sockets/ip-name-lookup@0.3.0');
    const bundled = await import(pathToFileURL(outFile).href);
    expect(await bundled.handler('pong')).toBe('pong');
  });
});
