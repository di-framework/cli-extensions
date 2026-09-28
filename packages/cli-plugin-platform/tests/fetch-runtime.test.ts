import { describe, expect, it } from 'bun:test';
import {
  bodyAsStream,
  HeadersPolyfill,
  installFetchRuntime,
  isAsyncIterable,
  RequestPolyfill,
  ResponsePolyfill,
  TextDecoderPolyfill,
  TextEncoderPolyfill,
  URLPolyfill,
  URLSearchParamsPolyfill,
} from '../assets/fetch-runtime';

async function* chunks(...values: unknown[]): AsyncGenerator<unknown> {
  for (const value of values) yield value;
}

describe('fetch runtime streams', () => {
  it('keeps an async-iterable request body until arrayBuffer is called', async () => {
    const first = new Uint8Array([1, 2]);
    const second = new Uint8Array([3]);
    const request = new RequestPolyfill('http://example/upload', {
      method: 'POST',
      body: chunks(first, second),
    });
    expect(isAsyncIterable(request.body)).toBe(true);
    const bytes = new Uint8Array(await request.arrayBuffer());
    expect([...bytes]).toEqual([1, 2, 3]);
  });

  it('exposes a response body as a stream without requiring the adapter to buffer first', async () => {
    const payload = new Uint8Array([9, 8, 7]);
    const response = new ResponsePolyfill(chunks(payload), { status: 201 });
    const stream = bodyAsStream(response.body);
    expect(stream).not.toBeNull();
    const collected: number[] = [];
    for await (const chunk of stream ?? []) collected.push(...chunk);
    expect(collected).toEqual([9, 8, 7]);
    expect(response.status).toBe(201);
  });

  it('coerces mixed stream chunks and empty byte bodies', async () => {
    const request = new RequestPolyfill('http://example/mixed', {
      method: 'POST',
      body: chunks(65, new Uint8Array([66]), new Uint8Array([67]).buffer),
    });
    expect(await request.text()).toBe('ABC');
    const original = new RequestPolyfill('http://example/quote', {
      method: 'POST',
      body: '{"items":[]}',
    });
    const cloned = original.clone();
    expect(await cloned.json()).toEqual({ items: [] });
    expect(await original.json()).toEqual({ items: [] });
    expect(bodyAsStream(null)).toBeNull();
    const empty = bodyAsStream(new Uint8Array());
    const yielded: Uint8Array[] = [];
    for await (const chunk of empty ?? []) yielded.push(chunk);
    expect(yielded).toEqual([]);
    const buffered = bodyAsStream(new Uint8Array([1, 2]));
    const collected: number[] = [];
    for await (const chunk of buffered ?? []) collected.push(...chunk);
    expect(collected).toEqual([1, 2]);
  });
});

