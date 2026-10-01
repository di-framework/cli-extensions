import { describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inherits } from 'node:util';
import { EventEmitter as UnenvEventEmitter } from 'unenv/node/events';
import { DEFAULT_DEPS } from '../src/deps';
import { wasmcloudNodeEnv } from '../src/node-compat/env';
import events, {
  captureRejectionSymbol,
  EventEmitter,
  errorMonitor,
  init,
  listenerCount,
  once,
  setMaxListeners,
} from '../src/node-compat/events';
import stream, { Readable, Stream } from '../src/node-compat/stream';
import * as clock from './memory-wasi-clocks';

// The bundled guest imports the runtime's WASI shims.
mock.module('wasi:clocks/monotonic-clock@0.3.0', () => clock);
mock.module('wasi:filesystem/preopens@0.2.12', () => ({ getDirectories: () => [] }));

type Emitter = InstanceType<typeof EventEmitter>;
const callable = EventEmitter as unknown as (this: object, options?: object) => void;
const kCapture = Symbol.for('kCapture');
const kShapeMode = Symbol.for('shapeMode');

function LegacyEmitter(this: Emitter & { tag: string }) {
  callable.call(this);
  this.tag = 'legacy';
}
inherits(LegacyEmitter, EventEmitter);

describe('guest node:events', () => {
  it('constructs with new and as an ES base class', () => {
    const plain = new EventEmitter();
    expect(plain).toBeInstanceOf(EventEmitter);
    expect(plain).toBeInstanceOf(UnenvEventEmitter);
    class Child extends EventEmitter {
      field = 'child';
    }
    const child = new Child();
    expect(child).toBeInstanceOf(Child);
    expect(child.field).toBe('child');
    const seen: number[] = [];
    child.on('value', (value: number) => seen.push(value));
    child.emit('value', 3);
    expect(seen).toEqual([3]);
    const capturing = new EventEmitter({ captureRejections: true });
    expect((capturing as unknown as Record<symbol, boolean>)[kCapture]).toBe(true);
  });

  it('initialises this when called as a function (EE.call / util.inherits)', () => {
    const Legacy = LegacyEmitter as unknown as new () => Emitter & { tag: string };
    const legacy = new Legacy();
    expect(legacy.tag).toBe('legacy');
    expect(legacy).toBeInstanceOf(EventEmitter);
    const seen: string[] = [];
    legacy.once('ping', (value: string) => seen.push(value));
    expect(legacy.emit('ping', 'a')).toBe(true);
    expect(legacy.emit('ping', 'b')).toBe(false);
    expect(seen).toEqual(['a']);
    expect(legacy.getMaxListeners()).toBe(10);

    const target = {} as Record<string | symbol, unknown>;
    expect(callable.call(target, { captureRejections: true })).toBeUndefined();
    expect(target._eventsCount).toBe(0);
    expect(target[kCapture]).toBe(true);
    expect(target[kShapeMode]).toBe(false);

    // An emitter that already has its own listener table keeps it (Node's shape mode).
    const events = { existing: () => {} };
    const shaped = { _events: events } as Record<string | symbol, unknown>;
    init.call(shaped);
    expect(shaped._events).toBe(events);
    expect(shaped[kShapeMode]).toBe(true);
    expect(shaped[kCapture]).toBe(false);
  });

  it('aliases on/off to addListener/removeListener like Node', () => {
    expect(EventEmitter.prototype.on).toBe(EventEmitter.prototype.addListener);
    expect(EventEmitter.prototype.off).toBe(EventEmitter.prototype.removeListener);
    // readable-stream's Readable: addListener is its own `on`, which calls the base `on`.
    class Readableish extends EventEmitter {
      override on(event: string, listener: (...args: unknown[]) => void): this {
        return EventEmitter.prototype.on.call(this, event, listener) as this;
      }
      override addListener = this.on;
    }
    const readable = new Readableish();
    const seen: string[] = [];
    const listener = (value: unknown) => seen.push(String(value));
    readable.addListener('data', listener);
    readable.emit('data', 'chunk');
    readable.off('data', listener);
    readable.emit('data', 'ignored');
    expect(seen).toEqual(['chunk']);
  });

  it('keeps the prototype, statics and module exports', async () => {
    expect(events).toBe(EventEmitter);
    expect(EventEmitter.EventEmitter).toBe(EventEmitter);
    expect(EventEmitter.name).toBe('EventEmitter');
    expect(EventEmitter.prototype).toBe(UnenvEventEmitter.prototype);
    expect(EventEmitter.prototype.constructor).toBe(EventEmitter);
    expect(EventEmitter.once).toBe(once);
    expect(typeof EventEmitter.on).toBe('function');
    expect(EventEmitter.errorMonitor).toBe(errorMonitor);
    expect(EventEmitter.captureRejectionSymbol).toBe(captureRejectionSymbol);
    expect(EventEmitter.defaultMaxListeners).toBe(10);
    expect(EventEmitter.captureRejections).toBeFalsy();
    expect((EventEmitter as unknown as { init: unknown }).init).toBe(init);

    const emitter = new EventEmitter();
    setMaxListeners(4, emitter);
    expect(emitter.getMaxListeners()).toBe(4);
    emitter.on('x', () => {});
    expect(listenerCount(emitter, 'x')).toBe(1);
    const fired = once(emitter, 'done');
    emitter.emit('done', 1);
    expect(await fired).toEqual([1]);
  });
});

