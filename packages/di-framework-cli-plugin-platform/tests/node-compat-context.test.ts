import { describe, expect, it } from 'bun:test';
import {
  AsyncLocalStorage,
  AsyncResource,
  installAsyncContext,
} from '../src/node-compat/async-hooks';

describe('guest async context scopes', () => {
  it('enters a scope without changing captured snapshots and restores the enclosing scope', () => {
    const storage = new AsyncLocalStorage<string>();
    storage.run('outer', () => {
      const snapshot = AsyncLocalStorage.snapshot();
      storage.enterWith('entered');
      expect(storage.getStore()).toBe('entered');
      expect(snapshot(() => storage.getStore())).toBe('outer');
      expect(storage.getStore()).toBe('entered');
    });
    expect(storage.getStore()).toBeUndefined();
  });

  it('binds resources to their creation scope with a receiver and arguments', () => {
    const storage = new AsyncLocalStorage<string>();
    const resource = storage.run('created', () => new AsyncResource('probe'));
    const bound = resource.bind(
      function (this: { value: number }, n: number) {
        return [storage.getStore(), this.value + n];
      },
      { value: 3 },
    );
    storage.run('caller', () => {
      expect(bound.call({ value: 100 }, 4)).toEqual(['created', 7]);
      expect(storage.getStore()).toBe('caller');
      expect(() =>
        resource.runInAsyncScope(() => {
          expect(storage.getStore()).toBe('created');
          throw new Error('resource failure');
        }, null),
      ).toThrow('resource failure');
      expect(storage.getStore()).toBe('caller');
    });
    expect(resource.emitDestroy()).toBe(resource);
    expect(storage.getStore()).toBeUndefined();
  });

  it('installs once and captures fulfillment and rejection contexts at registration', async () => {
    const originalThen = Promise.prototype.then;
    try {
      installAsyncContext();
      const installedThen = Promise.prototype.then;
      expect(installedThen).not.toBe(originalThen);
      installAsyncContext();
      expect(Promise.prototype.then).toBe(installedThen);

      const storage = new AsyncLocalStorage<string>();
      let resolve!: (value: number) => void;
      let reject!: (reason: Error) => void;
      const fulfilled = new Promise<number>((done) => {
        resolve = done;
      });
      const rejected = new Promise<never>((_, fail) => {
        reject = fail;
      });
      const failure = new Error('rejected');
      const first = storage.run('fulfillment', () =>
        fulfilled.then((value) => {
          expect(storage.getStore()).toBe('fulfillment');
          return value + 1;
        }),
      );
      const second = storage.run('rejection', () =>
        rejected.then(undefined, (error) => {
          expect(storage.getStore()).toBe('rejection');
          expect(error).toBe(failure);
          return 'recovered';
        }),
      );
      storage.run('settlement', () => {
        resolve(41);
        reject(failure);
      });
      expect(await first).toBe(42);
      expect(await second).toBe('recovered');
      expect(await Promise.resolve('passthrough').then<string>()).toBe('passthrough');
      await expect(Promise.reject(failure).then()).rejects.toBe(failure);
      expect(storage.getStore()).toBeUndefined();
    } finally {
      // biome-ignore lint/suspicious/noThenProperty: Restore the native Promise method after testing instrumentation.
      Promise.prototype.then = originalThen;
    }
  });

  it('restores nested scopes on return and throw and binds snapshots', () => {
    const storage = new AsyncLocalStorage<string>();
    let bound!: () => string | undefined;
    storage.run('outer', () => {
      bound = AsyncLocalStorage.bind(() => storage.getStore());
      expect(storage.run('inner', () => storage.getStore())).toBe('inner');
      expect(storage.getStore()).toBe('outer');
      expect(storage.exit(() => storage.getStore())).toBeUndefined();
      expect(() =>
        storage.run('bad', () => {
          throw new Error('failure');
        }),
      ).toThrow('failure');
      expect(storage.getStore()).toBe('outer');
      const resource = new AsyncResource('probe');
      expect(resource.runInAsyncScope(() => storage.getStore(), null)).toBe('outer');
    });
    expect(storage.getStore()).toBeUndefined();
    expect(bound()).toBe('outer');
    storage.disable();
    expect(bound()).toBeUndefined();
  });
  it('keeps separate storage instances and preserves callback this/arguments', () => {
    const first = new AsyncLocalStorage<number>({ defaultValue: 0, name: 'first' });
    const second = new AsyncLocalStorage<number>();
    expect(first.name).toBe('first');
    expect(first.getStore()).toBe(0);
    first.run(1, () =>
      second.run(2, () => {
        const bound = AsyncLocalStorage.bind(function (this: { value: number }, n: number) {
          return [first.getStore(), second.getStore(), this.value, n];
        });
        expect(bound.call({ value: 3 }, 4)).toEqual([1, 2, 3, 4]);
      }),
    );
    expect(second.getStore()).toBeUndefined();
  });
});
