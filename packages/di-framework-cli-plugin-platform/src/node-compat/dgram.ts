import { EventEmitter } from 'node:events';
import {
  familyFromHost,
  formatIpSocketAddress,
  type IpAddressFamily,
  type IpSocketAddress,
  ipSocketAddress,
  unspecifiedAddress,
} from './socket-address';
import {
  createUdpSocket,
  firstOfTuple,
  readSocketAddress,
  resolveSocketAddress,
  socketError,
  toBytes,
  toNodeBuffer,
  unwrapAsync,
  unwrapResult,
  type WasiUdpSocket,
} from './wasi-sockets';

export type RemoteInfo = {
  address: string;
  family: 'IPv4' | 'IPv6';
  port: number;
  size: number;
};

export type SocketType = 'udp4' | 'udp6';

function familyFromType(type: SocketType | { type?: SocketType }): IpAddressFamily {
  const name = typeof type === 'string' ? type : (type.type ?? 'udp4');
  return name === 'udp6' ? 'ipv6' : 'ipv4';
}

function emitSocketError(emitter: EventEmitter, error: unknown): void {
  if (typeof emitter.listenerCount === 'function' && emitter.listenerCount('error') === 0) return;
  emitter.emit('error', error);
}

export class Socket extends EventEmitter {
  type: SocketType;
  family: IpAddressFamily;
  native: WasiUdpSocket | undefined;
  bound = false;
  closed = false;
  receiving = false;
  localAddress = '';
  localPort = 0;

  constructor(type: SocketType | { type?: SocketType } = 'udp4') {
    super();
    this.type = (typeof type === 'string' ? type : (type.type ?? 'udp4')) as SocketType;
    this.family = familyFromType(type);
  }

  bind(
    portOrOptions?: number | { port?: number; address?: string } | (() => void),
    addressOrCallback?: string | (() => void),
    maybeCallback?: () => void,
  ): this {
    let port = 0;
    let address = this.family === 'ipv6' ? '::' : '0.0.0.0';
    let callback: (() => void) | undefined;
    if (typeof portOrOptions === 'function') {
      callback = portOrOptions;
    } else if (typeof portOrOptions === 'object' && portOrOptions !== null) {
      port = portOrOptions.port ?? 0;
      address = portOrOptions.address ?? address;
      callback = typeof addressOrCallback === 'function' ? addressOrCallback : undefined;
    } else {
      if (typeof portOrOptions === 'number') port = portOrOptions;
      if (typeof addressOrCallback === 'string') address = addressOrCallback;
      else if (typeof addressOrCallback === 'function') callback = addressOrCallback;
      if (typeof maybeCallback === 'function') callback = maybeCallback;
    }
    if (typeof callback === 'function') this.once('listening', callback);
    const resolved = ipSocketAddress(address, port, this.family);
    if (resolved !== undefined) this.bindResolved(resolved);
    else void this.bindNative(address, port);
    return this;
  }

  send(
    msg: string | Uint8Array,
    offsetOrPort?: number,
    lengthOrAddress?: number | string,
    portOrCallback?: number | ((error?: Error | null, bytes?: number) => void),
    addressOrCallback?: string | ((error?: Error | null, bytes?: number) => void),
    maybeCallback?: (error?: Error | null, bytes?: number) => void,
  ): void {
    let bytes = toBytes(msg);
    let port = 0;
    let address = this.family === 'ipv6' ? '::1' : '127.0.0.1';
    let callback: ((error?: Error | null, bytes?: number) => void) | undefined;
    if (typeof offsetOrPort === 'number' && typeof lengthOrAddress === 'number') {
      bytes = bytes.subarray(offsetOrPort, offsetOrPort + lengthOrAddress);
      port = typeof portOrCallback === 'number' ? portOrCallback : 0;
      if (typeof addressOrCallback === 'string') address = addressOrCallback;
      callback =
        typeof maybeCallback === 'function'
          ? maybeCallback
          : typeof addressOrCallback === 'function'
            ? addressOrCallback
            : undefined;
    } else {
      port = typeof offsetOrPort === 'number' ? offsetOrPort : 0;
      if (typeof lengthOrAddress === 'string') address = lengthOrAddress;
      callback =
        typeof portOrCallback === 'function'
          ? portOrCallback
          : typeof addressOrCallback === 'function'
            ? addressOrCallback
            : undefined;
    }
    void this.sendNative(bytes, port, address, callback);
  }