type Pipe = Emitter & {
  writable?: boolean;
  readable?: boolean;
  _isStdio?: boolean;
  written: unknown[];
  ended: number;
  destroyed: number;
  paused: number;
  resumed: number;
  full?: boolean;
  write(chunk: unknown): boolean;
  end(): void;
  destroy?(): void;
  pause?(): void;
  resume?(): void;
  pipe<T>(dest: T, options?: { end?: boolean }): T;
};

function LegacyStream(this: Pipe) {
  (Stream as unknown as (this: Pipe) => void).call(this);
  this.written = [];
  this.ended = 0;
  this.destroyed = 0;
  this.paused = 0;
  this.resumed = 0;
}
inherits(LegacyStream, Stream as unknown as new () => object);
Object.assign(LegacyStream.prototype, {
  write(this: Pipe, chunk: unknown) {
    this.written.push(chunk);
    return !this.full;
  },
  end(this: Pipe) {
    this.ended++;
  },
  destroy(this: Pipe) {
    this.destroyed++;
  },
  pause(this: Pipe) {
    this.paused++;
  },
  resume(this: Pipe) {
    this.resumed++;
  },
});
const makeStream = () => new (LegacyStream as unknown as new () => Pipe)();

describe('guest node:stream', () => {
  it('is a callable legacy Stream that is also the module default', () => {
    expect(stream as unknown).toBe(Stream);
    expect(stream.Stream as unknown).toBe(Stream);
    expect(stream.Readable).toBe(Readable);
    expect(wasmcloudNodeEnv().alias['node:stream']).toMatch(/node-compat\/stream\.(ts|js)$/);
    expect(wasmcloudNodeEnv().alias.events).toMatch(/node-compat\/events\.(ts|js)$/);
    const created = new (Stream as unknown as new () => Emitter)();
    expect(created).toBeInstanceOf(EventEmitter);
    class Modern extends (Stream as unknown as new () => Emitter) {}
    expect(new Modern()).toBeInstanceOf(Stream as unknown as new () => object);
    expect(makeStream()).toBeInstanceOf(EventEmitter);
  });

  it('pipes data with back-pressure and ends the destination once', () => {
    const source = makeStream();
    const dest = makeStream();
    const piped: unknown[] = [];
    dest.on('pipe', (from: unknown) => piped.push(from));
    expect(source.pipe(dest)).toBe(dest);
    expect(piped).toEqual([source]);

    source.emit('data', 'ignored');
    dest.writable = true;
    source.emit('data', 'a');
    dest.full = true;
    source.emit('data', 'b');
    expect(dest.written).toEqual(['a', 'b']);
    expect(source.paused).toBe(1);

    dest.emit('drain');
    source.readable = true;
    dest.emit('drain');
    expect(source.resumed).toBe(1);

    source.emit('end');
    source.emit('close');
    expect(dest.ended).toBe(1);
    expect(dest.destroyed).toBe(0);
    expect(source.listenerCount('data')).toBe(0);
  });

  it('destroys on close, honours end: false and stdio, and rethrows unhandled errors', () => {
    const source = makeStream();
    const dest = makeStream();
    source.pipe(dest);
    source.emit('close');
    expect(dest.destroyed).toBe(1);
    expect(dest.ended).toBe(0);

    const plain = makeStream();
    const noDestroy = Object.assign(makeStream(), { destroy: undefined });
    plain.pipe(noDestroy);
    plain.emit('close');
    plain.emit('end');
    expect(noDestroy.ended).toBe(0);

    const kept = makeStream();
    const open = makeStream();
    kept.pipe(open, { end: false });
    kept.emit('end');
    expect(open.ended).toBe(0);
    const stdio = Object.assign(makeStream(), { _isStdio: true });
    kept.pipe(stdio);
    kept.emit('end');
    expect(stdio.ended).toBe(0);

    const handled = makeStream();
    const handledDest = makeStream();
    const caught: unknown[] = [];
    handled.on('error', (error: unknown) => caught.push(error));
    handled.pipe(handledDest);
    handled.emit('error', 'boom');
    expect(caught).toEqual(['boom']);
    expect(handled.listenerCount('data')).toBe(0);

    const unhandled = makeStream();
    unhandled.pipe(makeStream());
    expect(() => unhandled.emit('error', new Error('unhandled'))).toThrow('unhandled');
  });
});

