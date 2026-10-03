import { afterEach, describe, expect, it } from 'bun:test';
import {
  AbortControllerPolyfill,
  BlobPolyfill,
  FilePolyfill,
  installFetchRuntime,
} from '../src/node-compat/fetch-runtime';

// installFetchRuntime(true) overwrites every fetch global, so restore them all
// or later test files run against the polyfills instead of Bun's natives.
const installedGlobals = [
  'TextEncoder',
  'TextDecoder',
  'URLSearchParams',
  'URL',
  'Headers',
  'Request',
  'Response',
  'Blob',
  'File',
  'FormData',
  'AbortSignal',
  'AbortController',
  'self',
  'console',
] as const;

describe('guest Blob', () => {
  const global = globalThis as Record<string, unknown>;
  const previous = Object.fromEntries(installedGlobals.map((key) => [key, global[key]]));

  afterEach(() => {
    for (const key of installedGlobals) global[key] = previous[key];
  });

  it('counts string and binary parts', () => {
    const blob = new BlobPolyfill(['ab', new Uint8Array([1, 2, 3])], {
      type: 'application/octet-stream',
    });
    expect(blob.size).toBe(5);
    expect(blob.type).toBe('application/octet-stream');
    expect(new BlobPolyfill().size).toBe(0);
    expect(new BlobPolyfill([new ArrayBuffer(4)]).size).toBe(4);
  });

  it('copies Blob and File parts instead of dropping them', async () => {
    const inner = new BlobPolyfill(['hello'], { type: 'text/plain' });
    const wrapped = new BlobPolyfill([inner]);
    expect(wrapped.size).toBe(5);
    expect(await wrapped.text()).toBe('hello');
    const file = new FilePolyfill([inner], 'x.txt', { type: 'text/plain' });
    expect(file.name).toBe('x.txt');
    expect(file.size).toBe(5);
    expect(await file.text()).toBe('hello');
    expect(await new BlobPolyfill([file]).text()).toBe('hello');
    expect(() => new BlobPolyfill([{} as never])).toThrow(TypeError);
    expect(() => new BlobPolyfill([new Blob(['hi'])])).toThrow(TypeError);
  });

  it('installs the polyfill when the guest has no Blob', () => {
    Reflect.deleteProperty(globalThis, 'Blob');
    installFetchRuntime();
    expect(globalThis.Blob as unknown).toBe(BlobPolyfill);
    installFetchRuntime(true);
    expect(globalThis.Blob as unknown).toBe(BlobPolyfill);
  });

  it('aborts once and installs self for libraries that read window globals', () => {
    const controller = new AbortControllerPolyfill();
    const seen: string[] = [];
    controller.signal.throwIfAborted();
    controller.signal.addEventListener('click', () => seen.push('click'));
    controller.signal.addEventListener('abort', () => seen.push('abort'));
    const listener = () => seen.push('again');
    controller.signal.addEventListener('abort', listener);
    controller.signal.removeEventListener('click', listener);
    controller.signal.removeEventListener('abort', listener);
    controller.signal.onabort = () => seen.push('onabort');
    controller.abort();
    controller.abort('second');
    expect(controller.signal.aborted).toBe(true);
    expect(seen).toEqual(['onabort', 'abort']);
    expect(controller.signal.dispatchEvent({ type: 'abort' })).toBe(true);
    expect(() => controller.signal.throwIfAborted()).toThrow('This operation was aborted');

    const stringReason = new AbortControllerPolyfill();
    stringReason.abort('stopped');
    expect(() => stringReason.signal.throwIfAborted()).toThrow('This operation was aborted');

    globalThis.self = null as unknown as typeof globalThis.self;
    Reflect.deleteProperty(globalThis, 'AbortController');
    installFetchRuntime();
    expect(globalThis.self as unknown).toBe(globalThis);
    expect(globalThis.AbortController as unknown).toBe(AbortControllerPolyfill);
  });
});
