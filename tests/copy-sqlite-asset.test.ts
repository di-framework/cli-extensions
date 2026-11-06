import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copySqliteAsset } from '../scripts/copy-sqlite-asset.ts';

const SCRIPT_PATH = join(import.meta.dir, '../scripts/copy-sqlite-asset.ts');

describe('copySqliteAsset', () => {
  const tempDirs: string[] = [];

  function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('copies di-framework-sqlite.wasm and companion files when present at sourceDir', () => {
    const root = makeTempDir('sqlite-asset-copy-');
    const sourceDir = join(root, 'source');
    const destinationDir = join(root, 'dest');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'di-framework-sqlite.wasm'), 'wasm-bytes');
    writeFileSync(join(sourceDir, 'extra.txt'), 'companion');

    const logs: string[] = [];
    const errors: string[] = [];
    const result = copySqliteAsset({
      env: {},
      sourceDir,
      destinationDir,
      log: (msg) => logs.push(msg),
      error: (msg) => errors.push(msg),
    });

    expect(result).toEqual({
      copied: true,
      source: sourceDir,
      destination: destinationDir,
    });
    expect(readFileSync(join(destinationDir, 'di-framework-sqlite.wasm'), 'utf8')).toBe(
      'wasm-bytes',
    );
    expect(readFileSync(join(destinationDir, 'extra.txt'), 'utf8')).toBe('companion');
    expect(logs).toEqual([`copied sqlite provider from ${sourceDir}`]);
    expect(errors).toEqual([]);
  });

  test('copies di-framework-sqlite.wasm using DI_FRAMEWORK_SQLITE_DIST from env', () => {
    const root = makeTempDir('sqlite-asset-env-');
    const sourceDir = join(root, 'env-dist');
    const destinationDir = join(root, 'dest');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'di-framework-sqlite.wasm'), 'from-env');

    const logs: string[] = [];
    const result = copySqliteAsset({
      env: { DI_FRAMEWORK_SQLITE_DIST: sourceDir },
      destinationDir,
      log: (msg) => logs.push(msg),
    });

    expect(result.copied).toBe(true);
    expect(result.source).toBe(sourceDir);
    expect(readFileSync(join(destinationDir, 'di-framework-sqlite.wasm'), 'utf8')).toBe('from-env');
    expect(logs).toEqual([`copied sqlite provider from ${sourceDir}`]);
  });

  test('fails and names the expected path and DI_FRAMEWORK_SQLITE_DIST when provider is missing', () => {
    const root = makeTempDir('sqlite-asset-missing-');
    const missingSource = join(root, 'missing-dist');
    const destinationDir = join(root, 'dest');
    const expectedProvider = join(missingSource, 'di-framework-sqlite.wasm');

    const logs: string[] = [];
    const errors: string[] = [];
    expect(() =>
      copySqliteAsset({
        env: { DI_FRAMEWORK_SQLITE_DIST: missingSource },
        destinationDir,
        log: (msg) => logs.push(msg),
        error: (msg) => errors.push(msg),
      }),
    ).toThrow(expectedProvider);

    expect(logs).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(expectedProvider);
    expect(errors[0]).toContain('DI_FRAMEWORK_SQLITE_DIST');
    expect(errors[0]).toContain('DI_FRAMEWORK_SKIP_SQLITE_ASSET=1');
    expect(existsSync(destinationDir)).toBe(false);

    const cli = Bun.spawnSync([process.execPath, SCRIPT_PATH], {
      env: {
        ...process.env,
        DI_FRAMEWORK_SQLITE_DIST: missingSource,
        DI_FRAMEWORK_SKIP_SQLITE_ASSET: '',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(cli.exitCode).toBe(1);
    expect(cli.stderr.toString()).toContain(expectedProvider);
    expect(cli.stderr.toString()).toContain('DI_FRAMEWORK_SQLITE_DIST');
  });

  test('succeeds without copying when DI_FRAMEWORK_SKIP_SQLITE_ASSET=1 is set and provider is missing', () => {
    const root = makeTempDir('sqlite-asset-skip-');
    const missingSource = join(root, 'missing-dist');
    const destinationDir = join(root, 'dest');
    const expectedProvider = join(missingSource, 'di-framework-sqlite.wasm');

    const logs: string[] = [];
    const errors: string[] = [];
    const result = copySqliteAsset({
      env: {
        DI_FRAMEWORK_SQLITE_DIST: missingSource,
        DI_FRAMEWORK_SKIP_SQLITE_ASSET: '1',
      },
      destinationDir,
      log: (msg) => logs.push(msg),
      error: (msg) => errors.push(msg),
    });

    expect(result).toEqual({
      copied: false,
      source: missingSource,
      destination: destinationDir,
    });
    expect(logs).toEqual([
      `sqlite provider not found at ${expectedProvider}; skipping asset copy (DI_FRAMEWORK_SKIP_SQLITE_ASSET=1)`,
    ]);
    expect(errors).toEqual([]);
    expect(existsSync(destinationDir)).toBe(false);

    const cli = Bun.spawnSync([process.execPath, SCRIPT_PATH], {
      env: {
        ...process.env,
        DI_FRAMEWORK_SQLITE_DIST: missingSource,
        DI_FRAMEWORK_SKIP_SQLITE_ASSET: '1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(cli.exitCode).toBe(0);
    expect(cli.stdout.toString()).toContain(
      `sqlite provider not found at ${expectedProvider}; skipping asset copy (DI_FRAMEWORK_SKIP_SQLITE_ASSET=1)`,
    );
  });
});
