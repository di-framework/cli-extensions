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
import { buildComponent, encryptProvider } from '../src/build';
import { runWasmcloudDeploy } from '../src/deploy';
import type { WasmcloudDeps } from '../src/deps';
import { DEFAULT_DEPS } from '../src/deps';
import {
  ALLOW_LOCAL_PGLITE_ENV,
  assertDistinctPgliteRoots,
  CACHE_DIR_ENV,
  cacheEntry,
  cacheRoot,
  EXCLUSIVE_INSTANCE_KEY,
  isWithin,
  PGLITE_ENCFS,
  PGLITE_ENCFS_WASM_ENV,
  PGLITE_ENCFS_WASM_FILE,
  PGLITE_ENCRYPTED_WASM_FILE,
  PGLITE_WASM_ENV,
  PGLITE_WASM_FILE,
  parseDigestReference,
  parsePgliteConfig,
  pullPgliteComponent,
  resolvePgliteComponent,
  resolvePgliteEncryption,
  STALE_STAGING_MS,
  verifyLayer,
  verifyManifest,
  warnIfHostIgnoresExclusive,
} from '../src/pglite';
import {
  encfsSection,
  encryptionComposition,
  planWiring,
  semverCompatible,
  worldInterfaces,
} from '../src/pglite-encryption';
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

/** A component binary with only custom sections: the pglite-encfs marker and `extra`. */
const marked = (extra: string, marker = true): Buffer => {
  const section = (name: string, contents: string) => {
    const body = Buffer.concat([
      Buffer.from([name.length]),
      Buffer.from(name),
      Buffer.from(contents),
    ]);
    return Buffer.concat([Buffer.from([0, body.length]), body]);
  };
  return Buffer.concat([
    Buffer.from([0, 0x61, 0x73, 0x6d, 0x0d, 0, 0x01, 0]),
    ...(marker ? [section('di-framework:pglite-encfs', 'format=1 codec=aes-256-xts')] : []),
    section('extra', extra),
  ]);
};

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

