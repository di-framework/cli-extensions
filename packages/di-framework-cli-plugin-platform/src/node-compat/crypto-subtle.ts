import { gcm } from '@noble/ciphers/aes.js';
import { p256 } from '@noble/curves/nist.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256, sha384, sha512 } from '@noble/hashes/sha2.js';
import { toArrayBuffer, toBytes } from './bytes';
import { digestSync, hashFunction, normalizeHashName } from './crypto-hash';
import { getRandomBytes } from './wasi-random';

type AlgorithmIdentifier = string | { name: string; [parameter: string]: unknown };
type BufferSource = ArrayBufferView | ArrayBuffer;
type JsonWebKey = Record<string, unknown>;

export type GuestCryptoKey = {
  type: 'secret' | 'private' | 'public';
  extractable: boolean;
  algorithm: { name: string; [parameter: string]: unknown };
  usages: string[];
  kind: 'hmac' | 'hkdf' | 'aes-gcm' | 'ecdh-private' | 'ecdh-public';
  bytes: Uint8Array;
};

type NobleHash = {
  (data: Uint8Array): Uint8Array;
  create(): { update(data: Uint8Array): unknown; digest(): Uint8Array };
  outputLen: number;
};

const HASH_OUTPUT: Record<string, { noble: NobleHash; bits: number }> = {
  sha256: { noble: sha256 as NobleHash, bits: 256 },
  sha384: { noble: sha384 as NobleHash, bits: 384 },
  sha512: { noble: sha512 as NobleHash, bits: 512 },
};

function operationError(message: string): Error {
  const error = new Error(message) as Error & { name: string };
  error.name = 'OperationError';
  return error;
}

function notSupported(message: string): Error {
  const error = new Error(message) as Error & { name: string };
  error.name = 'NotSupportedError';
  return error;
}

function dataError(message: string): Error {
  const error = new Error(message) as Error & { name: string };
  error.name = 'DataError';
  return error;
}

export function algorithmName(algorithm: AlgorithmIdentifier): string {
  if (typeof algorithm === 'string') return algorithm.toUpperCase();
  if (algorithm !== null && typeof algorithm === 'object' && typeof algorithm.name === 'string') {
    return algorithm.name.toUpperCase();
  }
  throw notSupported('Unrecognized algorithm');
}

function hashFromAlgorithm(algorithm: unknown): string {
  if (typeof algorithm === 'string') return normalizeHashName(algorithm);
  if (algorithm !== null && typeof algorithm === 'object') {
    const record = algorithm as { name?: unknown; hash?: unknown };
    if (record.hash !== undefined) return hashFromAlgorithm(record.hash);
    if (typeof record.name === 'string') return normalizeHashName(record.name);
  }
  throw notSupported('Unrecognized hash algorithm');
}

function asKey(key: unknown): GuestCryptoKey {
  if (key !== null && typeof key === 'object' && 'kind' in key && 'bytes' in key) {
    return key as GuestCryptoKey;
  }
  throw dataError('Invalid CryptoKey');
}

function algorithmParams(algorithm: AlgorithmIdentifier): Record<string, unknown> {
  return typeof algorithm === 'string' ? { name: algorithm } : { ...algorithm };
}

export function getRandomValues<T extends ArrayBufferView>(array: T): T {
  const view = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
  const random = getRandomBytes(view.length);
  view.set(random);
  return array;
}

