import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CommandFailure } from '@di-framework/cli-extension';
import { isNamespace } from './namespace';
import { findUp } from './project';
import type { RegistryInput } from './registry';
import { parseToml, TomlParseError } from './toml';

export const DEPLOY_MANIFEST_NAME = 'di-framework.deploy.toml';

export const DEFAULT_DISCOVERY_EXCLUDE = ['dist/**', 'coverage/**', '**/dist/**', '**/coverage/**'];

export const ALWAYS_SKIP_DIRECTORIES = new Set(['.git', 'node_modules', '.di-framework']);

export type DiscoveryConfig = {
  include: string[];
  exclude: string[];
};

export type ManagedTarget = {
  kind: 'managed';
  name: string;
  platform: string;
  stack: string;
};

export type ExternalTarget = {
  kind: 'external';
  name: string;
  kubeconfig: string;
  namespace: string;
  registry: RegistryInput;
  context?: string;
  hostgroup?: string;
  storageHostgroup?: string;
};

export type DeployTarget = ManagedTarget | ExternalTarget;

export type DeployManifest = {
  path: string;
  workspaceRoot: string;
  defaultTarget?: string;
  discovery: DiscoveryConfig;
  targets: Record<string, DeployTarget>;
};

const ENV_TOKEN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function manifestInvalid(
  message: string,
  details: Record<string, string | string[] | number | undefined>,
): never {
  throw new CommandFailure('WASMCLOUD_DEPLOY_MANIFEST_INVALID', message, 2, details);
}

export function findDeployManifest(startDirectory: string): string | undefined {
  return findUp(startDirectory, DEPLOY_MANIFEST_NAME);
}

export function loadDeployManifest(
  startDirectory: string,
  env: Record<string, string | undefined>,
): DeployManifest {
  const path = findDeployManifest(startDirectory);
  if (path === undefined) {
    throw new CommandFailure(
      'WASMCLOUD_DEPLOY_MANIFEST_NOT_FOUND',
      `No ${DEPLOY_MANIFEST_NAME} found above ${startDirectory}. Add one at the workspace root to describe deployment targets.`,
      2,
      { startDirectory },
    );
  }
  return parseDeployManifest(path, readFileSync(path, 'utf8'), env);
}

