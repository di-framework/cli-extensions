import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asWitIdentifier, findUp, loadProject, resolveInside } from '../src/project';
import { expectFailure, makeProject } from './helpers';

describe('findUp', () => {
  it('finds a marker in an ancestor directory and reports misses', () => {
    const project = makeProject();
    expect(findUp(join(project, 'src'), 'di-framework.config.json')).toBe(
      join(project, 'di-framework.config.json'),
    );
    expect(findUp(project, 'definitely-not-a-real-marker.json')).toBeUndefined();
  });
});

describe('asWitIdentifier', () => {
  it('slugifies names into WIT identifiers', () => {
    expect(asWitIdentifier('Demo App')).toBe('demo-app');
    expect(asWitIdentifier('9lives')).toBe('app-9lives');
    expect(asWitIdentifier('!!!')).toBe('app-component');
    expect(asWitIdentifier('--edge--')).toBe('edge');
  });
});

describe('resolveInside', () => {
  it('resolves contained paths and rejects escapes', () => {
    const project = makeProject();
    const config = join(project, 'di-framework.config.json');
    expect(resolveInside(project, 'src/app.ts', 'entry', config)).toBe(
      join(project, 'src', 'app.ts'),
    );
    for (const value of ['..', '../outside.ts', '/etc/passwd', '.']) {
      expectFailure(
        () => resolveInside(project, value, 'entry', config),
        'WASMCLOUD_CONFIG_INVALID',
        2,
      );
    }
  });
});

describe('loadProject', () => {
  it('validates explicit DNS permission names', () => {
    const root = makeProject();
    const config = join(root, 'di-framework.config.json');
    const allowedIpNameLookups = ['echo.wasmcloud.svc.cluster.local', '*.example.com', '::1'];
    writeFileSync(
      config,
      JSON.stringify({ name: 'probe', entry: 'src/app.ts', allowedIpNameLookups }),
    );
    expect(loadProject(root).allowedIpNameLookups).toEqual(allowedIpNameLookups);
    for (const names of ['*', [1], ['https://example.com'], [''], ['a..b'], ['example.com:80']]) {
      writeFileSync(
        config,
        JSON.stringify({ name: 'probe', entry: 'src/app.ts', allowedIpNameLookups: names }),
      );
      expectFailure(() => loadProject(root), 'WASMCLOUD_CONFIG_INVALID', 2);
    }
  });
  it('loads a valid project with defaults and package version', () => {
    const root = makeProject({ name: 'Demo App', entry: 'src/app.ts' });
    const project = loadProject(join(root, 'src'));
    expect(project.applicationName).toBe('Demo App');
    expect(project.witName).toBe('demo-app');
    expect(project.entryPath).toBe(join(root, 'src', 'app.ts'));
    expect(project.outputPath).toBe(join(root, 'dist', 'demo-app.wasm'));
    expect(project.projectRoot).toBe(root);
    expect(project.version).toBe('1.2.3');
    expect(project.bindingsRelative).toBe('src/bindings.ts');
    expect(project.bindingsConfigured).toBe(false);
    expect(project.bindingsPath).toBe(join(root, 'src', 'bindings.ts'));
  });

  it('honors an explicit output path and falls back on invalid versions', () => {
    const explicit = loadProject(
      makeProject(
        { name: 'demo', entry: 'src/app.ts', output: 'out/component.wasm' },
        { name: 'demo', version: 'not-semver' },
      ),
    );
    expect(explicit.outputPath).toEndWith(join('out', 'component.wasm'));
    expect(explicit.version).toBe('0.1.0');

    const withoutManifest = loadProject(makeProject({ name: 'demo', entry: 'src/app.ts' }, null));
    expect(withoutManifest.version).toBe('0.1.0');
  });

  it('fails outside a project directory', () => {
    const empty = mkdtempSync(join(tmpdir(), 'wasmcloud-empty-'));
    expectFailure(() => loadProject(empty), 'WASMCLOUD_PROJECT_NOT_FOUND', 2);
  });

  it('rejects malformed configuration', () => {
    const broken = mkdtempSync(join(tmpdir(), 'wasmcloud-broken-'));
    writeFileSync(join(broken, 'di-framework.config.json'), '{');
    expectFailure(() => loadProject(broken), 'WASMCLOUD_CONFIG_INVALID', 2);

    for (const config of [
      { entry: 'src/app.ts' },
      { name: '  ', entry: 'src/app.ts' },
      { name: 'demo' },
      { name: 'demo', entry: '' },
      { name: 'demo', entry: 'src/app.ts', output: 7 },
      { name: 'demo', entry: 'src/app.ts', bindings: 7 },
    ]) {
      const root = mkdtempSync(join(tmpdir(), 'wasmcloud-invalid-'));
      writeFileSync(join(root, 'di-framework.config.json'), `${JSON.stringify(config)}\n`);
      expectFailure(() => loadProject(root), 'WASMCLOUD_CONFIG_INVALID', 2);
    }
  });

  it('rejects an unreadable entry module', () => {
    const root = mkdtempSync(join(tmpdir(), 'wasmcloud-noentry-'));
    writeFileSync(
      join(root, 'di-framework.config.json'),
      `${JSON.stringify({ name: 'demo', entry: 'src/missing.ts' })}\n`,
    );
    expectFailure(() => loadProject(root), 'WASMCLOUD_CONFIG_INVALID', 2);
  });
});
