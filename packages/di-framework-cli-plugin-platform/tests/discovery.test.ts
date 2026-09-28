import { describe, expect, it, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverProjects,
  findConfigFiles,
  matchGlob,
  readDirents,
  resolveApplication,
  statLinkTarget,
} from '../src/discovery';
import { parseDeployManifest } from '../src/manifest';
import { expectFailure, makeWorkspace, writeProject } from './helpers';

describe('filesystem helpers', () => {
  it('returns empty results when readdir or stat fail', () => {
    const missing = join(tmpdir(), `wasmcloud-missing-fs-${Date.now()}`);
    expect(readDirents(missing)).toEqual([]);
    expect(statLinkTarget(missing)).toBeUndefined();
  });
});

describe('matchGlob', () => {
  it('matches ** and path segments', () => {
    expect(matchGlob('services/greeter/di-framework.config.json', '**')).toBe(true);
    expect(matchGlob('services/greeter/di-framework.config.json', 'services/**')).toBe(true);
    expect(matchGlob('nested/deep/echo/di-framework.config.json', 'services/**')).toBe(false);
    expect(matchGlob('vendor/pkg/di-framework.config.json', 'vendor/**')).toBe(true);
    expect(
      matchGlob('services/greeter/di-framework.config.json', '**/di-framework.config.json'),
    ).toBe(true);
    expect(matchGlob('services/greeter/di-framework.config.json', 'services/*/*.json')).toBe(true);
    expect(matchGlob('services/greeter/di-framework.config.json', 'services/gree?er/*.json')).toBe(
      true,
    );
    expect(matchGlob('file(1).json', 'file(1).json')).toBe(true);
    expect(matchGlob('a+b.json', 'a+b.json')).toBe(true);
  });
});

