import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, posix, resolve } from 'node:path';
import { type CliIo, CommandFailure } from '@di-framework/cli-extension';
import type { WasmcloudDeps } from './deps';
import { captureKubectl } from './kubernetes';
import type { ClusterConnection } from './target';
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
  /** Verified provider bytes; the build plugs a private copy of these. */
  bytes: Buffer;
  source: 'local' | 'cache' | 'registry';
  /** The digest pin, when the bytes came from the registry or the cache. */
  image?: string;
  /** The local file, when the bytes came from one. */
  path?: string;
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

function isWasm(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0 &&
    bytes[1] === 0x61 &&
    bytes[2] === 0x73 &&
    bytes[3] === 0x6d
  );
}

export function verifyLayer(bytes: Uint8Array, image: string, layerDigest: string): void {
  const actual = sha256(bytes);
  if (actual !== layerDigest)
    throw failure(
      'WASMCLOUD_PGLITE_DIGEST_MISMATCH',
      `Provider layer of ${image} hashes to ${actual}, not ${layerDigest} from its manifest`,
      { image, expected: layerDigest, actual },
    );
  if (!isWasm(bytes))
    throw failure(
      'WASMCLOUD_PGLITE_MANIFEST_INVALID',
      `Provider layer of ${image} is not a WebAssembly binary`,
      { image },
    );
}

/** The verified provider bytes of a cache entry, or undefined when it is absent or stale. */
function readVerifiedEntry(directory: string, image: string): Buffer | undefined {
  const manifestPath = join(directory, 'manifest.json');
  const wasmPath = join(directory, PGLITE_WASM_FILE);
  if (!existsSync(manifestPath) || !existsSync(wasmPath)) return undefined;
  try {
    const bytes = readFileSync(wasmPath);
    verifyLayer(bytes, image, verifyManifest(readFileSync(manifestPath), image));
    return bytes;
  } catch {
    return undefined;
  }
}

/** Staging directories older than this were left by a killed build and are removed. */
export const STALE_STAGING_MS = 24 * 60 * 60 * 1000;

