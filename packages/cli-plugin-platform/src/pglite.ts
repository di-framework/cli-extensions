import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, posix, resolve } from 'node:path';
import { type CliIo, CommandFailure } from '@di-framework/cli-extension';
import type { WasmcloudDeps } from './deps';
import { DI_PGLITE_VERSION } from './wit';

export { DI_PGLITE_PACKAGE, DI_PGLITE_VERSION, PGLITE_SOURCE } from './wit';

/**
 * Embedded PostgreSQL provider (`di-framework:pglite`), published by di-framework/platform
 * as `ghcr.io/di-framework/pglite-component`. A guest that imports its `database` interface
 * gets the provider plugged in after componentize; the deployed component is then marked
 * exclusive and given persistent storage, because the engine tolerates exactly one opener
 * of its data directory.
 */
export const PGLITE_REPOSITORY = 'ghcr.io/di-framework/pglite-component';
/** Absolute (or cwd-relative) path of a local provider build; wins over the config. */
export const PGLITE_WASM_ENV = 'DI_FRAMEWORK_PGLITE_WASM';
/** Root of the CLI's download cache. Defaults to `$XDG_CACHE_HOME/di-framework`. */
export const CACHE_DIR_ENV = 'DI_FRAMEWORK_CACHE_DIR';
/** Guest environment entry naming the database root the guest passes to `open`. */
export const PGLITE_DATA_DIR_ENV = 'DI_PGLITE_DATA_DIR';
/**
 * `localResources.config` entry the patched tenant host reads (di-framework/platform#140).
 * Components only: platform admission rejects it on the service.
 */
export const EXCLUSIVE_INSTANCE_KEY = 'di-framework.dev/exclusive-instance';
export const DEFAULT_PGLITE_STORAGE_MOUNT = '/data';
/** File name of the provider inside a cache entry. */
export const PGLITE_WASM_FILE = 'di-framework-pglite.wasm';

