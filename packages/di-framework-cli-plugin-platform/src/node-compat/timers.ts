import { now, waitUntil } from 'wasi:clocks/monotonic-clock@0.3.0';
import { AsyncLocalStorage } from './async-hooks';

let nextId = 1;
const pending = new Map<number, Timeout>();

export class Timeout {
  readonly id = nextId++;
  private active = true;
  private referenced = true;
  private generation = 0;
  private callback: () => void;
  constructor(
    callback: (...args: unknown[]) => void,
    private delay: number,
    private repeat: boolean,
    args: unknown[],
  ) {
    this.callback = AsyncLocalStorage.bind(() => callback(...args));
    this.refresh();
  }
  refresh(): this {
    this.active = true;
    pending.set(this.id, this);
    const generation = ++this.generation;
    void this.wait(generation);
    return this;
  }
  private async wait(generation: number): Promise<void> {
    do {
      const mark = now();
      const deadline = BigInt(mark) + BigInt(this.delay) * BigInt(1_000_000);
      // Bound cancellation latency: cancelled timers must not leave a long WASI
      // task alive after the request has completed.
      while (this.active && generation === this.generation && BigInt(now()) < deadline) {
        const slice = BigInt(now()) + BigInt(10_000_000);
        const when = slice < deadline ? slice : deadline;
        await waitUntil(typeof mark === 'bigint' ? when : Number(when));
      }
      if (!this.active || generation !== this.generation) return;
      if (!this.repeat) this.close();
      this.callback();
    } while (this.repeat && this.active && generation === this.generation);
  }
  close(): this {
    this.active = false;
    this.generation++;
    pending.delete(this.id);
    return this;
  }
  ref(): this {
    this.referenced = true;
    return this;
  }
  unref(): this {
    this.referenced = false;
    return this;
  }
  hasRef(): boolean {
    return this.referenced;
  }
  [Symbol.toPrimitive](): number {
    return this.id;
  }
}

function schedule(
  callback: (...args: any[]) => void,
  delay: number | undefined,
  repeat: boolean,
  args: unknown[],
): Timeout {
  if (typeof callback !== 'function') throw new TypeError('callback must be a function');
  const value = Number(delay);
  const duration =
    !Number.isFinite(value) || value < 1 || value > 2_147_483_647 ? 1 : Math.trunc(value);
  return new Timeout(callback, duration, repeat, args);
}
export function setTimeout(
  callback: (...args: any[]) => void,
  delay?: number,
  ...args: unknown[]
): Timeout {
  return schedule(callback, delay, false, args);
}
export function setInterval(
  callback: (...args: any[]) => void,
  delay?: number,
  ...args: unknown[]
): Timeout {
  return schedule(callback, delay, true, args);
}
export function clearTimeout(timer?: Timeout | number | string | null): void {
  if (timer instanceof Timeout) timer.close();
  else if (timer != null) pending.get(Number(timer))?.close();
}
export const clearInterval = clearTimeout;
export function setImmediate(callback: (...args: any[]) => void, ...args: unknown[]): Timeout {
  return setTimeout(callback, 1, ...args);
}
export const clearImmediate = clearTimeout;
export default {
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  setImmediate,
  clearImmediate,
};
