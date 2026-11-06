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

export type DeployEnvironment = 'prod' | 'staging';

export type ManifestBinding = {
  name: string;
  capability: string;
  serviceName: string;
  config?: Record<string, string>;
};

export type ManagedTarget = {
  kind: 'managed';
  name: string;
  platform: string;
  stack: string;
  env?: DeployEnvironment;
  bindings?: ManifestBinding[];
  secrets?: string[];
};

export type ExternalTarget = {
  kind: 'external';
  name: string;
  /** Platform tenant this target deploys into; derives namespace and hostgroup when they are unset. */
  tenant?: string;
  kubeconfig: string;
  namespace: string;
  registry: RegistryInput;
  context?: string;
  hostgroup?: string;
  storageHostgroup?: string;
  env?: DeployEnvironment;
  bindings?: ManifestBinding[];
  secrets?: string[];
};

export type AccountTarget = {
  kind: 'account';
  name: string;
  account: string;
  domain?: string;
  env?: DeployEnvironment;
  bindings?: ManifestBinding[];
  secrets?: string[];
};

export type ControllerTarget = {
  kind: 'controller';
  name: string;
  controller: string;
  account?: string;
  env?: DeployEnvironment;
  bindings?: ManifestBinding[];
  secrets?: string[];
};

export type DeployTarget = ManagedTarget | ExternalTarget | AccountTarget | ControllerTarget;

export type DeployManifest = {
  path: string;
  workspaceRoot: string;
  defaultTarget?: string;
  discovery: DiscoveryConfig;
  targets: Record<string, DeployTarget>;
  env?: DeployEnvironment;
  bindings?: ManifestBinding[];
  secrets?: string[];
};

/** Tenant names follow the platform's Tenant resource: a DNS label of at most 40 characters. */
const TENANT_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const TENANT_NAME_MAX_LENGTH = 40;

export function isTenantName(value: string): boolean {
  return value.length <= TENANT_NAME_MAX_LENGTH && TENANT_NAME.test(value);
}

/** Workload namespace the platform creates for a tenant. */
export function tenantNamespace(tenant: string): string {
  return `di-tenant-${tenant}`;
}

/** Host group the platform creates for a tenant. */
export function tenantHostgroup(tenant: string): string {
  return `tenant-${tenant}`;
}

const DOMAIN_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const CONTROLLER_DOMAIN_PATTERN = new RegExp(
  String.raw`^${DOMAIN_LABEL}(?:\.${DOMAIN_LABEL})*(?::([1-9][0-9]{0,4}))?$`,
);
const IPV6_HOST_PATTERN = /^\[[0-9a-f:.]+\]$/;

/** Valid DNS domain (and optional port) used to derive `https://<account>.controller.<domain>`. */
export function isControllerDomain(value: string): boolean {
  const match = CONTROLLER_DOMAIN_PATTERN.exec(value);
  if (match === null || value.length > 260) return false;
  return match[1] === undefined || Number(match[1]) <= 65535;
}

function isPlainHttpAllowedControllerHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  return hostname.endsWith('.svc') || hostname.endsWith('.svc.cluster.local');
}

function trimTrailingSlashes(value: string): string {
  let result = value;
  while (result.endsWith('/')) {
    result = result.slice(0, -1);
  }
  return result;
}

/**
 * Validates and normalizes a tenant controller URL (without trailing slash).
 * Requires `https://`, or `http://` for loopback and in-cluster (`*.svc`) hosts only.
 */
