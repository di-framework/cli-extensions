import { resolveAddresses } from 'wasi:sockets/ip-name-lookup@0.3.0';
import { TcpSocket, UdpSocket } from 'wasi:sockets/types@0.3.0';
import {
  type IpAddressFamily,
  type IpSocketAddress,
  ipSocketAddress,
  parseIpSocketAddress,
} from './socket-address';

export type WasiResult<T> = { tag: 'ok'; val: T } | { tag: 'err'; val: unknown };

export type WasiTcpSocket = {
  bind(localAddress: IpSocketAddress): unknown;
  connect(remoteAddress: IpSocketAddress): unknown;
  listen(): unknown;
  send(data: AsyncIterable<Uint8Array>): unknown;
  receive(): unknown;
  getLocalAddress(): unknown;
  getRemoteAddress(): unknown;
};

export type WasiUdpSocket = {
  bind(localAddress: IpSocketAddress): unknown;
  connect(remoteAddress: IpSocketAddress): unknown;
  send(data: Uint8Array | number[], remoteAddress?: IpSocketAddress): unknown;
  receive(): unknown;
  getLocalAddress(): unknown;
  getRemoteAddress(): unknown;
};

type ErrnoException = Error & {
  code: string;
  errno: number;
  syscall: string;
  address?: string;
  port?: number;
};

const SOCKET_ERRNO: Record<string, { code: string; errno: number }> = {
  'access-denied': { code: 'EACCES', errno: -13 },
  'not-supported': { code: 'ENOTSUP', errno: -95 },
  'invalid-argument': { code: 'EINVAL', errno: -22 },
  'out-of-memory': { code: 'ENOMEM', errno: -12 },
  timeout: { code: 'ETIMEDOUT', errno: -110 },
  'invalid-state': { code: 'EINVAL', errno: -22 },
  'address-not-bindable': { code: 'EADDRNOTAVAIL', errno: -99 },
  'address-in-use': { code: 'EADDRINUSE', errno: -98 },
  'remote-unreachable': { code: 'EHOSTUNREACH', errno: -113 },
  'connection-refused': { code: 'ECONNREFUSED', errno: -111 },
  'connection-broken': { code: 'EPIPE', errno: -32 },
  'connection-reset': { code: 'ECONNRESET', errno: -104 },
  'connection-aborted': { code: 'ECONNABORTED', errno: -103 },
  'datagram-too-large': { code: 'EMSGSIZE', errno: -90 },
  'name-unresolvable': { code: 'ENOTFOUND', errno: -3008 },
  'temporary-resolver-failure': { code: 'EAGAIN', errno: -11 },
  'permanent-resolver-failure': { code: 'ENOTFOUND', errno: -3008 },
};

export function errorCodeName(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value !== null && typeof value === 'object' && 'tag' in value) {
    return String((value as { tag: unknown }).tag);
  }
  return 'other';
}

export function socketError(
  value: unknown,
  syscall: string,
  address?: string,
  port?: number,
): ErrnoException {
  const name = errorCodeName(value);
  const mapped = SOCKET_ERRNO[name] ?? { code: 'EIO', errno: -5 };
  const error = new Error(
    `${mapped.code}: ${name.replace(/-/g, ' ')}, ${syscall}`,
  ) as ErrnoException;
  error.code = mapped.code;
  error.errno = mapped.errno;
  error.syscall = syscall;
  if (address !== undefined) error.address = address;
  if (port !== undefined) error.port = port;
  return error;
}

export function unwrapResult<T>(value: unknown, syscall: string): T {
  if (value !== null && typeof value === 'object' && 'tag' in value) {
    const result = value as WasiResult<T>;
    if (result.tag === 'err') throw socketError(result.val, syscall);
    if (result.tag === 'ok') return result.val;
  }
  return value as T;
}

export async function unwrapAsync<T>(value: unknown, syscall: string): Promise<T> {
  return unwrapResult(await Promise.resolve(value), syscall);
}

export function firstOfTuple<T>(value: T | [T, ...unknown[]] | { res: T }): T {
  if (Array.isArray(value)) return value[0];
  if (value !== null && typeof value === 'object' && 'res' in value) return value.res;
  return value;
}

export function asAsyncIterable<T>(value: unknown): AsyncIterable<T> {
  if (value != null && typeof value === 'object' && Symbol.asyncIterator in value) {
    return value as AsyncIterable<T>;
  }
  if (value != null && typeof value === 'object' && Symbol.iterator in value) {
    return {
      async *[Symbol.asyncIterator]() {
        yield* value as Iterable<T>;
      },
    };
  }
  throw socketError('invalid-argument', 'read');
}

export function toBytes(data: unknown): Uint8Array {
  if (typeof data === 'number') return Uint8Array.of(data & 0xff);
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (Array.isArray(data)) return Uint8Array.from(data.map((byte) => Number(byte) & 0xff));
  return new Uint8Array();
}

export function toNodeBuffer(bytes: Uint8Array): Uint8Array {
  return typeof Buffer === 'undefined' ? bytes : Buffer.from(bytes);
}

export function createTcpSocket(family: IpAddressFamily): WasiTcpSocket {
  const created = (TcpSocket as unknown as { create(family: IpAddressFamily): unknown }).create(
    family,
  );
  return unwrapResult(created, 'socket') as WasiTcpSocket;
}

export function createUdpSocket(family: IpAddressFamily): WasiUdpSocket {
  const created = (UdpSocket as unknown as { create(family: IpAddressFamily): unknown }).create(
    family,
  );
  return unwrapResult(created, 'socket') as WasiUdpSocket;
}

export function readSocketAddress(value: unknown, syscall: string): IpSocketAddress {
  const parsed = parseIpSocketAddress(unwrapResult(value, syscall));
  if (parsed === undefined) throw socketError('invalid-argument', syscall);
  return parsed;
}

export async function resolveSocketAddress(
  host: string,
  port: number,
  family: IpAddressFamily,
  syscall: string,
): Promise<IpSocketAddress> {
  const parsed = ipSocketAddress(host, port, family);
  if (parsed !== undefined) return parsed;
  const resolved = unwrapResult(
    await Promise.resolve(resolveAddresses(host)),
    syscall,
  ) as unknown[];
  const first = resolved[0];
  if (first === undefined) throw socketError('name-unresolvable', syscall, host, port);
  if (first !== null && typeof first === 'object' && 'tag' in first) {
    const tagged = first as { tag: string; val: unknown };
    if (tagged.tag === 'ipv6') {
      const address = Array.isArray(tagged.val)
        ? (tagged.val as [number, number, number, number, number, number, number, number])
        : undefined;
      if (address === undefined) throw socketError('name-unresolvable', syscall, host, port);
      return { tag: 'ipv6', val: { port, address, flowInfo: 0, scopeId: 0 } };
    }
    const address = Array.isArray(tagged.val)
      ? (tagged.val as [number, number, number, number])
      : undefined;
    if (address === undefined) throw socketError('name-unresolvable', syscall, host, port);
    return { tag: 'ipv4', val: { port, address } };
  }
  throw socketError('name-unresolvable', syscall, host, port);
}
