import { EventEmitter } from 'node:events';
import { concatBytes, toBytes, toNodeBuffer } from './bytes';
import {
  CHUNKED_END,
  ChunkedDecoder,
  contentLengthOf,
  encodeChunk,
  type HeaderMap,
  headerValue,
  isChunked,
  isUpgrade,
  MAX_HEADER_SIZE,
  parseHttpRequest,
  parseHttpResponse,
  serializeHttpRequest,
  serializeHttpResponse,
} from './http-parser';
import {
  type AddressInfo,
  createConnection,
  createServer as createNetServer,
  type Server as NetServer,
  type Socket,
} from './net';

export const METHODS = [
  'ACL',
  'BIND',
  'CHECKOUT',
  'CONNECT',
  'COPY',
  'DELETE',
  'GET',
  'HEAD',
  'LINK',
  'LOCK',
  'M-SEARCH',
  'MERGE',
  'MKACTIVITY',
  'MKCALENDAR',
  'MKCOL',
  'MOVE',
  'NOTIFY',
  'OPTIONS',
  'PATCH',
  'POST',
  'PRI',
  'PROPFIND',
  'PROPPATCH',
  'PURGE',
  'PUT',
  'REBIND',
  'REPORT',
  'SEARCH',
  'SOURCE',
  'SUBSCRIBE',
  'TRACE',
  'UNBIND',
  'UNLINK',
  'UNLOCK',
  'UNSUBSCRIBE',
];

export const STATUS_CODES: Record<number, string> = {
  100: 'Continue',
  101: 'Switching Protocols',
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  408: 'Request Timeout',
  409: 'Conflict',
  411: 'Length Required',
  413: 'Payload Too Large',
  414: 'URI Too Long',
  415: 'Unsupported Media Type',
  426: 'Upgrade Required',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
  505: 'HTTP Version Not Supported',
};

export const maxHeaderSize = MAX_HEADER_SIZE;

type RequestListener = (req: IncomingMessage, res: ServerResponse) => void;

function emitError(emitter: EventEmitter, error: unknown): void {
  if (typeof emitter.listenerCount === 'function' && emitter.listenerCount('error') === 0) return;
  emitter.emit('error', error);
}

function lowerHeaders(input: Record<string, unknown> | undefined): HeaderMap {
  const headers: HeaderMap = {};
  if (input === undefined) return headers;
  for (const [name, value] of Object.entries(input)) {
    if (value === undefined) continue;
    headers[name.toLowerCase()] = Array.isArray(value) ? value.map(String) : String(value);
  }
  return headers;
}

export class IncomingMessage extends EventEmitter {
  httpVersion = '1.1';
  httpVersionMajor = 1;
  httpVersionMinor = 1;
  complete = false;
  aborted = false;
  method = 'GET';
  url = '/';
  statusCode = 200;
  statusMessage = '';
  headers: HeaderMap = {};
  rawHeaders: string[] = [];
  socket: Socket;
  readable = true;

  constructor(socket: Socket) {
    super();
    this.socket = socket;
  }

  pushBody(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.emit('data', toNodeBuffer(chunk));
  }

  finish(): void {
    if (this.complete) return;
    this.complete = true;
    this.readable = false;
    this.emit('end');
  }

  setTimeout(_msecs: number, callback?: () => void): this {
    if (typeof callback === 'function') this.once('timeout', callback);
    return this;
  }
}

export class ServerResponse extends EventEmitter {
  statusCode = 200;
  statusMessage = '';
  headersSent = false;
  finished = false;
  writable = true;
  writableEnded = false;
  req: IncomingMessage;
  socket: Socket;
  headers: HeaderMap = {};
  chunked = false;
  bodyChunks: Uint8Array[] = [];

  constructor(req: IncomingMessage, socket: Socket) {
    super();
    this.req = req;
    this.socket = socket;
  }

  setHeader(name: string, value: string | number | readonly string[]): this {
    this.headers[name.toLowerCase()] = Array.isArray(value)
      ? [...value].map(String)
      : String(value);
    return this;
  }

  getHeader(name: string): string | string[] | undefined {
    return this.headers[name.toLowerCase()];
  }

  removeHeader(name: string): this {
    delete this.headers[name.toLowerCase()];
    return this;
  }

  writeHead(
    statusCode: number,
    statusMessageOrHeaders?: string | HeaderMap,
    maybeHeaders?: HeaderMap,
  ): this {
    this.statusCode = statusCode;
    if (typeof statusMessageOrHeaders === 'string') {
      this.statusMessage = statusMessageOrHeaders;
      if (maybeHeaders !== undefined) Object.assign(this.headers, lowerHeaders(maybeHeaders));
    } else if (statusMessageOrHeaders !== undefined) {
      Object.assign(this.headers, lowerHeaders(statusMessageOrHeaders));
    }
    this.flushHeaders();
    return this;
  }

