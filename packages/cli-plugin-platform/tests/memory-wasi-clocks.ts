import { setTimeout as nativeTimeout } from 'node:timers';

export function now(): number {
  return Math.trunc(performance.now() * 1_000_000);
}
export function waitUntil(when: bigint | number): Promise<void> {
  return new Promise((resolve) =>
    nativeTimeout(resolve, Math.max(0, Number(when) - now()) / 1_000_000),
  );
}
