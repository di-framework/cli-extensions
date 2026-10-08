import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parsePackageId, type WitRequirement } from './wit';

/**
 * A dependency that ships a WebAssembly component the guest imports by WIT
 * name. Declared in the dependency's package.json:
 *
 * ```json
 * "component": {
 *   "package": "pqc-subtle:crypto@0.1.0",
 *   "wasm": "component/pqc-subtle.wasm",
 *   "wit": "component/wit",
 *   "interfaces": ["ml-kem", "ml-dsa", "argon2"]
 * }
 * ```
 *
 * The build copies the WIT into the guest world's deps, keeps the package's
 * specifiers external in the bundle, adds the interfaces the bundle imports to
 * the world, and plugs the binary in after componentize. Only direct
 * dependencies of the project are considered.
 */
export type ComponentProvider = {
  /** npm package name, for messages and the requirement source. */
  dependency: string;
  /** WIT package id, e.g. `pqc-subtle:crypto`. */
  package: string;
  version: string;
  /** Interfaces the package exports, from the manifest or parsed from the WIT. */
  interfaces: string[];
  /** Absolute path of the component binary. */
  wasm: string;
  /** Absolute path of the WIT directory. */
  wit: string;
};

type Manifest = {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  component?: {
    package?: unknown;
    wasm?: unknown;
    wit?: unknown;
    interfaces?: unknown;
  };
};

function readManifest(path: string): Manifest | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
  } catch {
    return undefined;
  }
}

/** `node_modules/<name>/package.json`, searching upward from `from` (workspaces hoist). */
function findDependencyManifest(name: string, from: string): string | undefined {
  const candidates: string[] = [];
  for (let directory = resolve(from); ; directory = dirname(directory)) {
    candidates.push(join(directory, 'node_modules', name, 'package.json'));
    if (dirname(directory) === directory) break;
  }
  return candidates.find((candidate) => existsSync(candidate));
}

function interfacesFromWit(witDirectory: string): string[] {
  const names: string[] = [];
  for (const file of witFiles(witDirectory)) {
    for (const match of readFileSync(file, 'utf8').matchAll(
      /^\s*interface\s+([a-z][a-z0-9-]*)/gm,
    )) {
      const name = match[1] ?? '';
      if (name && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

function witFiles(witDirectory: string): string[] {
  if (!existsSync(witDirectory)) return [];
  return readdirSync(witDirectory)
    .filter((entry) => entry.endsWith('.wit'))
    .sort()
    .map((entry) => join(witDirectory, entry));
}

function providerFromManifest(
  dependency: string,
  manifestPath: string,
  manifest: Manifest,
): ComponentProvider | undefined {
  const declared = manifest.component;
  if (
    declared === undefined ||
    typeof declared.package !== 'string' ||
    typeof declared.wasm !== 'string' ||
    typeof declared.wit !== 'string'
  ) {
    return undefined;
  }
  const packageDirectory = dirname(manifestPath);
  const at = declared.package.lastIndexOf('@');
  if (at <= 0) {
    throw new Error(
      `Dependency ${dependency} declares component package "${declared.package}" without a version`,
    );
  }
  const id = declared.package.slice(0, at);
  parsePackageId(id);
  const absolute = (path: string) => (isAbsolute(path) ? path : join(packageDirectory, path));
  const wit = absolute(declared.wit);
  const interfaces = Array.isArray(declared.interfaces)
    ? declared.interfaces.filter((entry): entry is string => typeof entry === 'string')
    : interfacesFromWit(wit);
  return {
    dependency,
    package: id,
    version: declared.package.slice(at + 1),
    interfaces,
    wasm: absolute(declared.wasm),
    wit,
  };
}

/** Component providers among the project's direct dependencies, by dependency name. */
export function discoverComponentProviders(projectRoot: string): ComponentProvider[] {
  const manifest = readManifest(join(projectRoot, 'package.json'));
  if (manifest === undefined) return [];
  const names = Object.keys({
    ...(manifest.dependencies ?? {}),
    ...(manifest.optionalDependencies ?? {}),
  }).sort();
  const providers: ComponentProvider[] = [];
  for (const name of names) {
    const path = findDependencyManifest(name, projectRoot);
    if (path === undefined) continue;
    const dependencyManifest = readManifest(path);
    if (dependencyManifest === undefined) continue;
    const provider = providerFromManifest(name, path, dependencyManifest);
    if (provider !== undefined) providers.push(provider);
  }
  return providers;
}

/** WIT namespaces whose module specifiers the bundler must leave external. */
export function providerNamespaces(providers: readonly ComponentProvider[]): string[] {
  const namespaces = new Set<string>();
  for (const provider of providers) namespaces.add(parsePackageId(provider.package).namespace);
  return [...namespaces].sort();
}

/** Directory name under `wit/deps` for a provider's package. */
export function providerDepsDirectory(provider: ComponentProvider): string {
  const { namespace, name } = parsePackageId(provider.package);
  return `${namespace}-${name}`;
}

/**
 * Copies each provider's WIT into the generated deps directory. A single file
 * is written as `package.wit`, which is what the lock reads; several files are
 * copied by name.
 */
export function copyProviderWit(
  providers: readonly ComponentProvider[],
  depsDirectory: string,
): void {
  for (const provider of providers) {
    const files = witFiles(provider.wit);
    if (files.length === 0) {
      throw new Error(
        `Dependency ${provider.dependency} declares WIT at ${provider.wit} but no .wit file is there`,
      );
    }
    const target = join(depsDirectory, providerDepsDirectory(provider));
    mkdirSync(target, { recursive: true });
    if (files.length === 1) {
      writeFileSync(join(target, 'package.wit'), readFileSync(files[0] as string));
      continue;
    }
    for (const file of files)
      writeFileSync(join(target, file.slice(provider.wit.length + 1)), readFileSync(file));
  }
}

/**
 * Import requirements for the provider interfaces the bundled JavaScript
 * references. A `types` interface comes along whenever any sibling does, as
 * the functions' signatures use it.
 */
export function providerRequirementsFromJavaScript(
  source: string,
  providers: readonly ComponentProvider[],
): WitRequirement[] {
  const requirements: WitRequirement[] = [];
  for (const provider of providers) {
    const used = provider.interfaces.filter((iface) =>
      source.includes(`${provider.package}/${iface}@${provider.version}`),
    );
    if (used.length === 0) continue;
    const interfaces =
      provider.interfaces.includes('types') && !used.includes('types') ? ['types', ...used] : used;
    requirements.push({
      package: provider.package,
      version: provider.version,
      interfaces,
      direction: 'import',
      source: `component:${provider.dependency}`,
    });
  }
  return requirements;
}

/** Providers whose package the requirements import, in discovery order. */
export function providersToCompose(
  providers: readonly ComponentProvider[],
  requirements: readonly WitRequirement[],
): ComponentProvider[] {
  return providers.filter((provider) =>
    requirements.some(
      (requirement) =>
        requirement.direction === 'import' &&
        requirement.package === provider.package &&
        requirement.version === provider.version,
    ),
  );
}
