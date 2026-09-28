import { Connector } from 'wasi:tls/client@0.3.0-draft';
import { createPushStream, Socket } from './net';
import { clearTimeout, setTimeout, type Timeout } from './timers';
import { asAsyncIterable, toBytes } from './wasi-sockets';

export type ConnectionOptions = {
  host?: string;
  port?: number;
  family?: number;
  servername?: string;
  socket?: Socket;
  rejectUnauthorized?: boolean;
  [option: string]: unknown;
};

export function unsupported(feature: string): never {
  throw Object.assign(
    new Error(`${feature} is not supported by wasi:tls; configure TLS policy on the host`),
    {
      code: 'ERR_TLS_UNSUPPORTED_OPTION',
    },
  );
}

export function validateOptions(options: ConnectionOptions): void {
  if (options.rejectUnauthorized !== undefined && options.rejectUnauthorized !== true) {
    unsupported('rejectUnauthorized');
  }
  for (const name of [
    'ca',
    'cert',
    'key',
    'pfx',
    'passphrase',
    'crl',
    'secureContext',
    'checkServerIdentity',
    'ciphers',
    'sigalgs',
    'ecdhCurve',
    'dhparam',
    'minVersion',
    'maxVersion',
    'secureProtocol',
    'secureOptions',
    'ALPNProtocols',
    'ALPNCallback',
    'session',
    'pskCallback',
    'requestCert',
    'isServer',
    'SNICallback',
    'enableTrace',
    'allowPartialTrustChain',
    'clientCertEngine',
    'privateKeyEngine',
    'privateKeyIdentifier',
  ]) {
    if (options[name] !== undefined) unsupported(name);
  }
  if (options.servername !== undefined && !options.servername) unsupported('empty servername');
}

function tlsError(value: unknown): Error {
  // Component bindings throw result errors as Error objects carrying the WIT resource.
  if (value != null && typeof value === 'object' && 'payload' in value && value.payload !== value) {
    return tlsError(value.payload);
  }
  if (value instanceof Error) return value;
  const detail =
    value != null && typeof value === 'object' && 'toDebugString' in value
      ? (value as { toDebugString(): string }).toDebugString()
      : String(value);
  return Object.assign(new Error(`TLS connection failed: ${detail}`), {
    code: 'ERR_TLS_CONNECTION_FAILED',
  });
}

function checkResult(value: unknown): void {
  if (
    value != null &&
    typeof value === 'object' &&
    'tag' in value &&
    value.tag === 'err' &&
    'val' in value
  ) {
    throw tlsError((value as { val: unknown }).val);
  }
}

/** Client TLS using host verification and encryption. The raw socket carries ciphertext only. */
export class TLSSocket extends Socket {
  readonly encrypted = true;
  authorized = false;
  authorizationError: Error | null = null;
  readonly servername: string;
  readonly alpnProtocol = false;
  private readonly transport: Socket;
  private readonly ciphertext = createPushStream();
  private ended = false;
  private handshakeStarted = false;
  private timeoutMs = 0;
  private timer: Timeout | undefined;

  constructor(socket?: Socket, options: ConnectionOptions = {}) {
    super();
    validateOptions(options);
    this.servername = options.servername ?? options.host ?? socket?.remoteAddress ?? 'localhost';
    this.transport = socket ?? new Socket();
    this.connecting = true;
    this.readyState = 'opening';
    this.transport.on('data', (chunk) => this.ciphertext.push(toBytes(chunk)));
    this.transport.on('end', () => this.ciphertext.close());
    this.transport.on('error', (error) => this.fail(error));
    this.transport.on('close', () => {
      this.ciphertext.close();
      if (this.connecting && !this.handshakeStarted && !this.destroyed)
        this.fail(new Error('TLS socket closed before secure connection'));
    });
    queueMicrotask(() => {
      if (this.destroyed) return;
      if (socket === undefined) {
        this.transport.once('connect', () => void this.handshake());
        this.transport.connect({
          port: options.port ?? 443,
          host: options.host ?? 'localhost',
          family: options.family,
        });
      } else if (socket.connecting) socket.once('connect', () => void this.handshake());
      else if (socket.destroyed || !socket.writable)
        this.fail(new Error('TLS requires an open socket'));
      else void this.handshake();
    });
  }

  private fail(value: unknown): void {
    if (this.destroyed) return;
    const error = tlsError(value);
    if (!this.authorized) this.authorizationError = error;
    this.destroy(error);
  }

  override connect(..._args: Parameters<Socket['connect']>): this {
    return unsupported('TLSSocket.connect; use tls.connect(options)');
  }

  private observe(value: unknown): void {
    void Promise.resolve(value)
      .then(checkResult)
      .catch((error) => this.fail(error));
  }

