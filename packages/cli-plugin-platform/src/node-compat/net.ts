import { EventEmitter } from 'node:events';
import {
  familyFromHost,
  formatIpSocketAddress,
  type IpAddressFamily,
  type IpSocketAddress,
  ipSocketAddress,
  isIP,
  isIPv4,
  isIPv6,
} from './socket-address';
import {
  asAsyncIterable,
  createTcpSocket,
  firstOfTuple,
  readSocketAddress,
  resolveSocketAddress,
  socketError,
  toBytes,
  toNodeBuffer,
  unwrapAsync,
  unwrapResult,
  type WasiTcpSocket,
} from './wasi-sockets';

export { isIP, isIPv4, isIPv6 };

export type AddressInfo = {
  address: string;
  family: string;
  port: number;
};

type ConnectionListener = (socket: Socket) => void;

type PushStream = {
  iterable: AsyncIterable<Uint8Array>;
  push(chunk: Uint8Array): void;
  close(): void;
};

export function createPushStream(): PushStream {
  const chunks: Uint8Array[] = [];
  let closed = false;
  let notify: (() => void) | undefined;
  return {
    iterable: {
      async *[Symbol.asyncIterator]() {
        while (true) {
          while (chunks.length > 0) {
            const next = chunks.shift();
            if (next !== undefined) yield next;
          }
          if (closed) return;
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
        }
      },
    },
    push(chunk) {
      if (closed) return;
      chunks.push(chunk);
      notify?.();
      notify = undefined;
    },
    close() {
      closed = true;
      notify?.();
      notify = undefined;
    },
  };
}

function emitSocketError(emitter: EventEmitter, error: unknown): void {
  if (typeof emitter.listenerCount === 'function' && emitter.listenerCount('error') === 0) return;
  emitter.emit('error', error);
}

export class Socket extends EventEmitter {
  connecting = false;
  pending = true;
  destroyed = false;
  bytesRead = 0;
  bytesWritten = 0;
  remoteAddress = '';
  remoteFamily = '';
  remotePort = 0;
  localAddress = '';
  localPort = 0;
  readyState: 'opening' | 'open' | 'readOnly' | 'writeOnly' | 'closed' = 'closed';

  native: WasiTcpSocket | undefined;
  outgoing: PushStream | undefined;
  family: IpAddressFamily = 'ipv4';
  buffered: Uint8Array[] = [];
  ioStarted = false;
  paused = false;
  readableEnded = false;
  readableBuffer: Uint8Array[] = [];

  constructor(native?: WasiTcpSocket, family: IpAddressFamily = 'ipv4') {
    super();
    this.native = native;
    this.family = family;
    super.on('newListener', (event) => {
      if (event === 'data') {
        this.paused = false;
        queueMicrotask(() => this.flushReadable());
      }
    });
    if (native !== undefined) {
      this.pending = false;
      this.readyState = 'open';
      this.captureLocal(native);
      this.captureRemote(native);
      this.startIo(native);
    }
  }

  connect(
    portOrOptions: number | { port: number; host?: string; family?: number },
    hostOrCallback?: string | (() => void),
    maybeCallback?: () => void,
  ): this {
    let port = 0;
    let host = '127.0.0.1';
    let callback: (() => void) | undefined;
    if (typeof portOrOptions === 'object' && portOrOptions !== null) {
      port = portOrOptions.port;
      host = portOrOptions.host ?? host;
      if (portOrOptions.family === 6) this.family = 'ipv6';
      callback = typeof hostOrCallback === 'function' ? hostOrCallback : undefined;
    } else {
      port = portOrOptions;
      if (typeof hostOrCallback === 'string') host = hostOrCallback;
      else if (typeof hostOrCallback === 'function') callback = hostOrCallback;
      if (typeof maybeCallback === 'function') callback = maybeCallback;
    }
    this.family = familyFromHost(host, this.family);
    this.connecting = true;
    this.pending = true;
    this.readyState = 'opening';
    if (typeof callback === 'function') this.once('connect', callback);
    void this.connectNative(host, port);
    return this;
  }

  write(
    data: string | Uint8Array,
    encodingOrCallback?: string | ((error?: Error | null) => void),
    maybeCallback?: (error?: Error | null) => void,
  ): boolean {
    const callback = typeof encodingOrCallback === 'function' ? encodingOrCallback : maybeCallback;
    if (this.destroyed) {
      const error = socketError('invalid-state', 'write');
      if (callback !== undefined) queueMicrotask(() => callback(error));
      else emitSocketError(this, error);
      return false;
    }
    const bytes = toBytes(data);
    this.bytesWritten += bytes.length;
    if (this.outgoing !== undefined) this.outgoing.push(bytes);
    else this.buffered.push(bytes);
    if (callback !== undefined) queueMicrotask(() => callback(null));
    return true;
  }

