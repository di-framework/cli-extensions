import {
  ClientRequest,
  Agent as HttpAgent,
  type RequestOptions as HttpOptions,
  type IncomingMessage,
} from './http';
import { type ConnectionOptions, connect, TLSSocket, unsupported, validateOptions } from './tls';

export type RequestOptions = Omit<HttpOptions, 'agent'> &
  ConnectionOptions & { agent?: Agent | false };

export class Agent extends HttpAgent {
  readonly protocol = 'https:';
  readonly defaultPort = 443;
  constructor(readonly options: ConnectionOptions = {}) {
    super();
    validateOptions(options);
  }
  createConnection(
    options: ConnectionOptions,
    callback?: (error: Error | null, socket: TLSSocket) => void,
  ): TLSSocket {
    const socket = connect({ ...this.options, ...options });
    if (callback) {
      const onError = (error: Error) => callback(error, socket);
      socket.once('error', onError);
      socket.once('secureConnect', () => {
        socket.removeListener('error', onError);
        callback(null, socket);
      });
    }
    return socket;
  }
}

export const globalAgent = new Agent();

export function request(
  urlOrOptions: string | URL | RequestOptions,
  optionsOrCallback?: RequestOptions | ((res: IncomingMessage) => void),
  maybeCallback?: (res: IncomingMessage) => void,
): ClientRequest {
  let options: RequestOptions;
  const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
  if (typeof urlOrOptions === 'string' || urlOrOptions instanceof URL) {
    const url = new URL(urlOrOptions);
    options = {
      protocol: url.protocol,
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port ? Number(url.port) : 443,
      path: `${url.pathname}${url.search}`,
    };
    if (url.username || url.password) {
      options.headers = {
        authorization: `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')}`,
      };
    }
  } else options = { ...urlOrOptions };
  if (typeof optionsOrCallback === 'object') options = { ...options, ...optionsOrCallback };
  if (options.protocol !== undefined && options.protocol !== 'https:') {
    throw Object.assign(
      new TypeError(`Protocol "${options.protocol}" not supported. Expected "https:"`),
      { code: 'ERR_INVALID_PROTOCOL' },
    );
  }
  validateOptions(options);
  const agent = options.agent === false ? new Agent() : (options.agent ?? globalAgent);
  const connection = options.createConnection;
  const tlsOptions = {
    ...options,
    host: options.hostname ?? options.host ?? 'localhost',
    port: Number(options.port ?? 443),
  };
  const req = new ClientRequest(
    {
      ...options,
      protocol: 'https:',
      defaultPort: 443,
      createConnection: () => {
        const socket = connection ? connection(tlsOptions) : agent.createConnection(tlsOptions);
        if (!(socket instanceof TLSSocket)) {
          socket?.destroy();
          return unsupported('HTTPS connection without a TLSSocket');
        }
        return socket;
      },
    },
    callback,
  );
  if (options.timeout !== undefined)
    req.once('socket', (socket) => socket.setTimeout(options.timeout, () => req.emit('timeout')));
  return req;
}

export function get(
  urlOrOptions: string | URL | RequestOptions,
  optionsOrCallback?: RequestOptions | ((res: IncomingMessage) => void),
  callback?: (res: IncomingMessage) => void,
): ClientRequest {
  const req = request(urlOrOptions, optionsOrCallback, callback);
  req.end();
  return req;
}

export class Server {
  constructor(..._args: unknown[]) {
    unsupported('HTTPS servers');
  }
}
export function createServer(..._args: unknown[]): never {
  return unsupported('HTTPS servers');
}
export default { Agent, globalAgent, request, get, Server, createServer };
