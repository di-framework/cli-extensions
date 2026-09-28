import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Component-model / WASI preview the guest targets. Independent of any package version. */
export const COMPONENT_MODEL = '0.3';

export const HTTP_ADAPTER_SOURCE = 'http-adapter';
export const NODE_COMPAT_SOURCE = 'node-compat';
export const WASI_HTTP_PACKAGE = 'wasi:http';
export const WASI_HTTP_VERSION = '0.3.0';
export const WASI_HTTP_INTERFACE = 'handler';
export const WASI_SOCKETS_PACKAGE = 'wasi:sockets';
export const WASI_SOCKETS_VERSION = '0.3.0';
export const WASI_RANDOM_PACKAGE = 'wasi:random';
export const WASI_RANDOM_VERSION = '0.3.0';
export const QUEUE_ADAPTER_SOURCE = 'queue-adapter';
export const DI_QUEUES_PACKAGE = 'di-framework:queues';
export const DI_QUEUES_VERSION = '0.1.0';
export const DI_QUEUES_INTERFACE = 'dispatch';
export const DI_SQLITE_PACKAGE = 'di-framework:sqlite';
export const DI_SQLITE_VERSION = '0.1.0';
export const DI_SQLITE_INTERFACE = 'database';
export const DI_SQLITE_TYPES_INTERFACE = 'types';
export const SQLITE_SOURCE = 'sqlite-backend';

export type WitDirection = 'import' | 'export';

/**
 * One adapter or binding's WIT needs. A requirement is an interface group:
 * `interfaces` share resource identity and become one hostInterfaces entry.
 */
export type WitRequirement = {
  package: string;
  version: string;
  interfaces: string[];
  direction: WitDirection;
  instanceName?: string;
  namedImport?: boolean;
  source: string;
};

export type AggregatedRequirement = WitRequirement & { sources: string[] };

export type WitPackageLock = {
  id: string;
  version: string;
  source: 'bundled';
  path: string;
  digest: string;
};

export type WitLock = {
  schemaVersion: 1;
  componentModel: string;
  world: string;
  requirements: AggregatedRequirement[];
  packages: WitPackageLock[];
};

export const HTTP_ADAPTER_REQUIREMENTS: WitRequirement[] = [
  {
    package: WASI_HTTP_PACKAGE,
    version: WASI_HTTP_VERSION,
    interfaces: [WASI_HTTP_INTERFACE],
    direction: 'export',
    source: HTTP_ADAPTER_SOURCE,
  },
];

/** Default guest world: the HTTP adapter only. Bindings later concat onto this list. */
export function defaultProjectRequirements(): WitRequirement[] {
  return HTTP_ADAPTER_REQUIREMENTS.map((requirement) => ({ ...requirement }));
}

export const QUEUE_ADAPTER_REQUIREMENTS: WitRequirement[] = [
  {
    package: DI_QUEUES_PACKAGE,
    version: DI_QUEUES_VERSION,
    interfaces: [DI_QUEUES_INTERFACE],
    direction: 'export',
    source: QUEUE_ADAPTER_SOURCE,
  },
];

export const SQLITE_IMPORT_REQUIREMENTS: WitRequirement[] = [
  {
    package: DI_SQLITE_PACKAGE,
    version: DI_SQLITE_VERSION,
    interfaces: [DI_SQLITE_TYPES_INTERFACE, DI_SQLITE_INTERFACE],
    direction: 'import',
    source: SQLITE_SOURCE,
  },
];

/** Queue workers are long-lived HTTP services with SQLite-backed persistence. */
export function queueProjectRequirements(): WitRequirement[] {
  return [
    ...defaultProjectRequirements(),
    ...SQLITE_IMPORT_REQUIREMENTS.map((requirement) => ({ ...requirement })),
  ];
}

export function sqliteProjectRequirements(): WitRequirement[] {
  return SQLITE_IMPORT_REQUIREMENTS.map((requirement) => ({ ...requirement }));
}

/**
 * Runtime WASI pulled in by Node overlays (`node:net`/`dgram` → sockets,
 * `node:crypto` → random). Only added to the guest world when the bundled JS
 * actually imports those specifiers.
 */
