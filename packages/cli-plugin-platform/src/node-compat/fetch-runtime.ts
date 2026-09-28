/**
 * Minimal Fetch/URL/encoding globals for QuickJS-based WASI 0.3 guests.
 *
 * WASI 0.3 async HTTP (`wasi:http/handler#handle`) is the component interface,
 * not the WHATWG Fetch API. componentize-qjs embeds QuickJS, which has neither
 * `Request`/`Response` nor `URLSearchParams`. StarlingMonkey does provide
 * Fetch; install these polyfills only when those globals are missing so the
 * application contract (`new Response(...)`) stays unchanged.
 */

export class TextEncoderPolyfill {
  encode(input = ''): Uint8Array {
    const utf8 = unescape(encodeURIComponent(String(input)));
    const bytes = new Uint8Array(utf8.length);
    for (let i = 0; i < utf8.length; i++) bytes[i] = utf8.charCodeAt(i);
    return bytes;
  }
}

export class TextDecoderPolyfill {
  decode(input?: ArrayBuffer | ArrayBufferView | null): string {
    if (input == null) return '';
    const bytes =
      input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i] ?? 0);
    return decodeURIComponent(escape(binary));
  }
}

export class URLSearchParamsPolyfill {
  #pairs: Array<[string, string]> = [];

  constructor(init?: string | URLSearchParamsPolyfill | Record<string, string>) {
    if (typeof init === 'string') {
      const query = init.startsWith('?') ? init.slice(1) : init;
      if (query !== '') {
        for (const part of query.split('&')) {
          const eq = part.indexOf('=');
          const name = decodeURIComponent(eq === -1 ? part : part.slice(0, eq));
          const value = decodeURIComponent(eq === -1 ? '' : part.slice(eq + 1));
          this.#pairs.push([name, value]);
        }
      }
    } else if (init instanceof URLSearchParamsPolyfill) {
      this.#pairs = init.#pairs.map(([name, value]) => [name, value]);
    } else if (init && typeof init === 'object') {
      for (const [name, value] of Object.entries(init)) this.#pairs.push([name, String(value)]);
    }
  }

  get(name: string): string | null {
    const found = this.#pairs.find(([key]) => key === name);
    return found ? found[1] : null;
  }

  *entries(): IterableIterator<[string, string]> {
    yield* this.#pairs;
  }

  [Symbol.iterator](): IterableIterator<[string, string]> {
    return this.entries();
  }

  toString(): string {
    return this.#pairs
      .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
      .join('&');
  }
}

export class URLPolyfill {
  href: string;
  protocol: string;
  hostname: string;
  host: string;
  port: string;
  pathname: string;
  search: string;
  hash: string;
  origin: string;
  searchParams: URLSearchParamsPolyfill;

  constructor(url: string, base?: string) {
    const resolved = resolveUrl(String(url), base === undefined ? undefined : String(base));
    const match = resolved.match(
      /^([a-zA-Z][a-zA-Z0-9+.-]*:)(\/\/)?([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/,
    ) ?? ['', 'http:', '//', '', '/', '', ''];
    this.protocol = match[1] ?? 'http:';
    this.host = match[3] ?? '';
    const hostParts = this.host.split(':');
    this.hostname = hostParts[0] ?? '';
    this.port = hostParts.length > 1 ? (hostParts[hostParts.length - 1] ?? '') : '';
    this.pathname = match[4] || '/';
    this.search = match[5] ?? '';
    this.hash = match[6] ?? '';
    this.origin = `${this.protocol}//${this.host}`;
    this.href = resolved;
    this.searchParams = new URLSearchParamsPolyfill(this.search);
  }

  toString(): string {
    return this.href;
  }
}

function resolveUrl(url: string, base?: string): string {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) return url;
  if (base === undefined) throw new TypeError(`Invalid URL: ${url}`);
  const baseUrl = new URLPolyfill(base);
  if (url.startsWith('/')) return `${baseUrl.origin}${url}`;
  const directory = baseUrl.pathname.slice(0, baseUrl.pathname.lastIndexOf('/') + 1);
  return `${baseUrl.origin}${directory}${url}`;
}

export class HeadersPolyfill {
  #map = new Map<string, string[]>();

  constructor(init?: HeadersPolyfill | Record<string, string> | Array<[string, string]>) {
    if (init instanceof HeadersPolyfill) {
      for (const [name, value] of init.entries()) this.append(name, value);
    } else if (Array.isArray(init)) {
      for (const [name, value] of init) this.append(name, value);
    } else if (init) {
      for (const [name, value] of Object.entries(init)) this.append(name, value);
    }
  }

  #key(name: string): string {
    return name.toLowerCase();
  }

  append(name: string, value: string): void {
    const key = this.#key(name);
    const existing = this.#map.get(key) ?? [];
    existing.push(String(value));
    this.#map.set(key, existing);
  }

  set(name: string, value: string): void {
    this.#map.set(this.#key(name), [String(value)]);
  }

  get(name: string): string | null {
    const values = this.#map.get(this.#key(name));
    return values === undefined ? null : values.join(', ');
  }

  has(name: string): boolean {
    return this.#map.has(this.#key(name));
  }

  delete(name: string): void {
    this.#map.delete(this.#key(name));
  }

