import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildComponent } from '../src/build';
import type { WasmcloudDeps } from '../src/deps';
import {
  CACHE_DIR_ENV,
  cacheEntry,
  cacheRoot,
  EXCLUSIVE_INSTANCE_KEY,
  isWithin,
  PGLITE_WASM_ENV,
  PGLITE_WASM_FILE,
  parseDigestReference,
  parsePgliteConfig,
  pullPgliteComponent,
  resolvePgliteComponent,
  verifyLayer,
  verifyManifest,
} from '../src/pglite';
import { loadProject } from '../src/project';
import type { ClusterConnection } from '../src/target';
import { runtimeRequirementsFromJavaScript } from '../src/wit';
import { renderWorkloadManifest } from '../src/workload';
import {
  captureIo,
  expectFailure,
  fakeDeps,
  makeAssets,
  makeProject,
  type RunnerInvocation,
} from './helpers';

const REPOSITORY = 'ghcr.io/di-framework/pglite-component';
const PROVIDER = Buffer.from('\0asm\x01\0\0\0pglite-provider');

function digestOf(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function manifestFor(layer: Uint8Array, mediaType = 'application/wasm'): Buffer {
  return Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      config: {
        mediaType: 'application/vnd.wasm.config.v0+json',
        digest: digestOf(Buffer.from('{}')),
        size: 2,
      },
      layers: [{ mediaType, digest: digestOf(layer), size: layer.length }],
    }),
  );
}

const MANIFEST = manifestFor(PROVIDER);
const IMAGE = `${REPOSITORY}@${digestOf(MANIFEST)}`;
const CONFIG_PATH = '/project/di-framework.config.json';
const toProject = (path: string) => `/project/${path}`;