  flushHeaders(): void {
    if (this.headersSent) return;
    if (this.statusMessage.length === 0) {
      this.statusMessage = STATUS_CODES[this.statusCode] ?? '';
    }
    this.headersSent = true;
    this.socket.write(serializeHttpResponse(this.statusCode, this.statusMessage, this.headers));
  }

  write(
    chunk: string | Uint8Array,
    encodingOrCallback?: string | ((error?: Error | null) => void),
    maybeCallback?: (error?: Error | null) => void,
  ): boolean {
    const callback = typeof encodingOrCallback === 'function' ? encodingOrCallback : maybeCallback;
    if (this.writableEnded) {
      const error = new Error('write after end') as Error & { code: string };
      error.code = 'ERR_STREAM_WRITE_AFTER_END';
      if (callback !== undefined) queueMicrotask(() => callback(error));
      else emitError(this, error);
      return false;
    }
    const bytes = toBytes(chunk);
    if (!this.headersSent) {
      if (headerValue(this.headers, 'content-length') === undefined) {
        this.setHeader('Transfer-Encoding', 'chunked');
        this.chunked = true;
      }
      this.flushHeaders();
    }
    if (bytes.length > 0) {
      this.socket.write(this.chunked ? encodeChunk(bytes) : bytes);
    }
    if (callback !== undefined) queueMicrotask(() => callback(null));
    return true;
  }

  end(
    chunk?: string | Uint8Array | (() => void),
    encodingOrCallback?: string | (() => void),
    maybeCallback?: () => void,
  ): this {
    const callback =
      typeof chunk === 'function'
        ? chunk
        : typeof encodingOrCallback === 'function'
          ? encodingOrCallback
          : maybeCallback;
    const data = typeof chunk === 'function' || chunk === undefined ? undefined : chunk;
    if (this.writableEnded) {
      if (typeof callback === 'function') queueMicrotask(callback);
      return this;
    }
    this.writableEnded = true;
    this.finished = true;
    this.writable = false;
    if (!this.headersSent) {
      const bytes = data === undefined ? new Uint8Array() : toBytes(data);
      if (headerValue(this.headers, 'content-length') === undefined) {
        this.setHeader('Content-Length', String(bytes.length));
      }
      this.flushHeaders();
      if (bytes.length > 0) this.socket.write(bytes);
    } else if (data !== undefined) {
      const bytes = toBytes(data);
      this.socket.write(this.chunked ? encodeChunk(bytes) : bytes);
    }
    if (this.chunked) this.socket.write(CHUNKED_END);
    const connection = headerValue(this.headers, 'connection')?.toLowerCase();
    if (connection === 'close' || this.req.httpVersion === '1.0') this.socket.end();
    queueMicrotask(() => {
      this.emit('finish');
      if (typeof callback === 'function') callback();
    });
    return this;
  }

  setTimeout(_msecs: number, callback?: () => void): this {
    if (typeof callback === 'function') this.once('timeout', callback);
    return this;
  }
}

export class Agent extends EventEmitter {
  keepAlive = false;
  maxSockets = Infinity;
  destroy(): void {}
}

export const globalAgent = new Agent();

export type RequestOptions = {
  protocol?: string;
  host?: string;
  hostname?: string;
  port?: number | string;
  path?: string;
  method?: string;
  headers?: Record<string, unknown>;
  timeout?: number;
  createConnection?: (
    options: RequestOptions,
    callback?: (error: Error | null, socket: Socket) => void,
  ) => Socket;
  defaultPort?: number;
  agent?: Agent | false;
};

export class ClientRequest extends EventEmitter {
  method = 'GET';
  path = '/';
  host = 'localhost';
  port = 80;
  headers: HeaderMap = {};
  socket: Socket | undefined;
  aborted = false;
  writable = true;
  writableEnded = false;
  headersSent = false;
  body: Uint8Array[] = [];
  options: RequestOptions;