describe('pglite encryption', () => {
  const ENC_REPOSITORY = 'ghcr.io/di-framework/pglite-encfs';
  const LAYER = marked('pglite-encfs');
  const ENC_MANIFEST = manifestFor(LAYER);
  const ENC_IMAGE = `${ENC_REPOSITORY}@${digestOf(ENC_MANIFEST)}`;
  const GUEST =
    'import { open } from "di-framework:pglite/database@0.2.0";\nexport default open;\n';
  const WIT = 'world application {\n  export wasi:http/handler@0.3.0;\n}\n';
  const world = (lines: string[]) =>
    `package root:component;\n\nworld root {\n${lines.map((line) => `  ${line};`).join('\n')}\n}\n`;
  const PROVIDER_WIT = world([
    'import wasi:filesystem/types@0.2.9',
    'import wasi:filesystem/preopens@0.2.9',
    'import wasi:cli/environment@0.2.9',
    'export di-framework:pglite/database@0.2.0',
  ]);
  const LAYER_WIT = world([
    'import wasi:filesystem/types@0.2.9',
    'import wasi:filesystem/preopens@0.2.9',
    'import wasi:cli/environment@0.2.9',
    'export wasi:filesystem/types@0.2.9',
    'export wasi:filesystem/preopens@0.2.9',
    'export wasi:cli/environment@0.2.9',
  ]);
  const parse = (value: unknown) => parsePgliteConfig(value, CONFIG_PATH, toProject);

  /** oras serving the provider and the encryption layer, each by its own pin. */
  function twoImageRegistry(
    invocations: RunnerInvocation[],
  ): (args: readonly string[]) => { exitCode: number; stdout: string; stderr: string } {
    const blobs = new Map<string, Buffer>([
      [IMAGE, MANIFEST],
      [ENC_IMAGE, ENC_MANIFEST],
      [`${REPOSITORY}@${digestOf(PROVIDER)}`, PROVIDER],
      [`${ENC_REPOSITORY}@${digestOf(LAYER)}`, LAYER],
    ]);
    return (args) => {
      invocations.push({ command: 'oras', args: [...args], cwd: '', captured: true });
      const output = args[args.indexOf('--output') + 1] as string;
      const bytes = blobs.get(args[args.length - 1] as string);
      if (bytes === undefined) return { exitCode: 1, stdout: '', stderr: 'not found' };
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, bytes);
      return { exitCode: 0, stdout: '', stderr: '' };
    };
  }

  function project(
    pglite: Record<string, unknown>,
    controlSecretKeys: string[] | null = ['ISSUER_URL', 'DI_PGLITE_KEY'],
  ): string {
    const root = makeProject({
      name: 'Orders',
      entry: 'src/app.ts',
      pglite,
      ...(controlSecretKeys === null ? {} : { controlSecretKeys }),
    });
    mkdirSync(join(root, 'vendor'), { recursive: true });
    writeFileSync(join(root, 'vendor', 'pglite.wasm'), PROVIDER);
    writeFileSync(join(root, 'vendor', 'encfs.wasm'), LAYER);
    return root;
  }

  function buildDeps(
    root: string,
    options: {
      invocations?: RunnerInvocation[];
      env?: Record<string, string>;
      exitCodes?: Record<string, number>;
      cache?: string;
      layerWit?: string;
    } = {},
  ): WasmcloudDeps {
    const invocations = options.invocations ?? [];
    const worlds: Record<string, string> = {
      [PGLITE_WASM_FILE]: PROVIDER_WIT,
      [PGLITE_ENCFS_WASM_FILE]: options.layerWit ?? LAYER_WIT,
    };
    const base = fakeDeps({
      cwd: root,
      assets: makeAssets(),
      invocations,
      env: {
        [CACHE_DIR_ENV]: options.cache ?? mkdtempSync(join(tmpdir(), 'pglite-cache-')),
        ...options.env,
      },
      exitCodes: options.exitCodes,
      bundleContents: GUEST,
      componentOutput: () => '\0asm pglite-import',
      capturedStdout: { wit: WIT },
      captures: { oras: 'Version: 1.3.4' },
    });
    const oras = twoImageRegistry(invocations);
    return {
      ...base,
      runCaptured: async (command, args, runOptions) => {
        if (command === 'oras') return oras(args);
        const world =
          args[1] === 'wit' ? worlds[String(args[2]).split('/').pop() ?? ''] : undefined;
        if (world !== undefined) {
          invocations.push({ command, args: [...args], cwd: runOptions.cwd, captured: true });
          return { exitCode: 0, stdout: world, stderr: '' };
        }
        if (args[0] === 'compose') {
          // Stands in for `wac compose`: it writes the composed provider.
          invocations.push({ command, args: [...args], cwd: runOptions.cwd, captured: true });
          const exitCode = options.exitCodes?.['wac compose'] ?? 0;
          if (exitCode !== 0)
            return { exitCode, stdout: '', stderr: 'error: mismatched instantiation argument' };
          writeFileSync(args[args.indexOf('-o') + 1] as string, 'composed-encrypted-provider');
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        return base.runCaptured(command, args, runOptions);
      },
    };
  }

  it('parses a digest-pinned or local encryption layer and rejects anything else', () => {
    expect(parse({ image: IMAGE, encryption: { image: ENC_IMAGE } })?.encryption).toEqual({
      image: ENC_IMAGE,
    });
    expect(
      parse({ image: IMAGE, encryption: { image: ENC_IMAGE, wasm: 'vendor/encfs.wasm' } })
        ?.encryption,
    ).toEqual({ image: ENC_IMAGE, wasm: '/project/vendor/encfs.wasm' });
    expect(parse({ image: IMAGE })).not.toHaveProperty('encryption');
    for (const encryption of [
      null,
      [],
      'on',
      {},
      { image: 1 },
      { image: `${ENC_REPOSITORY}:0.1.0` },
      { wasm: '' },
      { image: ENC_IMAGE, mode: 'required' },
    ]) {
      expectFailure(() => parse({ image: IMAGE, encryption }), 'WASMCLOUD_CONFIG_INVALID', 2);
    }
    expect(() => parse({ image: IMAGE, encryption: {} })).toThrow(
      `pglite.encryption needs "image" (${ENC_REPOSITORY}@sha256:<digest>) or a local "wasm" path`,
    );
    expect(() => parse({ image: IMAGE, encryption: { image: `${ENC_REPOSITORY}:0.1.0` } })).toThrow(
      `pglite.encryption.image: "${ENC_REPOSITORY}:0.1.0" is not pinned by digest. Use ${ENC_REPOSITORY}@sha256`,
    );
    expect(() => parse({ image: IMAGE, encryption: { image: ENC_IMAGE, mode: 'x' } })).toThrow(
      'pglite.encryption has unsupported fields: mode. Use image, wasm',
    );
    expect(() => parse({ image: IMAGE, encryption: null })).toThrow(
      'pglite.encryption must be an object',
    );
  });

  it('pulls and verifies the layer by digest, plugs it into the provider, then the provider into the guest', async () => {
    const root = project({ image: IMAGE, encryption: { image: ENC_IMAGE } });
    const invocations: RunnerInvocation[] = [];
    const cache = mkdtempSync(join(tmpdir(), 'pglite-cache-'));
    const { io, stdout } = captureIo();
    const summary = await buildComponent(
      loadProject(root),
      io,
      buildDeps(root, { invocations, cache }),
    );
    expect(summary.pglite).toEqual({
      source: 'registry',
      image: IMAGE,
      encryption: { source: 'registry', image: ENC_IMAGE },
    });
    const generated = join(root, '.di-framework');
    const provider = join(generated, PGLITE_WASM_FILE);
    const layer = join(generated, PGLITE_ENCFS_WASM_FILE);
    const encrypted = join(generated, PGLITE_ENCRYPTED_WASM_FILE);
    const document = join(generated, 'pglite-encryption.wac');
    const composes = invocations.filter((entry) => entry.args[0] === 'compose');
    expect(composes.map((entry) => entry.args)).toEqual([
      [
        'compose',
        document,
        '--dep',
        `pglite:layer=${layer}`,
        '--dep',
        `pglite:provider=${provider}`,
        '-o',
        encrypted,
      ],
    ]);
    // Every provider import the layer exports is an explicit instantiation argument.
    expect(readFileSync(document, 'utf8')).toBe(
      [
        'package di-framework:pglite-encrypted;',
        '',
        'let layer = new pglite:layer { ... };',
        'let provider = new pglite:provider {',
        '  "wasi:filesystem/types@0.2.9": layer["wasi:filesystem/types@0.2.9"],',
        '  "wasi:filesystem/preopens@0.2.9": layer["wasi:filesystem/preopens@0.2.9"],',
        '  "wasi:cli/environment@0.2.9": layer["wasi:cli/environment@0.2.9"],',
        '  ...',
        '};',
        '',
        'export provider["di-framework:pglite/database@0.2.0"];',
        '',
      ].join('\n'),
    );
    const plugs = invocations.filter((entry) => entry.args[0] === 'plug');
    expect(plugs.map((entry) => entry.args)).toEqual([
      [
        'plug',
        '--plug',
        encrypted,
        join(root, 'dist', 'orders.wasm'),
        '-o',
        `${join(root, 'dist', 'orders.wasm')}.composed`,
      ],
    ]);
    expect(readFileSync(layer).equals(LAYER)).toBe(true);
    // The guest got the encrypted composition; the raw provider copy is left as pulled.
    expect(readFileSync(provider).equals(PROVIDER)).toBe(true);
    expect(readFileSync(encrypted, 'utf8')).toBe('composed-encrypted-provider');
    // Both inputs were inspected before composing.
    expect(
      invocations.filter((entry) => entry.args[1] === 'wit').map((entry) => entry.args[2]),
    ).toEqual(expect.arrayContaining([provider, layer]));
    // The layer is cached under its own digest and file name.
    const entry = cacheEntry({ [CACHE_DIR_ENV]: cache }, digestOf(ENC_MANIFEST));
    expect(readFileSync(join(entry, PGLITE_ENCFS_WASM_FILE)).equals(LAYER)).toBe(true);
    expect(stdout.join('')).toContain('Composing the PGlite encryption layer into the provider...');
    const build = JSON.parse(readFileSync(join(generated, 'build.json'), 'utf8'));
    expect(build.pglite.encryption).toEqual({ source: 'registry', image: ENC_IMAGE });

    // The layer is part of the rollout key: the same guest without it deploys differently.
    const plain = project({ image: IMAGE });
    const unencrypted = await buildComponent(loadProject(plain), captureIo().io, buildDeps(plain));
    expect(unencrypted.pglite).toEqual({ source: 'registry', image: IMAGE });
    expect(unencrypted.deploymentDigest).not.toBe(summary.deploymentDigest);
  });

  it('fails the build when DI_PGLITE_KEY is not a declared control Secret key', async () => {
    for (const keys of [null, ['ISSUER_URL']]) {
      const root = project({ image: IMAGE, encryption: { image: ENC_IMAGE } }, keys);
      const invocations: RunnerInvocation[] = [];
      await expect(
        buildComponent(loadProject(root), captureIo().io, buildDeps(root, { invocations })),
      ).rejects.toMatchObject({
        code: 'WASMCLOUD_PGLITE_KEY_UNDECLARED',
        exitCode: 2,
        message:
          'Orders turns on "pglite.encryption", whose layer reads its key from DI_PGLITE_KEY in ' +
          'the workload\'s control Secret; add "DI_PGLITE_KEY" to "controlSecretKeys" in di-framework.config.json',
      });
      // A config check: nothing was pulled (not even the provider) and nothing was bundled.
      expect(invocations.filter((entry) => entry.command === 'oras')).toEqual([]);
      expect(existsSync(join(root, '.di-framework', 'component.js'))).toBe(false);
    }
  });

  it('uses a local layer only outside deploys and CI unless opted in', async () => {
    const root = project({
      image: IMAGE,
      encryption: { image: ENC_IMAGE, wasm: 'vendor/encfs.wasm' },
    });
    const local = join(root, 'vendor', 'encfs.wasm');
    await expect(
      buildComponent(loadProject(root), captureIo().io, buildDeps(root), { deploy: true }),
    ).rejects.toMatchObject({
      code: 'WASMCLOUD_PGLITE_LOCAL_REFUSED',
      message:
        `Refusing the unverified local PGlite encryption layer ${local} (from pglite.encryption.wasm) in deploy; ` +
        `pin "pglite.encryption.image" by digest, or set ${ALLOW_LOCAL_PGLITE_ENV}=1 to use it anyway`,
    });
    const { io, stderr } = captureIo();
    const summary = await buildComponent(
      loadProject(root),
      io,
      buildDeps(root, { env: { [ALLOW_LOCAL_PGLITE_ENV]: '1' } }),
      { deploy: true },
    );
    expect(summary.pglite?.encryption).toEqual({ source: 'local', path: local });
    expect(stderr.join('')).toContain(
      `Warning: using the local, unverified PGlite encryption layer ${local} (from pglite.encryption.wasm) instead of the pinned ${ENC_IMAGE}`,
    );
  });

  it('prefers the environment override for the layer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pglite-encfs-'));
    writeFileSync(join(dir, 'env.wasm'), LAYER);
    const { io, stderr } = captureIo();
    const resolved = await resolvePgliteEncryption(
      { image: ENC_IMAGE },
      io,
      { ...registryDeps({ cwd: dir }), env: { [PGLITE_ENCFS_WASM_ENV]: 'env.wasm' } },
      dir,
    );
    expect(resolved).toMatchObject({ source: 'local', path: join(dir, 'env.wasm') });
    expect(stderr.join('')).toContain(`(from ${PGLITE_ENCFS_WASM_ENV}) instead of the pinned`);
    await expect(
      resolvePgliteEncryption({ wasm: join(dir, 'missing.wasm') }, io, registryDeps(), dir),
    ).rejects.toThrow(
      `PGlite encryption layer ${join(dir, 'missing.wasm')} (from pglite.encryption.wasm) does not exist`,
    );
    await expect(
      pullPgliteComponent(
        ENC_IMAGE,
        captureIo().io,
        registryDeps({ oras: undefined }),
        dir,
        PGLITE_ENCFS,
      ),
    ).rejects.toThrow(`set ${PGLITE_ENCFS_WASM_ENV} to a local build`);
    await expect(
      pullPgliteComponent(
        ENC_IMAGE,
        captureIo().io,
        registryDeps({ exitCodes: { 'manifest fetch': 1 } }),
        dir,
        PGLITE_ENCFS,
      ),
    ).rejects.toThrow(`offline, set ${PGLITE_ENCFS_WASM_ENV} or pglite.encryption.wasm`);
  });

  it('reports a failed encryption composition', async () => {
    const root = project({ image: IMAGE, encryption: { image: ENC_IMAGE } });
    await expect(
      buildComponent(
        loadProject(root),
        captureIo().io,
        buildDeps(root, { exitCodes: { 'wac compose': 1 } }),
      ),
    ).rejects.toMatchObject({
      code: 'WASMCLOUD_PGLITE_ENCRYPTION_NOT_INTERPOSED',
      exitCode: 3,
      message: expect.stringContaining(
        'wac compose refused the wiring: error: mismatched instantiation argument',
      ),
    });

    // wac exiting 0 without writing the component is a failure too.
    const deps = buildDeps(root);
    const runCaptured = deps.runCaptured;
    deps.runCaptured = async (command, args, options) =>
      args[0] === 'compose'
        ? { exitCode: 0, stdout: '', stderr: '' }
        : runCaptured(command, args, options);
    await expect(buildComponent(loadProject(root), captureIo().io, deps)).rejects.toThrow(
      'wac compose refused the wiring: wac wrote no component',
    );
  });

  it('reports the layer in the deploy result', async () => {
    const { greeter } = makeWorkspace();
    const configPath = join(greeter, 'di-framework.config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    writeFileSync(
      configPath,
      `${JSON.stringify({
        ...config,
        controlSecretKeys: ['DI_PGLITE_KEY'],
        pglite: { image: IMAGE, encryption: { wasm: 'vendor/encfs.wasm' } },
      })}\n`,
    );
    mkdirSync(join(greeter, 'vendor'), { recursive: true });
    writeFileSync(join(greeter, 'vendor', 'encfs.wasm'), LAYER);
    const result = await runWasmcloudDeploy(
      ['--target', 'development'],
      captureIo().io,
      buildDeps(greeter, { env: { [ALLOW_LOCAL_PGLITE_ENV]: '1' } }),
    );
    const layer = join(greeter, 'vendor', 'encfs.wasm');
    expect(result.data.pglite).toEqual({
      source: 'registry',
      image: IMAGE,
      encryption: { source: 'local', path: layer },
    });
    expect(result.text).toContain(
      ` PGlite: ${IMAGE}, encrypted at rest by local ${layer} (unverified).`,
    );
  });

  it('refuses a layer pinned to the provider repository or digest', () => {
    expect(() =>
      parse({ image: IMAGE, encryption: { image: `${REPOSITORY}@${digestOf(LAYER)}` } }),
    ).toThrow(
      `pglite.encryption.image must pin the encryption layer (${ENC_REPOSITORY}), not the provider repository ${REPOSITORY}`,
    );
    const mirror = `registry.example.com/mirror/pglite@${digestOf(MANIFEST)}`;
    expect(() =>
      parse({
        image: mirror,
        encryption: { image: `registry.example.com/mirror/pglite@${digestOf(LAYER)}` },
      }),
    ).toThrow('not the provider repository registry.example.com/mirror/pglite');
    expect(() =>
      parse({
        image: mirror,
        encryption: { image: `registry.example.com/mirror/encfs@${digestOf(MANIFEST)}` },
      }),
    ).toThrow('pglite.encryption.image pins the same digest as pglite.image');
    expect(
      parse({ wasm: 'vendor/pglite.wasm', encryption: { image: ENC_IMAGE } })?.encryption,
    ).toEqual({ image: ENC_IMAGE });
  });

  it('refuses a layer that does not cover the provider filesystem, before composing', async () => {
    const root = project({ image: IMAGE, encryption: { image: ENC_IMAGE } });
    const invocations: RunnerInvocation[] = [];
    const layerWit = world([
      'import wasi:cli/environment@0.2.9',
      'export wasi:cli/environment@0.2.9',
      'export wasi:filesystem/types@0.3.0',
    ]);
    await expect(
      buildComponent(loadProject(root), captureIo().io, buildDeps(root, { invocations, layerWit })),
    ).rejects.toMatchObject({
      code: 'WASMCLOUD_PGLITE_ENCRYPTION_NOT_INTERPOSED',
      exitCode: 3,
      message: expect.stringContaining(
        'the layer does not export what the provider imports: wasi:filesystem/types@0.2.9 (the layer exports @0.3.0); wasi:filesystem/preopens@0.2.9 (not exported)',
      ),
    });
    expect(invocations.some((entry) => entry.args[0] === 'compose')).toBe(false);
  });

  it('names the missing tool when wac or jco is not installed', async () => {
    const root = project({ image: IMAGE, encryption: { image: ENC_IMAGE } });
    const throwing = (error: unknown, when: (args: readonly string[]) => boolean) => {
      const deps = buildDeps(root);
      const runCaptured = deps.runCaptured;
      deps.runCaptured = async (command, args, options) => {
        if (when(args)) throw error;
        return runCaptured(command, args, options);
      };
      return deps;
    };
    const missing = new Error('ENOENT: Executable not found in $PATH: "wac"');
    await expect(
      buildComponent(
        loadProject(root),
        captureIo().io,
        throwing(missing, (args) => args[0] === 'compose'),
      ),
    ).rejects.toMatchObject({
      code: 'WASMCLOUD_WAC_REQUIRED',
      exitCode: 3,
      message: expect.stringContaining('wac is required to compose components'),
    });
    // The guest's own provider plug maps the same way, and a spawn code is enough to tell.
    const plain = project({ image: IMAGE });
    const coded = Object.assign(new Error('spawn failed'), { code: 'ENOENT' });
    await expect(
      buildComponent(
        loadProject(plain),
        captureIo().io,
        throwing(coded, (args) => args[0] === 'plug'),
      ),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_WAC_REQUIRED' });
    // Anything else wac throws is left as it is.
    const other = new Error('interrupted');
    await expect(
      buildComponent(
        loadProject(plain),
        captureIo().io,
        throwing(other, (args) => args[0] === 'plug'),
      ),
    ).rejects.toBe(other);
    await expect(
      buildComponent(
        loadProject(plain),
        captureIo().io,
        throwing(null, (args) => args[0] === 'plug'),
      ),
    ).rejects.toBeNull();

    const noJco = buildDeps(root);
    const runCaptured = noJco.runCaptured;
    noJco.runCaptured = async (command, args, options) =>
      args[1] === 'wit'
        ? { exitCode: 1, stdout: '', stderr: "Error: Cannot find module '/fake/jco.js'" }
        : runCaptured(command, args, options);
    await expect(buildComponent(loadProject(root), captureIo().io, noJco)).rejects.toMatchObject({
      code: 'WASMCLOUD_JCO_REQUIRED',
      message: expect.stringContaining(
        'jco is required to read the WIT world of the PGlite provider',
      ),
    });
  });

  it('reports a WIT world it cannot read', async () => {
    const root = project({ image: IMAGE, encryption: { image: ENC_IMAGE } });
    const deps = buildDeps(root);
    const runCaptured = deps.runCaptured;
    deps.runCaptured = async (command, args, options) =>
      args[1] === 'wit' && String(args[2]).endsWith(PGLITE_ENCFS_WASM_FILE)
        ? { exitCode: 1, stdout: '', stderr: 'not a component' }
        : runCaptured(command, args, options);
    await expect(buildComponent(loadProject(root), captureIo().io, deps)).rejects.toMatchObject({
      code: 'WASMCLOUD_COMPONENT_IMPORTS_UNREADABLE',
      message: 'Could not read the WIT world of the PGlite encryption layer: not a component',
    });
  });

  it('changes the deployment digest when only the layer changes, and hashes inputs only', async () => {
    const root = project({ image: IMAGE, encryption: { wasm: 'vendor/encfs.wasm' } });
    const build = () => buildComponent(loadProject(root), captureIo().io, buildDeps(root));
    const layerA = await build();
    expect(await build()).toMatchObject({ deploymentDigest: layerA.deploymentDigest });
    writeFileSync(join(root, 'vendor', 'encfs.wasm'), marked('layer-b'));
    const layerB = await build();
    expect(layerB.deploymentDigest).not.toBe(layerA.deploymentDigest);

    // wac's output is not an input: a different composition leaves the key alone.
    const other = buildDeps(root);
    const runCaptured = other.runCaptured;
    other.runCaptured = async (command, args, options) => {
      const result = await runCaptured(command, args, options);
      if (args[0] === 'compose')
        writeFileSync(args[args.indexOf('-o') + 1] as string, 'a different wac build');
      return result;
    };
    expect((await buildComponent(loadProject(root), captureIo().io, other)).deploymentDigest).toBe(
      layerB.deploymentDigest,
    );
  });
});

