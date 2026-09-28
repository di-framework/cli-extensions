import { afterEach, describe, expect, it, mock } from 'bun:test';
import { createHash as nodeCreateHash, createHmac as nodeCreateHmac } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_DEPS } from '../src/deps';
import { hostInterfacesFromRequirements } from '../src/host-interface';
import {
  concatBytes,
  decodeUtf8,
  encodeUtf8,
  toArrayBuffer,
  toBytes,
} from '../src/node-compat/bytes';
import type { GuestCryptoKey } from '../src/node-compat/crypto-subtle';
import { runtimeRequirementsFromJavaScript } from '../src/wit';
import * as clock from './memory-wasi-clocks';
import {
  getRandomBytes,
  resetMemoryRandom,
  seedMemoryRandom,
  setMemoryRandomMode,
} from './memory-wasi-random';

mock.module('wasi:clocks/monotonic-clock@0.3.0', () => clock);
mock.module('wasi:random/random@0.3.0', () => ({ getRandomBytes }));

const {
  checkPrime,
  createHash,
  createHmac,
  createCipheriv,
  default: cryptoDefault,
  getRandomValues,
  prng,
  randomBytes,
  randomFill,
  randomFillSync,
  randomInt,
  randomUUID,
  rng,
  subtle,
  timingSafeEqual,
  webcrypto,
} = await import('../src/node-compat/crypto');
const { getRandomBytes: guestGetRandomBytes } = await import('../src/node-compat/wasi-random');

afterEach(() => {
  resetMemoryRandom();
});

