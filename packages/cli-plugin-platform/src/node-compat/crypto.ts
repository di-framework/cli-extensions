import { toBytes, toNodeBuffer } from './bytes';
import { createHash, createHmac, Hash, Hmac } from './crypto-hash';
import { getRandomValues, randomUUID, subtle, webcrypto } from './crypto-subtle';
import { invalidArgType, outOfRange } from './node-errors';
import { fillRandom, getRandomBytes, RANDOM_SIZE_MAX } from './wasi-random';

export { createHash, createHmac, getRandomValues, Hash, Hmac, randomUUID, subtle, webcrypto };

function cryptoUnsupported(name: string): Error & { code: string } {
  const error = new Error(`crypto.${name} is not implemented in the wasmCloud guest`) as Error & {
    code: string;
  };
  error.code = 'ERR_CRYPTO_UNSUPPORTED';
  return error;
}

function notImplemented(name: string): (...args: never[]) => never {
  return () => {
    throw cryptoUnsupported(name);
  };
}

export function randomBytes(
  size: number,
  callback?: (error: Error | null, buffer: Uint8Array) => void,
): Uint8Array | undefined {
  if (callback !== undefined && typeof callback !== 'function') {
    throw invalidArgType('callback', 'of type function', callback);
  }
  const bytes = toNodeBuffer(getRandomBytes(size));
  if (typeof callback === 'function') {
    queueMicrotask(() => callback(null, bytes));
    return undefined;
  }
  return bytes;
}

type RandomTarget = ArrayBufferView | ArrayBuffer;

