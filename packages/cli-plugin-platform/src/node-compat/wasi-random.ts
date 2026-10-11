import { getRandomBytes as wasiGetRandomBytes } from 'wasi:random/random@0.3.0';
import { toBytes } from './bytes';

function unwrapRandom(value: unknown): Uint8Array {
  if (value !== null && typeof value === 'object' && 'tag' in value) {
    const result = value as { tag: string; val?: unknown };
    if (result.tag === 'ok') return toBytes(result.val);
    throw new Error(`wasi:random failed: ${String(result.val)}`);
  }
  return toBytes(value);
}

function sizeError<E extends Error>(error: E, code: string): E & { code: string } {
  return Object.assign(error, { code });
}

/**
 * Validates a byte count the way Node's `crypto.randomBytes` does before it
 * reaches the `u64` import: componentize-qjs 0.4.4-di.5+ traps when a `u64`
 * argument is not a BigInt or a non-negative safe-integer Number.
 */
function assertRandomSize(size: unknown): asserts size is number {
  if (typeof size !== 'number') {
    throw sizeError(
      new TypeError(
        `The "size" argument must be of type number. Received ${
          typeof size === 'bigint' ? `type bigint (${size}n)` : typeof size
        }`,
      ),
      'ERR_INVALID_ARG_TYPE',
    );
  }
  if (!Number.isSafeInteger(size) || size < 0) {
    throw sizeError(
      new RangeError(
        `The value of "size" is out of range. getRandomBytes size must be a non-negative integer <= ${Number.MAX_SAFE_INTEGER}. Received ${size}`,
      ),
      'ERR_OUT_OF_RANGE',
    );
  }
}

/** Guest CSPRNG from WASI 0.3 `wasi:random/random`. */
export function getRandomBytes(size: number): Uint8Array {
  assertRandomSize(size);
  if (size === 0) return new Uint8Array();
  // `max-len` is a WIT u64; BigInt is the canonical JS representation.
  const bytes = unwrapRandom(wasiGetRandomBytes(BigInt(size)));
  if (bytes.length === size) return bytes.slice();
  if (bytes.length > size) return bytes.slice(0, size);
  throw new Error(`wasi:random returned ${bytes.length} bytes, expected ${size}`);
}