describe('node:crypto overlay', () => {
  it('rejects the non-uniform randomInt tail and validates the 48-bit range', async () => {
    const range = 2 ** 47 + 1;
    seedMemoryRandom(255);
    const draw = () => {
      let value = 0;
      for (const byte of getRandomBytes(6) as Uint8Array) value = value * 256 + byte;
      return value;
    };
    expect(draw()).toBeGreaterThanOrEqual(range);
    let accepted = draw();
    while (accepted >= range) accepted = draw();
    seedMemoryRandom(255);
    expect(randomInt(-10, range - 10)).toBe(accepted - 10);
    seedMemoryRandom(255);
    const result = await new Promise<number>((resolve, reject) => {
      randomInt(range, (error, value) => (error ? reject(error) : resolve(value)));
    });
    expect(result).toBe(accepted);
    for (const [min, max] of [
      [0, 2 ** 48],
      [0.5, 2.5],
      [0, Infinity],
      [Number.MIN_SAFE_INTEGER - 1, 0],
    ]) {
      expect(() => randomInt(min ?? 0, max)).toThrow(RangeError);
    }
  });

  it('matches Node createHash for sha1 and sha256, including the WebSocket accept key', () => {
    expect(createHash('sha256').update('abc').digest('hex')).toBe(
      nodeCreateHash('sha256').update('abc').digest('hex'),
    );
    expect(createHash('sha1').update('abc').digest('base64')).toBe(
      nodeCreateHash('sha1').update('abc').digest('base64'),
    );
    const guid = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
    const key = 'dGhlIHNhbXBsZSBub25jZQ==';
    expect(
      createHash('sha1')
        .update(key + guid)
        .digest('base64'),
    ).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });

  it('matches Node HMAC-SHA256 and copies hash state', () => {
    const key = 'secret';
    expect(createHmac('sha256', key).update('msg').digest('hex')).toBe(
      nodeCreateHmac('sha256', key).update('msg').digest('hex'),
    );
    const hash = createHash('sha256').update('ab');
    const copy = hash.copy();
    hash.update('c');
    copy.update('c');
    expect(hash.digest('hex')).toBe(copy.digest('hex'));
  });

  it('issues v4 UUIDs, fills typed arrays, and compares in constant time', () => {
    const id = randomUUID();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const target = new Uint8Array(8);
    expect(getRandomValues(target)).toBe(target);
    expect(target.length).toBe(8);
    const bytes = randomBytes(16);
    if (bytes === undefined) throw new Error('expected randomBytes to return a buffer');
    expect(bytes.length).toBe(16);
    expect(timingSafeEqual(bytes, bytes)).toBe(true);
    expect(() => timingSafeEqual(bytes, bytes.subarray(0, 8))).toThrow(/same byte length/);
  });

  it('throws for unsupported Node OpenSSL APIs and unknown digests', () => {
    expect(() => createHash('not-a-hash')).toThrow(/Digest method not supported/);
    expect(() => createCipheriv()).toThrow(/not implemented/);
    expect(() => checkPrime()).toThrow(/not implemented/);
  });

  it('covers hash encodings, finalized errors, and Buffer-less hex', () => {
    expect(createHash('md5').update('abc').digest('hex')).toBe(
      nodeCreateHash('md5').update('abc').digest('hex'),
    );
    expect(createHash('sha384').update('abc').digest('base64url')).toBe(
      nodeCreateHash('sha384').update('abc').digest('base64url'),
    );
    expect(createHash('sha512').update('abc').digest('latin1')).toBe(
      nodeCreateHash('sha512').update('abc').digest('latin1'),
    );
    expect(createHash('sha256').update('616263', 'hex').digest('hex')).toBe(
      nodeCreateHash('sha256').update('abc').digest('hex'),
    );
    expect(createHash('sha256').update('YWJj', 'base64').digest('hex')).toBe(
      nodeCreateHash('sha256').update('abc').digest('hex'),
    );
    const hash = createHash('sha256').update('x');
    hash.digest();
    expect(() => hash.update('y')).toThrow(/Digest already called/);
    expect(() => hash.digest()).toThrow(/Digest already called/);
    const live = createHash('sha256').update('x');
    live.digest();
    expect(() => live.copy()).toThrow(/Digest already called/);
    const expected = nodeCreateHash('sha256').update('abc').digest('hex');
    const BufferRef = globalThis.Buffer;
    Reflect.deleteProperty(globalThis, 'Buffer');
    try {
      expect(createHash('sha256').update('abc').digest('hex')).toBe(expected);
    } finally {
      globalThis.Buffer = BufferRef;
    }
  });

  it('fills, samples, and unwraps wasi:random results', async () => {
    expect(guestGetRandomBytes(0).length).toBe(0);
    expect(() => guestGetRandomBytes(-1)).toThrow(/non-negative/);
    setMemoryRandomMode('ok');
    expect(randomBytes(4)?.length).toBe(4);
    setMemoryRandomMode('long');
    expect(guestGetRandomBytes(4).length).toBe(4);
    setMemoryRandomMode('short');
    expect(() => guestGetRandomBytes(4)).toThrow(/returned 3 bytes/);
    setMemoryRandomMode('err');
    expect(() => guestGetRandomBytes(4)).toThrow(/wasi:random failed/);
    setMemoryRandomMode('bytes');
    const syncBuf = new Uint8Array(8);
    expect(randomFillSync(syncBuf, 2, 3)).toBe(syncBuf);
    await new Promise<void>((resolve) => {
      randomBytes(2, (_error, buffer) => {
        expect(buffer?.length).toBe(2);
        resolve();
      });
    });
    await new Promise<void>((resolve) => {
      randomFill(syncBuf, () => resolve());
    });
    await new Promise<void>((resolve) => {
      randomFill(syncBuf, 1, () => resolve());
    });
    await new Promise<void>((resolve) => {
      randomFill(syncBuf, 1, 2, () => resolve());
    });
    expect(randomFill(syncBuf, 0, 2)).toBe(syncBuf);
    expect(randomInt(10)).toBeGreaterThanOrEqual(0);
    expect(randomInt(2, 5)).toBeGreaterThanOrEqual(2);
    await new Promise<void>((resolve) => {
      randomInt(4, () => resolve());
    });
    await new Promise<void>((resolve) => {
      randomInt(1, 4, () => resolve());
    });
    expect(() => randomInt(1, 1)).toThrow(/out of range/);
    expect(rng).toBe(randomBytes);
    expect(prng).toBe(randomBytes);
    expect(cryptoDefault.createHash).toBe(createHash);
  });
});

