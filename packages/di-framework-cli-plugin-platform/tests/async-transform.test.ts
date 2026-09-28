import { expect, it } from 'bun:test';
import { transformAsync } from '@babel/core';
import asyncToGenerator from '@babel/plugin-transform-async-to-generator';
import { lowerForAwait } from '../src/async-transform';

it('lowers await loops with iterator cleanup and labels without changing generator prototypes', async () => {
  const result = await transformAsync(
    `
    async function probe() {
      const calls = [], seen = [];
      const iterable = { [Symbol.asyncIterator]() {
        let value = 0;
        return {
          async next() { return { value: ++value, done: value > 3 }; },
          async return() { calls.push('close'); return { done: true }; }
        };
      }};
      outer: for await (const n of iterable) {
        if (n === 1) continue outer;
        seen.push(n);
        break;
      }
      try { for await (const n of iterable) { throw new Error('body'); } }
      catch (error) { calls.push(error.message); }
      let value;
      for await (value of [Promise.resolve(4)]) seen.push(value);
      return { seen, calls, prototype: !!Object.getPrototypeOf(Object.getPrototypeOf(async function*() {}).prototype) };
    }
  `,
    { babelrc: false, configFile: false, plugins: [lowerForAwait, asyncToGenerator] },
  );
  expect(result?.code).toBeDefined();
  const probe = new Function(`${result?.code}; return probe;`)();
  expect(await probe()).toEqual({
    seen: [2, 4],
    calls: ['close', 'close', 'body'],
    prototype: true,
  });
});
