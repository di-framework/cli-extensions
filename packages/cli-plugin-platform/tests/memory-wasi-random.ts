let next = 1;

export type MemoryRandomMode = 'bytes' | 'ok' | 'err' | 'short' | 'long';

export let memoryRandomMode: MemoryRandomMode = 'bytes';

export function setMemoryRandomMode(mode: MemoryRandomMode): void {
  memoryRandomMode = mode;
}

export function resetMemoryRandom(): void {
  next = 1;
  memoryRandomMode = 'bytes';
}

export function seedMemoryRandom(value: number): void {
  next = value;
}

/** Deterministic CSPRNG for tests. Not cryptographic. */
export function getRandomBytes(maxLen: bigint | number): unknown {
  const size = Number(maxLen);
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    out[i] = next & 0xff;
    next = (next * 1103515245 + 12345) >>> 0;
  }
  if (memoryRandomMode === 'ok') return { tag: 'ok', val: out };
  if (memoryRandomMode === 'err') return { tag: 'err', val: 'unavailable' };
  if (memoryRandomMode === 'short') return size === 0 ? out : out.subarray(0, size - 1);
  if (memoryRandomMode === 'long') {
    const longer = new Uint8Array(size + 1);
    longer.set(out);
    return longer;
  }
  return out;
}