function randomTargetBytes(buffer: unknown): { view: Uint8Array; elementSize: number } {
  if (ArrayBuffer.isView(buffer)) {
    return {
      view: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
      elementSize: (buffer as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT || 1,
    };
  }
  if (buffer instanceof ArrayBuffer) return { view: new Uint8Array(buffer), elementSize: 1 };
  throw invalidArgType('buf', 'an instance of ArrayBuffer or ArrayBufferView', buffer);
}

/** Node v22 `assertOffset`: offsets count elements, are bounded by the byte length, and truncate. */
function randomOffset(offset: unknown, elementSize: number, byteLength: number): number {
  if (typeof offset !== 'number') throw invalidArgType('offset', 'of type number', offset);
  const bytes = offset * elementSize;
  const max = Math.min(byteLength, RANDOM_SIZE_MAX);
  if (Number.isNaN(bytes) || bytes > max || bytes < 0) {
    throw outOfRange('offset', `>= 0 && <= ${max}`, bytes);
  }
  return Math.trunc(bytes);
}

/** Node v22 `assertSize`: sizes count elements and must fit after the offset. */
function randomSize(size: unknown, elementSize: number, offset: number, byteLength: number) {
  if (typeof size !== 'number') throw invalidArgType('size', 'of type number', size);
  const bytes = size * elementSize;
  if (Number.isNaN(bytes) || bytes > RANDOM_SIZE_MAX || bytes < 0) {
    throw outOfRange('size', `>= 0 && <= ${RANDOM_SIZE_MAX}`, bytes);
  }
  if (bytes + offset > byteLength)
    throw outOfRange('size + offset', `<= ${byteLength}`, bytes + offset);
  return Math.trunc(bytes);
}

function fillRange(view: Uint8Array, offset: number, size: number): void {
  if (size > 0) fillRandom(view.subarray(offset, offset + size));
}

export function randomFillSync<T extends RandomTarget>(
  buffer: T,
  offset: number = 0,
  size?: number,
): T {
  const { view, elementSize } = randomTargetBytes(buffer);
  const start = randomOffset(offset, elementSize, view.byteLength);
  const length =
    size === undefined
      ? view.byteLength - start
      : randomSize(size, elementSize, start, view.byteLength);
  fillRange(view, start, length);
  return buffer;
}

export function randomFill<T extends RandomTarget>(
  buffer: T,
  offset?: number | ((error: Error | null, buffer: T) => void),
  size?: number | ((error: Error | null, buffer: T) => void),
  callback?: (error: Error | null, buffer: T) => void,
): undefined | T {
  const { view, elementSize } = randomTargetBytes(buffer);
  let start = 0;
  let length = view.byteLength;
  let cb: ((error: Error | null, buffer: T) => void) | undefined;
  if (typeof offset === 'function') cb = offset;
  else if (typeof size === 'function') {
    cb = size;
    start = randomOffset(offset, elementSize, view.byteLength);
    length = view.byteLength - start;
  } else {
    cb = callback;
    start = randomOffset(offset ?? 0, elementSize, view.byteLength);
    length =
      size === undefined
        ? view.byteLength - start
        : randomSize(size, elementSize, start, view.byteLength);
  }
  fillRange(view, start, length);
  if (cb !== undefined) {
    queueMicrotask(() => cb(null, buffer));
    return undefined;
  }
  return buffer;
}

export function randomInt(
  min: number,
  max?: number | ((error: Error | null, value: number) => void),
  callback?: (error: Error | null, value: number) => void,
): number | undefined {
  let low = 0;
  let high = min;
  let cb = callback;
  if (typeof max === 'function') {
    cb = max;
  } else if (typeof max === 'number') {
    low = min;
    high = max;
  }
  const range = high - low;
  if (!Number.isSafeInteger(low) || !Number.isSafeInteger(high) || range <= 0 || range >= 2 ** 48) {
    throw new RangeError('The value of "max" is out of range');
  }
  const sampleSpace = 2 ** 48;
  const limit = sampleSpace - (sampleSpace % range);
  let value: number;
  do {
    const bytes = getRandomBytes(6);
    value = 0;
    for (const byte of bytes) value = value * 256 + byte;
  } while (value >= limit);
  const result = low + (value % range);
  if (cb !== undefined) {
    queueMicrotask(() => cb(null, result));
    return undefined;
  }
  return result;
}

export function timingSafeEqual(a: ArrayBufferView, b: ArrayBufferView): boolean {
  const left = toBytes(a);
  const right = toBytes(b);
  if (left.length !== right.length) {
    const error = new Error('Input buffers must have the same byte length') as Error & {
      code: string;
    };
    error.code = 'ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH';
    throw error;
  }
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

export const rng = randomBytes;
export const prng = randomBytes;

export const checkPrime = notImplemented('checkPrime');
export const checkPrimeSync = notImplemented('checkPrimeSync');
export const createCipheriv = notImplemented('createCipheriv');
export const createDecipheriv = notImplemented('createDecipheriv');
export const createDiffieHellman = notImplemented('createDiffieHellman');
export const createECDH = notImplemented('createECDH');
export const createPrivateKey = notImplemented('createPrivateKey');
export const createPublicKey = notImplemented('createPublicKey');
export const createSecretKey = notImplemented('createSecretKey');
export const createSign = notImplemented('createSign');
export const createVerify = notImplemented('createVerify');
export const diffieHellman = notImplemented('diffieHellman');
export const generateKeyPair = notImplemented('generateKeyPair');
export const generateKeyPairSync = notImplemented('generateKeyPairSync');
export const generateKey = notImplemented('generateKey');
export const pbkdf2 = notImplemented('pbkdf2');
export const pbkdf2Sync = notImplemented('pbkdf2Sync');
export const scrypt = notImplemented('scrypt');
export const scryptSync = notImplemented('scryptSync');
export const sign = notImplemented('sign');
export const verify = notImplemented('verify');
export const hkdfSync = notImplemented('hkdfSync');
export const privateDecrypt = notImplemented('privateDecrypt');
export const privateEncrypt = notImplemented('privateEncrypt');
export const publicDecrypt = notImplemented('publicDecrypt');
export const publicEncrypt = notImplemented('publicEncrypt');

const cryptoObject = {
  createHash,
  createHmac,
  Hash,
  Hmac,
  randomBytes,
  randomFill,
  randomFillSync,
  randomInt,
  randomUUID,
  getRandomValues,
  timingSafeEqual,
  subtle,
  webcrypto,
  rng,
  prng,
};

export default cryptoObject;