  constructor(options: RequestOptions, callback?: (res: IncomingMessage) => void) {
    super();
    this.options = options;
    this.method = (options.method ?? 'GET').toUpperCase();
    this.path = options.path ?? '/';
    this.host = options.hostname ?? options.host ?? 'localhost';
    this.port = Number(options.port ?? options.defaultPort ?? 80);
    this.headers = lowerHeaders(options.headers);
    if (typeof callback === 'function') this.once('response', callback);
    if (headerValue(this.headers, 'host') === undefined) {
      const hostname =
        this.host.includes(':') && !this.host.startsWith('[') ? `[${this.host}]` : this.host;
      const hostHeader =
        this.port === (options.defaultPort ?? 80) ? hostname : `${hostname}:${this.port}`;
      this.headers.host = hostHeader;
    }
    queueMicrotask(() => this.open());
  }

  setHeader(name: string, value: string | number | readonly string[]): this {
    this.headers[name.toLowerCase()] = Array.isArray(value)
      ? [...value].map(String)
      : String(value);
    return this;
  }

  getHeader(name: string): string | string[] | undefined {
    return this.headers[name.toLowerCase()];
  }

  write(
    chunk: string | Uint8Array,
    encodingOrCallback?: string | (() => void),
    maybeCallback?: () => void,
  ): boolean {
    const callback = typeof encodingOrCallback === 'function' ? encodingOrCallback : maybeCallback;
    this.body.push(toBytes(chunk));
    if (typeof callback === 'function') queueMicrotask(callback);
    return true;
  }

  end(
    chunk?: string | Uint8Array | (() => void),
    encodingOrCallback?: string | (() => void),
    maybeCallback?: () => void,
  ): this {
    const callback =
      typeof chunk === 'function'
        ? chunk
        : typeof encodingOrCallback === 'function'
          ? encodingOrCallback
          : maybeCallback;
    if (typeof chunk !== 'function' && chunk !== undefined) this.body.push(toBytes(chunk));
    this.writableEnded = true;
    this.writable = false;
    if (typeof callback === 'function') this.once('finish', callback);
    this.flush();
    return this;
  }

  abort(): void {
    this.aborted = true;
    this.socket?.destroy();
    this.emit('abort');
  }

  destroy(error?: Error): this {
    this.aborted = true;
    this.socket?.destroy(error);
    return this;
  }

  setTimeout(msecs: number, callback?: () => void): this {
    if (typeof callback === 'function') this.once('timeout', callback);
    this.socket?.setTimeout(msecs, () => this.emit('timeout'));
    return this;
  }

  open(): void {
    if (this.aborted) return;
    const onSocket = (socket: Socket) => {
      if (this.socket === socket) return;
      if (this.aborted) {
        socket.destroy();
        return;
      }
      this.socket = socket;
      this.emit('socket', socket);
      socket.on('error', (error) => emitError(this, error));
      if (socket.connecting)
        socket.once('encrypted' in socket ? 'secureConnect' : 'connect', () => this.flush());
      else this.flush();
    };
    if (this.options.createConnection !== undefined) {
      try {
        const created = this.options.createConnection(this.options, (error, socket) => {
          if (error !== null) emitError(this, error);
          else onSocket(socket);
        });
        if (created !== undefined) onSocket(created);
      } catch (error) {
        emitError(this, error);
      }
      return;
    }
    onSocket(createConnection({ port: this.port, host: this.host }));
  }

  flush(): void {
    if (this.aborted || this.socket === undefined || this.headersSent) return;
    if (this.socket.connecting) return;
    if (!this.writableEnded) return;
    const body = concatBytes(...this.body);
    const chunked = isChunked(this.headers);
    if (chunked) delete this.headers['content-length'];
    else if (headerValue(this.headers, 'content-length') === undefined && body.length > 0) {
      this.headers['content-length'] = String(body.length);
    }
    this.headersSent = true;
    void this.readResponse(this.socket);
    this.socket.write(serializeHttpRequest(this.method, this.path, this.headers));
    if (chunked) {
      for (const chunk of this.body) {
        if (chunk.length > 0) this.socket.write(encodeChunk(chunk));
      }
      this.socket.write(CHUNKED_END);
    } else if (body.length > 0) this.socket.write(body);
    this.emit('finish');
  }