describe('Web Crypto subset', () => {
  it('matches host Web Crypto for digest, HMAC, HKDF, and AES-GCM with AAD', async () => {
    const payload = new TextEncoder().encode('wasmcloud-crypto');
    const digest = new Uint8Array(await subtle.digest('SHA-256', payload));
    const hostDigest = new Uint8Array(await crypto.subtle.digest('SHA-256', payload));
    expect(digest).toEqual(hostDigest);

    const hmacKeyBytes = new Uint8Array(32).fill(9);
    const hmacKey = await subtle.importKey(
      'raw',
      hmacKeyBytes,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const hostHmacKey = await crypto.subtle.importKey(
      'raw',
      hmacKeyBytes,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    expect(new Uint8Array(await subtle.sign('HMAC', hmacKey, payload))).toEqual(
      new Uint8Array(await crypto.subtle.sign('HMAC', hostHmacKey, payload)),
    );

    const ikm = new Uint8Array(32).fill(3);
    const salt = new Uint8Array(16).fill(4);
    const info = new TextEncoder().encode('di-framework/socket:v1:encryption');
    const hkdfKey = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    const hostHkdfKey = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    const hkdfBits = new Uint8Array(
      await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, hkdfKey, 256),
    );
    const hostHkdf = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt, info },
        hostHkdfKey,
        256,
      ),
    );
    expect(hkdfBits).toEqual(hostHkdf);

    const aesKeyBytes = new Uint8Array(32).fill(7);
    const iv = new Uint8Array(12).fill(1);
    const aad = new TextEncoder().encode('session|1|text');
    const aesKey = await subtle.importKey('raw', aesKeyBytes, { name: 'AES-GCM' }, false, [
      'encrypt',
      'decrypt',
    ]);
    const hostAes = await crypto.subtle.importKey('raw', aesKeyBytes, { name: 'AES-GCM' }, false, [
      'encrypt',
      'decrypt',
    ]);
    const ciphertext = new Uint8Array(
      await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, aesKey, payload),
    );
    const hostCiphertext = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, hostAes, payload),
    );
    expect(ciphertext).toEqual(hostCiphertext);
    expect(
      new TextDecoder().decode(
        new Uint8Array(
          await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, aesKey, ciphertext),
        ),
      ),
    ).toBe('wasmcloud-crypto');
  });

  it('round-trips ECDH P-256 deriveBits', async () => {
    const left = (await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, [
      'deriveBits',
    ])) as { publicKey: GuestCryptoKey; privateKey: GuestCryptoKey };
    const right = (await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, [
      'deriveBits',
    ])) as { publicKey: GuestCryptoKey; privateKey: GuestCryptoKey };
    const exported = new Uint8Array((await subtle.exportKey('raw', left.publicKey)) as ArrayBuffer);
    expect(exported.length).toBe(65);
    expect(exported[0]).toBe(0x04);
    const ab = await subtle.deriveBits(
      { name: 'ECDH', public: right.publicKey },
      left.privateKey,
      256,
    );
    const ba = await subtle.deriveBits(
      { name: 'ECDH', public: left.publicKey },
      right.privateKey,
      256,
    );
    expect(new Uint8Array(ab)).toEqual(new Uint8Array(ba));
    expect(ab.byteLength).toBe(32);
  });

  it('exposes the same object as the injected webcrypto global', () => {
    expect(webcrypto.subtle).toBe(subtle);
    expect(webcrypto.randomUUID).toBe(randomUUID);
  });

  it('covers Web Crypto error paths and remaining algorithms', async () => {
    const payload = new TextEncoder().encode('cover');
    await expect(subtle.digest('SHA-1', payload)).resolves.toBeInstanceOf(ArrayBuffer);
    await expect(subtle.digest({ name: 'SHA-384' }, payload)).resolves.toBeInstanceOf(ArrayBuffer);
    await expect(subtle.digest({ name: 'SHA-512' }, payload)).resolves.toBeInstanceOf(ArrayBuffer);
    await expect(subtle.digest('SHA-3', payload)).rejects.toThrow(/does not support/);
    await expect(subtle.digest({} as never, payload)).rejects.toThrow(/Unrecognized algorithm/);
    await expect(subtle.importKey('jwk', {}, 'HMAC', false, ['sign'])).rejects.toThrow(/format/);
    await expect(subtle.importKey('raw', payload, 'HMAC', false, ['sign'])).rejects.toThrow(
      /HMAC requires a hash/,
    );
    await expect(
      subtle.importKey('raw', payload, { name: 'HMAC', hash: 1 }, false, ['sign']),
    ).rejects.toThrow(/Unrecognized hash algorithm/);
    await expect(
      subtle.importKey('raw', new Uint8Array(8), { name: 'AES-GCM' }, false, ['encrypt']),
    ).rejects.toThrow(/16, 24, or 32/);
    await expect(
      subtle.importKey('raw', new Uint8Array(65), { name: 'ECDH', namedCurve: 'P-384' }, true, []),
    ).rejects.toThrow(/not supported/);
    await expect(
      subtle.importKey('raw', new Uint8Array(65), { name: 'ECDH', namedCurve: 'P-256' }, true, []),
    ).rejects.toThrow(/uncompressed/);
    await expect(subtle.importKey('raw', payload, 'RSA-OAEP', false, [])).rejects.toThrow(
      /not supported/,
    );
    await expect(subtle.exportKey('jwk', {} as never)).rejects.toThrow(/format/);
    await expect(subtle.exportKey('raw', {} as never)).rejects.toThrow(/Invalid CryptoKey/);
    const hmacKey = await subtle.importKey(
      'raw',
      new Uint8Array(32).fill(1),
      { name: 'HMAC', hash: { name: 'SHA-256' } },
      false,
      ['sign'],
    );
    await expect(subtle.exportKey('raw', hmacKey)).rejects.toThrow(/not extractable/);
    const extractable = await subtle.importKey(
      'raw',
      new Uint8Array(32).fill(2),
      { name: 'HMAC', hash: 'SHA-384' },
      true,
      ['sign', 'verify'],
    );
    expect((await subtle.exportKey('raw', extractable)).byteLength).toBe(32);
    const signature = await subtle.sign('HMAC', extractable, payload);
    expect(await subtle.verify('HMAC', extractable, signature, payload)).toBe(true);
    expect(await subtle.verify('HMAC', extractable, new Uint8Array(3), payload)).toBe(false);
    expect(
      await subtle.verify('HMAC', extractable, new Uint8Array(signature.byteLength), payload),
    ).toBe(false);
    await expect(subtle.sign('ECDSA', extractable, payload)).rejects.toThrow(/does not support/);
    await expect(subtle.sign('HMAC', hmacKey, payload)).resolves.toBeInstanceOf(ArrayBuffer);
    await expect(subtle.generateKey({ name: 'AES-GCM' }, false, [])).rejects.toThrow(
      /not supported/,
    );
    await expect(
      subtle.generateKey({ name: 'ECDH', namedCurve: 'P-384' }, false, ['deriveBits']),
    ).rejects.toThrow(/not supported/);
    const pair = (await subtle.generateKey({ name: 'ECDH' }, true, ['deriveBits'])) as {
      publicKey: GuestCryptoKey;
      privateKey: GuestCryptoKey;
    };
    const publicRaw = await subtle.exportKey('raw', pair.publicKey);
    const importedPublic = await subtle.importKey(
      'raw',
      publicRaw,
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      [],
    );
    await expect(
      subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256' }, hmacKey, 256),
    ).rejects.toThrow(/not valid/);
    const hkdfKey = await subtle.importKey('raw', new Uint8Array(32).fill(3), 'HKDF', false, [
      'deriveBits',
    ]);
    await expect(
      subtle.deriveBits(
        { name: 'HKDF', hash: 'MD5', salt: new Uint8Array(8), info: payload },
        hkdfKey,
        256,
      ),
    ).rejects.toThrow(/not supported/);
    await expect(
      subtle.deriveBits({ name: 'ECDH', public: pair.publicKey }, hkdfKey, 256),
    ).rejects.toThrow(/not valid/);
    await expect(
      subtle.deriveBits({ name: 'ECDH', public: pair.privateKey }, pair.privateKey, 256),
    ).rejects.toThrow(/public key required/);
    await expect(
      subtle.deriveBits({ name: 'ECDH', public: importedPublic }, pair.privateKey, 33 * 8),
    ).rejects.toThrow(/too large/);
    await expect(subtle.deriveBits({ name: 'PBKDF2' }, hkdfKey, 256)).rejects.toThrow(
      /not supported/,
    );
    const aes16 = await subtle.importKey(
      'raw',
      new Uint8Array(16).fill(9),
      { name: 'AES-GCM' },
      true,
      ['encrypt', 'decrypt'],
    );
    await expect(
      subtle.encrypt({ name: 'AES-CBC', iv: new Uint8Array(16) }, aes16, payload),
    ).rejects.toThrow(/does not support/);
    await expect(
      subtle.encrypt({ name: 'AES-GCM', iv: new Uint8Array(16) }, aes16, payload),
    ).rejects.toThrow(/12 bytes/);
    await expect(
      subtle.encrypt({ name: 'AES-GCM', iv: new Uint8Array(12) }, hmacKey, payload),
    ).rejects.toThrow(/not valid/);
    await expect(subtle.sign('HMAC', aes16, payload)).rejects.toThrow(/not valid/);
    const iv = new Uint8Array(12).fill(2);
    const ciphertext = new Uint8Array(
      await subtle.encrypt({ name: 'AES-GCM', iv }, aes16, payload),
    );
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 0xff;
    await expect(subtle.decrypt({ name: 'AES-GCM', iv }, aes16, ciphertext)).rejects.toThrow(
      /Decryption failed/,
    );
    await expect(subtle.decrypt({ name: 'AES-CBC', iv }, aes16, payload)).rejects.toThrow(
      /does not support/,
    );
    await expect(subtle.decrypt({ name: 'AES-GCM', iv }, hmacKey, payload)).rejects.toThrow(
      /not valid/,
    );
  });
});