describe('bundled legacy emitters', () => {
  it('runs readable-stream style EE.call(this) and Stream.call(this) in a guest bundle', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wasmcloud-events-bundle-'));
    const adapterPath = join(root, 'adapter.ts');
    const entryPath = join(root, 'entry.ts');
    const legacyPath = join(root, 'legacy.cjs');
    const outFile = join(root, 'dist', 'component.js');
    writeFileSync(
      adapterPath,
      "import application from 'virtual:di-framework-application';\nexport const handler = application;\n",
    );
    // Same shape as readable-stream/lib/internal/streams/legacy.js and bl.
    writeFileSync(
      legacyPath,
      `
const { EventEmitter: EE } = require('events');
const inherits = require('util').inherits;
const NodeStream = require('stream').Stream;
function Stream(opts) {
  EE.call(this, opts);
}
Object.setPrototypeOf(Stream.prototype, EE.prototype);
Object.setPrototypeOf(Stream, EE);
function Writable() {
  Stream.call(this);
  this.chunks = [];
}
inherits(Writable, Stream);
Writable.prototype.write = function (chunk) {
  this.chunks.push(chunk);
  this.emit('wrote', chunk);
  return true;
};
function Piped() {
  NodeStream.call(this);
}
inherits(Piped, NodeStream);
module.exports = { Writable, Piped, EE };
`,
    );
    writeFileSync(
      entryPath,
      `
import { EventEmitter } from 'node:events';
import legacy from './legacy.cjs';

const writable = new legacy.Writable();
const seen: string[] = [];
writable.on('wrote', (chunk: string) => seen.push(chunk));
writable.write('a');
class Modern extends EventEmitter {}
const source = new legacy.Piped();
const dest = new legacy.Writable();
dest.writable = true;
source.pipe(dest);
source.emit('data', 'piped');
export default {
  seen,
  chunks: writable.chunks,
  isEmitter: writable instanceof EventEmitter,
  sameEmitter: legacy.EE === EventEmitter,
  modern: new Modern() instanceof EventEmitter,
  piped: dest.chunks,
};
`,
    );
    await DEFAULT_DEPS.bundler({
      adapterPath,
      entryPath,
      outFile,
      files: {},
      env: {},
      cwd: '/',
      guestLogging: false,
    });
    const bundled = await import(pathToFileURL(outFile).href);
    expect(bundled.handler).toEqual({
      seen: ['a'],
      chunks: ['a'],
      isEmitter: true,
      sameEmitter: true,
      modern: true,
      piped: ['piped'],
    });
  });
});