export function randomUUID(): string {
  const bytes = getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function digest(algorithm: AlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer> {
  const name = algorithmName(algorithm);
  if (name !== 'SHA-256' && name !== 'SHA-384' && name !== 'SHA-512' && name !== 'SHA-1') {
    throw notSupported(`subtle.digest does not support ${name}`);
  }
  return toArrayBuffer(digestSync(name, toBytes(data)));
}

async function importKey(
  format: string,
  keyData: BufferSource | JsonWebKey,
  algorithm: AlgorithmIdentifier,
  extractable: boolean,
  keyUsages: readonly string[],
): Promise<GuestCryptoKey> {
  const name = algorithmName(algorithm);
  const usages = [...keyUsages];
  if (format !== 'raw') throw notSupported(`importKey format ${format} is not supported`);
  const bytes = toBytes(keyData);
  if (name === 'HMAC') {
    const hashAlg = algorithmParams(algorithm).hash;
    if (hashAlg === undefined) throw notSupported('HMAC requires a hash');
    hashFunction(hashFromAlgorithm(hashAlg));
    return {
      type: 'secret',
      extractable,
      algorithm: { name: 'HMAC', hash: { name: algorithmName(hashAlg as AlgorithmIdentifier) } },
      usages,
      kind: 'hmac',
      bytes,
    };
  }
  if (name === 'HKDF') {
    return {
      type: 'secret',
      extractable,
      algorithm: { name: 'HKDF' },
      usages,
      kind: 'hkdf',
      bytes,
    };
  }
  if (name === 'AES-GCM') {
    if (bytes.length !== 16 && bytes.length !== 24 && bytes.length !== 32) {
      throw dataError(`AES-GCM key must be 16, 24, or 32 bytes, got ${bytes.length}`);
    }
    return {
      type: 'secret',
      extractable,
      algorithm: { name: 'AES-GCM', length: bytes.length * 8 },
      usages,
      kind: 'aes-gcm',
      bytes,
    };
  }
  if (name === 'ECDH') {
    const namedCurve = String(
      (algorithmParams(algorithm).namedCurve as string | undefined) ?? 'P-256',
    ).toUpperCase();
    if (namedCurve !== 'P-256') throw notSupported(`ECDH curve ${namedCurve} is not supported`);
    if (bytes.length !== 65 || bytes[0] !== 0x04) {
      throw dataError('ECDH P-256 public key must be uncompressed (65 bytes)');
    }
    return {
      type: 'public',
      extractable,
      algorithm: { name: 'ECDH', namedCurve: 'P-256' },
      usages,
      kind: 'ecdh-public',
      bytes,
    };
  }
  throw notSupported(`importKey algorithm ${name} is not supported`);
}

async function exportKey(format: string, key: GuestCryptoKey): Promise<ArrayBuffer> {
  if (format !== 'raw') throw notSupported(`exportKey format ${format} is not supported`);
  const cryptoKey = asKey(key);
  if (cryptoKey.kind === 'ecdh-public') return toArrayBuffer(cryptoKey.bytes);
  if (!cryptoKey.extractable) throw operationError('key is not extractable');
  return toArrayBuffer(cryptoKey.bytes);
}

async function generateKey(
  algorithm: AlgorithmIdentifier,
  extractable: boolean,
  keyUsages: readonly string[],
): Promise<GuestCryptoKey | { publicKey: GuestCryptoKey; privateKey: GuestCryptoKey }> {
  const name = algorithmName(algorithm);
  if (name !== 'ECDH') throw notSupported(`generateKey algorithm ${name} is not supported`);
  const namedCurve = String(
    (algorithmParams(algorithm).namedCurve as string | undefined) ?? 'P-256',
  ).toUpperCase();
  if (namedCurve !== 'P-256') throw notSupported(`ECDH curve ${namedCurve} is not supported`);
  const seedLength = Number(p256.lengths.seed ?? 48);
  const secretKey = p256.utils.randomSecretKey(getRandomBytes(seedLength));
  const publicBytes = p256.getPublicKey(secretKey, false);
  const usages = [...keyUsages];
  return {
    publicKey: {
      type: 'public',
      extractable: true,
      algorithm: { name: 'ECDH', namedCurve: 'P-256' },
      usages: [],
      kind: 'ecdh-public',
      bytes: publicBytes,
    },
    privateKey: {
      type: 'private',
      extractable,
      algorithm: { name: 'ECDH', namedCurve: 'P-256' },
      usages,
      kind: 'ecdh-private',
      bytes: secretKey,
    },
  };
}

async function deriveBits(
  algorithm: AlgorithmIdentifier,
  baseKey: GuestCryptoKey,
  length: number,
): Promise<ArrayBuffer> {
  const name = algorithmName(algorithm);
  const key = asKey(baseKey);
  const byteLength = Math.ceil(length / 8);
  if (name === 'HKDF') {
    if (key.kind !== 'hkdf') throw invalidAccess('HKDF');
    const params = algorithmParams(algorithm);
    const hash = HASH_OUTPUT[hashFromAlgorithm(params.hash)];
    if (hash === undefined) throw notSupported('HKDF hash is not supported');
    const salt = toBytes(params.salt);
    const info = toBytes(params.info);
    return toArrayBuffer(hkdf(hash.noble as never, key.bytes, salt, info, byteLength));
  }
  if (name === 'ECDH') {
    if (key.kind !== 'ecdh-private') throw invalidAccess('ECDH');
    const peer = asKey(paramsPublic(algorithm));
    if (peer.kind !== 'ecdh-public') throw dataError('ECDH public key required');
    const shared = p256.getSharedSecret(key.bytes, peer.bytes, true);
    const secret = shared.length === 32 ? shared : shared.subarray(shared.length - 32);
    if (secret.length < byteLength) throw operationError('deriveBits length too large');
    return toArrayBuffer(secret.subarray(0, byteLength));
  }
  throw notSupported(`deriveBits algorithm ${name} is not supported`);
}

function paramsPublic(algorithm: AlgorithmIdentifier): unknown {
  const params = algorithmParams(algorithm);
  return params.public;
}

function invalidAccess(name: string): Error {
  const error = new Error(`Key is not valid for ${name}`) as Error & { name: string };
  error.name = 'InvalidAccessError';
  return error;
}

async function sign(
  algorithm: AlgorithmIdentifier,
  key: GuestCryptoKey,
  data: BufferSource,
): Promise<ArrayBuffer> {
  const name = algorithmName(algorithm);
  const cryptoKey = asKey(key);
  if (name !== 'HMAC' && name !== 'HMAC-SHA-256') {
    throw notSupported(`subtle.sign does not support ${name}`);
  }
  if (cryptoKey.kind !== 'hmac') throw invalidAccess('HMAC');
  const hash = HASH_OUTPUT[hashFromAlgorithm(cryptoKey.algorithm.hash)] ?? HASH_OUTPUT.sha256;
  if (hash === undefined) throw notSupported('HMAC hash is not supported');
  return toArrayBuffer(hmac(hash.noble as never, cryptoKey.bytes, toBytes(data)));
}

async function verify(
  algorithm: AlgorithmIdentifier,
  key: GuestCryptoKey,
  signature: BufferSource,
  data: BufferSource,
): Promise<boolean> {
  const expected = new Uint8Array(await sign(algorithm, key, data));
  const actual = toBytes(signature);
  if (expected.length !== actual.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= (expected[i] ?? 0) ^ (actual[i] ?? 0);
  return diff === 0;
}

function gcmParams(algorithm: AlgorithmIdentifier): { iv: Uint8Array; aad?: Uint8Array } {
  const params = algorithmParams(algorithm);
  const iv = toBytes(params.iv);
  if (iv.length !== 12) throw notSupported('AES-GCM IV must be 12 bytes');
  const aad = params.additionalData === undefined ? undefined : toBytes(params.additionalData);
  return { iv, aad };
}

async function encrypt(
  algorithm: AlgorithmIdentifier,
  key: GuestCryptoKey,
  data: BufferSource,
): Promise<ArrayBuffer> {
  if (algorithmName(algorithm) !== 'AES-GCM') {
    throw notSupported(`subtle.encrypt does not support ${algorithmName(algorithm)}`);
  }
  const cryptoKey = asKey(key);
  if (cryptoKey.kind !== 'aes-gcm') throw invalidAccess('AES-GCM');
  const { iv, aad } = gcmParams(algorithm);
  return toArrayBuffer(gcm(cryptoKey.bytes, iv, aad).encrypt(toBytes(data)));
}

async function decrypt(
  algorithm: AlgorithmIdentifier,
  key: GuestCryptoKey,
  data: BufferSource,
): Promise<ArrayBuffer> {
  if (algorithmName(algorithm) !== 'AES-GCM') {
    throw notSupported(`subtle.decrypt does not support ${algorithmName(algorithm)}`);
  }
  const cryptoKey = asKey(key);
  if (cryptoKey.kind !== 'aes-gcm') throw invalidAccess('AES-GCM');
  const { iv, aad } = gcmParams(algorithm);
  try {
    return toArrayBuffer(gcm(cryptoKey.bytes, iv, aad).decrypt(toBytes(data)));
  } catch {
    throw operationError('Decryption failed');
  }
}

export const subtle = {
  digest,
  importKey,
  exportKey,
  generateKey,
  deriveBits,
  sign,
  verify,
  encrypt,
  decrypt,
};

export const webcrypto = {
  getRandomValues,
  randomUUID,
  subtle,
};
