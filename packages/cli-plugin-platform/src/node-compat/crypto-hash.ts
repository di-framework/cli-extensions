import { hmac as nobleHmac } from '@noble/hashes/hmac.js';
import { md5, sha1 } from '@noble/hashes/legacy.js';
import { sha256, sha384, sha512 } from '@noble/hashes/sha2.js';
import { toBytes, toNodeBuffer } from './bytes';

type HashFn = {
  create(): HashState;
  outputLen: number;
};

type HashState = {
  update(data: Uint8Array): HashState;
  digest(): Uint8Array;
  clone(): HashState;
};

const HASHES: Record<string, HashFn> = {
  md5: md5 as HashFn,
  sha1: sha1 as HashFn,
  sha256: sha256 as HashFn,
  sha384: sha384 as HashFn,
  sha512: sha512 as HashFn,
};

export function normalizeHashName(algorithm: string): string {
  return algorithm.toLowerCase().replace(/-/g, '');
}

export function hashFunction(algorithm: string): HashFn {
  const name = normalizeHashName(algorithm);
  const hash = HASHES[name];
  if (hash === undefined) {
    const error = new Error(`Digest method not supported: ${algorithm}`) as Error & {
      code: string;
    };
    error.code = 'ERR_CRYPTO_INVALID_DIGEST';
    throw error;
  }
  return hash;
}

function digestWithEncoding(bytes: Uint8Array, encoding?: string): string | Uint8Array {
  const buffer = toNodeBuffer(bytes);
  if (encoding === undefined || encoding === 'buffer') return buffer;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(buffer)) {
    return buffer.toString(encoding as BufferEncoding);
  }
  if (encoding === 'hex') return hexEncode(bytes);
  if (encoding === 'base64' || encoding === 'base64url' || encoding === 'latin1') {
    return Buffer.from(bytes).toString(encoding);
  }
  return buffer;
}

function hexEncode(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

function encodeInput(data: unknown, encoding?: string): Uint8Array {
  if (typeof data === 'string') {
    if (encoding === 'hex' && typeof Buffer !== 'undefined') return Buffer.from(data, 'hex');
    if ((encoding === 'base64' || encoding === 'base64url') && typeof Buffer !== 'undefined') {
      return Buffer.from(data, encoding);
    }
    return new TextEncoder().encode(data);
  }
  return toBytes(data);
}

export class Hash {
  algorithm: string;
  state: HashState;
  finalized = false;

  constructor(algorithm: string, state?: HashState) {
    this.algorithm = algorithm;
    this.state = state ?? hashFunction(algorithm).create();
  }

  update(data: unknown, encoding?: string): this {
    if (this.finalized) {
      const error = new Error('Digest already called') as Error & { code: string };
      error.code = 'ERR_CRYPTO_HASH_FINALIZED';
      throw error;
    }
    this.state.update(encodeInput(data, encoding));
    return this;
  }

  digest(encoding?: string): string | Uint8Array {
    if (this.finalized) {
      const error = new Error('Digest already called') as Error & { code: string };
      error.code = 'ERR_CRYPTO_HASH_FINALIZED';
      throw error;
    }
    this.finalized = true;
    return digestWithEncoding(this.state.digest(), encoding);
  }

  copy(): Hash {
    if (this.finalized) {
      const error = new Error('Digest already called') as Error & { code: string };
      error.code = 'ERR_CRYPTO_HASH_FINALIZED';
      throw error;
    }
    return new Hash(this.algorithm, this.state.clone());
  }
}

export class Hmac extends Hash {
  constructor(algorithm: string, key: unknown) {
    const hash = hashFunction(algorithm);
    super(algorithm, nobleHmac.create(hash as never, encodeInput(key)) as unknown as HashState);
  }
}

export function createHash(algorithm: string): Hash {
  return new Hash(algorithm);
}

export function createHmac(algorithm: string, key: unknown): Hmac {
  return new Hmac(algorithm, key);
}

export function digestSync(algorithm: string, data: Uint8Array): Uint8Array {
  const hash = hashFunction(algorithm);
  const state = hash.create();
  state.update(data);
  return state.digest();
}