const WASM_LAYER_MEDIA_TYPE = 'application/wasm';
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const DIGEST_REFERENCE = /^([a-z0-9]+(?:[.:-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+)@(.+)$/;
const CONFIG_KEYS = ['image', 'wasm', 'storageMount', 'dataDir'];

/** `pglite` in di-framework.config.json, resolved. */
export type PgliteConfig = {
  /** `<repository>@sha256:<hex>`; the manifest digest the platform publish job records. */
  image?: string;
  /** Absolute path of a local provider build, used instead of `image`. */
  wasm?: string;
  /** Guest preopen for the workload's persistent directory. */
  storageMount: string;
  /** Database root the guest opens; at or under `storageMount`. */
  dataDir: string;
};

export type ResolvedPglite = {
  wasm: string;
  source: 'local' | 'cache' | 'registry';
  image?: string;
};

function configInvalid(message: string, configPath: string): never {
  throw new CommandFailure('WASMCLOUD_CONFIG_INVALID', message, 2, { configPath });
}

export function parseDigestReference(reference: string): { repository: string; digest: string } {
  const match = DIGEST_REFERENCE.exec(reference);
  const digest = match?.[2] ?? '';
  if (match === null || !SHA256_DIGEST.test(digest)) {
    throw new Error(
      `"${reference}" is not pinned by digest. Use ${PGLITE_REPOSITORY}@sha256:<64 hex>; tags such as :${DI_PGLITE_VERSION} move`,
    );
  }
  return { repository: match[1] as string, digest };
}

function absoluteGuestPath(value: unknown, label: string, configPath: string): string {
  if (typeof value !== 'string' || !value.startsWith('/'))
    configInvalid(`pglite.${label} must be an absolute guest path`, configPath);
  const normalized = posix.normalize(value);
  return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

/** `image` must be a digest pin and `wasm` a path; at least one of them is required. */
function validateProviderSource(entry: Record<string, unknown>, configPath: string): void {
  if (entry.image !== undefined) {
    if (typeof entry.image !== 'string') configInvalid('pglite.image must be a string', configPath);
    try {
      parseDigestReference(entry.image);
    } catch (error) {
      configInvalid(`pglite.image: ${(error as Error).message}`, configPath);
    }
  }
  if (entry.wasm !== undefined && (typeof entry.wasm !== 'string' || entry.wasm.trim() === ''))
    configInvalid('pglite.wasm must be a non-empty path', configPath);
  if (entry.image === undefined && entry.wasm === undefined)
    configInvalid(
      `pglite needs "image" (${PGLITE_REPOSITORY}@sha256:<digest>) or a local "wasm" path`,
      configPath,
    );
}

/** True when `path` is `directory` or below it (both normalized guest paths). */
export function isWithin(path: string, directory: string): boolean {
  return path === directory || path.startsWith(directory === '/' ? '/' : `${directory}/`);
}

/** Validates `pglite` from the config. `resolveFile` keeps `wasm` inside the project. */
export function parsePgliteConfig(
  value: unknown,
  configPath: string,
  resolveFile: (path: string) => string,
): PgliteConfig | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    configInvalid('pglite must be an object', configPath);
  const entry = value as Record<string, unknown>;
  const unknown = Object.keys(entry).filter((key) => !CONFIG_KEYS.includes(key));
  if (unknown.length > 0)
    configInvalid(
      `pglite has unsupported fields: ${unknown.join(', ')}. Use ${CONFIG_KEYS.join(', ')}`,
      configPath,
    );
  validateProviderSource(entry, configPath);
  const storageMount =
    entry.storageMount === undefined
      ? DEFAULT_PGLITE_STORAGE_MOUNT
      : absoluteGuestPath(entry.storageMount, 'storageMount', configPath);
  const dataDir =
    entry.dataDir === undefined
      ? posix.join(storageMount, 'pglite')
      : absoluteGuestPath(entry.dataDir, 'dataDir', configPath);
  if (!isWithin(dataDir, storageMount))
    configInvalid(
      `pglite.dataDir ${dataDir} must be inside storageMount ${storageMount}; only that directory is persistent`,
      configPath,
    );
  return {
    ...(entry.image === undefined ? {} : { image: entry.image as string }),
    ...(entry.wasm === undefined ? {} : { wasm: resolveFile(entry.wasm as string) }),
    storageMount,
    dataDir,
  };
}

export function cacheRoot(env: Record<string, string | undefined>): string {
  const explicit = env[CACHE_DIR_ENV]?.trim();
  if (explicit) return resolve(explicit);
  const xdg = env.XDG_CACHE_HOME?.trim();
  return xdg ? join(xdg, 'di-framework') : join(env.HOME ?? homedir(), '.cache', 'di-framework');
}

/** Where a digest-pinned provider is cached: `<cache>/oci/sha256/<hex>/`. */
export function cacheEntry(env: Record<string, string | undefined>, digest: string): string {
  return join(cacheRoot(env), 'oci', 'sha256', digest.slice('sha256:'.length));
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function failure(
  code: string,
  message: string,
  details: Record<string, string> = {},
): CommandFailure {
  return new CommandFailure(code, message, 3, details);
}

/**
 * The manifest bytes must hash to the pinned digest; then the single `application/wasm`
 * layer names the blob digest the provider bytes must hash to.
 */
export function verifyManifest(bytes: Uint8Array, image: string): string {
  const { digest } = parseDigestReference(image);
  const actual = sha256(bytes);
  if (actual !== digest)
    throw failure(
      'WASMCLOUD_PGLITE_DIGEST_MISMATCH',
      `Manifest pulled for ${image} hashes to ${actual}, not the pinned ${digest}`,
      { image, expected: digest, actual },
    );
  let manifest: { manifests?: unknown; layers?: Array<{ mediaType?: unknown; digest?: unknown }> };
  try {
    manifest = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw failure('WASMCLOUD_PGLITE_MANIFEST_INVALID', `Manifest for ${image} is not JSON`, {
      image,
    });
  }
  if (manifest.manifests !== undefined)
    throw failure(
      'WASMCLOUD_PGLITE_MANIFEST_INVALID',
      `${image} is an image index; pin the digest of the wasm artifact manifest instead`,
      { image },
    );
  const layers = (manifest.layers ?? []).filter(
    (layer) => layer.mediaType === WASM_LAYER_MEDIA_TYPE,
  );
  const layer = layers[0];
  if (layers.length !== 1 || typeof layer?.digest !== 'string' || !SHA256_DIGEST.test(layer.digest))
    throw failure(
      'WASMCLOUD_PGLITE_MANIFEST_INVALID',
      `Manifest for ${image} must have exactly one ${WASM_LAYER_MEDIA_TYPE} layer with a sha256 digest`,
      { image },
    );
  return layer.digest;
}

export function verifyLayer(bytes: Uint8Array, image: string, layerDigest: string): void {
  const actual = sha256(bytes);
  if (actual !== layerDigest)
    throw failure(
      'WASMCLOUD_PGLITE_DIGEST_MISMATCH',
      `Provider layer of ${image} hashes to ${actual}, not ${layerDigest} from its manifest`,
      { image, expected: layerDigest, actual },
    );
  if (
    bytes.length < 4 ||
    bytes[0] !== 0 ||
    bytes[1] !== 0x61 ||
    bytes[2] !== 0x73 ||
    bytes[3] !== 0x6d
  )
    throw failure(
      'WASMCLOUD_PGLITE_MANIFEST_INVALID',
      `Provider layer of ${image} is not a WebAssembly binary`,
      { image },
    );
}

function verifyCacheEntry(directory: string, image: string): boolean {
  const manifestPath = join(directory, 'manifest.json');
  const wasmPath = join(directory, PGLITE_WASM_FILE);
  if (!existsSync(manifestPath) || !existsSync(wasmPath)) return false;
  try {
    verifyLayer(readFileSync(wasmPath), image, verifyManifest(readFileSync(manifestPath), image));
    return true;
  } catch {
    return false;
  }
}

async function oras(
  deps: WasmcloudDeps,
  args: string[],
  image: string,
  cwd: string,
): Promise<void> {
  const result = await deps.runCaptured('oras', args, { cwd });
  if (result.exitCode === 0) return;
  const reason = (result.stderr || result.stdout).trim();
  const detail = reason ? `: ${reason}` : '';
  throw failure(
    'WASMCLOUD_PGLITE_PULL_FAILED',
    `oras ${args.slice(0, 2).join(' ')} failed for ${image}${detail}. ` +
      `If the package is private, run \`oras login ghcr.io\`; offline, set ${PGLITE_WASM_ENV} or pglite.wasm`,
    { image, exitCode: String(result.exitCode) },
  );
}

/**
 * Pulls the provider by digest with `oras`, verifying the manifest digest and the layer
 * digest, into the cache. A cached entry is re-verified on every use; a corrupt one is
 * pulled again.
 */
export async function pullPgliteComponent(
  image: string,
  io: CliIo,
  deps: WasmcloudDeps,
  cwd: string,
): Promise<ResolvedPglite> {
  const { repository, digest } = parseDigestReference(image);
  const entry = cacheEntry(deps.env, digest);
  const wasm = join(entry, PGLITE_WASM_FILE);
  if (verifyCacheEntry(entry, image)) {
    io.stdout.write(`Using cached ${image}\n`);
    return { wasm, source: 'cache', image };
  }
  if (existsSync(entry)) {
    io.stderr.write(`Cached ${image} failed verification; pulling it again\n`);
    rmSync(entry, { recursive: true, force: true });
  }
  if (deps.capture('oras', ['version']) === undefined)
    throw failure(
      'WASMCLOUD_ORAS_REQUIRED',
      `oras is required to pull ${image}; install it from https://oras.land or set ${PGLITE_WASM_ENV} to a local provider build`,
      { image, tool: 'oras' },
    );
  const root = cacheRoot(deps.env);
  mkdirSync(root, { recursive: true });
  const staging = mkdtempSync(join(root, '.pull-'));
  try {
    io.stdout.write(`Pulling ${image}...\n`);
    const manifestPath = join(staging, 'manifest.json');
    await oras(deps, ['manifest', 'fetch', '--output', manifestPath, image], image, cwd);
    const layerDigest = verifyManifest(readFileSync(manifestPath), image);
    const stagedWasm = join(staging, PGLITE_WASM_FILE);
    await oras(
      deps,
      ['blob', 'fetch', '--output', stagedWasm, `${repository}@${layerDigest}`],
      image,
      cwd,
    );
    verifyLayer(readFileSync(stagedWasm), image, layerDigest);
    mkdirSync(join(entry, '..'), { recursive: true });
    try {
      renameSync(staging, entry);
    } catch (error) {
      // A concurrent build sharing the cache may have stored the same digest first.
      if (!verifyCacheEntry(entry, image)) throw error;
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return { wasm, source: 'registry', image };
}

/**
 * The provider to compose: `DI_FRAMEWORK_PGLITE_WASM`, then `pglite.wasm`, then the
 * digest-pinned `pglite.image`. Local files are not checked against the digest.
 */
export async function resolvePgliteComponent(
  config: PgliteConfig,
  io: CliIo,
  deps: WasmcloudDeps,
  projectRoot: string,
): Promise<ResolvedPglite> {
  const fromEnv = deps.env[PGLITE_WASM_ENV]?.trim();
  const local = fromEnv ? resolve(deps.cwd(), fromEnv) : config.wasm;
  if (local !== undefined) {
    if (!existsSync(local))
      throw failure(
        'WASMCLOUD_PGLITE_PROVIDER_MISSING',
        `PGlite provider ${local} (from ${fromEnv ? PGLITE_WASM_ENV : 'pglite.wasm'}) does not exist`,
        { path: local },
      );
    const replaced = config.image ? ` instead of ${config.image}` : '';
    io.stdout.write(`Using local PGlite provider ${local}${replaced}\n`);
    return { wasm: local, source: 'local' };
  }
  return pullPgliteComponent(config.image as string, io, deps, projectRoot);
}
