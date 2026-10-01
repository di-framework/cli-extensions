import { afterEach, describe, expect, it } from 'bun:test';
import {
  AbortControllerPolyfill,
  BlobPolyfill,
  installFetchRuntime,
} from '../src/node-compat/fetch-runtime';

describe('guest Blob', () => {
  const previous = globalThis.Blob;

  afterEach(() => {
    globalThis.Blob = previous;
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

  it('installs the polyfill when the guest has no Blob', () => {
    Reflect.deleteProperty(globalThis, 'Blob');
    installFetchRuntime();
    expect(globalThis.Blob).toBe(BlobPolyfill);
    installFetchRuntime(true);
    expect(globalThis.Blob).toBe(BlobPolyfill);
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

    const previousSelf = globalThis.self;
    globalThis.self = null as unknown as typeof globalThis.self;
    Reflect.deleteProperty(globalThis, 'AbortController');
    installFetchRuntime();
    expect(globalThis.self).toBe(globalThis);
    expect(globalThis.AbortController).toBe(AbortControllerPolyfill);
    globalThis.self = previousSelf;
  });
});