describe('pglite encryption interface checks', () => {
  it('reads world imports and exports from jco wit output', () => {
    expect(
      worldInterfaces(
        'package root:component;\n\nworld root {\n  import wasi:filesystem/types@0.2.9;\n  import x: func();\n  export di-framework:pglite/database@0.2.0;\n  export local:pkg/iface;\n}\n',
      ),
    ).toEqual({
      imports: [{ name: 'wasi:filesystem/types', version: '0.2.9' }],
      exports: [
        { name: 'di-framework:pglite/database', version: '0.2.0' },
        { name: 'local:pkg/iface' },
      ],
      unrecognized: ['import x: func();'],
    });
  });

  it('finds the pglite-encfs marker at any depth of a component, and nowhere else', () => {
    expect(encfsSection(marked('a'))).toBe('format=1 codec=aes-256-xts');
    expect(encfsSection(marked('a', false))).toBeUndefined();
    expect(encfsSection(Buffer.from('not wasm at all'))).toBeUndefined();
    // A core module nested in a component, as Rust's #[link_section] places it.
    const inner = marked('core');
    inner[4] = 1;
    inner[6] = 0;
    const nested = Buffer.concat([
      Buffer.from([0, 0x61, 0x73, 0x6d, 0x0d, 0, 0x01, 0]),
      Buffer.from([1, inner.length]),
      inner,
    ]);
    expect(encfsSection(nested)).toBe('format=1 codec=aes-256-xts');
    // A section larger than 127 bytes has a multi-byte LEB128 size.
    const big = Buffer.concat([Buffer.from([3]), Buffer.from('big'), Buffer.alloc(200, 0x61)]);
    const large = Buffer.concat([
      Buffer.from([0, 0x61, 0x73, 0x6d, 0x0d, 0, 0x01, 0]),
      Buffer.from([0, 0x80 | (big.length & 0x7f), big.length >> 7]),
      big,
      marked('after').subarray(8),
    ]);
    expect(encfsSection(large)).toBe('format=1 codec=aes-256-xts');
  });

  it('refuses unrecognized world items and imports outside the host allowlist', () => {
    const layer = { exports: [{ name: 'wasi:filesystem/types', version: '0.2.9' }] };
    const fs = { name: 'wasi:filesystem/types', version: '0.2.9' };
    expect(
      planWiring({ imports: [fs], unrecognized: ['import fs: interface {'] }, layer).problem,
    ).toBe("the provider's world has items the build cannot wire: import fs: interface {");
    expect(
      planWiring(
        {
          imports: [
            fs,
            { name: 'wasi:random/random', version: '0.2.3' },
            { name: 'wasix:filesystem/types', version: '0.2.9' },
          ],
        },
        layer,
      ).problem,
    ).toBe(
      'the layer does not export what the provider imports: wasix:filesystem/types@0.2.9 (neither exported by the layer nor allowed from the host)',
    );
  });

  it('matches versions the way wac does (wac-types are_semver_compatible)', () => {
    for (const [a, b, compatible] of [
      ['0.2.9', '0.2.9', true],
      ['0.2.10', '0.2.9', true],
      ['0.2.8', '0.2.9', true],
      ['0.3.0', '0.2.9', false],
      ['0.0.3', '0.0.2', false],
      ['0.0.2', '0.0.2', true],
      ['1.4.0', '1.2.3', true],
      ['1.1.9', '1.2.3', true],
      ['2.0.0', '1.2.3', false],
      ['0.2.9-rc1', '0.2.9-rc1', true],
      ['0.2.10-rc1', '0.2.9', false],
      ['0.2.10', 'not-semver', false],
      [undefined, undefined, true],
      ['0.2.9', undefined, false],
    ] as const) {
      expect(semverCompatible(a, b)).toBe(compatible);
      expect(semverCompatible(b, a)).toBe(compatible);
    }
  });

  it('plans the wiring: exact names first, then the same semver track', () => {
    const plan = planWiring(
      {
        imports: [
          { name: 'wasi:filesystem/types', version: '0.2.9' },
          { name: 'wasi:io/streams', version: '0.2.9' },
          { name: 'wasi:clocks/wall-clock', version: '0.2.9' },
        ],
      },
      {
        exports: [
          { name: 'wasi:filesystem/types', version: '0.2.12' },
          { name: 'wasi:filesystem/types', version: '0.2.9' },
          { name: 'wasi:io/streams', version: '0.2.12' },
        ],
      },
    );
    expect(plan).toEqual({
      wires: [
        {
          providerImport: 'wasi:filesystem/types@0.2.9',
          layerExport: 'wasi:filesystem/types@0.2.9',
        },
        { providerImport: 'wasi:io/streams@0.2.9', layerExport: 'wasi:io/streams@0.2.12' },
      ],
    });
    expect(
      encryptionComposition(plan.wires, [
        { name: 'di-framework:pglite/database', version: '0.2.0' },
      ]),
    ).toContain('  "wasi:io/streams@0.2.9": layer["wasi:io/streams@0.2.12"],\n  ...\n};');
  });

  it('needs a provider that imports the filesystem', () => {
    expect(
      planWiring({ imports: [{ name: 'wasi:cli/environment', version: '0.2.9' }] }, { exports: [] })
        .problem,
    ).toBe(
      'the provider imports no wasi:filesystem interface, so there is nothing for the layer to encrypt',
    );
  });
});

