import { concatBytes, decodeUtf8, encodeUtf8 } from './bytes';

export const MAX_HEADER_SIZE = 16_384;

export type HeaderValue = string | string[];
export type HeaderMap = Record<string, HeaderValue>;

export type ParsedHeaders = {
  headers: HeaderMap;
  rawHeaders: string[];
};

export type ParsedRequest = ParsedHeaders & {
  method: string;
  url: string;
  httpVersion: string;
  headerLength: number;
};

export type ParsedResponse = ParsedHeaders & {
  statusCode: number;
  statusMessage: string;
  httpVersion: string;
  headerLength: number;
};

export function concatChunks(left: Uint8Array, right: Uint8Array): Uint8Array {
  return concatBytes(left, right);
}

export function indexOfHeaderEnd(buffer: Uint8Array): number {
  for (let i = 0; i + 3 < buffer.length; i++) {
    if (buffer[i] === 13 && buffer[i + 1] === 10 && buffer[i + 2] === 13 && buffer[i + 3] === 10) {
      return i;
    }
  }
  return -1;
}

export function parseHttpHeaders(block: string): ParsedHeaders {
  const headers: HeaderMap = {};
  const rawHeaders: string[] = [];
  if (block.length === 0) return { headers, rawHeaders };
  for (const line of block.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    rawHeaders.push(name, value);
    const key = name.toLowerCase();
    const existing = headers[key];
    if (existing === undefined) headers[key] = value;
    else if (key === 'set-cookie') {
      headers[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
    } else {
      headers[key] = `${existing}, ${value}`;
    }
  }
  return { headers, rawHeaders };
}

export function parseHttpRequest(buffer: Uint8Array): ParsedRequest | undefined {
  const end = indexOfHeaderEnd(buffer);
  if (end < 0) return undefined;
  const text = decodeUtf8(buffer.subarray(0, end));
  const firstLineEnd = text.indexOf('\r\n');
  const start = firstLineEnd < 0 ? text : text.slice(0, firstLineEnd);
  const rest = firstLineEnd < 0 ? '' : text.slice(firstLineEnd + 2);
  const match = /^([A-Z]+)\s+(\S+)\s+HTTP\/(\d\.\d)$/.exec(start);
  if (match === null) {
    throw new Error(`Invalid HTTP request line: ${start}`);
  }
  return {
    method: match[1] ?? 'GET',
    url: match[2] ?? '/',
    httpVersion: match[3] ?? '1.1',
    headerLength: end + 4,
    ...parseHttpHeaders(rest),
  };
}

export function parseHttpResponse(buffer: Uint8Array): ParsedResponse | undefined {
  const end = indexOfHeaderEnd(buffer);
  if (end < 0) return undefined;
  const text = decodeUtf8(buffer.subarray(0, end));
  const firstLineEnd = text.indexOf('\r\n');
  const start = firstLineEnd < 0 ? text : text.slice(0, firstLineEnd);
  const rest = firstLineEnd < 0 ? '' : text.slice(firstLineEnd + 2);
  const match = /^HTTP\/(\d\.\d)\s+(\d{3})\s*(.*)$/.exec(start);
  if (match === null) {
    throw new Error(`Invalid HTTP response line: ${start}`);
  }
  return {
    httpVersion: match[1] ?? '1.1',
    statusCode: Number(match[2]),
    statusMessage: match[3] ?? '',
    headerLength: end + 4,
    ...parseHttpHeaders(rest),
  };
}

export function headerValue(headers: HeaderMap, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.join(', ') : value;
}

export function contentLengthOf(headers: HeaderMap): number | undefined {
  const value = headerValue(headers, 'content-length');
  if (value === undefined) return undefined;
  const length = Number(value);
  return Number.isFinite(length) ? length : undefined;
}

export function isUpgrade(headers: HeaderMap): boolean {
  return headerValue(headers, 'upgrade') !== undefined;
}

export function serializeHeaders(headers: HeaderMap): string {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) lines.push(`${name}: ${item}`);
    } else {
      lines.push(`${name}: ${value}`);
    }
  }
  return lines.join('\r\n');
}

export function serializeHttpRequest(method: string, url: string, headers: HeaderMap): Uint8Array {
  const head = serializeHeaders(headers);
  const block =
    head.length === 0
      ? `${method} ${url} HTTP/1.1\r\n\r\n`
      : `${method} ${url} HTTP/1.1\r\n${head}\r\n\r\n`;
  return encodeUtf8(block);
}

export function serializeHttpResponse(
  statusCode: number,
  statusMessage: string,
  headers: HeaderMap,
): Uint8Array {
  const reason = statusMessage.length > 0 ? statusMessage : 'OK';
  const head = serializeHeaders(headers);
  const block =
    head.length === 0
      ? `HTTP/1.1 ${statusCode} ${reason}\r\n\r\n`
      : `HTTP/1.1 ${statusCode} ${reason}\r\n${head}\r\n\r\n`;
  return encodeUtf8(block);
}

export function encodeChunk(data: Uint8Array): Uint8Array {
  return concatBytes(encodeUtf8(`${data.length.toString(16)}\r\n`), data, encodeUtf8('\r\n'));
}

export const CHUNKED_END = encodeUtf8('0\r\n\r\n');

export function isChunked(headers: HeaderMap): boolean {
  return (
    headerValue(headers, 'transfer-encoding')?.toLowerCase().split(',').at(-1)?.trim() === 'chunked'
  );
}

/** Incremental decoder; returns bytes after the trailers when the body is complete. */
export class ChunkedDecoder {
  buffer: Uint8Array<ArrayBufferLike> = new Uint8Array();
  state: 'size' | 'data' | 'delimiter' | 'trailers' = 'size';
  remaining = 0;

  write(bytes: Uint8Array, onData: (data: Uint8Array) => void): Uint8Array | undefined {
    this.buffer = concatBytes(this.buffer, bytes);
    while (true) {
      if (this.state === 'data') {
        const take = Math.min(this.remaining, this.buffer.length);
        if (take === 0) return undefined;
        onData(this.buffer.subarray(0, take));
        this.buffer = this.buffer.subarray(take);
        this.remaining -= take;
        if (this.remaining > 0) return undefined;
        this.state = 'delimiter';
      }
      if (this.state === 'delimiter') {
        if (this.buffer.length < 2) return undefined;
        if (this.buffer[0] !== 13 || this.buffer[1] !== 10)
          throw new Error('Invalid chunk delimiter');
        this.buffer = this.buffer.subarray(2);
        this.state = 'size';
      }
      let end = -1;
      for (let i = 0; i + 1 < this.buffer.length; i++) {
        if (this.buffer[i] === 13 && this.buffer[i + 1] === 10) {
          end = i;
          break;
        }
      }
      if (end > MAX_HEADER_SIZE || (end < 0 && this.buffer.length > MAX_HEADER_SIZE)) {
        throw new Error('Chunk header too large');
      }
      if (end < 0) return undefined;
      const line = decodeUtf8(this.buffer.subarray(0, end));
      this.buffer = this.buffer.subarray(end + 2);
      if (this.state === 'trailers') {
        if (line === '') return this.buffer;
        continue;
      }
      const size = line.split(';')[0] ?? '';
      if (!/^[0-9a-fA-F]+$/.test(size)) throw new Error('Invalid chunk size');
      this.remaining = Number.parseInt(size, 16);
      if (!Number.isSafeInteger(this.remaining)) throw new Error('Chunk size too large');
      this.state = this.remaining === 0 ? 'trailers' : 'data';
    }
  }
}