/** Deps whose `oras` serves `manifest` and `layer` from an in-memory registry. */
function registryDeps(
  options: {
    manifest?: Buffer;
    layer?: Buffer;
    cache?: string;
    invocations?: RunnerInvocation[];
    oras?: string | undefined;
    exitCodes?: Record<string, number>;
    env?: Record<string, string | undefined>;
    cwd?: string;
  } = {},
): WasmcloudDeps {
  const cache = options.cache ?? mkdtempSync(join(tmpdir(), 'pglite-cache-'));
  const invocations = options.invocations ?? [];
  const base = fakeDeps({
    cwd: options.cwd ?? tmpdir(),
    env: { [CACHE_DIR_ENV]: cache, ...options.env },
    captures: { oras: 'oras' in options ? options.oras : 'Version: 1.3.4' },
  });
  return {
    ...base,
    runCaptured: async (command, args, runOptions) => {
      invocations.push({ command, args: [...args], cwd: runOptions.cwd, captured: true });
      const key = `${args[0]} ${args[1]}`;
      const exitCode = options.exitCodes?.[key] ?? 0;
      if (exitCode !== 0) return { exitCode, stdout: '', stderr: 'denied: unauthorized\n' };
      const output = args[args.indexOf('--output') + 1] as string;
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(
        output,
        key === 'manifest fetch' ? (options.manifest ?? MANIFEST) : (options.layer ?? PROVIDER),
      );
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };
}

describe('pglite config', () => {
  const parse = (value: unknown) => parsePgliteConfig(value, CONFIG_PATH, toProject);

  it('defaults storage to /data and the database root to /data/pglite', () => {
    expect(parse(undefined)).toBeUndefined();
    expect(parse({ image: IMAGE })).toEqual({
      image: IMAGE,
      storageMount: '/data',
      dataDir: '/data/pglite',
    });
    expect(
      parse({ wasm: 'vendor/pglite.wasm', storageMount: '/data/actors/', dataDir: '/data/actors' }),
    ).toEqual({
      wasm: '/project/vendor/pglite.wasm',
      storageMount: '/data/actors',
      dataDir: '/data/actors',
    });
    expect(parse({ image: IMAGE, storageMount: '/', dataDir: '/db' })?.dataDir).toBe('/db');
  });

  it('checks guest paths against the mount', () => {
    expect(isWithin('/data', '/data')).toBe(true);
    expect(isWithin('/data/pglite', '/data')).toBe(true);
    expect(isWithin('/database', '/data')).toBe(false);
    expect(isWithin('/db', '/')).toBe(true);
  });

  it('accepts only digest pins, never a floating tag', () => {
    for (const image of [
      `${REPOSITORY}:0.2.0`,
      `${REPOSITORY}@sha256:abc`,
      `${REPOSITORY}:0.2.0@${digestOf(MANIFEST)}`,
      'pglite@sha256:0',
    ]) {
      expectFailure(() => parse({ image }), 'WASMCLOUD_CONFIG_INVALID', 2);
    }
    expect(() => parse({ image: `${REPOSITORY}:0.2.0` })).toThrow(
      /not pinned by digest.*tags such as :0\.2\.0 move/,
    );
    expect(parseDigestReference(`localhost:5000/mirror/pglite@${digestOf(MANIFEST)}`)).toEqual({
      repository: 'localhost:5000/mirror/pglite',
      digest: digestOf(MANIFEST),
    });
  });

  it('rejects malformed entries', () => {
    for (const value of [
      null,
      [],
      'ghcr.io/x',
      {},
      { image: 1 },
      { wasm: '' },
      { wasm: 3 },
      { image: IMAGE, extra: true },
      { image: IMAGE, storageMount: 'data' },
      { image: IMAGE, dataDir: 5 },
      { image: IMAGE, dataDir: '/srv/pg' },
      { image: IMAGE, storageMount: '/data/actors', dataDir: '/data/pglite' },
    ]) {
      expectFailure(() => parse(value), 'WASMCLOUD_CONFIG_INVALID', 2);
    }
    expect(() => parse({ image: IMAGE, tag: 'x' })).toThrow(/unsupported fields: tag/);
    expect(() => parse({})).toThrow(/needs "image"/);
    expect(() => parse({ image: IMAGE, dataDir: '/srv/pg' })).toThrow(
      /must be inside storageMount \/data/,
    );
  });

  it('loads from di-framework.config.json and keeps wasm inside the project', () => {
    const root = makeProject({ name: 'Orders', entry: 'src/app.ts', pglite: { image: IMAGE } });
    expect(loadProject(root).pglite).toEqual({
      image: IMAGE,
      storageMount: '/data',
      dataDir: '/data/pglite',
    });
    expect(loadProject(makeProject()).pglite).toBeUndefined();
    const outside = makeProject({
      name: 'Orders',
      entry: 'src/app.ts',
      pglite: { wasm: '../pglite.wasm' },
    });
    expectFailure(() => loadProject(outside), 'WASMCLOUD_CONFIG_INVALID', 2);
  });

  it('detects the database import in bundled JavaScript', () => {
    expect(
      runtimeRequirementsFromJavaScript(
        'import { open } from "di-framework:pglite/database@0.2.0";',
      ),
    ).toEqual([
      {
        package: 'di-framework:pglite',
        version: '0.2.0',
        interfaces: ['types', 'database'],
        direction: 'import',
        source: 'pglite-backend',
      },
    ]);
    expect(runtimeRequirementsFromJavaScript('di-framework:pglite/database@0.1.0')).toEqual([]);
  });
});

describe('pglite digest verification', () => {
  it('returns the wasm layer digest when the manifest matches the pin', () => {
    expect(verifyManifest(MANIFEST, IMAGE)).toBe(digestOf(PROVIDER));
    expect(() => verifyLayer(PROVIDER, IMAGE, digestOf(PROVIDER))).not.toThrow();
  });

  it('rejects a manifest whose bytes do not hash to the pin', () => {
    const other = manifestFor(Buffer.from('\0asmother'));
    expect(() => verifyManifest(other, IMAGE)).toThrow(
      expect.objectContaining({
        code: 'WASMCLOUD_PGLITE_DIGEST_MISMATCH',
        message: expect.stringContaining(`not the pinned ${digestOf(MANIFEST)}`),
      }),
    );
  });

  it('rejects manifests without exactly one wasm layer', () => {
    const cases = [
      Buffer.from('not json'),
      Buffer.from(JSON.stringify({ manifests: [] })),
      Buffer.from(JSON.stringify({ schemaVersion: 2 })),
      manifestFor(PROVIDER, 'application/octet-stream'),
      Buffer.from(
        JSON.stringify({ layers: [{ mediaType: 'application/wasm', digest: 'md5:abc' }] }),
      ),
    ];
    for (const bytes of cases) {
      const image = `${REPOSITORY}@${digestOf(bytes)}`;
      expect(() => verifyManifest(bytes, image)).toThrow(
        expect.objectContaining({ code: 'WASMCLOUD_PGLITE_MANIFEST_INVALID' }),
      );
    }
    const index = Buffer.from(JSON.stringify({ manifests: [] }));
    expect(() => verifyManifest(index, `${REPOSITORY}@${digestOf(index)}`)).toThrow(/image index/);
  });

  it('rejects provider bytes that differ from the layer digest or are not wasm', () => {
    expect(() => verifyLayer(Buffer.from('\0asmtampered'), IMAGE, digestOf(PROVIDER))).toThrow(
      expect.objectContaining({ code: 'WASMCLOUD_PGLITE_DIGEST_MISMATCH' }),
    );
    const text = Buffer.from('no');
    expect(() => verifyLayer(text, IMAGE, digestOf(text))).toThrow(
      expect.objectContaining({ code: 'WASMCLOUD_PGLITE_MANIFEST_INVALID' }),
    );
  });
});

describe('pglite cache and pull', () => {
  it('resolves the cache root from the environment', () => {
    expect(cacheRoot({ [CACHE_DIR_ENV]: '/c' })).toBe('/c');
    expect(cacheRoot({ XDG_CACHE_HOME: '/x' })).toBe('/x/di-framework');
    expect(cacheRoot({ HOME: '/h' })).toBe('/h/.cache/di-framework');
    expect(cacheEntry({ [CACHE_DIR_ENV]: '/c' }, digestOf(MANIFEST))).toBe(
      `/c/oci/sha256/${digestOf(MANIFEST).slice(7)}`,
    );
  });

  it('pulls by digest with oras, verifies, caches, and reuses the cache', async () => {
    const cache = mkdtempSync(join(tmpdir(), 'pglite-cache-'));
    const invocations: RunnerInvocation[] = [];
    const deps = registryDeps({ cache, invocations });
    const { io, stdout } = captureIo();
    const pulled = await pullPgliteComponent(IMAGE, io, deps, '/project');
    const entry = cacheEntry(deps.env, digestOf(MANIFEST));
    expect(pulled).toEqual({
      wasm: join(entry, PGLITE_WASM_FILE),
      source: 'registry',
      image: IMAGE,
    });
    expect(readFileSync(pulled.wasm).equals(PROVIDER)).toBe(true);
    expect(readFileSync(join(entry, 'manifest.json')).equals(MANIFEST)).toBe(true);
    expect(invocations.map((entry) => entry.args.slice(0, 2).join(' '))).toEqual([
      'manifest fetch',
      'blob fetch',
    ]);
    expect(invocations[0]?.args.at(-1)).toBe(IMAGE);
    expect(invocations[1]?.args.at(-1)).toBe(`${REPOSITORY}@${digestOf(PROVIDER)}`);
    expect(stdout.join('')).toContain(`Pulling ${IMAGE}`);

    const again = await pullPgliteComponent(IMAGE, io, deps, '/project');
    expect(again.source).toBe('cache');
    expect(invocations).toHaveLength(2);
  });

  it('pulls again when the cached bytes no longer verify', async () => {
    const cache = mkdtempSync(join(tmpdir(), 'pglite-cache-'));
    const invocations: RunnerInvocation[] = [];
    const deps = registryDeps({ cache, invocations });
    const entry = cacheEntry(deps.env, digestOf(MANIFEST));
    mkdirSync(entry, { recursive: true });
    writeFileSync(join(entry, 'manifest.json'), MANIFEST);
    writeFileSync(join(entry, PGLITE_WASM_FILE), '\0asmcorrupt');
    const { io, stderr } = captureIo();
    const pulled = await pullPgliteComponent(IMAGE, io, deps, '/project');
    expect(pulled.source).toBe('registry');
    expect(readFileSync(pulled.wasm).equals(PROVIDER)).toBe(true);
    expect(stderr.join('')).toContain('failed verification');
    expect(invocations).toHaveLength(2);
  });

  it('uses the entry a concurrent build stored first, and only if it verifies', async () => {
    const winner = (layer: Buffer) => {
      const cache = mkdtempSync(join(tmpdir(), 'pglite-cache-'));
      const deps = registryDeps({ cache });
      const entry = cacheEntry(deps.env, digestOf(MANIFEST));
      return {
        entry,
        deps: {
          ...deps,
          runCaptured: async (
            command: string,
            args: readonly string[],
            options: { cwd: string },
          ) => {
            const result = await deps.runCaptured(command, args, options);
            if (args[0] === 'blob') {
              mkdirSync(entry, { recursive: true });
              writeFileSync(join(entry, 'manifest.json'), MANIFEST);
              writeFileSync(join(entry, PGLITE_WASM_FILE), layer);
            }
            return result;
          },
        } satisfies WasmcloudDeps,
      };
    };
    const valid = winner(PROVIDER);
    const pulled = await pullPgliteComponent(IMAGE, captureIo().io, valid.deps, '/p');
    expect(pulled).toEqual({
      wasm: join(valid.entry, PGLITE_WASM_FILE),
      source: 'registry',
      image: IMAGE,
    });
    const corrupt = winner(Buffer.from('\0asmcorrupt'));
    await expect(
      pullPgliteComponent(IMAGE, captureIo().io, corrupt.deps, '/p'),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^E/) });
  });

  it('leaves no cache entry when the pulled layer does not match', async () => {
    const deps = registryDeps({ layer: Buffer.from('\0asmswapped') });
    await expect(pullPgliteComponent(IMAGE, captureIo().io, deps, '/p')).rejects.toMatchObject({
      code: 'WASMCLOUD_PGLITE_DIGEST_MISMATCH',
      exitCode: 3,
    });
    expect(existsSync(cacheEntry(deps.env, digestOf(MANIFEST)))).toBe(false);
  });

  it('rejects a registry manifest that does not match the pin', async () => {
    const deps = registryDeps({ manifest: manifestFor(Buffer.from('\0asmother')) });
    await expect(pullPgliteComponent(IMAGE, captureIo().io, deps, '/p')).rejects.toMatchObject({
      code: 'WASMCLOUD_PGLITE_DIGEST_MISMATCH',
    });
  });

  it('explains a missing oras and a failed pull', async () => {
    await expect(
      pullPgliteComponent(IMAGE, captureIo().io, registryDeps({ oras: undefined }), '/p'),
    ).rejects.toThrow(/oras is required.*DI_FRAMEWORK_PGLITE_WASM/);
    await expect(
      pullPgliteComponent(
        IMAGE,
        captureIo().io,
        registryDeps({ exitCodes: { 'manifest fetch': 1 } }),
        '/p',
      ),
    ).rejects.toMatchObject({
      code: 'WASMCLOUD_PGLITE_PULL_FAILED',
      message: expect.stringMatching(/denied: unauthorized.*oras login ghcr\.io/),
    });
    const silent = registryDeps();
    const failing: WasmcloudDeps = {
      ...silent,
      runCaptured: async () => ({ exitCode: 2, stdout: '', stderr: '' }),
    };
    await expect(pullPgliteComponent(IMAGE, captureIo().io, failing, '/p')).rejects.toThrow(
      `oras manifest fetch failed for ${IMAGE}. If`,
    );
  });

  it('prefers the environment override, then pglite.wasm, then the pinned image', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pglite-local-'));
    writeFileSync(join(dir, 'env.wasm'), PROVIDER);
    writeFileSync(join(dir, 'config.wasm'), PROVIDER);
    const invocations: RunnerInvocation[] = [];
    const config = {
      image: IMAGE,
      wasm: join(dir, 'config.wasm'),
      storageMount: '/data',
      dataDir: '/data/pglite',
    };
    const { io, stdout } = captureIo();
    const fromEnv = await resolvePgliteComponent(
      config,
      io,
      registryDeps({ invocations, cwd: dir, env: { [PGLITE_WASM_ENV]: 'env.wasm' } }),
      dir,
    );
    expect(fromEnv).toEqual({ wasm: join(dir, 'env.wasm'), source: 'local' });
    expect(stdout.join('')).toContain(`instead of ${IMAGE}`);
    const fromConfig = await resolvePgliteComponent(config, io, registryDeps({ invocations }), dir);
    expect(fromConfig).toEqual({ wasm: join(dir, 'config.wasm'), source: 'local' });
    expect(invocations).toHaveLength(0);

    const pulled = await resolvePgliteComponent(
      { ...config, wasm: undefined },
      io,
      registryDeps({ invocations }),
      dir,
    );
    expect(pulled.source).toBe('registry');

    await expect(
      resolvePgliteComponent(
        { wasm: join(dir, 'missing.wasm'), storageMount: '/data', dataDir: '/data' },
        io,
        registryDeps(),
        dir,
      ),
    ).rejects.toMatchObject({
      code: 'WASMCLOUD_PGLITE_PROVIDER_MISSING',
      message: expect.stringContaining('(from pglite.wasm)'),
    });
    await expect(
      resolvePgliteComponent(
        config,
        io,
        registryDeps({ env: { [PGLITE_WASM_ENV]: '/nope' } }),
        dir,
      ),
    ).rejects.toThrow(`/nope (from ${PGLITE_WASM_ENV}) does not exist`);
  });
});