/**
 * Real `wac compose`, `jco wit` and `wasm-tools print` on small components built from the WAT next
 * to them (`wasm-tools parse <name>.wat -o <name>.wasm`). The stand-in provider imports
 * `wasi:filesystem/{types,preopens}@0.2.9` and `wasi:cli/environment@0.2.9` like PGlite does.
 */
const FIXTURES = join(import.meta.dir, 'fixtures', 'pglite-encryption');
const hasWac = DEFAULT_DEPS.capture('wac', ['--version']) !== undefined;
const hasWasmTools = Bun.which('wasm-tools') !== null;
describe.skipIf(!hasWac || DEFAULT_DEPS.nodeBinaryPath() === undefined)(
  'pglite encryption with real components',
  () => {
    const compose = async (layer: string, provider = 'provider') => {
      const dir = mkdtempSync(join(tmpdir(), 'pglite-encfs-real-'));
      const output = join(dir, 'encrypted.wasm');
      await encryptProvider(
        { projectRoot: dir, applicationName: 'Orders' },
        DEFAULT_DEPS,
        captureIo().io,
        join(FIXTURES, `${provider}.wasm`),
        join(FIXTURES, `${layer}.wasm`),
        output,
      );
      return output;
    };

    /**
     * Where the composed provider instance gets each `wasi:filesystem` import: `layer` when the
     * argument is an alias of the layer instance's export, `host` when it is a root import.
     */
    const filesystemSources = (component: string): Record<string, string> => {
      const printed = Bun.spawnSync(['wasm-tools', 'print', component]).stdout.toString();
      const origin = new Map<string, string>();
      const sources: Record<string, string> = {};
      let inProvider = false;
      for (const line of printed.split('\n')) {
        const imported = /^ {2}\(import "[^"]+" \(instance \(;(\d+);\)/.exec(line);
        if (imported) origin.set(imported[1] as string, 'host');
        const alias = /^ {2}\(alias export \$(\w+) "[^"]+" \(instance \(;(\d+);\)/.exec(line);
        if (alias) origin.set(alias[2] as string, alias[1] as string);
        if (/^ {2}\(instance \$provider /.test(line)) inProvider = true;
        else if (/^ {2}\S/.test(line)) inProvider = false;
        const arg = /\(with "(wasi:filesystem\/[^"]+)" \(instance (\d+)\)\)/.exec(line);
        if (inProvider && arg) sources[arg[1] as string] = origin.get(arg[2] as string) ?? '?';
      }
      return sources;
    };

    it('composes a layer at the same, a newer or an older patch of the same track', async () => {
      for (const layer of ['layer-full', 'layer-newer-patch', 'layer-older-patch']) {
        const output = await compose(layer);
        expect(readFileSync(output).subarray(0, 4).toString('latin1')).toBe('\0asm');
      }
    }, 30_000);

    it.skipIf(!hasWasmTools)(
      "wires the provider's filesystem to the layer instance, never to the root imports",
      async () => {
        expect(filesystemSources(await compose('layer-full'))).toEqual({
          'wasi:filesystem/types@0.2.9': 'layer',
          'wasi:filesystem/preopens@0.2.9': 'layer',
        });
        // The same check sees the bypass `wac plug` produces for a layer of the wrong type.
        const dir = mkdtempSync(join(tmpdir(), 'pglite-encfs-plug-'));
        const plugged = join(dir, 'plugged.wasm');
        const result = Bun.spawnSync([
          'wac',
          'plug',
          '--plug',
          join(FIXTURES, 'layer-typemismatch.wasm'),
          join(FIXTURES, 'provider.wasm'),
          '-o',
          plugged,
        ]);
        expect(result.exitCode).toBe(0);
        const printed = Bun.spawnSync(['wasm-tools', 'print', plugged]).stdout.toString();
        expect(printed).toMatch(/\(with "wasi:filesystem\/types@0\.2\.9" \(instance 0\)\)/);
      },
      30_000,
    );

    it('refuses a layer whose filesystem exports have the right names but the wrong types', async () => {
      await expect(compose('layer-typemismatch')).rejects.toMatchObject({
        code: 'WASMCLOUD_PGLITE_ENCRYPTION_NOT_INTERPOSED',
        exitCode: 3,
        message: expect.stringContaining(
          'wac compose refused the wiring: error: failed to resolve document',
        ),
      });
      await expect(compose('layer-typemismatch')).rejects.toThrow(
        'mismatched instantiation argument `wasi:filesystem/types@0.2.9`',
      );
    }, 30_000);

    it('refuses a layer without the pglite-encfs marker, even one that wires like layer-full', async () => {
      await expect(compose('layer-rawpass')).rejects.toMatchObject({
        code: 'WASMCLOUD_PGLITE_ENCRYPTION_LAYER_UNMARKED',
        exitCode: 3,
        message: expect.stringContaining('has no di-framework:pglite-encfs custom section'),
      });
      expect(await compose('layer-full')).toEndWith('encrypted.wasm');
    }, 30_000);

    it('fails closed on provider imports it cannot wire or allow', async () => {
      await expect(compose('layer-full', 'provider-plain')).rejects.toMatchObject({
        code: 'WASMCLOUD_PGLITE_ENCRYPTION_NOT_INTERPOSED',
        message: expect.stringContaining(
          "the provider's world has items the build cannot wire: import fs: interface {",
        ),
      });
      await expect(compose('layer-full', 'provider-extrafs')).rejects.toThrow(
        'wasi:filesystem/extra@0.2.9 (not exported)',
      );
      await expect(compose('layer-full', 'provider-altpkg')).rejects.toThrow(
        'wasix:filesystem/types@0.2.9 (neither exported by the layer nor allowed from the host)',
      );
      await expect(compose('layer-full', 'provider-twover')).rejects.toThrow(
        'wasi:filesystem/types@0.3.0 (the layer exports @0.2.9)',
      );
    }, 30_000);

    it('refuses a 0.0.z layer that wac would not match', async () => {
      await expect(compose('layer-000', 'provider-000')).rejects.toThrow(
        'the layer does not export what the provider imports: wasi:filesystem/types@0.0.2 (the layer exports @0.0.3)',
      );
    }, 30_000);

    it('refuses a layer that exports only wasi:cli/environment, which wac plug would accept', async () => {
      await expect(compose('layer-env-only')).rejects.toMatchObject({
        code: 'WASMCLOUD_PGLITE_ENCRYPTION_NOT_INTERPOSED',
        message: expect.stringContaining(
          'wasi:filesystem/types@0.2.9 (not exported); wasi:filesystem/preopens@0.2.9 (not exported)',
        ),
      });
    }, 30_000);

    it('refuses a layer missing preopens or exporting an incompatible version', async () => {
      await expect(compose('layer-no-preopens')).rejects.toThrow(
        'the layer does not export what the provider imports: wasi:filesystem/preopens@0.2.9 (not exported)',
      );
      await expect(compose('layer-0.3.0')).rejects.toThrow(
        'wasi:filesystem/types@0.2.9 (the layer exports @0.3.0); wasi:filesystem/preopens@0.2.9 (the layer exports @0.3.0)',
      );
    }, 30_000);
  },
);
