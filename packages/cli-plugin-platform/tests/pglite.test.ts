import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildComponent } from '../src/build';
import { runWasmcloudDeploy } from '../src/deploy';
import type { WasmcloudDeps } from '../src/deps';
import {
  ALLOW_LOCAL_PGLITE_ENV,
  assertDistinctPgliteRoots,
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
  STALE_STAGING_MS,
  verifyLayer,
  verifyManifest,
  warnIfHostIgnoresExclusive,
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
  makeWorkspace,
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

  it('refuses a pglite.wasm symlink that leaves the project', () => {
    const outside = mkdtempSync(join(tmpdir(), 'pglite-outside-'));
    writeFileSync(join(outside, 'pglite.wasm'), PROVIDER);
    const root = makeProject({
      name: 'Orders',
      entry: 'src/app.ts',
      pglite: { wasm: 'vendor/pglite.wasm' },
    });
    mkdirSync(join(root, 'vendor'));
    symlinkSync(join(outside, 'pglite.wasm'), join(root, 'vendor', 'pglite.wasm'));
    expectFailure(() => loadProject(root), 'WASMCLOUD_CONFIG_INVALID', 2);
    const inside = makeProject({
      name: 'Orders',
      entry: 'src/app.ts',
      pglite: { wasm: 'vendor/link.wasm' },
    });
    mkdirSync(join(inside, 'vendor'));
    writeFileSync(join(inside, 'vendor', 'real.wasm'), PROVIDER);
    symlinkSync(join(inside, 'vendor', 'real.wasm'), join(inside, 'vendor', 'link.wasm'));
    expect(loadProject(inside).pglite?.wasm).toBe(join(inside, 'vendor', 'link.wasm'));
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
    expect(pulled).toMatchObject({ source: 'registry', image: IMAGE });
    expect(pulled.bytes.equals(PROVIDER)).toBe(true);
    expect(readFileSync(join(entry, PGLITE_WASM_FILE)).equals(PROVIDER)).toBe(true);
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
    expect(again.bytes.equals(PROVIDER)).toBe(true);
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
    expect(pulled.bytes.equals(PROVIDER)).toBe(true);
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
    expect(pulled).toMatchObject({ source: 'registry', image: IMAGE });
    expect(pulled.bytes.equals(PROVIDER)).toBe(true);
    const corrupt = winner(Buffer.from('\0asmcorrupt'));
    await expect(
      pullPgliteComponent(IMAGE, captureIo().io, corrupt.deps, '/p'),
    ).rejects.toMatchObject({
      code: 'WASMCLOUD_PGLITE_CACHE_CONFLICT',
      exitCode: 3,
      message: expect.stringContaining(`remove ${corrupt.entry} and retry`),
    });
  });

  it('sweeps staging directories a killed build left behind', async () => {
    const cache = mkdtempSync(join(tmpdir(), 'pglite-cache-'));
    const stale = join(cache, '.pull-old');
    const fresh = join(cache, '.pull-new');
    const other = join(cache, 'keep');
    for (const dir of [stale, fresh, other]) mkdirSync(dir);
    const old = new Date(Date.now() - STALE_STAGING_MS - 60_000);
    utimesSync(stale, old, old);
    utimesSync(other, old, old);
    await pullPgliteComponent(IMAGE, captureIo().io, registryDeps({ cache }), '/p');
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(other)).toBe(true);
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
    const { io, stderr } = captureIo();
    const fromEnv = await resolvePgliteComponent(
      config,
      io,
      registryDeps({ invocations, cwd: dir, env: { [PGLITE_WASM_ENV]: 'env.wasm' } }),
      dir,
    );
    expect(fromEnv).toMatchObject({ path: join(dir, 'env.wasm'), source: 'local' });
    expect(stderr.join('')).toContain(
      `Warning: using the local, unverified PGlite provider ${join(dir, 'env.wasm')} (from ${PGLITE_WASM_ENV}) instead of the pinned ${IMAGE}`,
    );
    const fromConfig = await resolvePgliteComponent(config, io, registryDeps({ invocations }), dir);
    expect(fromConfig).toMatchObject({ path: join(dir, 'config.wasm'), source: 'local' });
    expect(fromConfig.bytes.equals(PROVIDER)).toBe(true);
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

  it('checks local providers are wasm and refuses them in deploys and on CI', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pglite-local-'));
    writeFileSync(join(dir, 'text.wasm'), 'not wasm');
    writeFileSync(join(dir, 'ok.wasm'), PROVIDER);
    const local = (name: string) => ({
      wasm: join(dir, name),
      storageMount: '/data',
      dataDir: '/data/pglite',
    });
    await expect(
      resolvePgliteComponent(local('text.wasm'), captureIo().io, registryDeps(), dir),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_PGLITE_PROVIDER_INVALID' });
    await expect(
      resolvePgliteComponent(local('ok.wasm'), captureIo().io, registryDeps(), dir, {
        deploy: true,
      }),
    ).rejects.toThrow(
      `Refusing the unverified local PGlite provider ${join(dir, 'ok.wasm')} (from pglite.wasm) in deploy; pin "pglite.image" by digest, or set ${ALLOW_LOCAL_PGLITE_ENV}=1`,
    );
    await expect(
      resolvePgliteComponent(
        local('ok.wasm'),
        captureIo().io,
        registryDeps({ env: { CI: 'true' } }),
        dir,
      ),
    ).rejects.toMatchObject({
      code: 'WASMCLOUD_PGLITE_LOCAL_REFUSED',
      message: expect.stringContaining('in CI'),
    });
    const { io, stderr } = captureIo();
    const allowed = await resolvePgliteComponent(
      local('ok.wasm'),
      io,
      registryDeps({ env: { CI: 'true', [ALLOW_LOCAL_PGLITE_ENV]: '1' } }),
      dir,
      { deploy: true },
    );
    expect(allowed.source).toBe('local');
    expect(stderr.join('')).toBe(
      `Warning: using the local, unverified PGlite provider ${join(dir, 'ok.wasm')} (from pglite.wasm)\n`,
    );
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
    // The plug reads a private copy of the verified bytes, not the shared cache file.
    const copy = join(root, '.di-framework', PGLITE_WASM_FILE);
    expect(plugs[0]?.args).toContain(copy);
    expect(readFileSync(copy).equals(PROVIDER)).toBe(true);
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
    expect(summary.pglite).toEqual({ source: 'local', path: join(root, 'vendor', 'pglite.wasm') });
    expect(invocations.some((entry) => entry.command === 'oras')).toBe(false);
    expect(invocations.find((entry) => entry.args[0] === 'plug')?.args).toContain(
      join(root, '.di-framework', PGLITE_WASM_FILE),
    );
  });

  it('refuses a local provider in a deploy build unless opted in', async () => {
    const root = pgliteProject({ wasm: 'vendor/pglite.wasm' });
    const deps = (env: Record<string, string> = {}) =>
      fakeDeps({
        cwd: root,
        assets: makeAssets(),
        env,
        bundleContents: GUEST,
        componentOutput: () => '\0asm pglite-import',
        capturedStdout: { wit: WIT },
      });
    await expect(
      buildComponent(loadProject(root), captureIo().io, deps(), { deploy: true }),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_PGLITE_LOCAL_REFUSED' });
    const summary = await buildComponent(
      loadProject(root),
      captureIo().io,
      deps({ [ALLOW_LOCAL_PGLITE_ENV]: '1' }),
      { deploy: true },
    );
    expect(summary.pglite?.source).toBe('local');
  });

  it('fails when the composed component still imports pglite', async () => {
    const root = pgliteProject({ wasm: 'vendor/pglite.wasm' });
    const deps = (wit: string): WasmcloudDeps => {
      const base = fakeDeps({
        cwd: root,
        assets: makeAssets(),
        env: { [ALLOW_LOCAL_PGLITE_ENV]: '1' },
        bundleContents: GUEST,
        componentOutput: () => '\0asm pglite-import',
        capturedStdout: { wit },
      });
      return {
        ...base,
        // The fake plug writes a non-wasm placeholder; make it look composed so imports are read.
        runCaptured: async (command, args, options) => {
          const result = await base.runCaptured(command, args, options);
          if (args[0] === 'plug')
            writeFileSync(args[args.indexOf('-o') + 1] as string, '\0asm composed');
          return result;
        },
      };
    };
    await expect(
      buildComponent(
        loadProject(root),
        captureIo().io,
        deps(`${WIT}  import di-framework:pglite/database@0.2.0;\n`),
      ),
    ).rejects.toMatchObject({
      code: 'WASMCLOUD_PGLITE_COMPOSE_FAILED',
      message: expect.stringContaining('still imports di-framework:pglite'),
    });
    expect(
      (await buildComponent(loadProject(root), captureIo().io, deps(WIT))).pglite?.source,
    ).toBe('local');
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

describe('pglite workload safety', () => {
  const config = (storageMount: string, dataDir: string) => ({
    image: IMAGE,
    storageMount,
    dataDir,
  });

  it('refuses two members that resolve to the same database root', () => {
    // /data/pglite and /data/actors/pglite are the same host directory: members share it.
    expectFailure(
      () =>
        assertDistinctPgliteRoots('shop', [
          { applicationName: 'a', workload: 'shop', pglite: config('/data', '/data/pglite') },
          {
            applicationName: 'b',
            workload: 'shop',
            pglite: config('/data/actors', '/data/actors/pglite'),
          },
        ]),
      'WASMCLOUD_PGLITE_DATA_DIR_CONFLICT',
      2,
    );
    expect(() =>
      assertDistinctPgliteRoots('shop', [
        { applicationName: 'a', workload: 'shop', pglite: config('/data', '/data') },
        { applicationName: 'b', workload: 'shop', pglite: config('/data/actors', '/data/actors') },
      ]),
    ).toThrow('a and b would open the same PGlite database (<workload storage>/.)');
    expect(() =>
      assertDistinctPgliteRoots('shop', [
        { applicationName: 'a', workload: 'shop', pglite: config('/data', '/data/orders') },
        { applicationName: 'b', workload: 'shop', pglite: config('/data', '/data/users') },
        { applicationName: 'c', workload: 'other', pglite: config('/data', '/data/orders') },
        { applicationName: 'd', workload: 'shop' },
      ]),
    ).not.toThrow();
  });

  const pods = (...images: string[]) =>
    JSON.stringify({ items: [{ spec: { containers: images.map((image) => ({ image })) } }, {}] });
  const tenant: ClusterConnection = {
    target: 'acme',
    kubeconfig: '/tmp/kube',
    namespace: 'di-tenant-acme',
    registry: { push: 'r', pull: 'r', insecure: false },
    hostgroup: 'tenant-acme',
  };
  const app = { applicationName: 'orders', projectRoot: '/tmp', pglite: config('/data', '/data') };

  it('warns when the tenant host is not the exclusive build', async () => {
    const invocations: RunnerInvocation[] = [];
    const out = captureIo();
    await warnIfHostIgnoresExclusive(
      app,
      tenant,
      out.io,
      fakeDeps({
        cwd: '/tmp',
        invocations,
        capturedStdout: { 'kubectl get': pods('ghcr.io/di-framework/wash:2.8.0-wasi-tls') },
      }),
    );
    expect(invocations[0]?.args).toContain('di-runtime-acme');
    expect(invocations[0]?.args).toContain('wasmcloud.com/hostgroup=tenant-acme');
    expect(out.stderr.join('')).toContain(
      'Warning: orders embeds PGlite and is marked exclusive, but host group tenant-acme runs ghcr.io/di-framework/wash:2.8.0-wasi-tls, which does not look like the exclusive build',
    );
    expect(out.stderr.join('')).toContain(
      'a second instance can open the same PGlite data directory',
    );

    for (const result of [
      { exitCodes: { 'kubectl get': 1 } },
      { capturedStdout: { 'kubectl get': 'nope' } },
      { capturedStdout: { 'kubectl get': '{}' } },
    ]) {
      const unread = captureIo();
      await warnIfHostIgnoresExclusive(
        app,
        tenant,
        unread.io,
        fakeDeps({ cwd: '/tmp', ...result }),
      );
      expect(unread.stderr.join('')).toContain('could not read its host image');
    }
  });

  it('stays quiet on the exclusive build and without pglite, and notes other targets', async () => {
    const quiet = captureIo();
    await warnIfHostIgnoresExclusive(
      app,
      tenant,
      quiet.io,
      fakeDeps({
        cwd: '/tmp',
        capturedStdout: {
          'kubectl get': pods('ghcr.io/di-framework/wash:2.8.0-wasi-tls-exclusive@sha256:abc'),
        },
      }),
    );
    await warnIfHostIgnoresExclusive(
      { ...app, pglite: undefined },
      tenant,
      quiet.io,
      fakeDeps({ cwd: '/tmp' }),
    );
    expect(quiet.stderr).toEqual([]);

    const external = captureIo();
    const invocations: RunnerInvocation[] = [];
    await warnIfHostIgnoresExclusive(
      app,
      { ...tenant, hostgroup: undefined, storageHostgroup: 'db' },
      external.io,
      fakeDeps({ cwd: '/tmp', invocations }),
    );
    await warnIfHostIgnoresExclusive(
      app,
      { ...tenant, hostgroup: undefined },
      external.io,
      fakeDeps({ cwd: '/tmp', invocations }),
    );
    await warnIfHostIgnoresExclusive(
      app,
      { ...tenant, hostgroup: 'shared' },
      external.io,
      fakeDeps({ cwd: '/tmp', invocations }),
    );
    expect(invocations).toEqual([]);
    expect(external.stderr.join('')).toContain(
      'Note: orders embeds PGlite and is marked exclusive; host group db must run',
    );
    expect(external.stderr.join('')).toContain('host group storage must run');
    expect(external.stderr.join('')).toContain('host group shared must run');
  });
});

describe('pglite deploy', () => {
  const GUEST =
    'import { open } from "di-framework:pglite/database@0.2.0";\nexport default open;\n';

  function workspace(pglite: Record<string, unknown>): string {
    const { greeter } = makeWorkspace();
    const configPath = join(greeter, 'di-framework.config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    writeFileSync(configPath, `${JSON.stringify({ ...config, pglite })}\n`);
    mkdirSync(join(greeter, 'vendor'), { recursive: true });
    writeFileSync(join(greeter, 'vendor', 'pglite.wasm'), PROVIDER);
    return greeter;
  }

  const deps = (cwd: string, env: Record<string, string>) =>
    fakeDeps({
      cwd,
      assets: makeAssets(),
      env,
      bundleContents: GUEST,
      componentOutput: () => '\0asm pglite-import',
      capturedStdout: { wit: 'world application {}\n' },
    });

  it('reports a pinned provider and notes the host requirement', async () => {
    const greeter = workspace({ image: IMAGE });
    const cache = mkdtempSync(join(tmpdir(), 'pglite-cache-'));
    const entry = cacheEntry({ [CACHE_DIR_ENV]: cache }, digestOf(MANIFEST));
    mkdirSync(entry, { recursive: true });
    writeFileSync(join(entry, 'manifest.json'), MANIFEST);
    writeFileSync(join(entry, PGLITE_WASM_FILE), PROVIDER);
    const out = captureIo();
    const result = await runWasmcloudDeploy(
      ['--target', 'development'],
      out.io,
      deps(greeter, { [CACHE_DIR_ENV]: cache }),
    );
    expect(result.data.pglite).toEqual({ source: 'cache', image: IMAGE });
    expect(result.text).toContain(` PGlite: ${IMAGE}.`);
    expect(out.stderr.join('')).toContain(
      'host group storage must run a wash image built with the exclusive patch',
    );
  });

  it('refuses a local provider unless opted in, then reports it as unverified', async () => {
    const greeter = workspace({ wasm: 'vendor/pglite.wasm' });
    await expect(
      runWasmcloudDeploy(['--target', 'development'], captureIo().io, deps(greeter, {})),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_PGLITE_LOCAL_REFUSED' });
    const result = await runWasmcloudDeploy(
      ['--target', 'development'],
      captureIo().io,
      deps(greeter, { [ALLOW_LOCAL_PGLITE_ENV]: '1' }),
    );
    const path = join(greeter, 'vendor', 'pglite.wasm');
    expect(result.data.pglite).toEqual({ source: 'local', path });
    expect(result.text).toContain(` PGlite: local ${path} (unverified).`);
  });
});