  *entries(): IterableIterator<[string, string]> {
    for (const [name, values] of this.#map) {
      for (const value of values) yield [name, value];
    }
  }

  forEach(callback: (value: string, name: string, parent: HeadersPolyfill) => void): void {
    for (const [name, value] of this.entries()) callback(value, name, this);
  }

  [Symbol.iterator](): IterableIterator<[string, string]> {
    return this.entries();
  }
}

export function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return value != null && typeof value === 'object' && Symbol.asyncIterator in value;
}

type BodySource = Uint8Array | AsyncIterable<unknown> | null;

function toBodySource(body: unknown): BodySource {
  if (body == null) return null;
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (isAsyncIterable(body)) return body;
  if (typeof body === 'string') return new TextEncoderPolyfill().encode(body);
  return new TextEncoderPolyfill().encode(String(body));
}

export async function collectBytes(source: BodySource): Promise<Uint8Array> {
  if (source == null) return new Uint8Array();
  if (source instanceof Uint8Array) return source;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of source) {
    const bytes =
      chunk instanceof Uint8Array
        ? chunk
        : typeof chunk === 'number'
          ? new Uint8Array([chunk])
          : new Uint8Array(chunk as ArrayBuffer);
    chunks.push(bytes);
    total += bytes.length;
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}

async function* bytesAsStream(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  if (bytes.length > 0) yield bytes;
}

export function bodyAsStream(source: BodySource): AsyncIterable<Uint8Array> | null {
  if (source == null) return null;
  if (source instanceof Uint8Array) return bytesAsStream(source);
  return source as AsyncIterable<Uint8Array>;
}

export class RequestPolyfill {
  method: string;
  url: string;
  headers: HeadersPolyfill;
  #body: BodySource;

  constructor(input: string | RequestPolyfill, init: Record<string, unknown> = {}) {
    if (input instanceof RequestPolyfill) {
      this.method = String(init.method ?? input.method);
      this.url = input.url;
      this.headers = new HeadersPolyfill(
        (init.headers as HeadersPolyfill | Record<string, string> | undefined) ?? input.headers,
      );
      this.#body = init.body === undefined ? input.#body : toBodySource(init.body);
    } else {
      this.method = String(init.method ?? 'GET').toUpperCase();
      this.url = String(input);
      this.headers = new HeadersPolyfill(
        init.headers as HeadersPolyfill | Record<string, string> | undefined,
      );
      this.#body = toBodySource(init.body);
    }
  }

  get body(): AsyncIterable<Uint8Array> | null {
    return bodyAsStream(this.#body);
  }

  clone(): RequestPolyfill {
    const body = this.#body instanceof Uint8Array ? this.#body.slice() : this.#body;
    return new RequestPolyfill(this, { body });
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    const bytes = await collectBytes(this.#body);
    this.#body = bytes;
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }

  async text(): Promise<string> {
    return new TextDecoderPolyfill().decode(new Uint8Array(await this.arrayBuffer()));
  }

  async json(): Promise<unknown> {
    return JSON.parse(await this.text());
  }
}

export class ResponsePolyfill {
  status: number;
  statusText: string;
  headers: HeadersPolyfill;
  ok: boolean;
  #body: BodySource;

  constructor(body?: unknown, init: Record<string, unknown> = {}) {
    this.status = Number(init.status ?? 200);
    this.statusText = String(init.statusText ?? '');
    this.headers = new HeadersPolyfill(
      init.headers as HeadersPolyfill | Record<string, string> | undefined,
    );
    this.ok = this.status >= 200 && this.status < 300;
    this.#body = toBodySource(body);
  }

  static json(data: unknown, init: Record<string, unknown> = {}): ResponsePolyfill {
    const headers = new HeadersPolyfill(
      init.headers as HeadersPolyfill | Record<string, string> | undefined,
    );
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    return new ResponsePolyfill(JSON.stringify(data), { ...init, headers });
  }

  get body(): AsyncIterable<Uint8Array> | null {
    return bodyAsStream(this.#body);
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    const bytes = await collectBytes(this.#body);
    this.#body = bytes;
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }

  async text(): Promise<string> {
    return new TextDecoderPolyfill().decode(new Uint8Array(await this.arrayBuffer()));
  }

  async json(): Promise<unknown> {
    return JSON.parse(await this.text());
  }
}

const noopConsole = {
  log() {},
  info() {},
  warn() {},
  error() {},
  debug() {},
};

export function installFetchRuntime(force = false): void {
  const global = globalThis as Record<string, unknown>;
  if (force || typeof global.TextEncoder !== 'function') global.TextEncoder = TextEncoderPolyfill;
  if (force || typeof global.TextDecoder !== 'function') global.TextDecoder = TextDecoderPolyfill;
  if (force || typeof global.URLSearchParams !== 'function') {
    global.URLSearchParams = URLSearchParamsPolyfill;
  }
  if (force || typeof global.URL !== 'function') global.URL = URLPolyfill;
  if (force || typeof global.Headers !== 'function') global.Headers = HeadersPolyfill;
  if (force || typeof global.Request !== 'function') global.Request = RequestPolyfill;
  if (force || typeof global.Response !== 'function') global.Response = ResponsePolyfill;
  if (force || typeof global.console !== 'object' || global.console === null) {
    global.console = noopConsole;
  }
}

installFetchRuntime();
