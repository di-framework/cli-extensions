// unenv's `Stream` throws on construction, so packages that subclass Node's legacy
// stream (`Stream.call(this)` plus `util.inherits(Foo, Stream)`) fail. This is Node's
// legacy Stream: a callable EventEmitter with the classic `pipe`.
import unenvStream from 'unenv/node/stream';
import { EventEmitter } from './events';

export * from 'unenv/node/stream';

type Emitter = InstanceType<typeof EventEmitter>;
type PipeSource = Emitter & { readable?: boolean; pause?(): void; resume?(): void };
type PipeDestination = Emitter & {
  writable?: boolean;
  _isStdio?: boolean;
  write(chunk: unknown): boolean;
  end(): void;
  destroy?(): void;
};

export function Stream(this: Emitter, options?: { captureRejections?: boolean }): void {
  (EventEmitter as unknown as (this: Emitter, options?: object) => void).call(this, options);
}

Object.setPrototypeOf(Stream.prototype, EventEmitter.prototype);
Object.setPrototypeOf(Stream, EventEmitter);

Stream.prototype.pipe = function pipe<T extends PipeDestination>(
  this: PipeSource,
  dest: T,
  options?: { end?: boolean },
): T {
  const source = this;
  function ondata(chunk: unknown) {
    if (dest.writable && dest.write(chunk) === false && source.pause) source.pause();
  }
  source.on('data', ondata);
  function ondrain() {
    if (source.readable && source.resume) source.resume();
  }
  dest.on('drain', ondrain);
  // Without `end: false`, end dest once when source ends or closes.
  if (!dest._isStdio && options?.end !== false) {
    source.on('end', onend);
    source.on('close', onclose);
  }
  let didOnEnd = false;
  function onend() {
    if (didOnEnd) return;
    didOnEnd = true;
    dest.end();
  }
  function onclose() {
    if (didOnEnd) return;
    didOnEnd = true;
    if (typeof dest.destroy === 'function') dest.destroy();
  }
  // Don't leave dangling pipes when there are errors.
  function onerror(this: Emitter, error: unknown) {
    cleanup();
    if (this.listenerCount('error') === 0) this.emit('error', error);
  }
  source.prependListener('error', onerror);
  dest.prependListener('error', onerror);
  function cleanup() {
    source.removeListener('data', ondata);
    dest.removeListener('drain', ondrain);
    source.removeListener('end', onend);
    source.removeListener('close', onclose);
    source.removeListener('error', onerror);
    dest.removeListener('error', onerror);
    source.removeListener('end', cleanup);
    source.removeListener('close', cleanup);
    dest.removeListener('close', cleanup);
  }
  source.on('end', cleanup);
  source.on('close', cleanup);
  dest.on('close', cleanup);
  dest.emit('pipe', source);
  return dest;
};

// `require('stream')` in Node is the Stream function carrying the other exports.
const stream = Object.assign(Stream, unenvStream, { Stream });

export default stream;
