/**
 * Minimal Fetch/URL/encoding globals for QuickJS-based WASI 0.3 guests.
 *
 * WASI 0.3 async HTTP (`wasi:http/handler#handle`) is the component interface,
 * not the WHATWG Fetch API. componentize-qjs embeds QuickJS, which has neither
 * `Request`/`Response`, `URLSearchParams`, or `FormData`. StarlingMonkey does
 * provide Fetch; install these polyfills when a global is missing or only
 * partly implemented so the application contract (`new Response(...)`,
 * `request.formData()`) stays unchanged.
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
  #onChange?: () => void;

  constructor(init?: string | URLSearchParamsPolyfill | Record<string, string>) {
    if (typeof init === 'string') {
      const query = init.startsWith('?') ? init.slice(1) : init;
      if (query !== '') {
        for (const part of query.split('&')) {
          const eq = part.indexOf('=');
          const decode = (text: string) => decodeURIComponent(text.replaceAll('+', ' '));
          const name = decode(eq === -1 ? part : part.slice(0, eq));
          const value = decode(eq === -1 ? '' : part.slice(eq + 1));
          this.#pairs.push([name, value]);
        }
      }
    } else if (init instanceof URLSearchParamsPolyfill) {
      this.#pairs = init.#pairs.map(([name, value]) => [name, value]);
    } else if (init && typeof init === 'object') {
      for (const [name, value] of Object.entries(init)) this.#pairs.push([name, String(value)]);
    }
  }

  /** Lets `URL` refresh `search` and `href` after `set`, `append`, or `delete`. */
  bind(onChange: () => void): void {
    this.#onChange = onChange;
  }

  get(name: string): string | null {
    const found = this.#pairs.find(([key]) => key === name);
    return found ? found[1] : null;
  }

  getAll(name: string): string[] {
    return this.#pairs.filter(([key]) => key === name).map(([, value]) => value);
  }

  has(name: string): boolean {
    return this.#pairs.some(([key]) => key === name);
  }

  append(name: string, value: string): void {
    this.#pairs.push([name, String(value)]);
    this.#onChange?.();
  }

  set(name: string, value: string): void {
    const next: Array<[string, string]> = [];
    let placed = false;
    for (const pair of this.#pairs) {
      if (pair[0] !== name) next.push(pair);
      else if (!placed) {
        next.push([name, String(value)]);
        placed = true;
      }
    }
    if (!placed) next.push([name, String(value)]);
    this.#pairs = next;
    this.#onChange?.();
  }

  delete(name: string): void {
    this.#pairs = this.#pairs.filter(([key]) => key !== name);
    this.#onChange?.();
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
    this.searchParams.bind(() => this.#sync());
  }

  #sync(): void {
    const query = this.searchParams.toString();
    this.search = query === '' ? '' : `?${query}`;
    this.href = `${this.origin}${this.pathname}${this.search}${this.hash}`;
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

  /**
   * Fetch's sort-and-combine list: one combined value per name, except
   * `set-cookie`, which stays one pair per value. `entries()` still yields
   * each stored value so the HTTP adapter can forward multi-value headers.
   */
  *#combined(): IterableIterator<[string, string]> {
    for (const name of [...this.#map.keys()].sort()) {
      const values = this.#map.get(name) ?? [];
      if (values.length === 0) continue;
      if (name === 'set-cookie') {
        for (const value of values) yield [name, value];
      } else {
        yield [name, values.join(', ')];
      }
    }
  }

  *keys(): IterableIterator<string> {
    for (const [name] of this.#combined()) yield name;
  }

  *values(): IterableIterator<string> {
    for (const [, value] of this.#combined()) yield value;
  }

  /** Every `Set-Cookie` value, in order, without comma-joining. */
  getSetCookie(): string[] {
    return [...(this.#map.get('set-cookie') ?? [])];
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
      this.#body = init.body === undefined ? input.#body : bodyFromInit(init.body, this.headers);
    } else {
      this.method = String(init.method ?? 'GET').toUpperCase();
      this.url = String(input);
      this.headers = new HeadersPolyfill(
        init.headers as HeadersPolyfill | Record<string, string> | undefined,
      );
      this.#body = bodyFromInit(init.body, this.headers);
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

  async formData(): Promise<FormDataPolyfill> {
    return formDataFromBody(this.headers, await this.arrayBuffer());
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
    this.#body = bodyFromInit(body, this.headers);
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

  async formData(): Promise<FormDataPolyfill> {
    return formDataFromBody(this.headers, await this.arrayBuffer());
  }
}

export class AbortSignalPolyfill {
  aborted = false;
  reason: unknown = undefined;
  onabort: ((event: { type: 'abort' }) => void) | null = null;
  #listeners: Array<(event: { type: 'abort' }) => void> = [];

  addEventListener(type: string, listener: (event: { type: 'abort' }) => void): void {
    if (type === 'abort') this.#listeners.push(listener);
  }

  removeEventListener(type: string, listener: (event: { type: 'abort' }) => void): void {
    if (type !== 'abort') return;
    this.#listeners = this.#listeners.filter((item) => item !== listener);
  }

  dispatchEvent(event: { type: 'abort' }): boolean {
    for (const listener of this.#listeners) listener(event);
    return true;
  }

  throwIfAborted(): void {
    if (this.aborted)
      throw this.reason instanceof Error ? this.reason : new Error('This operation was aborted');
  }
}

export class AbortControllerPolyfill {
  readonly signal = new AbortSignalPolyfill();

  abort(reason?: unknown): void {
    if (this.signal.aborted) return;
    this.signal.aborted = true;
    this.signal.reason = reason ?? new Error('This operation was aborted');
    const event = { type: 'abort' as const };
    this.signal.onabort?.(event);
    this.signal.dispatchEvent(event);
  }
}

type BlobPart = string | ArrayBuffer | ArrayBufferView;

const blobContents = new WeakMap<BlobPolyfill, Uint8Array>();

function bytesOfPart(part: BlobPart): Uint8Array {
  if (typeof part === 'string') return new TextEncoder().encode(part);
  if (part instanceof ArrayBuffer) return new Uint8Array(part);
  return new Uint8Array(part.buffer, part.byteOffset, part.byteLength);
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function readBlobBytes(blob: BlobPolyfill): Uint8Array {
  return blobContents.get(blob) ?? new Uint8Array();
}

/** QuickJS has no Blob. unenv's File extends it while Node streams load. */
export class BlobPolyfill {
  readonly size: number;
  readonly type: string;

  constructor(parts: BlobPart[] = [], options?: { type?: string }) {
    const bytes = concatBytes(parts.map((part) => bytesOfPart(part)));
    blobContents.set(this, bytes);
    this.size = bytes.byteLength;
    this.type = options?.type ?? '';
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return readBlobBytes(this).slice().buffer;
  }

  async text(): Promise<string> {
    return new TextDecoderPolyfill().decode(readBlobBytes(this));
  }
}

/** File entry returned by `FormData` for multipart parts that carry a filename. */
export class FilePolyfill extends BlobPolyfill {
  readonly name: string;
  readonly lastModified: number;

  constructor(parts: BlobPart[], name: string, options?: { type?: string; lastModified?: number }) {
    super(parts, options);
    this.name = String(name);
    this.lastModified = options?.lastModified ?? Date.now();
  }
}

type FormDataEntryValue = string | FilePolyfill;

export class FormDataPolyfill {
  #entries: Array<[string, FormDataEntryValue]> = [];

  constructor(init?: FormDataPolyfill) {
    if (init instanceof FormDataPolyfill) {
      for (const [name, value] of init.entries()) {
        if (typeof value === 'string') this.append(name, value);
        else this.append(name, value, value.name);
      }
    }
  }

  append(name: string, value: string | BlobPolyfill, filename?: string): void {
    this.#entries.push([String(name), formEntry(value, filename)]);
  }

  set(name: string, value: string | BlobPolyfill, filename?: string): void {
    const entry = formEntry(value, filename);
    const next: Array<[string, FormDataEntryValue]> = [];
    let placed = false;
    for (const pair of this.#entries) {
      if (pair[0] !== name) next.push(pair);
      else if (!placed) {
        next.push([String(name), entry]);
        placed = true;
      }
    }
    if (!placed) next.push([String(name), entry]);
    this.#entries = next;
  }

  get(name: string): FormDataEntryValue | null {
    const found = this.#entries.find(([key]) => key === name);
    return found ? found[1] : null;
  }

  getAll(name: string): FormDataEntryValue[] {
    return this.#entries.filter(([key]) => key === name).map(([, value]) => value);
  }

  has(name: string): boolean {
    return this.#entries.some(([key]) => key === name);
  }

  delete(name: string): void {
    this.#entries = this.#entries.filter(([key]) => key !== name);
  }

  *entries(): IterableIterator<[string, FormDataEntryValue]> {
    yield* this.#entries;
  }

  *keys(): IterableIterator<string> {
    for (const [name] of this.#entries) yield name;
  }

  *values(): IterableIterator<FormDataEntryValue> {
    for (const [, value] of this.#entries) yield value;
  }

  forEach(
    callback: (value: FormDataEntryValue, name: string, parent: FormDataPolyfill) => void,
  ): void {
    const pairs = this.#entries;
    for (let index = 0; index < pairs.length; index++) {
      const pair = pairs[index] as [string, FormDataEntryValue];
      callback(pair[1], pair[0], this);
    }
  }

  [Symbol.iterator](): IterableIterator<[string, FormDataEntryValue]> {
    return this.entries();
  }
}

function formEntry(value: string | BlobPolyfill, filename?: string): FormDataEntryValue {
  if (typeof value !== 'object' || value === null) return String(value);
  if (!(value instanceof BlobPolyfill)) {
    throw new TypeError('FormData file fields must be Blob or File objects');
  }
  if (value instanceof FilePolyfill && filename === undefined) return value;
  return new FilePolyfill([readBlobBytes(value)], filename ?? 'blob', { type: value.type });
}

function isFormDataBody(body: unknown): body is FormDataPolyfill {
  if (body instanceof FormDataPolyfill) return true;
  const ctor = (globalThis as { FormData?: unknown }).FormData;
  return typeof ctor === 'function' && body instanceof (ctor as new (...args: never[]) => object);
}

function createBoundary(): string {
  let token = '';
  for (let i = 0; i < 16; i++) {
    token += Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, '0');
  }
  return `----diFormBoundary${token}`;
}

function escapeDisposition(value: string): string {
  return value.replaceAll('"', '%22').replaceAll('\r', '').replaceAll('\n', '');
}

function encodeMultipart(
  entries: Iterable<[string, FormDataEntryValue]>,
  boundary: string,
): Uint8Array {
  const encoder = new TextEncoderPolyfill();
  const chunks: Uint8Array[] = [];
  const push = (text: string) => chunks.push(encoder.encode(text));
  for (const [name, value] of entries) {
    const quotedName = escapeDisposition(name);
    push(`--${boundary}\r\n`);
    if (typeof value === 'string') {
      push(`Content-Disposition: form-data; name="${quotedName}"\r\n\r\n${value}\r\n`);
    } else if (value instanceof BlobPolyfill) {
      const type = value.type === '' ? '' : `Content-Type: ${value.type}\r\n`;
      const filename = escapeDisposition(value.name);
      push(
        `Content-Disposition: form-data; name="${quotedName}"; filename="${filename}"\r\n` +
          `${type}\r\n`,
      );
      chunks.push(readBlobBytes(value));
      push('\r\n');
    } else {
      throw new TypeError('FormData file fields must be Blob or File objects');
    }
  }
  push(`--${boundary}--\r\n`);
  return concatBytes(chunks);
}

function encodeFormBody(body: FormDataPolyfill): { bytes: Uint8Array; contentType: string } {
  const boundary = createBoundary();
  return {
    bytes: encodeMultipart(body.entries(), boundary),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function bodyFromInit(body: unknown, headers: HeadersPolyfill): BodySource {
  if (!isFormDataBody(body)) return toBodySource(body);
  const encoded = encodeFormBody(body);
  if (!headers.has('content-type')) headers.set('content-type', encoded.contentType);
  return encoded.bytes;
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  if (needle.length === 0) return from;
  const end = haystack.length - needle.length;
  for (let i = from; i <= end; i++) {
    let matched = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return i;
  }
  return -1;
}

function parseContentType(header: string | null): { type: string; boundary?: string } {
  if (header == null || header === '') return { type: '' };
  const [rawType, ...params] = header.split(';');
  let boundary: string | undefined;
  for (const param of params) {
    const eq = param.indexOf('=');
    if (eq === -1) continue;
    if (param.slice(0, eq).trim().toLowerCase() !== 'boundary') continue;
    let value = param.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    boundary = value;
  }
  return { type: (rawType ?? '').trim().toLowerCase(), boundary };
}

function headerValue(block: string, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const line of block.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    if (line.slice(0, colon).trim().toLowerCase() !== lower) continue;
    return line.slice(colon + 1).trim();
  }
  return undefined;
}

function dispositionParam(value: string, param: string): string | undefined {
  for (const part of value.split(';').slice(1)) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim().toLowerCase() !== param) continue;
    let raw = part.slice(eq + 1).trim();
    if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) raw = raw.slice(1, -1);
    return raw.replaceAll('%22', '"');
  }
  return undefined;
}

function parseUrlEncoded(bytes: Uint8Array): FormDataPolyfill {
  const form = new FormDataPolyfill();
  const params = new URLSearchParamsPolyfill(new TextDecoderPolyfill().decode(bytes));
  for (const [name, value] of params) form.append(name, value);
  return form;
}

function parseMultipart(bytes: Uint8Array, boundary: string): FormDataPolyfill {
  const encoder = new TextEncoderPolyfill();
  const decoder = new TextDecoderPolyfill();
  const dashBoundary = encoder.encode(`--${boundary}`);
  const headerBreak = encoder.encode('\r\n\r\n');
  const nextMarker = encoder.encode(`\r\n--${boundary}`);
  const form = new FormDataPolyfill();
  let position = indexOfBytes(bytes, dashBoundary);
  if (position < 0) throw new TypeError('multipart/form-data body is missing its boundary');
  position += dashBoundary.length;

  while (position < bytes.length) {
    if (bytes[position] === 45 && bytes[position + 1] === 45) break;
    if (bytes[position] !== 13 || bytes[position + 1] !== 10) {
      throw new TypeError('multipart/form-data body is malformed');
    }
    position += 2;
    const headerEnd = indexOfBytes(bytes, headerBreak, position);
    if (headerEnd < 0) throw new TypeError('multipart/form-data part is missing its headers');
    const headerText = decoder.decode(bytes.subarray(position, headerEnd));
    position = headerEnd + headerBreak.length;
    const next = indexOfBytes(bytes, nextMarker, position);
    if (next < 0) throw new TypeError('multipart/form-data part is truncated');
    const partBody = bytes.subarray(position, next);
    position = next + 2 + dashBoundary.length;

    const disposition = headerValue(headerText, 'content-disposition');
    if (disposition === undefined) continue;
    const name = dispositionParam(disposition, 'name');
    if (name === undefined) continue;
    const filename = dispositionParam(disposition, 'filename');
    if (filename === undefined) {
      form.append(name, decoder.decode(partBody));
    } else {
      const type = headerValue(headerText, 'content-type') ?? '';
      form.append(name, new BlobPolyfill([partBody], { type }), filename);
    }
  }
  return form;
}

function formDataFromBody(headers: HeadersPolyfill, buffer: ArrayBuffer): FormDataPolyfill {
  const parsed = parseContentType(headers.get('content-type'));
  const bytes = new Uint8Array(buffer);
  if (parsed.type === 'application/x-www-form-urlencoded') return parseUrlEncoded(bytes);
  if (parsed.type === 'multipart/form-data') {
    if (parsed.boundary === undefined || parsed.boundary === '') {
      throw new TypeError('multipart/form-data body is missing a boundary');
    }
    return parseMultipart(bytes, parsed.boundary);
  }
  throw new TypeError(
    'Content-Type is not multipart/form-data or application/x-www-form-urlencoded',
  );
}

const noopConsole = {
  log() {},
  info() {},
  warn() {},
  error() {},
  debug() {},
};

const URL_SEARCH_PARAMS_METHODS = [
  'get',
  'getAll',
  'has',
  'append',
  'set',
  'delete',
  'toString',
  'entries',
  Symbol.iterator,
] as const;

const HEADERS_METHODS = [
  'append',
  'set',
  'get',
  'has',
  'delete',
  'entries',
  'forEach',
  'keys',
  'values',
  'getSetCookie',
  Symbol.iterator,
] as const;

const FORM_DATA_METHODS = [
  'append',
  'get',
  'getAll',
  'has',
  'set',
  'delete',
  'entries',
  Symbol.iterator,
] as const;

function hasRequiredMethods(value: unknown, methods: readonly (string | symbol)[]): boolean {
  if (typeof value !== 'function') return false;
  const prototype = (value as { prototype?: Record<string | symbol, unknown> | null }).prototype;
  if (prototype != null && methods.every((method) => typeof prototype[method] === 'function')) {
    return true;
  }
  try {
    const instance = new (value as new () => Record<string | symbol, unknown>)();
    return methods.every((method) => typeof instance[method] === 'function');
  } catch {
    return false;
  }
}

/**
 * Install `implementation` when `name` is missing or lacks a method guests call.
 * A partial constructor used to be kept, and the missing method then failed as
 * an HTTP 500. A constructor that already has the methods is left alone.
 */
function installWebConstructor(
  global: Record<string, unknown>,
  name: string,
  implementation: unknown,
  methods: readonly (string | symbol)[],
  force: boolean,
): void {
  if (force || !hasRequiredMethods(global[name], methods)) global[name] = implementation;
}

export function installFetchRuntime(force = false): void {
  const global = globalThis as Record<string, unknown>;
  if (force || typeof global.TextEncoder !== 'function') global.TextEncoder = TextEncoderPolyfill;
  if (force || typeof global.TextDecoder !== 'function') global.TextDecoder = TextDecoderPolyfill;
  installWebConstructor(
    global,
    'URLSearchParams',
    URLSearchParamsPolyfill,
    URL_SEARCH_PARAMS_METHODS,
    force,
  );
  if (force || typeof global.URL !== 'function') global.URL = URLPolyfill;
  installWebConstructor(global, 'Headers', HeadersPolyfill, HEADERS_METHODS, force);
  if (force || typeof global.Request !== 'function') global.Request = RequestPolyfill;
  if (force || typeof global.Response !== 'function') global.Response = ResponsePolyfill;
  installWebConstructor(global, 'FormData', FormDataPolyfill, FORM_DATA_METHODS, force);
  if (force || typeof global.Blob !== 'function') global.Blob = BlobPolyfill;
  if (force || typeof global.File !== 'function') global.File = FilePolyfill;
  if (force || typeof global.AbortSignal !== 'function') global.AbortSignal = AbortSignalPolyfill;
  if (force || typeof global.AbortController !== 'function') {
    global.AbortController = AbortControllerPolyfill;
  }
  // mqtt's browser abort-controller reads AbortController from self or window.
  if (force || typeof global.self !== 'object' || global.self === null) global.self = globalThis;
  if (force || typeof global.console !== 'object' || global.console === null) {
    global.console = noopConsole;
  }
}

installFetchRuntime();