  async readResponse(socket: Socket): Promise<void> {
    let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array();
    let complete = false;
    let failed = false;
    let closeDelimited: IncomingMessage | undefined;
    socket.on('error', () => {
      failed = true;
    });
    socket.once('end', () => {
      if (complete || failed || this.aborted) return;
      if (closeDelimited !== undefined) closeDelimited.finish();
      else
        emitError(
          this,
          Object.assign(new Error('Socket ended before the HTTP response completed'), {
            code: 'ECONNRESET',
          }),
        );
    });
    const onData = (chunk: unknown) => {
      buffer = concatBytes(buffer, toBytes(chunk));
      let parsed: ReturnType<typeof parseHttpResponse>;
      try {
        parsed = parseHttpResponse(buffer);
      } catch (error) {
        failed = true;
        emitError(this, error);
        return;
      }
      if (parsed === undefined) {
        if (buffer.length > MAX_HEADER_SIZE) emitError(this, new Error('HTTP header too large'));
        return;
      }
      socket.removeListener('data', onData);
      const leftover = buffer.subarray(parsed.headerLength);
      const incoming = new IncomingMessage(socket);
      incoming.once('end', () => {
        complete = true;
      });
      incoming.httpVersion = parsed.httpVersion;
      incoming.statusCode = parsed.statusCode;
      incoming.statusMessage = parsed.statusMessage;
      incoming.headers = parsed.headers;
      incoming.rawHeaders = parsed.rawHeaders;
      if (isUpgrade(parsed.headers) && parsed.statusCode === 101) {
        complete = true;
        socket.pause();
        this.emit('upgrade', incoming, socket, toNodeBuffer(leftover));
        return;
      }
      this.emit('response', incoming);
      const noBody =
        this.method === 'HEAD' || parsed.statusCode === 204 || parsed.statusCode === 304;
      if (noBody) {
        complete = true;
        incoming.finish();
        return;
      }
      if (isChunked(parsed.headers)) {
        readChunkedBody(socket, incoming, leftover, this, () => {});
        return;
      }
      const length = contentLengthOf(parsed.headers);
      if (length === undefined) {
        closeDelimited = incoming;
        if (leftover.length > 0) incoming.pushBody(leftover);
        socket.on('data', (chunk) => incoming.pushBody(toBytes(chunk)));
        return;
      }
      if (leftover.length > 0) incoming.pushBody(leftover.subarray(0, length));
      if (leftover.length >= length) incoming.finish();
      else {
        let remaining = length - leftover.length;
        const bodyData = (chunk: unknown) => {
          const bytes = toBytes(chunk);
          const take = bytes.subarray(0, remaining);
          remaining -= take.length;
          incoming.pushBody(take);
          if (remaining <= 0) {
            socket.removeListener('data', bodyData);
            incoming.finish();
          }
        };
        socket.on('data', bodyData);
      }
    };
    socket.on('data', onData);
  }
}

function readChunkedBody(
  socket: Socket,
  incoming: IncomingMessage,
  initial: Uint8Array,
  owner: EventEmitter,
  onComplete: (leftover: Uint8Array) => void,
): void {
  const decoder = new ChunkedDecoder();
  const onData = (chunk: unknown) => {
    let leftover: Uint8Array | undefined;
    try {
      leftover = decoder.write(toBytes(chunk), (data) => incoming.pushBody(data));
    } catch (error) {
      socket.removeListener('data', onData);
      socket.destroy();
      emitError(owner, error);
      return;
    }
    if (leftover !== undefined) {
      socket.removeListener('data', onData);
      incoming.finish();
      onComplete(leftover);
    }
  };
  socket.on('data', onData);
  onData(initial);
}

export class Server extends EventEmitter {
  netServer: NetServer;
  listening = false;
  maxHeadersCount = 2000;
  timeout = 0;
  requestListener: RequestListener | undefined;

  constructor(requestListener?: RequestListener) {
    super();
    this.requestListener = requestListener;
    if (requestListener !== undefined) this.on('request', requestListener);
    this.netServer = createNetServer((socket) => this.handleConnection(socket));
    this.netServer.on('listening', () => {
      this.listening = true;
      this.emit('listening');
    });
    this.netServer.on('error', (error) => emitError(this, error));
    this.netServer.on('close', () => {
      this.listening = false;
      this.emit('close');
    });
  }

  listen(
    portOrOptions?: number | { port?: number; host?: string },
    hostnameOrCallback?: string | (() => void),
    backlogOrCallback?: number | (() => void),
    maybeCallback?: () => void,
  ): this {
    this.netServer.listen(portOrOptions, hostnameOrCallback, backlogOrCallback, maybeCallback);
    return this;
  }

  address(): AddressInfo | null {
    return this.netServer.address();
  }

  close(callback?: (error?: Error) => void): this {
    this.netServer.close(callback);
    return this;
  }

  ref(): this {
    this.netServer.ref();
    return this;
  }

  unref(): this {
    this.netServer.unref();
    return this;
  }