  end(
    data?: string | Uint8Array | (() => void),
    encodingOrCallback?: string | (() => void),
    maybeCallback?: () => void,
  ): this {
    const callback =
      typeof data === 'function'
        ? data
        : typeof encodingOrCallback === 'function'
          ? encodingOrCallback
          : maybeCallback;
    if (typeof data !== 'function' && data !== undefined) this.write(data);
    this.outgoing?.close();
    if (typeof callback === 'function') this.once('close', callback);
    return this;
  }

  destroy(error?: Error): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.connecting = false;
    this.readyState = 'closed';
    this.readableEnded = true;
    this.outgoing?.close();
    if (error !== undefined) emitSocketError(this, error);
    queueMicrotask(() => this.emit('close'));
    return this;
  }

  get writable(): boolean {
    return !this.destroyed && this.readyState !== 'closed';
  }

  get readable(): boolean {
    return !this.destroyed && !this.readableEnded;
  }

  unshift(chunk: string | Uint8Array): boolean {
    this.readableBuffer.unshift(toBytes(chunk));
    this.flushReadable();
    return true;
  }

  pause(): this {
    this.paused = true;
    return this;
  }

  resume(): this {
    this.paused = false;
    this.flushReadable();
    return this;
  }

  flushReadable(): void {
    if (this.paused || this.destroyed) return;
    if (typeof this.listenerCount === 'function' && this.listenerCount('data') === 0) return;
    while (this.readableBuffer.length > 0) {
      const next = this.readableBuffer.shift();
      if (next !== undefined) this.emit('data', toNodeBuffer(next));
    }
  }

  address(): AddressInfo | null {
    if (this.localPort === 0 && this.localAddress === '') return null;
    return {
      address: this.localAddress || (this.family === 'ipv6' ? '::' : '0.0.0.0'),
      family: this.family === 'ipv6' ? 'IPv6' : 'IPv4',
      port: this.localPort,
    };
  }

  setNoDelay(_noDelay?: boolean): this {
    return this;
  }

  setKeepAlive(_enable?: boolean, _initialDelay?: number): this {
    return this;
  }

  setTimeout(_timeout: number, callback?: () => void): this {
    if (typeof callback === 'function') this.once('timeout', callback);
    return this;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }

  async connectNative(host: string, port: number): Promise<void> {
    try {
      const native = this.native ?? createTcpSocket(this.family);
      this.native = native;
      const remote = await resolveSocketAddress(host, port, this.family, 'connect');
      unwrapResult(await Promise.resolve(native.connect(remote)), 'connect');
      this.connecting = false;
      this.pending = false;
      this.readyState = 'open';
      this.captureLocal(native);
      this.captureRemote(native, remote);
      this.startIo(native);
      this.emit('connect');
    } catch (error) {
      this.connecting = false;
      emitSocketError(this, error);
      this.destroy();
    }
  }

  startIo(native: WasiTcpSocket): void {
    if (this.ioStarted) return;
    this.ioStarted = true;
    const outgoing = createPushStream();
    this.outgoing = outgoing;
    for (const chunk of this.buffered) outgoing.push(chunk);
    this.buffered = [];
    try {
      void unwrapAsync(native.send(outgoing.iterable), 'write');
    } catch (error) {
      emitSocketError(this, error);
    }
    void this.pumpReceive(native);
  }

  async pumpReceive(native: WasiTcpSocket): Promise<void> {
    try {
      const received = native.receive();
      const stream = firstOfTuple(await Promise.resolve(received));
      for await (const chunk of asAsyncIterable(stream)) {
        if (this.destroyed) return;
        const bytes = toBytes(chunk);
        if (bytes.length === 0) continue;
        this.bytesRead += bytes.length;
        this.readableBuffer.push(bytes);
        this.flushReadable();
      }
      this.readableEnded = true;
      if (!this.destroyed) this.emit('end');
    } catch (error) {
      if (!this.destroyed) emitSocketError(this, error);
    } finally {
      if (!this.destroyed) this.destroy();
    }
  }

  captureLocal(native: WasiTcpSocket): void {
    try {
      const local = formatIpSocketAddress(
        readSocketAddress(native.getLocalAddress(), 'getsockname'),
      );
      this.localAddress = local.address;
      this.localPort = local.port;
    } catch {
      /* host may not report a local address until bind/connect completes */
    }
  }

  captureRemote(native: WasiTcpSocket, fallback?: IpSocketAddress): void {
    try {
      const remote = formatIpSocketAddress(
        readSocketAddress(native.getRemoteAddress(), 'getpeername'),
      );
      this.remoteAddress = remote.address;
      this.remoteFamily = remote.family;
      this.remotePort = remote.port;
    } catch {
      if (fallback !== undefined) {
        const remote = formatIpSocketAddress(fallback);
        this.remoteAddress = remote.address;
        this.remoteFamily = remote.family;
        this.remotePort = remote.port;
      }
    }
  }
}

