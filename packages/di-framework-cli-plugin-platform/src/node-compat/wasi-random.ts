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

/** Guest CSPRNG from WASI 0.3 `wasi:random/random`. */
export function getRandomBytes(size: number): Uint8Array {
  if (!Number.isFinite(size) || size < 0) {
    throw new RangeError(`getRandomBytes size must be a non-negative integer, received ${size}`);
  }
  if (size === 0) return new Uint8Array();
  const bytes = unwrapRandom(wasiGetRandomBytes(size));
  if (bytes.length === size) return bytes.slice();
  if (bytes.length > size) return bytes.slice(0, size);
  throw new Error(`wasi:random returned ${bytes.length} bytes, expected ${size}`);
}