  handleConnection(socket: Socket): void {
    let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array();
    const onData = (chunk: unknown) => {
      buffer = concatBytes(buffer, toBytes(chunk));
      let parsed: ReturnType<typeof parseHttpRequest>;
      try {
        parsed = parseHttpRequest(buffer);
      } catch (error) {
        emitError(this, error);
        socket.destroy();
        return;
      }
      if (parsed === undefined) {
        if (buffer.length > MAX_HEADER_SIZE) socket.destroy();
        return;
      }
      const leftover = buffer.subarray(parsed.headerLength);
      buffer = new Uint8Array();
      const req = new IncomingMessage(socket);
      req.method = parsed.method;
      req.url = parsed.url;
      req.httpVersion = parsed.httpVersion;
      req.headers = parsed.headers;
      req.rawHeaders = parsed.rawHeaders;
      if (isUpgrade(parsed.headers)) {
        socket.pause();
        socket.removeListener('data', onData);
        if (typeof this.listenerCount === 'function' && this.listenerCount('upgrade') === 0) {
          socket.destroy();
          return;
        }
        this.emit('upgrade', req, socket, toNodeBuffer(leftover));
        return;
      }
      const res = new ServerResponse(req, socket);
      if (isChunked(parsed.headers)) {
        socket.removeListener('data', onData);
        this.emit('request', req, res);
        readChunkedBody(socket, req, leftover, this, (rest) => {
          socket.on('data', onData);
          if (rest.length > 0) onData(rest);
        });
        return;
      }
      const length = contentLengthOf(parsed.headers);
      const hasBody = length !== undefined && length > 0 && req.method !== 'HEAD';
      this.emit('request', req, res);
      if (!hasBody) {
        if (leftover.length > 0) buffer = leftover;
        req.finish();
        return;
      }
      let remaining = length;
      if (leftover.length > 0) {
        const take = leftover.subarray(0, remaining);
        remaining -= take.length;
        req.pushBody(take);
        buffer = leftover.subarray(take.length);
      }
      if (remaining <= 0) {
        req.finish();
        return;
      }
      const bodyData = (next: unknown) => {
        const bytes = toBytes(next);
        const take = bytes.subarray(0, remaining);
        remaining -= take.length;
        req.pushBody(take);
        if (remaining <= 0) {
          socket.removeListener('data', bodyData);
          socket.on('data', onData);
          buffer = bytes.subarray(take.length);
          req.finish();
        }
      };
      socket.removeListener('data', onData);
      socket.on('data', bodyData);
    };
    socket.on('data', onData);
    socket.on('error', (error) => emitError(this, error));
  }
}

export function createServer(
  options?: { IncomingMessage?: unknown; ServerResponse?: unknown } | RequestListener,
  listener?: RequestListener,
): Server {
  if (typeof options === 'function') return new Server(options);
  return new Server(listener);
}

export function request(
  urlOrOptions: string | URL | RequestOptions,
  optionsOrCallback?: RequestOptions | ((res: IncomingMessage) => void),
  maybeCallback?: (res: IncomingMessage) => void,
): ClientRequest {
  let options: RequestOptions = {};
  let callback = maybeCallback;
  if (typeof urlOrOptions === 'string' || urlOrOptions instanceof URL) {
    const url = typeof urlOrOptions === 'string' ? new URL(urlOrOptions) : urlOrOptions;
    options = {
      host: url.hostname,
      hostname: url.hostname,
      port: url.port === '' ? 80 : Number(url.port),
      path: `${url.pathname}${url.search}`,
      protocol: url.protocol,
    };
    if (typeof optionsOrCallback === 'function') callback = optionsOrCallback;
    else if (optionsOrCallback !== undefined) options = { ...options, ...optionsOrCallback };
  } else {
    options = urlOrOptions;
    if (typeof optionsOrCallback === 'function') callback = optionsOrCallback;
  }
  if (options.protocol !== undefined && options.protocol !== 'http:') {
    throw Object.assign(
      new TypeError(`Protocol "${options.protocol}" not supported. Expected "http:"`),
      { code: 'ERR_INVALID_PROTOCOL' },
    );
  }
  return new ClientRequest(options, callback);
}

export function get(
  urlOrOptions: string | URL | RequestOptions,
  optionsOrCallback?: RequestOptions | ((res: IncomingMessage) => void),
  maybeCallback?: (res: IncomingMessage) => void,
): ClientRequest {
  const req = request(urlOrOptions, optionsOrCallback, maybeCallback);
  req.method = 'GET';
  req.end();
  return req;
}

export default {
  METHODS,
  STATUS_CODES,
  maxHeaderSize,
  IncomingMessage,
  ServerResponse,
  Server,
  Agent,
  globalAgent,
  ClientRequest,
  createServer,
  request,
  get,
};