export function normalizeControllerUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  if (url.username || url.password || url.search || url.hash) return undefined;
  const hostname = url.hostname.toLowerCase();
  const validHost =
    new RegExp(String.raw`^${DOMAIN_LABEL}(?:\.${DOMAIN_LABEL})*$`).test(hostname) ||
    IPV6_HOST_PATTERN.test(hostname);
  if (!validHost) return undefined;
  if (url.protocol === 'http:' && !isPlainHttpAllowedControllerHost(hostname)) {
    return undefined;
  }
  const path = url.pathname === '/' ? '' : trimTrailingSlashes(url.pathname);
  return `${url.origin}${path}`;
}

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
  const manifestEnv = optionalDeployEnvironment(interpolated.env, 'env', path);
  const bindings = parseManifestBindings(interpolated.bindings, 'bindings', path);
  const secrets = parseManifestSecrets(interpolated.secrets, 'secrets', path);
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

  const knownKeys = new Set([
    'default-target',
    'discovery',
    'targets',
    'env',
    'bindings',
    'secrets',
  ]);
  const unknown = Object.keys(interpolated).filter((key) => !knownKeys.has(key));
  if (unknown.length > 0) {
    manifestInvalid(
      `${DEPLOY_MANIFEST_NAME} has unsupported fields: ${unknown.join(', ')}. Valid fields are default-target, discovery, targets, env, bindings, and secrets.`,
      { manifestPath: path, fields: unknown },
    );
  }

  return {
    path,
    workspaceRoot: dirname(path),
    defaultTarget,
    discovery,
    targets,
    ...(manifestEnv ? { env: manifestEnv } : {}),
    ...(bindings ? { bindings } : {}),
    ...(secrets ? { secrets } : {}),
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
  const tenant = optionalString(value.tenant, `targets.${name}.tenant`, manifestPath);
  if (tenant !== undefined && !isTenantName(tenant)) {
    manifestInvalid(
      `targets.${name}.tenant must be a platform tenant name: 1-40 lowercase letters, digits, and single hyphens, starting with a letter (got "${tenant}")`,
      { manifestPath, target: name, tenant },
    );
  }
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
  const account = optionalString(value.account, `targets.${name}.account`, manifestPath);
  if (account !== undefined && !isTenantName(account)) {
    manifestInvalid(
      `targets.${name}.account must be a platform tenant name: 1-40 lowercase letters, digits, and single hyphens, starting with a letter (got "${account}")`,
      { manifestPath, target: name, account },
    );
  }
  const domain = optionalString(value.domain, `targets.${name}.domain`, manifestPath);
  if (domain !== undefined && !isControllerDomain(domain)) {
    manifestInvalid(`targets.${name}.domain must be a valid DNS domain (got "${domain}")`, {
      manifestPath,
      target: name,
      domain,
    });
  }
  const rawController = optionalString(
    value.controller,
    `targets.${name}.controller`,
    manifestPath,
  );
  const controller =
    rawController === undefined ? undefined : normalizeControllerUrl(rawController);
  if (rawController !== undefined && controller === undefined) {
    manifestInvalid(
      `targets.${name}.controller must be an https:// URL (or http:// for loopback or in-cluster *.svc hosts)`,
      { manifestPath, target: name, controller: rawController },
    );
  }
  const env = optionalDeployEnvironment(value.env, `targets.${name}.env`, manifestPath);
  const bindings = parseManifestBindings(value.bindings, `targets.${name}.bindings`, manifestPath);
  const secrets = parseManifestSecrets(value.secrets, `targets.${name}.secrets`, manifestPath);

  const known = new Set([
    'platform',
    'stack',
    'kubeconfig',
    'context',
    'tenant',
    'namespace',
    'registry',
    'hostgroup',
    'storage-hostgroup',
    'account',
    'controller',
    'domain',
    'env',
    'bindings',
    'secrets',
  ]);
  const unknown = Object.keys(value).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    manifestInvalid(
      `Target "${name}" has unsupported fields: ${unknown.join(', ')}. Managed targets accept platform and stack; external targets accept kubeconfig, context, tenant, namespace, registry, hostgroup, and storage-hostgroup; tenant controller targets accept account, domain, and controller.`,
      { manifestPath, target: name, fields: unknown },
    );
  }

  const managedFields = [platform ? 'platform' : undefined, stack ? 'stack' : undefined].filter(
    (field): field is string => field !== undefined,
  );
  const externalFields = [
    kubeconfig ? 'kubeconfig' : undefined,
    context ? 'context' : undefined,
    tenant ? 'tenant' : undefined,
    hostgroup ? 'hostgroup' : undefined,
    storageHostgroup ? 'storage-hostgroup' : undefined,
    namespace ? 'namespace' : undefined,
    registry ? 'registry' : undefined,
  ].filter((field): field is string => field !== undefined);
  const controllerFields = [
    account ? 'account' : undefined,
    controller ? 'controller' : undefined,
    domain ? 'domain' : undefined,
  ].filter((field): field is string => field !== undefined);

  if (managedFields.length > 0 && externalFields.length > 0) {
    manifestInvalid(
      `Target "${name}" mixes managed-platform and kubeconfig fields (${[...managedFields, ...externalFields].join(', ')}). Use either platform (and optional stack), or kubeconfig + registry + tenant or namespace.`,
      { manifestPath, target: name },
    );
  }

  if (controllerFields.length > 0 && (managedFields.length > 0 || externalFields.length > 0)) {
    manifestInvalid(
      `Target "${name}" mixes controller/account fields with operator fields (${[...managedFields, ...externalFields, ...controllerFields].join(', ')}). Use account (and optional domain) or controller (and optional account) for tenant controller targets.`,
      { manifestPath, target: name },
    );
  }

  if (domain !== undefined && controller !== undefined) {
    manifestInvalid(
      `Target "${name}" sets domain with controller. domain is only valid on account targets without an explicit controller URL.`,
      { manifestPath, target: name },
    );
  }

  if (domain !== undefined && account === undefined) {
    manifestInvalid(
      `Target "${name}" sets domain without account. domain is only valid on account targets.`,
      { manifestPath, target: name },
    );
  }

  if (stack !== undefined && platform === undefined) {
    manifestInvalid(
      `Target "${name}" sets stack without platform. stack is only valid on managed Pulumi targets.`,
      { manifestPath, target: name },
    );
  }

  const bundleExtras = {
    ...(env ? { env } : {}),
    ...(bindings ? { bindings } : {}),
    ...(secrets ? { secrets } : {}),
  };

  if (controller !== undefined) {
    return {
      kind: 'controller',
      name,
      controller,
      ...(account ? { account } : {}),
      ...bundleExtras,
    };
  }

  if (account !== undefined) {
    return {
      kind: 'account',
      name,
      account,
      ...(domain ? { domain } : {}),
      ...bundleExtras,
    };
  }

  if (platform !== undefined) {
    return { kind: 'managed', name, platform, stack: stack ?? 'dev', ...bundleExtras };
  }

  if (
    kubeconfig !== undefined ||
    tenant !== undefined ||
    namespace !== undefined ||
    registry !== undefined
  ) {
    // Explicit namespace/hostgroup win over the values a tenant derives.
    const resolvedNamespace =
      namespace ?? (tenant === undefined ? undefined : tenantNamespace(tenant));
    const resolvedHostgroup =
      hostgroup ?? (tenant === undefined ? undefined : tenantHostgroup(tenant));
    const missing = [
      kubeconfig === undefined ? 'kubeconfig' : undefined,
      resolvedNamespace === undefined ? 'tenant or namespace' : undefined,
      registry === undefined ? 'registry' : undefined,
    ].filter((field): field is string => field !== undefined);
    if (missing.length > 0) {
      manifestInvalid(
        `Target "${name}" is incomplete; external targets require kubeconfig, registry, and either tenant (deploys into the platform tenant's di-tenant-<tenant> namespace and tenant-<tenant> host group) or namespace. Missing: ${missing.join(', ')}.`,
        { manifestPath, target: name, missing },
      );
    }
    return {
      kind: 'external',
      name,
      kubeconfig: kubeconfig as string,
      namespace: resolvedNamespace as string,
      registry: registry as RegistryInput,
      context,
      ...(tenant ? { tenant } : {}),
      ...(resolvedHostgroup ? { hostgroup: resolvedHostgroup } : {}),
      ...(storageHostgroup ? { storageHostgroup } : {}),
      ...bundleExtras,
    };
  }

  manifestInvalid(
    `Target "${name}" is empty. Set platform (and optional stack) for a managed Pulumi platform, or kubeconfig, registry, and tenant (or namespace) for an external cluster.`,
    { manifestPath, target: name },
  );
}