export function runtimeRequirementsFromJavaScript(source: string): WitRequirement[] {
  const requirements: WitRequirement[] = [];
  if (source.includes('wasi:tls/client@0.3.0-draft')) {
    requirements.push({
      package: 'wasi:tls',
      version: '0.3.0-draft',
      interfaces: ['client', 'types'],
      direction: 'import',
      source: NODE_COMPAT_SOURCE,
    });
  }
  const socketInterfaces: string[] = [];
  if (source.includes(`${WASI_SOCKETS_PACKAGE}/types@${WASI_SOCKETS_VERSION}`)) {
    socketInterfaces.push('types');
  }
  if (source.includes(`${WASI_SOCKETS_PACKAGE}/ip-name-lookup@${WASI_SOCKETS_VERSION}`)) {
    socketInterfaces.push('ip-name-lookup');
  }
  if (socketInterfaces.length > 0) {
    requirements.push({
      package: WASI_SOCKETS_PACKAGE,
      version: WASI_SOCKETS_VERSION,
      interfaces: socketInterfaces,
      direction: 'import',
      source: NODE_COMPAT_SOURCE,
    });
  }
  if (source.includes(`${WASI_RANDOM_PACKAGE}/random@${WASI_RANDOM_VERSION}`)) {
    requirements.push({
      package: WASI_RANDOM_PACKAGE,
      version: WASI_RANDOM_VERSION,
      interfaces: ['random'],
      direction: 'import',
      source: NODE_COMPAT_SOURCE,
    });
  }
  if (source.includes('wasi:clocks/monotonic-clock@0.3.0')) {
    requirements.push({
      package: 'wasi:clocks',
      version: '0.3.0',
      interfaces: ['monotonic-clock'],
      direction: 'import',
      source: NODE_COMPAT_SOURCE,
    });
  }
  if (source.includes('wasi:cli/environment@0.3.0')) {
    requirements.push({
      package: 'wasi:cli',
      version: '0.3.0',
      interfaces: ['environment'],
      direction: 'import',
      source: NODE_COMPAT_SOURCE,
    });
  }
  if (source.includes(`${DI_SQLITE_PACKAGE}/${DI_SQLITE_INTERFACE}@${DI_SQLITE_VERSION}`)) {
    requirements.push({
      package: DI_SQLITE_PACKAGE,
      version: DI_SQLITE_VERSION,
      interfaces: [DI_SQLITE_TYPES_INTERFACE, DI_SQLITE_INTERFACE],
      direction: 'import',
      source: SQLITE_SOURCE,
    });
  }
  return requirements;
}

/** @deprecated Use {@link runtimeRequirementsFromJavaScript}. */
export function socketRequirementsFromJavaScript(source: string): WitRequirement[] {
  return runtimeRequirementsFromJavaScript(source);
}

export function parsePackageId(id: string): { namespace: string; name: string } {
  const separator = id.indexOf(':');
  if (separator <= 0 || separator === id.length - 1) {
    throw new Error(`Invalid WIT package id "${id}"`);
  }
  return { namespace: id.slice(0, separator), name: id.slice(separator + 1) };
}

function requirementKey(requirement: WitRequirement): string {
  return [
    requirement.direction,
    requirement.package,
    requirement.version,
    requirement.instanceName ?? '',
  ].join('\0');
}

/** Merge interface groups that share package, version, direction, and instance name. */
export function aggregateRequirements(
  requirements: readonly WitRequirement[],
): AggregatedRequirement[] {
  const groups = new Map<string, AggregatedRequirement>();
  for (const requirement of requirements) {
    if (requirement.interfaces.length === 0) continue;
    const key = requirementKey(requirement);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        ...requirement,
        interfaces: [...requirement.interfaces],
        sources: [requirement.source],
      });
      continue;
    }
    for (const iface of requirement.interfaces) {
      if (!existing.interfaces.includes(iface)) existing.interfaces.push(iface);
    }
    if (!existing.sources.includes(requirement.source)) existing.sources.push(requirement.source);
  }
  return [...groups.values()];
}

function importClause(requirement: AggregatedRequirement, iface: string): string {
  const { namespace, name } = parsePackageId(requirement.package);
  const target = `${namespace}:${name}/${iface}@${requirement.version}`;
  if (requirement.direction === 'export') return `export ${target};`;
  if (requirement.namedImport && requirement.instanceName)
    return `import ${requirement.instanceName}: ${target};`;
  // Legacy bindings retain their unlabeled imports.
  // qjs previously could not encode `import name: pkg/iface` (cm-implements). Named instances
  // still appear on hostInterfaces; the guest world is unlabeled.
  return `import ${target};`;
}

export function renderWorldWit(
  packageName: string,
  version: string,
  requirements: readonly WitRequirement[],
): string {
  const lines = [`package local:${packageName}@${version};`, '', 'world application {'];
  const seen = new Set<string>();
  for (const requirement of aggregateRequirements(requirements)) {
    for (const iface of requirement.interfaces) {
      const clause = importClause(requirement, iface);
      if (seen.has(clause)) continue;
      seen.add(clause);
      lines.push(`  ${clause}`);
    }
  }
  lines.push('}', '');
  return lines.join('\n');
}

function packageIdFromWit(contents: string): { id: string; version: string } | undefined {
  const match = contents.match(/^package\s+([a-z][a-z0-9-]*:[a-z][a-z0-9-]*)@([0-9][^;\s]*)/m);
  if (match == null) return undefined;
  return { id: match[1] ?? '', version: match[2] ?? '' };
}

export function digestBytes(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export function buildWitLock(
  requirements: readonly WitRequirement[],
  witDepsDirectory: string,
): WitLock {
  const packages: WitPackageLock[] = [];
  for (const entry of readdirSync(witDepsDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(entry.name, 'package.wit');
    const absolute = join(witDepsDirectory, path);
    let contents: string;
    try {
      contents = readFileSync(absolute, 'utf8');
    } catch {
      continue;
    }
    const parsed = packageIdFromWit(contents);
    if (parsed === undefined) continue;
    packages.push({
      id: parsed.id,
      version: parsed.version,
      source: 'bundled',
      path: `wit/deps/${path.replaceAll('\\', '/')}`,
      digest: digestBytes(contents),
    });
  }
  packages.sort((left, right) => left.id.localeCompare(right.id));
  return {
    schemaVersion: 1,
    componentModel: COMPONENT_MODEL,
    world: 'application',
    requirements: aggregateRequirements(requirements),
    packages,
  };
}
