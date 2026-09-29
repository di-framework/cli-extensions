import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  calculatePackageMetrics,
  generateShieldBadgeJson,
  getPackageSlugFromPath,
  getWorkspacePackages,
  isSourceFile,
  parseLcov,
  writeShieldBadgeFiles,
} from '../scripts/coverage-mapping';

const repoRoot = resolve(import.meta.dir, '..');

function writePackage(root: string, relPath: string, name: string): void {
  const dir = join(root, relPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name }));
}

describe('coverage badge mapping', () => {
  it('discovers every @di-framework package under packages/', () => {
    const packages = getWorkspacePackages(repoRoot);
    expect(packages.map((pkg) => pkg.name)).toEqual([
      '@di-framework/cli-plugin-ai',
      '@di-framework/cli-plugin-platform',
    ]);
    expect(packages.map((pkg) => pkg.slug)).toEqual(['cli-plugin-ai', 'cli-plugin-platform']);
    expect(packages.find((pkg) => pkg.slug === 'cli-plugin-platform')?.relPath).toBe(
      'packages/cli-plugin-platform',
    );
  });

  it('maps source files onto package slugs and ignores tests', () => {
    getWorkspacePackages(repoRoot);
    expect(getPackageSlugFromPath('packages/cli-plugin-platform/src/index.ts')).toBe(
      'cli-plugin-platform',
    );
    expect(getPackageSlugFromPath('packages/cli-plugin-ai/src/index.ts')).toBe('cli-plugin-ai');
    expect(isSourceFile('packages/cli-plugin-platform/src/index.ts')).toBe(true);
    expect(isSourceFile('packages/cli-plugin-platform/tests/service.test.ts')).toBe(false);
    expect(isSourceFile('scripts/publish-workspace.ts')).toBe(false);
  });

  it('skips node_modules and nested repository checkouts', () => {
    const root = mkdtempSync(join(tmpdir(), 'cov-discover-'));
    writePackage(root, 'packages/cli-plugin-platform', '@di-framework/cli-plugin-platform');
    writePackage(root, 'node_modules/@di-framework/core', '@di-framework/core');
    writePackage(root, 'sqlite-src/platform/platform', '@di-framework/platform');
    writeFileSync(join(root, 'sqlite-src', '.git'), 'gitdir: /tmp/sqlite\n');

    const packages = getWorkspacePackages(root);
    expect(packages.map((pkg) => pkg.slug)).toEqual(['cli-plugin-platform']);
    expect(getPackageSlugFromPath(join(root, 'packages/cli-plugin-platform/src/index.ts'))).toBe(
      'cli-plugin-platform',
    );
    expect(getPackageSlugFromPath(join(root, 'sqlite-src/platform/platform/src/index.ts'))).toBe(
      null,
    );
  });

  it('writes Shields endpoint JSON for each discovered package', () => {
    const root = mkdtempSync(join(tmpdir(), 'cov-pkgs-'));
    writePackage(root, 'packages/cli-plugin-platform', '@di-framework/cli-plugin-platform');
    writePackage(root, 'packages/cli-plugin-ai', '@di-framework/cli-plugin-ai');
    const packages = getWorkspacePackages(root);
    const lcov = `
SF:${join(root, 'packages/cli-plugin-platform/src/index.ts')}
DA:1,4
DA:2,1
end_of_record
SF:${join(root, 'packages/cli-plugin-ai/src/index.ts')}
DA:1,1
end_of_record
`;
    const metrics = calculatePackageMetrics(packages, parseLcov(lcov));
    const platform = metrics.find((metric) => metric.slug === 'cli-plugin-platform');
    if (!platform) throw new Error('missing package metric');
    expect(platform.badgeMessage).toBe('100%');
    expect(generateShieldBadgeJson(platform)).toEqual({
      schemaVersion: 1,
      label: 'line coverage',
      message: '100%',
      color: 'brightgreen',
    });

    const outDir = join(root, 'coverage', 'badges');
    const written = writeShieldBadgeFiles(metrics, outDir);
    expect(written.map((file) => file.slice(outDir.length + 1)).sort()).toEqual([
      'cli-plugin-ai.json',
      'cli-plugin-platform.json',
    ]);
  });
});
