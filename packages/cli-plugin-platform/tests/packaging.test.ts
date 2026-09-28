import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PACKAGE_ROOT = join(import.meta.dir, '..');

describe('npm artifact', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('externalizes the virtual application module when bundling the adapter', () => {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      scripts: { build: string };
    };
    expect(pkg.scripts.build).toContain("--external 'virtual:di-framework-application'");
    expect(pkg.scripts.build).toContain("--external 'virtual:di-framework-wasmcloud-guests'");
  });

  it('ships every self-contained generated platform asset', () => {
    const destination = mkdtempSync(join(tmpdir(), 'wasmcloud-pack-'));
    temporaryDirectories.push(destination);
    execFileSync('npm', ['pack', '--pack-destination', destination], {
      cwd: PACKAGE_ROOT,
      stdio: 'pipe',
    });
    const tarball = readdirSync(destination).find((entry) => entry.endsWith('.tgz'));
    expect(tarball).toBeDefined();
    const entries = execFileSync('tar', ['-tzf', join(destination, tarball as string)], {
      encoding: 'utf8',
    });

    for (const asset of [
      'package/dist/assets/platform/.gitignore.tmpl',
      'package/dist/assets/platform/Pulumi.yaml.tmpl',
      'package/dist/assets/platform/README.md',
      'package/dist/assets/platform/index.ts.tmpl',
      'package/dist/assets/platform/package.json.tmpl',
      'package/dist/assets/platform/tsconfig.json',
    ]) {
      expect(entries).toContain(asset);
    }
  }, 60_000);
});