describe('byte helpers', () => {
  it('accepts typed arrays, ArrayBuffers, and number arrays', () => {
    expect(toBytes(new Uint16Array([1]))).toBeInstanceOf(Uint8Array);
    expect(toBytes(new Uint8Array([1, 2]).buffer)).toEqual(new Uint8Array([1, 2]));
    expect(toBytes([3, 4])).toEqual(new Uint8Array([3, 4]));
    expect(concatBytes(new Uint8Array([1]), new Uint8Array([2]))).toEqual(new Uint8Array([1, 2]));
    expect(decodeUtf8(encodeUtf8('hi'))).toBe('hi');
    expect(toArrayBuffer(new Uint8Array([9])).byteLength).toBe(1);
  });
});

describe('wasi:random requirements', () => {
  it('adds wasi:random to the guest world and keeps it off hostInterfaces', () => {
    expect(runtimeRequirementsFromJavaScript('export const bundled = true;\n')).toEqual([]);
    const requirements = runtimeRequirementsFromJavaScript(
      'import { getRandomBytes } from "wasi:random/random@0.3.0";\n',
    );
    expect(requirements).toEqual([
      expect.objectContaining({
        package: 'wasi:random',
        version: '0.3.0',
        interfaces: ['random'],
        direction: 'import',
        source: 'node-compat',
      }),
    ]);
    expect(hostInterfacesFromRequirements(requirements)).toEqual([]);
  });
});

describe('bundled node:crypto overlay', () => {
  it('keeps wasi:random imports external and hashes in the guest bundle', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wasmcloud-crypto-bundle-'));
    const adapterPath = join(root, 'adapter.ts');
    const entryPath = join(root, 'entry.ts');
    const outFile = join(root, 'dist', 'component.js');
    writeFileSync(
      adapterPath,
      "import application from 'virtual:di-framework-application';\nexport const handler = application;\n",
    );
    writeFileSync(
      entryPath,
      `
import { createHash, randomUUID } from 'node:crypto';
export default {
  hex: createHash('sha256').update('abc').digest('hex'),
  uuid: randomUUID(),
};
`,
    );
    await DEFAULT_DEPS.bundler({ adapterPath, entryPath, outFile });
    const source = await Bun.file(outFile).text();
    expect(source).toContain('wasi:random/random@0.3.0');
    expect(source).not.toContain('wasi:sockets/types@0.3.0');
    const bundled = await import(pathToFileURL(outFile).href);
    expect(bundled.handler.hex).toBe(nodeCreateHash('sha256').update('abc').digest('hex'));
    expect(bundled.handler.uuid).toMatch(/^[0-9a-f-]{36}$/);
  });
});
