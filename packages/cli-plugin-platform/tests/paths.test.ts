import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';
import { isInside, resolveInsideRoot } from '../src/paths';

describe('paths', () => {
  it('treats the root itself as inside and rejects paths that escape it', () => {
    expect(isInside('/workspace', '/workspace')).toBe(true);
    expect(isInside('/workspace', '/workspace/deploy')).toBe(true);
    expect(isInside('/workspace', '/elsewhere')).toBe(false);
    expect(resolveInsideRoot('/workspace', 'deploy/platform')).toEqual({
      ok: true,
      path: resolve('/workspace', 'deploy/platform'),
    });
    expect(resolveInsideRoot('/workspace', '.')).toEqual({ ok: false });
    expect(resolveInsideRoot('/workspace', '..')).toEqual({ ok: false });
    expect(resolveInsideRoot('/workspace', '/elsewhere')).toEqual({ ok: false });
  });
});