describe('pglite composition', () => {
  const GUEST =
    'import { open } from "di-framework:pglite/database@0.2.0";\nexport default open;\n';
  const WIT = `world application {
  export wasi:http/handler@0.3.0;
  import wasi:filesystem/preopens@0.2.12;
}
`;

  function pgliteProject(pglite?: Record<string, unknown>): string {
    const root = makeProject({
      name: 'Orders',
      entry: 'src/app.ts',
      ...(pglite ? { pglite } : {}),
    });
    mkdirSync(join(root, 'vendor'), { recursive: true });
    writeFileSync(join(root, 'vendor', 'pglite.wasm'), PROVIDER);
    return root;
  }

  it('plugs the pulled provider into a guest that imports the database', async () => {
    const root = pgliteProject({ image: IMAGE });
    const cache = mkdtempSync(join(tmpdir(), 'pglite-cache-'));
    const invocations: RunnerInvocation[] = [];
    const base = fakeDeps({
      cwd: root,
      assets: makeAssets(),
      invocations,
      env: { [CACHE_DIR_ENV]: cache },
      bundleContents: GUEST,
      componentOutput: () => '\0asm pglite-import',
      capturedStdout: { wit: WIT },
      captures: { oras: 'Version: 1.3.4' },
    });
    const registry = registryDeps({ cache });
    const deps: WasmcloudDeps = {
      ...base,
      runCaptured: (command, args, options) =>
        command === 'oras'
          ? registry.runCaptured(command, args, options)
          : base.runCaptured(command, args, options),
    };
    const summary = await buildComponent(loadProject(root), captureIo().io, deps);
    expect(summary.pglite).toEqual({ source: 'registry', image: IMAGE });
    const world = readFileSync(join(root, '.di-framework', 'wit', 'world.wit'), 'utf8');
    expect(world).toContain('import di-framework:pglite/types@0.2.0;');
    expect(world).toContain('import di-framework:pglite/database@0.2.0;');
    const plugs = invocations.filter((entry) => entry.args[0] === 'plug');
    expect(plugs).toHaveLength(1);
    expect(plugs[0]?.args).toContain(
      join(cacheEntry(deps.env, digestOf(MANIFEST)), PGLITE_WASM_FILE),
    );
    const build = JSON.parse(readFileSync(join(root, '.di-framework', 'build.json'), 'utf8'));
    expect(build.pglite).toEqual({ source: 'registry', image: IMAGE });
  });

  it('composes a local provider without the network', async () => {
    const root = pgliteProject({ image: IMAGE, wasm: 'vendor/pglite.wasm' });
    const invocations: RunnerInvocation[] = [];
    const summary = await buildComponent(
      loadProject(root),
      captureIo().io,
      fakeDeps({
        cwd: root,
        assets: makeAssets(),
        invocations,
        bundleContents: GUEST,
        componentOutput: () => '\0asm pglite-import',
        capturedStdout: { wit: WIT },
      }),
    );
    expect(summary.pglite).toEqual({ source: 'local' });
    expect(invocations.some((entry) => entry.command === 'oras')).toBe(false);
    expect(invocations.find((entry) => entry.args[0] === 'plug')?.args).toContain(
      join(root, 'vendor', 'pglite.wasm'),
    );
  });

  it('requires the pin when the guest imports pglite, and the import when pinned', async () => {
    const deps = (root: string, bundleContents?: string) =>
      fakeDeps({
        cwd: root,
        assets: makeAssets(),
        bundleContents,
        componentOutput: () => '\0asm pglite-import',
        capturedStdout: { wit: WIT },
      });
    const unpinned = pgliteProject();
    await expect(
      buildComponent(loadProject(unpinned), captureIo().io, deps(unpinned, GUEST)),
    ).rejects.toMatchObject({
      code: 'WASMCLOUD_PGLITE_NOT_CONFIGURED',
      exitCode: 2,
      message: expect.stringContaining(
        '"pglite": { "image": "ghcr.io/di-framework/pglite-component@sha256:<digest>" }',
      ),
    });
    const unused = pgliteProject({ wasm: 'vendor/pglite.wasm' });
    await expect(
      buildComponent(loadProject(unused), captureIo().io, deps(unused)),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_PGLITE_UNUSED', exitCode: 2 });
  });

  it('reports a failed composition', async () => {
    const root = pgliteProject({ wasm: 'vendor/pglite.wasm' });
    await expect(
      buildComponent(
        loadProject(root),
        captureIo().io,
        fakeDeps({
          cwd: root,
          assets: makeAssets(),
          bundleContents: GUEST,
          componentOutput: () => '\0asm pglite-import',
          capturedStdout: { wit: WIT },
          exitCodes: { '--plug': 1 },
        }),
      ),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_PGLITE_COMPOSE_FAILED', exitCode: 3 });
  });
});

describe('pglite workload manifest', () => {
  const external: ClusterConnection = {
    target: 'development',
    kubeconfig: '/tmp/kube',
    namespace: 'wasmcloud',
    registry: { push: 'registry.example.com/t', pull: 'registry.example.com/t', insecure: false },
  };
  const tenant: ClusterConnection = {
    ...external,
    namespace: 'di-tenant-acme',
    hostgroup: 'tenant-acme',
  };
  const project = (pglite: Record<string, unknown> = { image: IMAGE }) =>
    loadProject(makeProject({ name: 'Orders', entry: 'src/app.ts', pglite }));

  it('marks the component exclusive and asks the platform for storage', () => {
    const yaml = renderWorkloadManifest(project(), tenant, 'registry.example.com/orders:1');
    expect(yaml).toContain('    di-framework.dev/persistent-storage: "true"\n');
    expect(yaml).not.toContain('di-framework.dev/storage-mount');
    expect(yaml).toContain(
      `          localResources:\n            environment:\n              config:\n                DI_CONTROL_HTTP_HOST:`,
    );
    expect(yaml).toContain('                DI_PGLITE_DATA_DIR: "/data/pglite"\n');
    expect(yaml).toContain(
      `              - name: orders-control\n            config:\n              ${EXCLUSIVE_INSTANCE_KEY}: "true"\n`,
    );
    // The opt-in is on the one component, never on a service; no postgres binding is emitted.
    expect(yaml.split(EXCLUSIVE_INSTANCE_KEY)).toHaveLength(2);
    expect(yaml).toContain('      components:\n        - name: orders\n');
    expect(yaml).not.toMatch(/^ {6}service:/m);
    expect(yaml).not.toContain('package: postgres');
    expect(yaml).toContain('spec:\n  replicas: 1\n  deployPolicy: Recreate\n');
    expect(yaml).not.toContain('volumeMounts:');
  });

  it('renders a configurable mount and data root', () => {
    const yaml = renderWorkloadManifest(
      project({ image: IMAGE, storageMount: '/data/actors', dataDir: '/data/actors/orders' }),
      tenant,
      'registry.example.com/orders:1',
    );
    expect(yaml).toContain('    di-framework.dev/storage-mount: "/data/actors"\n');
    expect(yaml).toContain('DI_PGLITE_DATA_DIR: "/data/actors/orders"');

    const hosted = renderWorkloadManifest(
      project({ wasm: 'src/app.ts', storageMount: '/srv/db', dataDir: '/srv/db' }),
      external,
      'registry.example.com/orders:1',
    );
    expect(hosted).toContain(
      '            volumeMounts:\n              - name: app-storage\n                mountPath: /srv/db\n',
    );
    expect(hosted).toContain('hostgroup: storage');
    expect(hosted).not.toContain('di-framework.dev/persistent-storage');
  });

  it('keeps storage on even when the caller turns it off, and checks the data root', () => {
    const yaml = renderWorkloadManifest(
      project(),
      tenant,
      'registry.example.com/orders:1',
      undefined,
      [],
      { hasPersistentStorage: false },
    );
    expect(yaml).toContain('di-framework.dev/persistent-storage: "true"');
    expectFailure(
      () =>
        renderWorkloadManifest(project(), tenant, 'r/o:1', undefined, [], {
          storageVolume: { mountPath: '/data/actors' },
        }),
      'WASMCLOUD_PGLITE_STORAGE_MISMATCH',
      2,
    );
    expectFailure(
      () =>
        renderWorkloadManifest(
          project({ image: IMAGE, storageMount: '/srv', dataDir: '/srv' }),
          tenant,
          'r/o:1',
        ),
      'WASMCLOUD_STORAGE_MOUNT_UNSUPPORTED',
      2,
    );
    expectFailure(
      () => renderWorkloadManifest(project(), tenant, 'r/o:1', undefined, [], { replicas: 2 }),
      'WASMCLOUD_STORAGE_REPLICA_CONSTRAINT',
      2,
    );
    expect(() =>
      renderWorkloadManifest(project(), tenant, 'r/o:1', undefined, [], { replicas: 2 }),
    ).toThrow('PGlite workloads require replicas: 1');
  });

  it('deploys a service-shaped guest as a component so the opt-in stays legal', () => {
    const yaml = renderWorkloadManifest(
      {
        ...project(),
        ingress: false,
        workloadEntry: { kind: 'service' as const, exportName: 'run', path: '/run' },
      },
      tenant,
      'registry.example.com/orders:1',
      [],
    );
    expect(yaml).toContain('      components:\n');
    expect(yaml).not.toMatch(/^ {6}service:/m);
    expect(yaml).toContain(`${EXCLUSIVE_INSTANCE_KEY}: "true"`);
  });
});