function sweepStaleStaging(root: string, now: number): void {
  for (const name of readdirSync(root)) {
    if (!name.startsWith('.pull-')) continue;
    const path = join(root, name);
    try {
      if (now - statSync(path).mtimeMs > STALE_STAGING_MS)
        rmSync(path, { recursive: true, force: true });
    } catch {
      // Another build removed it first.
    }
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
 * Stores a verified staging directory as the cache entry. A concurrent build may have
 * stored the same digest first; its entry is used when it verifies.
 */
function storeEntry(staging: string, entry: string, image: string, bytes: Buffer): Buffer {
  mkdirSync(join(entry, '..'), { recursive: true });
  try {
    renameSync(staging, entry);
    return bytes;
  } catch (error) {
    const winner = readVerifiedEntry(entry, image);
    if (winner !== undefined) return winner;
    throw failure(
      'WASMCLOUD_PGLITE_CACHE_CONFLICT',
      `Could not store ${image} in the cache at ${entry} (${(error as NodeJS.ErrnoException).code ?? 'unknown error'}), ` +
        `and the entry there does not verify; remove ${entry} and retry`,
      { image, entry },
    );
  }
}

/**
 * Pulls the provider by digest with `oras`, verifying the manifest digest and the layer
 * digest, into the cache. A cached entry is re-verified on every use; a corrupt one is
 * pulled again. Returns the verified bytes, so later readers never see a swapped file.
 */
export async function pullPgliteComponent(
  image: string,
  io: CliIo,
  deps: WasmcloudDeps,
  cwd: string,
): Promise<ResolvedPglite> {
  const { repository, digest } = parseDigestReference(image);
  const entry = cacheEntry(deps.env, digest);
  const cached = readVerifiedEntry(entry, image);
  if (cached !== undefined) {
    io.stdout.write(`Using cached ${image}\n`);
    return { bytes: cached, source: 'cache', image };
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
  sweepStaleStaging(root, Date.now());
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
    const bytes = readFileSync(stagedWasm);
    verifyLayer(bytes, image, layerDigest);
    return { bytes: storeEntry(staging, entry, image, bytes), source: 'registry', image };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Set to `1` to let `deploy` or a CI build use a local, unverified provider. */
export const ALLOW_LOCAL_PGLITE_ENV = 'DI_FRAMEWORK_ALLOW_LOCAL_PGLITE';

export type ResolvePgliteOptions = {
  /** A deploy ships the provider, so a local file needs the explicit opt-in. */
  deploy?: boolean;
};

function readLocalProvider(
  local: string,
  origin: string,
  config: PgliteConfig,
  io: CliIo,
  deps: WasmcloudDeps,
  options: ResolvePgliteOptions,
): ResolvedPglite {
  if (!existsSync(local))
    throw failure(
      'WASMCLOUD_PGLITE_PROVIDER_MISSING',
      `PGlite provider ${local} (from ${origin}) does not exist`,
      { path: local },
    );
  let context: string | undefined;
  if (options.deploy) context = 'deploy';
  else if (deps.env.CI) context = 'CI';
  if (context !== undefined && deps.env[ALLOW_LOCAL_PGLITE_ENV] !== '1')
    throw failure(
      'WASMCLOUD_PGLITE_LOCAL_REFUSED',
      `Refusing the unverified local PGlite provider ${local} (from ${origin}) in ${context}; ` +
        `pin "pglite.image" by digest, or set ${ALLOW_LOCAL_PGLITE_ENV}=1 to use it anyway`,
      { path: local, context },
    );
  const bytes = readFileSync(local);
  if (!isWasm(bytes))
    throw failure(
      'WASMCLOUD_PGLITE_PROVIDER_INVALID',
      `PGlite provider ${local} (from ${origin}) is not a WebAssembly binary`,
      { path: local },
    );
  const replaced = config.image ? ` instead of the pinned ${config.image}` : '';
  io.stderr.write(
    `Warning: using the local, unverified PGlite provider ${local} (from ${origin})${replaced}\n`,
  );
  return { bytes, source: 'local', path: local };
}

/**
 * The provider to compose: `DI_FRAMEWORK_PGLITE_WASM`, then `pglite.wasm`, then the
 * digest-pinned `pglite.image`. Local files are only checked to be WebAssembly, and are
 * refused in a deploy or on CI without `DI_FRAMEWORK_ALLOW_LOCAL_PGLITE=1`.
 */
export async function resolvePgliteComponent(
  config: PgliteConfig,
  io: CliIo,
  deps: WasmcloudDeps,
  projectRoot: string,
  options: ResolvePgliteOptions = {},
): Promise<ResolvedPglite> {
  const fromEnv = deps.env[PGLITE_WASM_ENV]?.trim();
  if (fromEnv)
    return readLocalProvider(
      resolve(deps.cwd(), fromEnv),
      PGLITE_WASM_ENV,
      config,
      io,
      deps,
      options,
    );
  if (config.wasm !== undefined)
    return readLocalProvider(config.wasm, 'pglite.wasm', config, io, deps, options);
  return pullPgliteComponent(config.image as string, io, deps, projectRoot);
}

/**
 * Members of one workload share one storage directory, mounted at each member's own
 * `storageMount`. Two members whose `dataDir` is the same path relative to their mount
 * would open the same database from separate instances, which exclusivity cannot stop.
 */
export function assertDistinctPgliteRoots(
  workload: string,
  members: Iterable<{ applicationName: string; workload?: string; pglite?: PgliteConfig }>,
): void {
  const owners = new Map<string, string>();
  for (const member of members) {
    if (member.workload !== workload || member.pglite === undefined) continue;
    const root = posix.relative(member.pglite.storageMount, member.pglite.dataDir);
    const previous = owners.get(root);
    if (previous !== undefined)
      throw new CommandFailure(
        'WASMCLOUD_PGLITE_DATA_DIR_CONFLICT',
        `${workload}: ${previous} and ${member.applicationName} would open the same PGlite database ` +
          `(<workload storage>/${root || '.'}); members share one storage directory, so give each a different dataDir relative to its storageMount`,
        2,
        { workload, root },
      );
    owners.set(root, member.applicationName);
  }
}

/** Tag fragment of the tenant host image that honours the exclusive opt-in (#140). */
export const EXCLUSIVE_HOST_IMAGE_MARKER = '-exclusive';

function hasExclusiveTag(image: string): boolean {
  const tag = image.split('@')[0]?.split('/').pop()?.split(':')[1];
  return tag?.includes(EXCLUSIVE_HOST_IMAGE_MARKER) === true;
}

async function hostImages(
  connection: ClusterConnection,
  hostgroup: string,
  deps: WasmcloudDeps,
  cwd: string,
): Promise<string[] | undefined> {
  const runtime = { ...connection, namespace: `di-runtime-${hostgroup.slice('tenant-'.length)}` };
  const result = await captureKubectl(
    deps,
    runtime,
    ['get', 'pods', '-l', `wasmcloud.com/hostgroup=${hostgroup}`, '-o', 'json'],
    cwd,
  );
  if (result.exitCode !== 0) return undefined;
  try {
    const list = JSON.parse(result.stdout) as {
      items?: { spec?: { containers?: { image?: string }[] } }[];
    };
    return (list.items ?? []).flatMap((pod) =>
      (pod.spec?.containers ?? []).flatMap((container) =>
        typeof container.image === 'string' ? [container.image] : [],
      ),
    );
  } catch {
    return undefined;
  }
}

/**
 * Stock wash ignores `di-framework.dev/exclusive-instance`: when its pool saturates or an
 * instance drains, it builds a second store, which opens the same data directory. Warn when
 * a tenant host group's image is not the exclusive build; elsewhere the CLI cannot see the
 * host, so say what the opt-in depends on.
 */
export async function warnIfHostIgnoresExclusive(
  project: { applicationName: string; projectRoot: string; pglite?: PgliteConfig },
  connection: ClusterConnection,
  io: CliIo,
  deps: WasmcloudDeps,
): Promise<void> {
  if (project.pglite === undefined) return;
  const risk =
    'Without it a second instance can open the same PGlite data directory and corrupt it';
  const hostgroup = connection.hostgroup;
  if (!hostgroup?.startsWith('tenant-')) {
    const group = hostgroup ?? connection.storageHostgroup ?? 'storage';
    io.stderr.write(
      `Note: ${project.applicationName} embeds PGlite and is marked exclusive; host group ${group} ` +
        `must run a wash image built with the exclusive patch (tagged *${EXCLUSIVE_HOST_IMAGE_MARKER}). ${risk}.\n`,
    );
    return;
  }
  const images = await hostImages(connection, hostgroup, deps, project.projectRoot);
  if (images?.some(hasExclusiveTag)) return;
  const seen =
    images === undefined || images.length === 0
      ? 'could not read its host image'
      : `runs ${images[0]}`;
  io.stderr.write(
    `Warning: ${project.applicationName} embeds PGlite and is marked exclusive, but host group ${hostgroup} ` +
      `${seen}, which does not look like the exclusive build (tagged *${EXCLUSIVE_HOST_IMAGE_MARKER}, set with the platform's tenantHostImage). ${risk}.\n`,
  );
}
