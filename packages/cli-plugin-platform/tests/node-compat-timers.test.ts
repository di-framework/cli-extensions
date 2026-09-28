import { expect, it, mock } from 'bun:test';
import { AsyncLocalStorage } from '../src/node-compat/async-hooks';
import * as clock from './memory-wasi-clocks';

mock.module('wasi:clocks/monotonic-clock@0.3.0', () => clock);
const { setTimeout, clearTimeout, setInterval, clearInterval, setImmediate } = await import(
  '../src/node-compat/timers'
);

it('runs WASI timers with arguments and context, cancels and refreshes handles', async () => {
  const storage = new AsyncLocalStorage<string>();
  const fired: string[] = [];
  const cancelled = setTimeout(() => fired.push('cancelled'), 2);
  clearTimeout(Number(cancelled));
  const value = await storage.run(
    'timer-scope',
    () =>
      new Promise((resolve) => {
        const timer = setTimeout(
          (argument) => resolve([argument, storage.getStore()]),
          3,
          'argument',
        );
        expect(timer.unref().hasRef()).toBe(false);
        expect(timer.ref().hasRef()).toBe(true);
        timer.refresh();
      }),
  );
  expect(value).toEqual(['argument', 'timer-scope']);
  await new Promise<void>((resolve) => {
    const interval = setInterval(() => {
      fired.push('tick');
      if (fired.length === 2) {
        clearInterval(interval);
        resolve();
      }
    }, 2);
  });
  expect(fired).toEqual(['tick', 'tick']);
  expect(await new Promise<string>((resolve) => setImmediate(() => resolve('immediate')))).toBe(
    'immediate',
  );
  expect(() => setTimeout(null as never)).toThrow(TypeError);
});