  address(): { address: string; family: string; port: number } {
    return {
      address: this.localAddress || (this.family === 'ipv6' ? '::' : '0.0.0.0'),
      family: this.family === 'ipv6' ? 'IPv6' : 'IPv4',
      port: this.localPort,
    };
  }

  close(callback?: () => void): this {
    this.closed = true;
    if (typeof callback === 'function') this.once('close', callback);
    queueMicrotask(() => this.emit('close'));
    return this;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }

  bindResolved(local: IpSocketAddress): void {
    try {
      const native = this.native ?? createUdpSocket(this.family);
      this.native = native;
      unwrapResult(native.bind(local), 'bind');
      const reported = formatIpSocketAddress(
        readSocketAddress(native.getLocalAddress(), 'getsockname'),
      );
      this.localAddress = reported.address;
      this.localPort = reported.port;
      this.bound = true;
      this.startReceive(native);
      queueMicrotask(() => this.emit('listening'));
    } catch (error) {
      emitSocketError(this, error);
    }
  }

  async bindNative(address: string, port: number): Promise<void> {
    try {
      this.family = familyFromHost(address, this.family);
      this.bindResolved(await resolveSocketAddress(address, port, this.family, 'bind'));
    } catch (error) {
      emitSocketError(this, error);
    }
  }

  async sendNative(
    bytes: Uint8Array,
    port: number,
    address: string,
    callback?: (error?: Error | null, bytes?: number) => void,
  ): Promise<void> {
    try {
      if (this.closed) throw socketError('invalid-state', 'send');
      const native = this.native ?? createUdpSocket(this.family);
      this.native = native;
      if (!this.bound) {
        this.bindResolved(unspecifiedAddress(this.family, 0));
      }
      const remote = await resolveSocketAddress(address, port, this.family, 'send');
      await unwrapAsync(native.send(bytes, remote), 'send');
      callback?.(null, bytes.length);
    } catch (error) {
      if (callback !== undefined) callback(error as Error);
      else emitSocketError(this, error);
    }
  }

  startReceive(native: WasiUdpSocket): void {
    if (this.receiving) return;
    this.receiving = true;
    void this.receiveLoop(native);
  }

  async receiveLoop(native: WasiUdpSocket): Promise<void> {
    while (!this.closed) {
      try {
        const received = await unwrapAsync(native.receive(), 'recv');
        const tuple = Array.isArray(received)
          ? received
          : firstOfTuple(received as [unknown, unknown]);
        const payload = toBytes(Array.isArray(tuple) ? tuple[0] : tuple);
        const remoteRaw = Array.isArray(tuple) ? tuple[1] : undefined;
        const remote =
          remoteRaw !== undefined
            ? formatIpSocketAddress(readSocketAddress(remoteRaw, 'recv'))
            : {
                address: '',
                family: (this.family === 'ipv6' ? 'IPv6' : 'IPv4') as 'IPv4' | 'IPv6',
                port: 0,
              };
        const rinfo: RemoteInfo = {
          address: remote.address,
          family: remote.family,
          port: remote.port,
          size: payload.length,
        };
        this.emit('message', toNodeBuffer(payload), rinfo);
      } catch (error) {
        if (!this.closed) emitSocketError(this, error);
        return;
      }
    }
  }
}

export function createSocket(
  type: SocketType | { type?: SocketType } = 'udp4',
  listener?: (msg: Uint8Array, rinfo: RemoteInfo) => void,
): Socket {
  const socket = new Socket(type);
  if (typeof listener === 'function') socket.on('message', listener);
  return socket;
}

export default { Socket, createSocket };
