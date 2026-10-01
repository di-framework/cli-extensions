// unenv's EventEmitter is an ES class, so the function-style subclassing that npm
// packages copied from Node (`EE.call(this)` plus `util.inherits`, as in
// readable-stream's legacy Stream) throws "class constructors must be invoked with
// 'new'". This wrapper keeps unenv's implementation and adds Node's call behavior.
import { EventEmitter as UnenvEventEmitter } from 'unenv/node/events';

export * from 'unenv/node/events';

const kCapture = Symbol.for('kCapture');
const kShapeMode = Symbol.for('shapeMode');

type EmitterState = {
  _events?: object;
  _eventsCount?: number;
  _maxListeners?: number;
  [kCapture]?: boolean;
  [kShapeMode]?: boolean;
};

type EmitterOptions = { captureRejections?: boolean } | undefined;

/** Node's `EventEmitter.init`: the constructor body for an existing `this`. */
function initialize(target: EmitterState, options: EmitterOptions): void {
  const prototype = Object.getPrototypeOf(target) as EmitterState | null;
  if (target._events === undefined || target._events === prototype?._events) {
    target._events = Object.create(null) as object;
    target._eventsCount = 0;
    target[kShapeMode] = false;
  } else {
    target[kShapeMode] = true;
  }
  target._maxListeners = target._maxListeners || undefined;
  target[kCapture] = Boolean(options?.captureRejections);
}

function EventEmitterConstructor(this: EmitterState, options?: EmitterOptions): object | undefined {
  // `new` and `super()` from an ES subclass construct unenv's class for new.target.
  if (new.target) return Reflect.construct(UnenvEventEmitter, [options], new.target) as object;
  initialize(this, options);
  return undefined;
}

/** `EventEmitter.init.call(this)`, the older spelling of `EventEmitter.call(this)`. */
export function init(this: EmitterState, options?: EmitterOptions): void {
  initialize(this, options);
}

const emitterPrototype = UnenvEventEmitter.prototype;
// Node aliases these; unenv's `on` calls `this.addListener`, which recurses forever when a
// subclass points addListener back at its own `on` (readable-stream's Readable does).
emitterPrototype.on = emitterPrototype.addListener;
emitterPrototype.off = emitterPrototype.removeListener;

Object.setPrototypeOf(EventEmitterConstructor, UnenvEventEmitter);
EventEmitterConstructor.prototype = emitterPrototype;
Object.defineProperty(emitterPrototype, 'constructor', {
  value: EventEmitterConstructor,
  writable: true,
  configurable: true,
});
Object.defineProperties(EventEmitterConstructor, {
  name: { value: 'EventEmitter' },
  EventEmitter: { value: EventEmitterConstructor, writable: true, configurable: true },
  init: { value: init, writable: true, configurable: true },
});

export const EventEmitter = EventEmitterConstructor as unknown as typeof UnenvEventEmitter;

// unenv exports these as "not implemented"; the class statics already work.
export const setMaxListeners: typeof UnenvEventEmitter.setMaxListeners = (...args) =>
  UnenvEventEmitter.setMaxListeners(...args);
export const listenerCount: typeof UnenvEventEmitter.listenerCount = (emitter, type) =>
  emitter.listenerCount(type);

export default EventEmitter;
