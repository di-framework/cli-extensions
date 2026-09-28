import './fetch-runtime';
import { installAsyncContext } from './async-hooks';
import timers from './timers';

installAsyncContext();
const global = globalThis as Record<string, unknown>;
for (const [name, implementation] of Object.entries(timers)) {
  if (typeof global[name] !== 'function') global[name] = implementation;
}
