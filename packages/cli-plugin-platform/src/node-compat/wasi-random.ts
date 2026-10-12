import { getRandomBytes as wasiGetRandomBytes } from 'wasi:random/random@0.3.0';
import { toBytes } from './bytes';
import { invalidArgType, outOfRange } from './node-errors';

/** Node's `kMaxPossibleLength` for `crypto.randomBytes` / `randomFillSync` sizes: 2**31 - 1. */
export const RANDOM_SIZE_MAX = 2 ** 31 - 1;

/**
 * Largest `max-len` one `wasi:random` call asks for. Bigger requests are filled in
 * chunks so the host never allocates more than this per call (it matches the Web
 * Crypto `getRandomValues` quota).
 */
export const RANDOM_CHUNK = 65_536;

function unwrapRandom(value: unknown): Uint8Array {
  if (value !== null && typeof value === 'object' && 'tag' in value) {
    const result = value as { tag: string; val?: unknown };
    if (result.tag === 'ok') return toBytes(result.val);
    throw new Error(`wasi:random failed: ${String(result.val)}`);
  }
  return toBytes(value);
}

/**
 * Validates a byte count exactly as Node v22's `crypto.randomBytes` does: a number
 * (`ERR_INVALID_ARG_TYPE` otherwise, BigInt included) in `[0, 2**31 - 1]`
 * (`ERR_OUT_OF_RANGE` otherwise, NaN included). Like Node, fractional sizes are
 * accepted and truncated (`1.5` gives one byte). Returns the truncated count.
 */
export function validateRandomSize(size: unknown, name = 'size'): number {
  if (typeof size !== 'number') throw invalidArgType(name, 'of type number', size);
  if (Number.isNaN(size) || size < 0 || size > RANDOM_SIZE_MAX) {
    throw outOfRange(name, `>= 0 && <= ${RANDOM_SIZE_MAX}`, size);
  }
  return Math.trunc(size);
}

function requestRandom(length: number): Uint8Array {
  // `max-len` is a WIT u64; BigInt is the canonical JS representation, and
  // componentize-qjs 0.4.4-di.5+ traps on a Number that is not a safe integer.
  const bytes = unwrapRandom(wasiGetRandomBytes(BigInt(length)));
  if (bytes.length < length) {
    throw new Error(`wasi:random returned ${bytes.length} bytes, expected ${length}`);
  }
  return bytes.length === length ? bytes : bytes.subarray(0, length);
}

/**
 * Fills `target` from the guest CSPRNG in calls of at most {@link RANDOM_CHUNK} bytes.
 * Callers validate the length first.
 */
export function fillRandom(target: Uint8Array): Uint8Array {
  for (let offset = 0; offset < target.length; offset += RANDOM_CHUNK) {
    target.set(requestRandom(Math.min(RANDOM_CHUNK, target.length - offset)), offset);
  }
  return target;
}

/** Guest CSPRNG from WASI 0.3 `wasi:random/random`, validated like `crypto.randomBytes`. */
export function getRandomBytes(size: number): Uint8Array {
  const length = validateRandomSize(size);
  return fillRandom(new Uint8Array(length));
}