export function optionalDeployEnvironment(
  value: unknown,
  label: string,
  manifestPath: string,
): DeployEnvironment | undefined {
  if (value === undefined) return undefined;
  if (value !== 'prod' && value !== 'staging') {
    manifestInvalid(`${label} must be "prod" or "staging"`, { manifestPath, field: label });
  }
  return value;
}

export function parseManifestSecrets(
  value: unknown,
  label: string,
  manifestPath: string,
): string[] | undefined {
  const entries = optionalStringArray(value, label, manifestPath);
  return entries === undefined ? undefined : [...new Set(entries)];
}

export function parseManifestBindings(
  value: unknown,
  label: string,
  manifestPath: string,
): ManifestBinding[] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    manifestInvalid(`${label} must be a table of named bindings`, { manifestPath, field: label });
  }
  const result: ManifestBinding[] = [];
  for (const [name, entry] of Object.entries(value)) {
    if (!isRecord(entry)) {
      manifestInvalid(`${label}.${name} must be a table`, {
        manifestPath,
        field: `${label}.${name}`,
      });
    }
    const known = new Set(['capability', 'service', 'serviceName', 'service-name', 'config']);
    const unknown = Object.keys(entry).filter((key) => !known.has(key));
    if (unknown.length > 0) {
      manifestInvalid(`${label}.${name} has unsupported fields: ${unknown.join(', ')}`, {
        manifestPath,
        field: `${label}.${name}`,
        fields: unknown,
      });
    }
    const capability = optionalString(
      entry.capability,
      `${label}.${name}.capability`,
      manifestPath,
    );
    if (capability === undefined) {
      manifestInvalid(`${label}.${name}.capability is required`, {
        manifestPath,
        field: `${label}.${name}.capability`,
      });
    }
    const serviceName =
      optionalString(
        entry.serviceName ?? entry['service-name'] ?? entry.service,
        `${label}.${name}.serviceName`,
        manifestPath,
      ) ?? name;
    let config: Record<string, string> | undefined;
    if (entry.config !== undefined) {
      if (
        !isRecord(entry.config) ||
        Object.values(entry.config).some((v) => typeof v !== 'string')
      ) {
        manifestInvalid(`${label}.${name}.config must be a table of string values`, {
          manifestPath,
          field: `${label}.${name}.config`,
        });
      }
      if (Object.keys(entry.config).length > 0) {
        config = { ...(entry.config as Record<string, string>) };
      }
    }
    result.push({
      name,
      capability,
      serviceName,
      ...(config ? { config } : {}),
    });
  }
  return result;
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