export function parseDeployManifest(
  path: string,
  source: string,
  env: Record<string, string | undefined>,
): DeployManifest {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(source);
  } catch (error) {
    const line = error instanceof TomlParseError ? error.line : undefined;
    manifestInvalid(
      `Could not parse ${path}${line === undefined ? '' : ` (line ${line})`}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { manifestPath: path, ...(line === undefined ? {} : { line }) },
    );
  }

  if ('apps' in parsed) {
    manifestInvalid(
      `${DEPLOY_MANIFEST_NAME} must not declare "apps"; project identity comes only from the "name" in di-framework.config.json`,
      { manifestPath: path },
    );
  }

  const interpolated = interpolateEnv(parsed, env, path) as Record<string, unknown>;
  const defaultTarget = optionalString(interpolated['default-target'], 'default-target', path);
  const discovery = parseDiscovery(interpolated.discovery, path);
  const targetsValue = interpolated.targets;
  if (targetsValue === undefined) {
    manifestInvalid(`${DEPLOY_MANIFEST_NAME} must declare at least one [targets.<name>] table`, {
      manifestPath: path,
    });
  }
  if (!isRecord(targetsValue) || Object.keys(targetsValue).length === 0) {
    manifestInvalid(`${DEPLOY_MANIFEST_NAME} "targets" must be a non-empty table`, {
      manifestPath: path,
    });
  }

  const targets: Record<string, DeployTarget> = {};
  for (const [name, value] of Object.entries(targetsValue)) {
    targets[name] = parseTarget(name, value, path);
  }

  if (defaultTarget !== undefined && targets[defaultTarget] === undefined) {
    manifestInvalid(
      `default-target "${defaultTarget}" does not match any declared target. Known targets: ${Object.keys(targets).join(', ')}`,
      { manifestPath: path, defaultTarget, targets: Object.keys(targets) },
    );
  }

  const knownKeys = new Set(['default-target', 'discovery', 'targets']);
  const unknown = Object.keys(interpolated).filter((key) => !knownKeys.has(key));
  if (unknown.length > 0) {
    manifestInvalid(
      `${DEPLOY_MANIFEST_NAME} has unsupported fields: ${unknown.join(', ')}. Valid fields are default-target, discovery, and targets.`,
      { manifestPath: path, fields: unknown },
    );
  }

  return {
    path,
    workspaceRoot: dirname(path),
    defaultTarget,
    discovery,
    targets,
  };
}

export function interpolateEnv(
  value: unknown,
  env: Record<string, string | undefined>,
  manifestPath: string,
): unknown {
  if (typeof value === 'string') return interpolateString(value, env, manifestPath);
  if (Array.isArray(value)) return value.map((entry) => interpolateEnv(entry, env, manifestPath));
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = interpolateEnv(entry, env, manifestPath);
    }
    return result;
  }
  return value;
}

function interpolateString(
  value: string,
  env: Record<string, string | undefined>,
  manifestPath: string,
): string {
  return value.replace(ENV_TOKEN, (_match, name: string) => {
    const replacement = env[name];
    if (replacement === undefined || replacement === '') {
      throw new CommandFailure(
        'WASMCLOUD_ENV_UNSET',
        `Environment variable ${name} is not set (required by ${manifestPath}). Set ${name} or remove the \${${name}} interpolation.`,
        2,
        { variable: name, manifestPath },
      );
    }
    return replacement;
  });
}

function parseDiscovery(value: unknown, manifestPath: string): DiscoveryConfig {
  if (value === undefined) {
    return { include: ['**'], exclude: [...DEFAULT_DISCOVERY_EXCLUDE] };
  }
  if (!isRecord(value)) {
    manifestInvalid(`${DEPLOY_MANIFEST_NAME} "discovery" must be a table`, { manifestPath });
  }
  const include = optionalStringArray(value.include, 'discovery.include', manifestPath) ?? ['**'];
  const userExclude = optionalStringArray(value.exclude, 'discovery.exclude', manifestPath) ?? [];
  const unknown = Object.keys(value).filter((key) => key !== 'include' && key !== 'exclude');
  if (unknown.length > 0) {
    manifestInvalid(
      `discovery has unsupported fields: ${unknown.join(', ')}. Valid fields are include and exclude.`,
      { manifestPath, fields: unknown },
    );
  }
  if (include.length === 0) {
    manifestInvalid('discovery.include must contain at least one pattern', { manifestPath });
  }
  return { include, exclude: [...DEFAULT_DISCOVERY_EXCLUDE, ...userExclude] };
}

function parseTarget(name: string, value: unknown, manifestPath: string): DeployTarget {
  if (!isRecord(value)) {
    manifestInvalid(`targets.${name} must be a table`, { manifestPath, target: name });
  }

  const platform = optionalString(value.platform, `targets.${name}.platform`, manifestPath);
  const stack = optionalString(value.stack, `targets.${name}.stack`, manifestPath);
  const kubeconfig = optionalString(value.kubeconfig, `targets.${name}.kubeconfig`, manifestPath);
  const context = optionalString(value.context, `targets.${name}.context`, manifestPath);
  const hostgroup = optionalString(value.hostgroup, `targets.${name}.hostgroup`, manifestPath);
  const storageHostgroup = optionalString(
    value['storage-hostgroup'],
    `targets.${name}.storage-hostgroup`,
    manifestPath,
  );
  for (const [field, group] of [
    ['hostgroup', hostgroup],
    ['storage-hostgroup', storageHostgroup],
  ]) {
    if (group !== undefined && !isNamespace(group))
      manifestInvalid(`targets.${name}.${field} must be a DNS label of at most 63 characters`, {
        manifestPath,
        target: name,
      });
  }
  const namespace = optionalString(value.namespace, `targets.${name}.namespace`, manifestPath);
  if (namespace !== undefined && !isNamespace(namespace)) {
    manifestInvalid(
      `targets.${name}.namespace must be a Kubernetes namespace (a DNS label of at most 63 characters)`,
      { manifestPath, target: name },
    );
  }
  const registry = optionalRegistry(value.registry, `targets.${name}.registry`, manifestPath);

  const known = new Set([
    'platform',
    'stack',
    'kubeconfig',
    'context',
    'namespace',
    'registry',
    'hostgroup',
    'storage-hostgroup',
  ]);
  const unknown = Object.keys(value).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    manifestInvalid(
      `Target "${name}" has unsupported fields: ${unknown.join(', ')}. Managed targets accept platform and stack; external targets accept kubeconfig, context, namespace, registry, hostgroup, and storage-hostgroup.`,
      { manifestPath, target: name, fields: unknown },
    );
  }

  const managedFields = [platform ? 'platform' : undefined, stack ? 'stack' : undefined].filter(
    (field): field is string => field !== undefined,
  );
  const externalFields = [
    kubeconfig ? 'kubeconfig' : undefined,
    context ? 'context' : undefined,
    hostgroup ? 'hostgroup' : undefined,
    storageHostgroup ? 'storage-hostgroup' : undefined,
    namespace ? 'namespace' : undefined,
    registry ? 'registry' : undefined,
  ].filter((field): field is string => field !== undefined);

  if (managedFields.length > 0 && externalFields.length > 0) {
    manifestInvalid(
      `Target "${name}" mixes managed-platform and kubeconfig fields (${[...managedFields, ...externalFields].join(', ')}). Use either platform (and optional stack), or kubeconfig + namespace + registry.`,
      { manifestPath, target: name },
    );
  }

  if (stack !== undefined && platform === undefined) {
    manifestInvalid(
      `Target "${name}" sets stack without platform. stack is only valid on managed Pulumi targets.`,
      { manifestPath, target: name },
    );
  }

  if (platform !== undefined) {
    return { kind: 'managed', name, platform, stack: stack ?? 'dev' };
  }

  if (kubeconfig !== undefined || namespace !== undefined || registry !== undefined) {
    const missing = [
      kubeconfig === undefined ? 'kubeconfig' : undefined,
      namespace === undefined ? 'namespace' : undefined,
      registry === undefined ? 'registry' : undefined,
    ].filter((field): field is string => field !== undefined);
    if (missing.length > 0) {
      manifestInvalid(
        `Target "${name}" is incomplete; external targets require kubeconfig, namespace, and registry. Missing: ${missing.join(', ')}.`,
        { manifestPath, target: name, missing },
      );
    }
    return {
      kind: 'external',
      name,
      kubeconfig: kubeconfig as string,
      namespace: namespace as string,
      registry: registry as RegistryInput,
      context,
      ...(hostgroup ? { hostgroup } : {}),
      ...(storageHostgroup ? { storageHostgroup } : {}),
    };
  }

  manifestInvalid(
    `Target "${name}" is empty. Set platform (and optional stack) for a managed Pulumi platform, or kubeconfig, namespace, and registry for an external cluster.`,
    { manifestPath, target: name },
  );
}

function optionalString(value: unknown, label: string, manifestPath: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    manifestInvalid(`${label} must be a non-empty string`, { manifestPath, field: label });
  }
  return value;
}

function optionalRegistry(
  value: unknown,
  label: string,
  manifestPath: string,
): RegistryInput | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return optionalString(value, label, manifestPath);
  if (!isRecord(value)) {
    manifestInvalid(`${label} must be a string or a table with push, pull, and insecure`, {
      manifestPath,
      field: label,
    });
  }
  const push = optionalString(value.push, `${label}.push`, manifestPath);
  const pull = optionalString(value.pull, `${label}.pull`, manifestPath);
  const insecure = value.insecure;
  const unknown = Object.keys(value).filter(
    (key) => key !== 'push' && key !== 'pull' && key !== 'insecure',
  );
  if (unknown.length > 0) {
    manifestInvalid(`${label} has unsupported fields: ${unknown.join(', ')}`, {
      manifestPath,
      field: label,
      fields: unknown,
    });
  }
  const missing = [
    push === undefined ? 'push' : undefined,
    pull === undefined ? 'pull' : undefined,
  ].filter((field): field is string => field !== undefined);
  if (missing.length > 0) {
    manifestInvalid(`${label} requires push and pull. Missing: ${missing.join(', ')}.`, {
      manifestPath,
      field: label,
      missing,
    });
  }
  if (insecure !== undefined && typeof insecure !== 'boolean') {
    manifestInvalid(`${label}.insecure must be a boolean when present`, {
      manifestPath,
      field: `${label}.insecure`,
    });
  }
  return {
    push: push as string,
    pull: pull as string,
    ...(insecure === undefined ? {} : { insecure }),
  };
}

function optionalStringArray(
  value: unknown,
  label: string,
  manifestPath: string,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== 'string' || entry.trim() === '')
  ) {
    manifestInvalid(`${label} must be an array of non-empty strings`, {
      manifestPath,
      field: label,
    });
  }
  return value as string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