describe('fetch runtime polyfills', () => {
  it('encodes and decodes UTF-8 text', () => {
    const encoded = new TextEncoderPolyfill().encode('hi');
    expect([...encoded]).toEqual([104, 105]);
    expect([...new TextEncoderPolyfill().encode()]).toEqual([]);
    const decoder = new TextDecoderPolyfill();
    expect(decoder.decode()).toBe('');
    expect(decoder.decode(null)).toBe('');
    expect(decoder.decode(encoded)).toBe('hi');
    expect(decoder.decode(encoded.buffer as ArrayBuffer)).toBe('hi');
  });

  it('parses query strings from several init shapes', () => {
    const fromString = new URLSearchParamsPolyfill('?a=1&lonely&b=2');
    expect(fromString.get('a')).toBe('1');
    expect(fromString.get('lonely')).toBe('');
    expect(fromString.get('missing')).toBeNull();
    expect(fromString.toString()).toBe('a=1&lonely=&b=2');
    expect([...fromString.entries()]).toEqual([
      ['a', '1'],
      ['lonely', ''],
      ['b', '2'],
    ]);
    // itty-router iterates searchParams with for...of, not .entries().
    expect([...fromString]).toEqual([
      ['a', '1'],
      ['lonely', ''],
      ['b', '2'],
    ]);
    expect([...new URLPolyfill('http://example/health').searchParams]).toEqual([]);
    expect([...new URLPolyfill('http://example/greet/Ada?lang=es').searchParams]).toEqual([
      ['lang', 'es'],
    ]);
    expect(new URLSearchParamsPolyfill('').toString()).toBe('');
    expect(new URLSearchParamsPolyfill({ a: '1' }).get('a')).toBe('1');
    expect(new URLSearchParamsPolyfill(fromString).get('b')).toBe('2');
  });

  it('resolves absolute and relative URLs', () => {
    const absolute = new URLPolyfill('https://example.com:8080/path/page?q=1#hash');
    expect(absolute.protocol).toBe('https:');
    expect(absolute.hostname).toBe('example.com');
    expect(absolute.port).toBe('8080');
    expect(absolute.pathname).toBe('/path/page');
    expect(absolute.search).toBe('?q=1');
    expect(absolute.hash).toBe('#hash');
    expect(absolute.toString()).toBe('https://example.com:8080/path/page?q=1#hash');
    expect(new URLPolyfill('http://example.com').pathname).toBe('/');
    expect(new URLPolyfill('/abs', 'https://example.com/dir/page').href).toBe(
      'https://example.com/abs',
    );
    expect(new URLPolyfill('rel', 'https://example.com/dir/page').href).toBe(
      'https://example.com/dir/rel',
    );
    expect(() => new URLPolyfill('/no-base')).toThrow(TypeError);
  });

  it('stores, copies, and iterates headers', () => {
    const headers = new HeadersPolyfill({ Accept: 'text/plain' });
    headers.append('Accept', 'application/json');
    headers.set('X-Test', '1');
    expect(headers.get('accept')).toBe('text/plain, application/json');
    expect(headers.has('x-test')).toBe(true);
    headers.delete('x-test');
    expect(headers.has('x-test')).toBe(false);
    expect(headers.get('missing')).toBeNull();
    expect([...headers]).toEqual([
      ['accept', 'text/plain'],
      ['accept', 'application/json'],
    ]);
    expect([...new HeadersPolyfill(headers).entries()]).toEqual([...headers]);
    expect([...new HeadersPolyfill([['x', 'y']]).entries()]).toEqual([['x', 'y']]);
    expect([...new HeadersPolyfill().entries()]).toEqual([]);
    const visited: Array<[string, string, HeadersPolyfill]> = [];
    headers.forEach((value, name, parent) => {
      visited.push([value, name, parent]);
    });
    expect(visited).toEqual([
      ['text/plain', 'accept', headers],
      ['application/json', 'accept', headers],
    ]);
    const emptyVisits: string[] = [];
    new HeadersPolyfill().forEach((value) => {
      emptyVisits.push(value);
    });
    expect(emptyVisits).toEqual([]);
  });

  it('copies requests and reads JSON bodies', async () => {
    const original = new RequestPolyfill('http://example/item', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"n":1}',
    });
    const copied = new RequestPolyfill(original);
    expect(copied.method).toBe('POST');
    expect(copied.headers.get('content-type')).toBe('application/json');
    expect(await copied.json()).toEqual({ n: 1 });
    const replaced = new RequestPolyfill(original, {
      method: 'PUT',
      headers: { accept: 'text/plain' },
      body: new Uint8Array([65]),
    });
    expect(replaced.method).toBe('PUT');
    expect(await replaced.text()).toBe('A');
    expect(
      await new RequestPolyfill('http://example/buf', {
        method: 'POST',
        body: new Uint8Array([66]).buffer,
      }).text(),
    ).toBe('B');
  });

  it('builds JSON responses and buffers non-stream bodies', async () => {
    const json = ResponsePolyfill.json({ ok: true });
    expect(json.headers.get('content-type')).toBe('application/json');
    expect(await json.json()).toEqual({ ok: true });
    const custom = ResponsePolyfill.json(
      { ok: false },
      { status: 400, headers: { 'content-type': 'application/vnd.api+json' } },
    );
    expect(custom.status).toBe(400);
    expect(custom.ok).toBe(false);
    expect(custom.headers.get('content-type')).toBe('application/vnd.api+json');
    expect(await new ResponsePolyfill('hello').text()).toBe('hello');
    expect(await new ResponsePolyfill(42).text()).toBe('42');
    expect(await new ResponsePolyfill(null).arrayBuffer()).toEqual(new ArrayBuffer(0));
    expect(new ResponsePolyfill(null).body).toBeNull();
    const streamed = new ResponsePolyfill(new Uint8Array([9]));
    const collected: number[] = [];
    for await (const chunk of streamed.body ?? []) collected.push(...chunk);
    expect(collected).toEqual([9]);
  });

  it('installs polyfills onto missing or forced globals', () => {
    const global = globalThis as Record<string, unknown>;
    const keys = [
      'TextEncoder',
      'TextDecoder',
      'URLSearchParams',
      'URL',
      'Headers',
      'Request',
      'Response',
      'console',
    ] as const;
    const originals = Object.fromEntries(keys.map((key) => [key, global[key]]));
    try {
      for (const key of keys) {
        if (key === 'console') global.console = null;
        else delete global[key];
      }
      installFetchRuntime();
      expect(typeof global.TextEncoder).toBe('function');
      expect(typeof global.URLSearchParams).toBe('function');
      expect(typeof (global.console as { error: unknown }).error).toBe('function');
      (global.console as { log(): void; info(): void; warn(): void; debug(): void }).log();
      (global.console as { info(): void }).info();
      (global.console as { warn(): void }).warn();
      (global.console as { debug(): void }).debug();
      global.console = 1;
      installFetchRuntime();
      expect(typeof (global.console as { error(): void }).error).toBe('function');
      installFetchRuntime(true);
      expect(global.Request).toBe(RequestPolyfill);
    } finally {
      for (const key of keys) global[key] = originals[key];
    }
  });
});