export class Server extends EventEmitter {
  listening = false;
  maxConnections = Infinity;
  connectionListener: ConnectionListener | undefined;
  native: WasiTcpSocket | undefined;
  family: IpAddressFamily = 'ipv4';
  local: AddressInfo | null = null;
  closed = false;

  constructor(connectionListener?: ConnectionListener) {
    super();
    this.connectionListener = connectionListener;
  }

  listen(
    portOrOptions?: number | { port?: number; host?: string },
    hostnameOrCallback?: string | (() => void),
    backlogOrCallback?: number | (() => void),
    maybeCallback?: () => void,
  ): this {
    let port = 0;
    let host = '0.0.0.0';
    let callback: (() => void) | undefined;
    if (typeof portOrOptions === 'object' && portOrOptions !== null) {
      port = portOrOptions.port ?? 0;
      host = portOrOptions.host ?? host;
      callback = typeof hostnameOrCallback === 'function' ? hostnameOrCallback : undefined;
    } else {
      if (typeof portOrOptions === 'number') port = portOrOptions;
      if (typeof hostnameOrCallback === 'string') host = hostnameOrCallback;
      else if (typeof hostnameOrCallback === 'function') callback = hostnameOrCallback;
      if (typeof backlogOrCallback === 'function') callback = backlogOrCallback;
      if (typeof maybeCallback === 'function') callback = maybeCallback;
    }
    this.family = familyFromHost(host, this.family);
    if (typeof callback === 'function') this.once('listening', callback);
    const resolved = ipSocketAddress(host, port, this.family);
    if (resolved !== undefined) this.bindResolved(resolved);
    else void this.bindAndListen(host, port);
    return this;
  }

  address(): AddressInfo | null {
    return this.local;
  }

  close(callback?: (error?: Error) => void): this {
    this.closed = true;
    this.listening = false;
    if (typeof callback === 'function') this.once('close', () => callback());
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
      const native = createTcpSocket(this.family);
      this.native = native;
      unwrapResult(native.bind(local), 'bind');
      const accepted = unwrapResult(native.listen(), 'listen');
      this.local = formatIpSocketAddress(
        readSocketAddress(native.getLocalAddress(), 'getsockname'),
      );
      this.listening = true;
      queueMicrotask(() => this.emit('listening'));
      void this.acceptLoop(asAsyncIterable(firstOfTuple(accepted)));
    } catch (error) {
      emitSocketError(this, error);
    }
  }

  async bindAndListen(host: string, port: number): Promise<void> {
    try {
      this.bindResolved(await resolveSocketAddress(host, port, this.family, 'bind'));
    } catch (error) {
      emitSocketError(this, error);
    }
  }

  async acceptLoop(incoming: AsyncIterable<unknown>): Promise<void> {
    try {
      for await (const child of incoming) {
        if (this.closed) return;
        const native = unwrapResult(child, 'accept') as WasiTcpSocket;
        const socket = new Socket(native, this.family);
        this.emit('connection', socket);
        this.connectionListener?.(socket);
      }
    } catch (error) {
      if (!this.closed) emitSocketError(this, error);
    }
  }
}

export function createServer(
  options?: { allowHalfOpen?: boolean } | ConnectionListener,
  listener?: ConnectionListener,
): Server {
  if (typeof options === 'function') return new Server(options);
  return new Server(listener);
}

export function createConnection(
  portOrOptions: number | { port: number; host?: string; family?: number },
  hostOrCallback?: string | (() => void),
  maybeCallback?: () => void,
): Socket {
  const socket = new Socket();
  socket.connect(portOrOptions, hostOrCallback, maybeCallback);
  return socket;
}

export const connect = createConnection;

export class SocketAddress {
  address: string;
  family: 'ipv4' | 'ipv6';
  port: number;
  flowlabel: number;

  constructor(options: {
    address: string;
    family?: 'ipv4' | 'ipv6';
    port: number;
    flowlabel?: number;
  }) {
    this.address = options.address;
    this.family = options.family ?? 'ipv4';
    this.port = options.port;
    this.flowlabel = options.flowlabel ?? 0;
  }
}

export { Socket as Stream };

export default {
  Server,
  Socket,
  Stream: Socket,
  SocketAddress,
  createServer,
  createConnection,
  connect,
  isIP,
  isIPv4,
  isIPv6,
};
