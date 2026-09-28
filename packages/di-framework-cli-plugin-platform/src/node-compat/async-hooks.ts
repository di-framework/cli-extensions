// The bundler lowers async functions to Promise continuations. Native await does
// not call Promise.prototype.then and cannot be instrumented by this JS runtime.
let current = new Map<symbol, unknown>();

function inContext<T>(context: Map<symbol, unknown>, callback: () => T): T {
  const previous = current;
  current = context;
  try {
    return callback();
  } finally {
    current = previous;
  }
}

export class AsyncLocalStorage<T> {
  private key = Symbol();
  private defaultValue: T | undefined;
  readonly name: string;

  constructor(options?: { defaultValue?: T; name?: string }) {
    this.defaultValue = options?.defaultValue;
    this.name = options?.name ?? '';
  }
  getStore(): T | undefined {
    return current.has(this.key) ? (current.get(this.key) as T) : this.defaultValue;
  }
  run<R, A extends unknown[]>(store: T, callback: (...args: A) => R, ...args: A): R {
    const context = new Map(current);
    context.set(this.key, store);
    return inContext(context, () => callback(...args));
  }
  exit<R, A extends unknown[]>(callback: (...args: A) => R, ...args: A): R {
    const context = new Map(current);
    context.delete(this.key);
    return inContext(context, () => callback(...args));
  }
  enterWith(store: T): void {
    current = new Map(current);
    current.set(this.key, store);
  }
  disable(): void {
    current = new Map(current);
    current.delete(this.key);
    this.key = Symbol();
  }
  static bind<F extends (...args: any[]) => any>(callback: F): F {
    const context = current;
    return function (this: unknown, ...args: Parameters<F>) {
      return inContext(context, () => callback.apply(this, args));
    } as F;
  }
  static snapshot() {
    const context = current;
    return <R, A extends unknown[]>(callback: (...args: A) => R, ...args: A): R =>
      inContext(context, () => callback(...args));
  }
}

export class AsyncResource {
  private scope = AsyncLocalStorage.snapshot();
  // biome-ignore lint/complexity/noUselessConstructor: Match the Node constructor signature.
  constructor(_type: string, _options?: unknown) {}
  runInAsyncScope<R, A extends unknown[]>(
    callback: (...args: A) => R,
    thisArg: unknown,
    ...args: A
  ): R {
    return this.scope(() => callback.apply(thisArg, args));
  }
  bind<F extends (...args: any[]) => any>(callback: F, thisArg?: unknown): F {
    return ((...args: Parameters<F>) => this.runInAsyncScope(callback, thisArg, ...args)) as F;
  }
  emitDestroy(): this {
    return this;
  }
}

let installed = false;
export function installAsyncContext(): void {
  if (installed) return;
  installed = true;
  const then = Promise.prototype.then;
  // biome-ignore lint/suspicious/noThenProperty: Bind real Promise continuations to the captured guest context.
  Promise.prototype.then = function (this: Promise<unknown>, onfulfilled, onrejected) {
    return then.call(
      this,
      typeof onfulfilled === 'function' ? AsyncLocalStorage.bind(onfulfilled) : onfulfilled,
      typeof onrejected === 'function' ? AsyncLocalStorage.bind(onrejected) : onrejected,
    );
  } as typeof then;
}

export default { AsyncLocalStorage, AsyncResource };
