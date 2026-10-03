import { describe, expect, it } from 'bun:test';
import {
  BlobPolyfill,
  bodyAsStream,
  FilePolyfill,
  FormDataPolyfill,
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
    expect(new URLSearchParamsPolyfill('scope=openid+profile+email').get('scope')).toBe(
      'openid profile email',
    );
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
    const edited = new URLSearchParamsPolyfill('scope=openid&scope=profile&extra=1');
    expect(edited.has('scope')).toBe(true);
    expect(edited.has('missing')).toBe(false);
    expect(edited.getAll('scope')).toEqual(['openid', 'profile']);
    edited.append('scope', 'email');
    edited.set('extra', '2');
    edited.delete('missing');
    expect(edited.toString()).toBe('scope=openid&scope=profile&extra=2&scope=email');
    const url = new URLPolyfill('/oauth2/consent', 'http://relative.invalid');
    url.searchParams.set('client_id', 'access');
    url.searchParams.set('state', 'abc');
    expect(`${url.pathname}${url.search}`).toBe('/oauth2/consent?client_id=access&state=abc');
    expect(url.toString()).toBe(
      'http://relative.invalid/oauth2/consent?client_id=access&state=abc',
    );
    url.searchParams.delete('state');
    expect(url.search).toBe('?client_id=access');
    url.searchParams.delete('client_id');
    expect(url.search).toBe('');
    expect(url.href).toBe('http://relative.invalid/oauth2/consent');
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

  it('lists header names and values and keeps every Set-Cookie', () => {
    const headers = new HeadersPolyfill();
    headers.append('Set-Cookie', 'a=1');
    headers.append('Accept', 'text/plain');
    headers.append('Set-Cookie', 'b=2; HttpOnly');
    headers.append('Accept', 'application/json');
    expect(headers.getSetCookie()).toEqual(['a=1', 'b=2; HttpOnly']);
    expect(headers.get('set-cookie')).toBe('a=1, b=2; HttpOnly');
    expect([...headers.keys()]).toEqual(['accept', 'set-cookie', 'set-cookie']);
    expect([...headers.values()]).toEqual(['text/plain, application/json', 'a=1', 'b=2; HttpOnly']);
    expect(new HeadersPolyfill().getSetCookie()).toEqual([]);
    expect([...new HeadersPolyfill().keys()]).toEqual([]);
    expect([...new HeadersPolyfill().values()]).toEqual([]);
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
    const echoed = new FormDataPolyfill();
    echoed.append('field', 'value');
    const formResponse = new ResponsePolyfill(echoed);
    expect(formResponse.headers.get('content-type')?.startsWith('multipart/form-data;')).toBe(true);
    expect((await formResponse.formData()).get('field')).toBe('value');
    const streamed = new ResponsePolyfill(new Uint8Array([9]));
    const collected: number[] = [];
    for await (const chunk of streamed.body ?? []) collected.push(...chunk);
    expect(collected).toEqual([9]);
  });

  it('reads multipart and urlencoded bodies with FormData', async () => {
    const form = new FormDataPolyfill();
    form.append('name', 'test-file');
    form.append('file', new BlobPolyfill(['hello'], { type: 'text/plain' }), 'test.txt');
    form.append('bin', new BlobPolyfill([new Uint8Array([0xff, 0xfe, 0x00])]), 'b.bin');
    form.append('name', 'second');
    expect(form.get('name')).toBe('test-file');
    expect(form.getAll('name')).toEqual(['test-file', 'second']);
    expect(form.has('missing')).toBe(false);
    expect([...form.keys()]).toEqual(['name', 'file', 'bin', 'name']);
    form.set('name', 'only');
    expect(form.getAll('name')).toEqual(['only']);
    form.delete('bin');
    expect(form.has('bin')).toBe(false);
    expect([...new FormDataPolyfill(form).values()].map((value) => typeof value)).toEqual([
      'string',
      'object',
    ]);

    const posted = new FormDataPolyfill();
    posted.append('operations', '{"query":"{ hello }"}');
    posted.append('file', new BlobPolyfill(['hello'], { type: 'text/plain' }), 'test.txt');
    const request = new RequestPolyfill('http://example/upload', { method: 'POST', body: posted });
    expect(request.headers.get('content-type')?.startsWith('multipart/form-data; boundary=')).toBe(
      true,
    );
    const parsed = await request.formData();
    expect(parsed.get('operations')).toBe('{"query":"{ hello }"}');
    const file = parsed.get('file');
    expect(file).toBeInstanceOf(FilePolyfill);
    expect((file as FilePolyfill).name).toBe('test.txt');
    expect(await (file as FilePolyfill).text()).toBe('hello');

    const manual = [
      '--bound',
      'Content-Disposition: form-data; name="operations"',
      '',
      '{"query":"{ hello }"}',
      '--bound',
      'Content-Disposition: form-data; name="file"; filename="test.txt"',
      'Content-Type: text/plain',
      '',
      'hello',
      '--bound--',
      '',
    ].join('\r\n');
    const incoming = new RequestPolyfill('http://example/upload', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary="bound"' },
      body: manual,
    });
    expect((await incoming.formData()).get('operations')).toBe('{"query":"{ hello }"}');
    expect(await ((await incoming.formData()).get('file') as FilePolyfill).text()).toBe('hello');

    const payload = new Uint8Array([0xff, 0xfe, 0x00, 0x61]);
    const prefix = new TextEncoder().encode(
      [
        '--bound',
        'Content-Disposition: form-data; name="bin"; filename="b.bin"',
        'Content-Type: application/octet-stream',
        '',
        '',
      ].join('\r\n'),
    );
    const suffix = new TextEncoder().encode('\r\n--bound--\r\n');
    const binaryBody = new Uint8Array(prefix.length + payload.length + suffix.length);
    binaryBody.set(prefix, 0);
    binaryBody.set(payload, prefix.length);
    binaryBody.set(suffix, prefix.length + payload.length);
    const binary = await new RequestPolyfill('http://example/bin', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=bound' },
      body: binaryBody,
    }).formData();
    const bin = binary.get('bin') as FilePolyfill;
    expect(bin.name).toBe('b.bin');
    expect([...new Uint8Array(await bin.arrayBuffer())]).toEqual([...payload]);

    const urlencoded = new RequestPolyfill('http://example/form', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: 'scope=openid+profile&extra=1',
    });
    const fields = await urlencoded.formData();
    expect(fields.get('scope')).toBe('openid profile');
    expect(fields.get('extra')).toBe('1');

    const malformed = new RequestPolyfill('http://example/upload', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=something' },
      body: 'bad boundary data',
    });
    await expect(malformed.formData()).rejects.toThrow(TypeError);
    const json = new RequestPolyfill('http://example/json', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    await expect(json.formData()).rejects.toThrow(TypeError);
    expect(() => form.append('file', {} as BlobPolyfill)).toThrow(TypeError);
  });

  it('replaces partial Web constructors and keeps complete ones', () => {
    const global = globalThis as Record<string, unknown>;
    expect(global.Headers).not.toBe(HeadersPolyfill);
    expect(global.URLSearchParams).not.toBe(URLSearchParamsPolyfill);
    expect(global.FormData).not.toBe(FormDataPolyfill);
    const keys = ['URLSearchParams', 'Headers', 'FormData'] as const;
    const originals = Object.fromEntries(keys.map((key) => [key, global[key]]));

    class PartialURLSearchParams {
      get(): null {
        return null;
      }
    }
    class PartialHeaders {
      append(): void {}
      set(): void {}
      get(): null {
        return null;
      }
      has(): boolean {
        return false;
      }
      delete(): void {}
      entries(): IterableIterator<[string, string]> {
        return [][Symbol.iterator]();
      }
      forEach(): void {}
      keys(): IterableIterator<string> {
        return [][Symbol.iterator]();
      }
      values(): IterableIterator<string> {
        return [][Symbol.iterator]();
      }
      [Symbol.iterator](): IterableIterator<[string, string]> {
        return this.entries();
      }
    }
    class PartialFormData {
      append(): void {}
    }
    class CompleteURLSearchParams {
      get(): null {
        return null;
      }
      getAll(): string[] {
        return [];
      }
      has(): boolean {
        return false;
      }
      append(): void {}
      set(): void {}
      delete(): void {}
      toString(): string {
        return '';
      }
      entries(): IterableIterator<[string, string]> {
        return [][Symbol.iterator]();
      }
      [Symbol.iterator](): IterableIterator<[string, string]> {
        return this.entries();
      }
    }
    class CompleteHeaders extends PartialHeaders {
      getSetCookie(): string[] {
        return [];
      }
    }
    class CompleteFormData {
      append(): void {}
      get(): null {
        return null;
      }
      getAll(): string[] {
        return [];
      }
      has(): boolean {
        return false;
      }
      set(): void {}
      delete(): void {}
      entries(): IterableIterator<[string, string]> {
        return [][Symbol.iterator]();
      }
      [Symbol.iterator](): IterableIterator<[string, string]> {
        return this.entries();
      }
    }

    try {
      global.URLSearchParams = PartialURLSearchParams;
      global.Headers = PartialHeaders;
      global.FormData = PartialFormData;
      installFetchRuntime();
      expect(global.URLSearchParams).toBe(URLSearchParamsPolyfill);
      expect(global.Headers).toBe(HeadersPolyfill);
      expect(global.FormData).toBe(FormDataPolyfill);

      global.URLSearchParams = CompleteURLSearchParams;
      global.Headers = CompleteHeaders;
      global.FormData = CompleteFormData;
      installFetchRuntime();
      expect(global.URLSearchParams).toBe(CompleteURLSearchParams);
      expect(global.Headers).toBe(CompleteHeaders);
      expect(global.FormData).toBe(CompleteFormData);
    } finally {
      for (const key of keys) global[key] = originals[key];
    }
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
      'FormData',
      'File',
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
      expect(global.FormData).toBe(FormDataPolyfill);
      expect(global.File).toBe(FilePolyfill);
    } finally {
      for (const key of keys) global[key] = originals[key];
    }
  });
});