describe('project discovery', () => {
  it('finds arbitrarily located projects and ignores default generated directories', () => {
    const { root, greeter, echo } = makeWorkspace();
    writeProject(join(root, 'node_modules', 'hidden'), 'hidden-dep');
    writeProject(join(root, '.git', 'hidden'), 'hidden-git');
    writeProject(join(root, '.di-framework', 'hidden'), 'hidden-gen');
    writeProject(join(root, 'dist', 'hidden'), 'hidden-dist');
    writeProject(join(root, 'coverage', 'hidden'), 'hidden-coverage');

    const manifest = parseDeployManifest(
      join(root, 'di-framework.deploy.toml'),
      readManifest(),
      {},
    );
    const found = discoverProjects(root, manifest.discovery);
    expect([...found.keys()].sort()).toEqual(['echo', 'greeter']);
    expect(found.get('greeter')?.projectRoot).toBe(greeter);
    expect(found.get('echo')?.projectRoot).toBe(echo);
  });

  it('honors include and extra exclude patterns', () => {
    const { root } = makeWorkspace();
    writeProject(join(root, 'vendor', 'other'), 'vendor-app');
    const manifest = parseDeployManifest(
      join(root, 'di-framework.deploy.toml'),
      `default-target = "local"
[discovery]
include = ["services/**"]
exclude = ["vendor/**"]
[targets.local]
platform = "deploy/platform"
`,
      {},
    );
    const found = discoverProjects(root, manifest.discovery);
    expect([...found.keys()]).toEqual(['greeter']);
  });

  it('rejects duplicate configured names and reports every path', () => {
    const { root } = makeWorkspace();
    writeProject(join(root, 'copy', 'also-greeter'), 'greeter');
    const manifest = parseDeployManifest(
      join(root, 'di-framework.deploy.toml'),
      readManifest(),
      {},
    );
    expectFailure(
      () => discoverProjects(root, manifest.discovery),
      'WASMCLOUD_DUPLICATE_PROJECT',
      2,
    );
    try {
      discoverProjects(root, manifest.discovery);
    } catch (error) {
      expect(String(error)).toContain(
        join(root, 'services', 'greeter', 'di-framework.config.json'),
      );
      expect(String(error)).toContain(
        join(root, 'copy', 'also-greeter', 'di-framework.config.json'),
      );
    }
  });

  it('resolves deploy greeter from the workspace root and missing names', () => {
    const { root, greeter } = makeWorkspace();
    const manifest = parseDeployManifest(
      join(root, 'di-framework.deploy.toml'),
      readManifest(),
      {},
    );
    const project = resolveApplication(root, 'greeter', root, manifest.discovery);
    expect(project.projectRoot).toBe(greeter);
    expect(project.applicationName).toBe('greeter');

    expectFailure(
      () => resolveApplication(root, 'missing', root, manifest.discovery),
      'WASMCLOUD_PROJECT_NOT_FOUND',
      2,
    );
  });

  it('uses the nearest project when no name is given', () => {
    const { root, echo } = makeWorkspace();
    const manifest = parseDeployManifest(
      join(root, 'di-framework.deploy.toml'),
      readManifest(),
      {},
    );
    const project = resolveApplication(join(echo, 'src'), undefined, root, manifest.discovery);
    expect(project.applicationName).toBe('echo');
  });

  it('does not follow symlink loops or links that escape the workspace', () => {
    const { root } = makeWorkspace();
    const loop = join(root, 'loop');
    mkdirSync(loop, { recursive: true });
    symlinkSync(root, join(loop, 'back'));
    const outside = join(root, '..', `outside-${Date.now()}`);
    mkdirSync(outside, { recursive: true });
    writeProject(outside, 'escaped');
    symlinkSync(outside, join(root, 'escape'));

    const files = findConfigFiles(root, { include: ['**'], exclude: ['dist/**', 'coverage/**'] });
    expect(files.some((file) => file.includes('escaped'))).toBe(false);
    expect(files.filter((file) => file.endsWith('di-framework.config.json')).length).toBe(2);
  });

  it('rejects a nearest project that sits outside the workspace', () => {
    const { root } = makeWorkspace();
    const outside = mkdtempSync(join(tmpdir(), 'wasmcloud-outside-project-'));
    writeProject(outside, 'solo');
    expectFailure(
      () => resolveApplication(outside, undefined, root, { include: ['**'], exclude: [] }),
      'WASMCLOUD_PROJECT_NOT_FOUND',
      2,
    );
  });

  it('reports no known projects when the workspace is empty', () => {
    const root = mkdtempSync(join(tmpdir(), 'wasmcloud-empty-ws-'));
    expectFailure(
      () => resolveApplication(root, 'greeter', root, { include: ['**'], exclude: [] }),
      'WASMCLOUD_PROJECT_NOT_FOUND',
      2,
    );
  });

  it('returns no configs when the workspace root cannot be resolved', () => {
    expect(
      findConfigFiles(join(tmpdir(), `wasmcloud-missing-${Date.now()}`), {
        include: ['**'],
        exclude: [],
      }),
    ).toEqual([]);
  });

  it('skips directories whose realpath fails during the walk', () => {
    const { root } = makeWorkspace();
    const vanishing = join(root, 'vanishing');
    writeProject(vanishing, 'vanishing');
    const originalRealpath = fs.realpathSync;
    const spy = spyOn(fs, 'realpathSync').mockImplementation(((path: fs.PathLike) => {
      if (String(path) === vanishing) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      return originalRealpath(path);
    }) as typeof fs.realpathSync);
    try {
      const files = findConfigFiles(root, { include: ['**'], exclude: [] });
      expect(files.some((file) => file.includes('vanishing'))).toBe(false);
      expect(files.filter((file) => file.endsWith('di-framework.config.json')).length).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('skips dangling directory links, dangling config links, and config links that escape', () => {
    const { root } = makeWorkspace();
    symlinkSync(join(root, 'missing-dir'), join(root, 'dangling-dir'));

    const brokenDir = join(root, 'broken-config');
    mkdirSync(brokenDir, { recursive: true });
    symlinkSync(join(root, 'no-such-config.json'), join(brokenDir, 'di-framework.config.json'));

    const outside = mkdtempSync(join(tmpdir(), 'wasmcloud-config-escape-'));
    writeProject(outside, 'escaped');
    const linked = join(root, 'linked-config');
    mkdirSync(linked, { recursive: true });
    symlinkSync(
      join(outside, 'di-framework.config.json'),
      join(linked, 'di-framework.config.json'),
    );

    const files = findConfigFiles(root, { include: ['**'], exclude: ['dist/**', 'coverage/**'] });
    expect(files.some((file) => file.includes('escaped'))).toBe(false);
    expect(files.some((file) => file.includes('broken-config'))).toBe(false);
    expect(files.filter((file) => file.endsWith('di-framework.config.json')).length).toBe(2);
  });

  it('skips unreadable directories instead of failing the walk', () => {
    const { root } = makeWorkspace();
    const secret = join(root, 'secret');
    writeProject(secret, 'secret');
    chmodSync(secret, 0o000);
    try {
      const files = findConfigFiles(root, { include: ['**'], exclude: [] });
      expect(files.some((file) => file.includes(`${join(root, 'secret')}`))).toBe(false);
      expect(files.filter((file) => file.endsWith('di-framework.config.json')).length).toBe(2);
    } finally {
      chmodSync(secret, 0o755);
    }
  });

  it('follows an in-workspace config symlink and skips one that lstat says escaped', () => {
    const { root } = makeWorkspace();
    writeProject(join(root, 'canonical'), 'canonical');
    const alias = join(root, 'alias');
    mkdirSync(alias, { recursive: true });
    symlinkSync(
      join(root, 'canonical', 'di-framework.config.json'),
      join(alias, 'di-framework.config.json'),
    );

    const withAlias = findConfigFiles(root, {
      include: ['**'],
      exclude: ['canonical/**', 'dist/**', 'coverage/**'],
    });
    expect(
      withAlias.some((file) => file.includes(`${join('alias', 'di-framework.config.json')}`)),
    ).toBe(true);

    const originalLstat = fs.lstatSync;
    const originalRealpath = fs.realpathSync;
    const lstatSpy = spyOn(fs, 'lstatSync').mockImplementation(((
      path: fs.PathLike,
      options?: fs.StatSyncOptions,
    ) => {
      if (String(path).includes(`${join('echo', 'di-framework.config.json')}`)) {
        return { isSymbolicLink: () => true } as fs.Stats;
      }
      return originalLstat(path, options as fs.StatSyncOptions);
    }) as typeof fs.lstatSync);
    const realpathSpy = spyOn(fs, 'realpathSync').mockImplementation(((path: fs.PathLike) => {
      if (String(path).includes(`${join('echo', 'di-framework.config.json')}`)) {
        return '/tmp/escaped-echo-config.json';
      }
      return originalRealpath(path);
    }) as typeof fs.realpathSync);
    try {
      const files = findConfigFiles(root, { include: ['**'], exclude: ['dist/**', 'coverage/**'] });
      expect(
        files.some((file) => file.includes(`${join('echo', 'di-framework.config.json')}`)),
      ).toBe(false);
    } finally {
      lstatSpy.mockRestore();
      realpathSpy.mockRestore();
    }
  });

  it('skips directory links whose target cannot be stated and configs whose lstat throws', () => {
    const { root } = makeWorkspace();
    const poison = join(root, 'poison-dir');
    mkdirSync(poison, { recursive: true });
    symlinkSync(poison, join(root, 'poison-link'));

    const originalStat = fs.statSync;
    const originalLstat = fs.lstatSync;
    const statSpy = spyOn(fs, 'statSync').mockImplementation(((
      path: fs.PathLike,
      options?: fs.StatSyncOptions,
    ) => {
      if (String(path) === poison) {
        throw Object.assign(new Error('EIO'), { code: 'EIO' });
      }
      return originalStat(path, options as fs.StatSyncOptions);
    }) as typeof fs.statSync);
    const lstatSpy = spyOn(fs, 'lstatSync').mockImplementation(((
      path: fs.PathLike,
      options?: fs.StatSyncOptions,
    ) => {
      if (String(path).includes(`${join('greeter', 'di-framework.config.json')}`)) {
        throw Object.assign(new Error('EIO'), { code: 'EIO' });
      }
      return originalLstat(path, options as fs.StatSyncOptions);
    }) as typeof fs.lstatSync);
    try {
      const files = findConfigFiles(root, { include: ['**'], exclude: [] });
      expect(files.some((file) => file.includes('poison-link'))).toBe(false);
      expect(
        files.some((file) => file.includes(`${join('greeter', 'di-framework.config.json')}`)),
      ).toBe(false);
      expect(
        files.some((file) => file.includes(`${join('echo', 'di-framework.config.json')}`)),
      ).toBe(true);
    } finally {
      statSpy.mockRestore();
      lstatSpy.mockRestore();
    }
  });
});

function readManifest(): string {
  return `default-target = "local"
[targets.local]
platform = "deploy/platform"
`;
}