  private transform(value: unknown): AsyncIterable<Uint8Array> {
    if (!Array.isArray(value) || value.length !== 2)
      throw new Error('Invalid wasi:tls stream result');
    this.observe(value[1]);
    return asAsyncIterable<Uint8Array>(value[0]);
  }

  private async sendCiphertext(stream: AsyncIterable<Uint8Array>): Promise<void> {
    try {
      for await (const chunk of stream) {
        if (this.destroyed) return;
        this.transport.write(toBytes(chunk));
      }
      if (!this.destroyed) this.transport.end();
    } catch (error) {
      this.fail(error);
    }
  }

  private async handshake(): Promise<void> {
    if (this.destroyed) return;
    this.handshakeStarted = true;
    try {
      this.emit('connect');
      const connector = new Connector();
      const incoming = this.transform(connector.receive(this.ciphertext.iterable));
      const cleartext = createPushStream();
      const outgoing = this.transform(connector.send(cleartext.iterable));
      this.once('close', () => cleartext.close());
      void this.sendCiphertext(outgoing);
      checkResult(await Connector.connect(connector, this.servername));
      if (this.destroyed) return;
      this.authorized = true;
      this.connecting = false;
      this.pending = false;
      this.readyState = 'open';
      this.outgoing = cleartext;
      for (const chunk of this.buffered) cleartext.push(chunk);
      this.buffered = [];
      if (this.ended) cleartext.close();
      this.localAddress = this.transport.localAddress;
      this.localPort = this.transport.localPort;
      this.remoteAddress = this.transport.remoteAddress;
      this.remotePort = this.transport.remotePort;
      this.remoteFamily = this.transport.remoteFamily;
      this.refreshTimeout();
      this.emit('secureConnect');
      for await (const chunk of incoming) {
        if (this.destroyed) return;
        const bytes = toBytes(chunk);
        this.bytesRead += bytes.length;
        this.refreshTimeout();
        this.readableBuffer.push(bytes);
        this.flushReadable();
      }
      if (!this.destroyed) {
        this.readableEnded = true;
        this.emit('end');
        this.destroy();
      }
    } catch (error) {
      this.fail(error);
    }
  }

  override write(
    data: string | Uint8Array,
    encodingOrCallback?: string | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean {
    if (this.ended) {
      const error = Object.assign(new Error('write after end'), {
        code: 'ERR_STREAM_WRITE_AFTER_END',
      });
      const cb = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
      if (cb) queueMicrotask(() => cb(error));
      else this.fail(error);
      return false;
    }
    this.refreshTimeout();
    return super.write(data, encodingOrCallback, callback);
  }

  override end(
    data?: string | Uint8Array | (() => void),
    encodingOrCallback?: string | (() => void),
    callback?: () => void,
  ): this {
    super.end(data, encodingOrCallback, callback);
    this.ended = true;
    return this;
  }

  override destroy(error?: Error): this {
    if (this.destroyed) return this;
    clearTimeout(this.timer);
    this.ciphertext.close();
    super.destroy(error);
    this.transport.destroy();
    return this;
  }

  override setTimeout(timeout: number, callback?: () => void): this {
    this.timeoutMs = timeout;
    if (callback) this.once('timeout', callback);
    this.refreshTimeout();
    return this;
  }

  private refreshTimeout(): void {
    clearTimeout(this.timer);
    if (this.timeoutMs > 0 && !this.destroyed)
      this.timer = setTimeout(() => this.emit('timeout'), this.timeoutMs);
  }

  getPeerCertificate(): never {
    return unsupported('getPeerCertificate');
  }
  getCipher(): never {
    return unsupported('getCipher');
  }
  getProtocol(): never {
    return unsupported('getProtocol');
  }
  getSession(): never {
    return unsupported('getSession');
  }
  renegotiate(): never {
    return unsupported('renegotiate');
  }
}

export function connect(
  portOrOptions: number | ConnectionOptions,
  hostOrOptionsOrCallback?: string | ConnectionOptions | (() => void),
  optionsOrCallback?: ConnectionOptions | (() => void),
  callback?: () => void,
): TLSSocket {
  let options: ConnectionOptions =
    typeof portOrOptions === 'number' ? { port: portOrOptions } : { ...portOrOptions };
  for (const argument of [hostOrOptionsOrCallback, optionsOrCallback]) {
    if (typeof argument === 'string') options.host = argument;
    else if (typeof argument === 'function') callback = argument;
    else if (argument) options = { ...options, ...argument };
  }
  const socket = new TLSSocket(options.socket, options);
  if (callback) socket.once('secureConnect', callback);
  return socket;
}

export class Server {
  constructor(..._args: unknown[]) {
    unsupported('TLS servers');
  }
}
export function createServer(..._args: unknown[]): never {
  return unsupported('TLS servers');
}
export function createSecureContext(..._args: unknown[]): never {
  return unsupported('createSecureContext');
}
export default { TLSSocket, connect, Server, createServer, createSecureContext };
