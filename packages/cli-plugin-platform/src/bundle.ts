import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { CliIo } from '@di-framework/cli-extension';
import { discoverActors } from './actors';
import { type BindingRecord, discoverBindings } from './bindings';
import {
  type BuildSummary,
  buildComponent,
  canonicalBuildDigest,
  requirementsForProject,
} from './build';
import { discoverScheduledJobs } from './cron';
import { DEFAULT_DEPS, type WasmcloudDeps } from './deps';
import { resolveApplication } from './discovery';
import {
  type DeployEnvironment,
  type DeployManifest,
  type DeployTarget,
  findDeployManifest,
  interpolateEnv,
  type ManifestBinding,
  optionalDeployEnvironment,
  parseDeployManifest,
  parseManifestBindings,
  parseManifestSecrets,
} from './manifest';
import { loadProject, type WasmcloudProject } from './project';
import { ociReference, type PublishedImage, projectRelativePath } from './publish';
import { discoverQueueHandlers, isQueueWorkerProject } from './queues';
import {
  materializeRegistry,
  type RegistryInput,
  registryReferenceHost,
  registryUsesPlainHttp,
} from './registry';
import { invalidUsage, toolFailed } from './support';
import { type ClusterConnection, resolveConnection, resolveTarget } from './target';
import { parseToml } from './toml';
import { deploymentResourceName, renderWorkloadManifest } from './workload';

export type { DeployEnvironment, ManifestBinding };
export { canonicalBuildDigest };

export const PASSTHROUGH_LABEL_PREFIX = 'app.di-framework.dev/';

export type ComponentReference = {
  reference: string;
  digest: string;
};

export type DeployBinding = {
  name: string;
  capability: string;
  serviceName: string;
  config?: Record<string, string>;
};

export type DeployBundle = {
  env: DeployEnvironment;
  service: string;
  component: ComponentReference;
  workload: Record<string, unknown>;
  bindings: DeployBinding[];
  secrets: string[];
};

export type BundleRegistryCredentials = {
  registry?: RegistryInput;
  repository?: string;
  username?: string;
  password?: string;
  token?: string;
  registryConfigPath?: string;
};

export type BundlePublishContext = {
  project: WasmcloudProject;
  connection: ClusterConnection;
  build: BuildSummary;
  io: CliIo;
  deps: WasmcloudDeps;
  tag?: string;
  credentials?: BundleRegistryCredentials;
};

export type BuildDeployBundleOptions = {
  name?: string;
  project?: WasmcloudProject;
  env?: DeployEnvironment;
  target?: string;
  registry?: RegistryInput;
  tag?: string;
  credentials?:
    | BundleRegistryCredentials
    | (() => Promise<BundleRegistryCredentials> | BundleRegistryCredentials);
  publish?: (context: BundlePublishContext) => Promise<PublishedImage | ComponentReference>;
  bindings?: readonly DeployBinding[];
  secrets?: readonly string[];
  /** Optional passthrough labels (`app.di-framework.dev/*`) to merge onto workload.metadata.labels. */
  labels?: Readonly<Record<string, string>>;
  /** Optional passthrough annotations (`app.di-framework.dev/*`) to merge onto workload.metadata.annotations. */
  annotations?: Readonly<Record<string, string>>;
  outputPath?: string;
};

export type ParsedBuildArgs = {
  bundle?: string;
  env?: DeployEnvironment;
  target?: string;
  registry?: string;
  tag?: string;
  name?: string;
};

export function parseBuildArgs(args: readonly string[]): ParsedBuildArgs {
  if (args.length === 0) return {};
  const result: ParsedBuildArgs = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '--bundle' || arg.startsWith('--bundle=')) {
      const value = arg === '--bundle' ? args[++i] : arg.slice('--bundle='.length);
      if (!value || value.startsWith('-')) invalidUsage('Missing value for --bundle', arg);
      result.bundle = value;
      continue;
    }
    if (arg === '--env' || arg.startsWith('--env=')) {
      const value = arg === '--env' ? args[++i] : arg.slice('--env='.length);
      if (value !== 'prod' && value !== 'staging') {
        invalidUsage('Invalid --env value; expected "prod" or "staging"', arg);
      }
      result.env = value;
      continue;
    }
    if (arg === '--target' || arg.startsWith('--target=')) {
      const value = arg === '--target' ? args[++i] : arg.slice('--target='.length);
      if (!value || value.startsWith('-')) invalidUsage('Missing value for --target', arg);
      result.target = value;
      continue;
    }
    if (arg === '--registry' || arg.startsWith('--registry=')) {
      const value = arg === '--registry' ? args[++i] : arg.slice('--registry='.length);
      if (!value || value.startsWith('-')) invalidUsage('Missing value for --registry', arg);
      result.registry = value;
      continue;
    }
    if (arg === '--tag' || arg.startsWith('--tag=')) {
      const value = arg === '--tag' ? args[++i] : arg.slice('--tag='.length);
      if (!value || value.startsWith('-')) invalidUsage('Missing value for --tag', arg);
      result.tag = value;
      continue;
    }
    if (arg.startsWith('-')) {
      invalidUsage(`Unknown option: ${arg}`, arg);
    }
    if (result.name !== undefined) {
      invalidUsage(`Unexpected argument: ${arg}`, arg);
    }
    result.name = arg;
  }
  if (result.bundle === undefined) {
    const first = args[0] as string;
    invalidUsage(`platform build does not accept arguments without --bundle: ${first}`, first);
  }
  return result;
}

type BundleManifestConfig = {
  manifest?: DeployManifest;
  env?: DeployEnvironment;
  bindings?: ManifestBinding[];
  secrets?: string[];
};

function loadBundleManifestConfig(
  startDirectory: string,
  env: Record<string, string | undefined>,
  hasExplicitRegistryOrPublish: boolean,
): BundleManifestConfig {
  const path = findDeployManifest(startDirectory);
  if (path === undefined) return {};
  const source = readFileSync(path, 'utf8');
  if (hasExplicitRegistryOrPublish) {
    const raw = interpolateEnv(parseToml(source), env, path) as Record<string, unknown>;
    if (raw.targets === undefined) {
      return {
        env: optionalDeployEnvironment(raw.env, 'env', path),
        bindings: parseManifestBindings(raw.bindings, 'bindings', path),
        secrets: parseManifestSecrets(raw.secrets, 'secrets', path),
      };
    }
  }
  const manifest = parseDeployManifest(path, source, env);
  return {
    manifest,
    env: manifest.env,
    bindings: manifest.bindings,
    secrets: manifest.secrets,
  };
}

export function normalizeSha256Digest(digest: string): string {
  return digest.startsWith('sha256:') ? digest : `sha256:${digest}`;
}

export function pinImageToDigest(reference: string, digest: string): string {
  const normalizedDigest = normalizeSha256Digest(digest);
  const atIndex = reference.indexOf('@');
  const withoutDigest = atIndex >= 0 ? reference.slice(0, atIndex) : reference;
  const lastSlash = withoutDigest.lastIndexOf('/');
  const lastColon = withoutDigest.lastIndexOf(':');
  const repository = lastColon > lastSlash ? withoutDigest.slice(0, lastColon) : withoutDigest;
  return `${repository}@${normalizedDigest}`;
}

function parseManifestDescriptorDigest(stdout: string): string {
  let parsed: { digest?: unknown } | null = null;
  try {
    parsed = JSON.parse(stdout) as { digest?: unknown } | null;
  } catch {
    // handled below
  }
  const digest = typeof parsed === 'object' && parsed !== null ? parsed.digest : undefined;
  if (typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/i.test(digest)) {
    throw new Error(`Failed to resolve OCI manifest digest from oras descriptor: ${stdout.trim()}`);
  }
  return digest.toLowerCase();
}

async function publishWithBundleOptions(context: BundlePublishContext): Promise<PublishedImage> {
  const { project, connection, build, io, deps, tag, credentials } = context;
  const repository = credentials?.repository ?? project.witName;
  const resolvedTag = tag ?? `sha256-${build.deploymentDigest}`;
  const pushReference = `${registryReferenceHost(connection.registry.push)}/${repository}:${resolvedTag}`;
  const pullReference = `${registryReferenceHost(connection.registry.pull)}/${repository}:${resolvedTag}`;
  const configPath = resolve(project.projectRoot, '.di-framework', 'oci-config.json');
  const componentPath = projectRelativePath(project.projectRoot, project.outputPath);
  const projectConfigPath = projectRelativePath(project.projectRoot, configPath);
  const transportArgs = registryUsesPlainHttp(connection.registry) ? ['--plain-http'] : [];

  let tempAuthDir: string | undefined;
  let authArgs: string[] = [];
  if (credentials?.registryConfigPath) {
    authArgs = ['--registry-config', credentials.registryConfigPath];
  } else if (credentials?.username || credentials?.token) {
    tempAuthDir = mkdtempSync(join(tmpdir(), 'di-framework-oras-'));
    const tempConfigPath = join(tempAuthDir, 'config.json');
    const authEntry: Record<string, string> = {};
    if (credentials.username) {
      authEntry.auth = Buffer.from(
        `${credentials.username}:${credentials.password ?? ''}`,
      ).toString('base64');
    }
    if (credentials.token) {
      authEntry.identitytoken = credentials.token;
    }
    const refHost = registryReferenceHost(connection.registry.push);
    const serverHost = refHost.replace(/\/.*$/, '');
    const config = {
      auths: {
        [serverHost]: authEntry,
        [refHost]: authEntry,
      },
    };
    const fd = openSync(tempConfigPath, 'wx', 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(config)}\n`, 'utf8');
    } finally {
      closeSync(fd);
    }
    authArgs = ['--registry-config', tempConfigPath];
  }

  try {
    io.stdout.write(`Publishing ${componentPath} as ${pushReference}...\n`);
    if (!tag) {
      const existing = await deps.runCaptured(
        'oras',
        ['manifest', 'fetch', ...transportArgs, ...authArgs, '--descriptor', pushReference],
        { cwd: project.projectRoot },
      );
      if (existing.exitCode === 0) {
        io.stdout.write(`OCI tag ${pushReference} already exists; keeping it immutable.\n`);
        const existingDigest = parseManifestDescriptorDigest(existing.stdout);
        return {
          artifactDigest: existingDigest,
          digest: build.deploymentDigest,
          pullReference,
          pushReference,
          reference: pushReference,
        };
      }
    }
    const pushed = await deps.runner(
      'oras',
      [
        'push',
        ...transportArgs,
        ...authArgs,
        '--config',
        `${projectConfigPath}:application/vnd.wasm.config.v0+json`,
        pushReference,
        `${componentPath}:application/wasm`,
      ],
      { cwd: project.projectRoot },
    );
    if (pushed.exitCode !== 0) {
      throw toolFailed('oras push', pushed.exitCode);
    }
    const descriptor = await deps.runCaptured(
      'oras',
      ['manifest', 'fetch', ...transportArgs, ...authArgs, '--descriptor', pushReference],
      { cwd: project.projectRoot },
    );
    if (descriptor.exitCode !== 0) {
      throw toolFailed('oras manifest fetch', descriptor.exitCode);
    }
    const manifestDigest = parseManifestDescriptorDigest(descriptor.stdout);
    return {
      artifactDigest: manifestDigest,
      digest: build.deploymentDigest,
      pullReference,
      pushReference,
      reference: pushReference,
    };
  } finally {
    if (tempAuthDir !== undefined) {
      rmSync(tempAuthDir, { recursive: true, force: true });
    }
  }
}

function filterPassthroughMap(
  source: unknown,
  extra?: Readonly<Record<string, string>>,
): Record<string, string> | undefined {
  const merged: Record<string, string> = {};
  if (typeof source === 'object' && source !== null && !Array.isArray(source)) {
    for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
      if (key.startsWith(PASSTHROUGH_LABEL_PREFIX) && typeof value === 'string') {
        merged[key] = value;
      }
    }
  }
  if (extra !== undefined) {
    for (const [key, value] of Object.entries(extra)) {
      if (key.startsWith(PASSTHROUGH_LABEL_PREFIX)) {
        merged[key] = value;
      }
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function sanitizeGuestSpec(
  guest: Record<string, unknown>,
  pinnedImage: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    ...guest,
    image: pinnedImage,
  };
  const local = result.localResources;
  if (typeof local === 'object' && local !== null && !Array.isArray(local)) {
    const nextLocal: Record<string, unknown> = { ...(local as Record<string, unknown>) };
    delete nextLocal.volumeMounts;
    delete nextLocal.allowedIpNameLookups;
    const envObj = nextLocal.environment;
    if (typeof envObj === 'object' && envObj !== null && !Array.isArray(envObj)) {
      const nextEnv: Record<string, unknown> = { ...(envObj as Record<string, unknown>) };
      delete nextEnv.configFrom;
      delete nextEnv.secretFrom;
      if (Object.keys(nextEnv).length > 0) {
        nextLocal.environment = nextEnv;
      } else {
        delete nextLocal.environment;
      }
    }
    if (Object.keys(nextLocal).length > 0) {
      result.localResources = nextLocal;
    } else {
      delete result.localResources;
    }
  }
  return result;
}

export type SanitizeWorkloadOptions = {
  service: string;
  env: DeployEnvironment;
  component: ComponentReference;
  publicIngress?: boolean;
  labels?: Readonly<Record<string, string>>;
  annotations?: Readonly<Record<string, string>>;
};

export function sanitizeWorkloadForBundle(
  workload: Record<string, unknown>,
  options: SanitizeWorkloadOptions,
): Record<string, unknown> {
  const { service, env, component, publicIngress = true } = options;
  const workloadName = `${service}-${env}`;
  const pinnedImage = pinImageToDigest(component.reference, component.digest);

  const rawMeta =
    typeof workload.metadata === 'object' && workload.metadata !== null
      ? (workload.metadata as Record<string, unknown>)
      : {};
  const labels = filterPassthroughMap(rawMeta.labels, options.labels);
  const annotations = filterPassthroughMap(rawMeta.annotations, options.annotations);
  const metadata: Record<string, unknown> = {
    name: workloadName,
    ...(labels ? { labels } : {}),
    ...(annotations ? { annotations } : {}),
  };

  const rawSpec = (workload.spec ?? {}) as Record<string, unknown>;
  const rawTemplate = (rawSpec.template ?? {}) as Record<string, unknown>;
  const rawTemplateSpec = (rawTemplate.spec ?? {}) as Record<string, unknown>;

  const nextTemplateSpec: Record<string, unknown> = { ...rawTemplateSpec };
  delete nextTemplateSpec.hostSelector;
  delete nextTemplateSpec.environment;
  delete nextTemplateSpec.hostId;
  delete nextTemplateSpec.kubernetes;
  delete nextTemplateSpec.volumes;

  const rawComponents = Array.isArray(nextTemplateSpec.components)
    ? (nextTemplateSpec.components as Record<string, unknown>[])
    : [];
  const rawService =
    typeof nextTemplateSpec.service === 'object' && nextTemplateSpec.service !== null
      ? (nextTemplateSpec.service as Record<string, unknown>)
      : undefined;

  if (rawComponents.length > 0) {
    nextTemplateSpec.components = rawComponents.map((comp) => sanitizeGuestSpec(comp, pinnedImage));
    if (rawService !== undefined) {
      nextTemplateSpec.service = sanitizeGuestSpec(rawService, pinnedImage);
    }
  } else if (rawService !== undefined) {
    nextTemplateSpec.components = [
      sanitizeGuestSpec({ name: service, ...rawService }, pinnedImage),
    ];
    delete nextTemplateSpec.service;
  }

  if (Array.isArray(nextTemplateSpec.hostInterfaces)) {
    nextTemplateSpec.hostInterfaces = (
      nextTemplateSpec.hostInterfaces as Record<string, unknown>[]
    ).map((entry) => {
      const copy: Record<string, unknown> = { ...entry };
      delete copy.configFrom;
      delete copy.secretFrom;
      if (copy.namespace === 'wasi' && copy.package === 'http') {
        const rawConfig =
          typeof copy.config === 'object' && copy.config !== null && !Array.isArray(copy.config)
            ? { ...(copy.config as Record<string, string>) }
            : {};
        const isClusterLocal =
          typeof rawConfig.host === 'string' && rawConfig.host.endsWith('.svc.cluster.local');
        if (!publicIngress || isClusterLocal) {
          delete rawConfig.host;
          if (Object.keys(rawConfig).length > 0) {
            copy.config = rawConfig;
          } else {
            delete copy.config;
          }
        } else {
          copy.config = { ...rawConfig, host: workloadName };
        }
      }
      return copy;
    });
  }

  return {
    apiVersion: workload.apiVersion ?? 'runtime.wasmcloud.dev/v1alpha1',
    kind: workload.kind ?? 'WorkloadDeployment',
    metadata,
    spec: {
      ...rawSpec,
      template: {
        ...rawTemplate,
        spec: nextTemplateSpec,
      },
    },
  };
}

type YamlLine = { indent: number; text: string };

function splitYamlKeyValue(text: string): { key: string; value: string } {
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' && text[i - 1] !== '\\') inQuotes = !inQuotes;
    else if (ch === ':' && !inQuotes) {
      const rawKey = text.slice(0, i).trim();
      const key = rawKey.startsWith('"') ? (JSON.parse(rawKey) as string) : rawKey;
      return { key, value: text.slice(i + 1).trim() };
    }
  }
  return { key: text.trim(), value: '' };
}

function parseYamlScalar(raw: string): unknown {
  if (raw.startsWith('"') || raw.startsWith('[')) {
    return JSON.parse(raw) as unknown;
  }
  if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10);
  return raw;
}

function parseYamlBlock(
  lines: readonly YamlLine[],
  startIndex: number,
  blockIndent: number,
): [unknown, number] {
  if (lines[startIndex]?.text.startsWith('- ')) {
    const items: unknown[] = [];
    let index = startIndex;
    while (index < lines.length && (lines[index] as YamlLine).indent === blockIndent) {
      const line = lines[index] as YamlLine;
      if (!line.text.startsWith('- ')) break;
      const itemText = line.text.slice(2).trim();
      const { key, value } = splitYamlKeyValue(itemText);
      if (value === '' && !itemText.endsWith(':')) {
        items.push(parseYamlScalar(itemText));
        index++;
        continue;
      }
      const itemMap: Record<string, unknown> = {};
      if (value !== '') {
        itemMap[key] = parseYamlScalar(value);
        index++;
      } else {
        const nextIndent = (lines[index + 1] as YamlLine).indent;
        const [nested, nextIdx] = parseYamlBlock(lines, index + 1, nextIndent);
        itemMap[key] = nested;
        index = nextIdx;
      }
      if (index < lines.length && (lines[index] as YamlLine).indent > blockIndent) {
        const [restMap, nextIdx] = parseYamlMap(lines, index, (lines[index] as YamlLine).indent);
        Object.assign(itemMap, restMap);
        index = nextIdx;
      }
      items.push(itemMap);
    }
    return [items, index];
  }
  return parseYamlMap(lines, startIndex, blockIndent);
}

function parseYamlMap(
  lines: readonly YamlLine[],
  startIndex: number,
  mapIndent: number,
): [Record<string, unknown>, number] {
  const result: Record<string, unknown> = {};
  let index = startIndex;
  while (index < lines.length && (lines[index] as YamlLine).indent === mapIndent) {
    const line = lines[index] as YamlLine;
    if (line.text.startsWith('- ')) break;
    const { key, value } = splitYamlKeyValue(line.text);
    if (value !== '') {
      result[key] = parseYamlScalar(value);
      index++;
    } else {
      const childIndent = (lines[index + 1] as YamlLine).indent;
      const [nested, nextIdx] = parseYamlBlock(lines, index + 1, childIndent);
      result[key] = nested;
      index = nextIdx;
    }
  }
  return [result, index];
}

export function parseWorkloadDeploymentYaml(manifestYaml: string): Record<string, unknown> {
  const documents = manifestYaml
    .split(/\n---\n/)
    .map((doc) => doc.trim())
    .filter((doc) => doc.length > 0);
  const workloadSection =
    documents.find((doc) => doc.includes('kind: WorkloadDeployment')) ?? documents[0] ?? '';
  const lines: YamlLine[] = workloadSection
    .split(/\r?\n/)
    .filter((raw) => raw.trim().length > 0)
    .map((raw) => {
      const trimmed = raw.trimStart();
      return { indent: raw.length - trimmed.length, text: trimmed };
    });
  const [parsed] = parseYamlMap(lines, 0, 0);
  return parsed;
}

const KIND_TO_CAPABILITY: Record<string, string> = {
  Postgres: 'postgres',
  KeyValue: 'keyvalue',
  Blobstore: 'blobstore',
  Messaging: 'messaging',
  OutgoingHttp: 'egress',
};

function collectDeployBindings(
  manifestBindings: readonly ManifestBinding[] | undefined,
  targetBindings: readonly ManifestBinding[] | undefined,
  discoveredBindings: readonly BindingRecord[],
  optionBindings: readonly DeployBinding[] | undefined,
): DeployBinding[] {
  const byName = new Map<string, DeployBinding>();
  for (const record of discoveredBindings) {
    if (record.serviceName === undefined) continue;
    const capability = KIND_TO_CAPABILITY[record.kind];
    if (capability === undefined) continue;
    byName.set(record.name, {
      name: record.name,
      capability,
      serviceName: record.serviceName,
      ...(record.config && Object.keys(record.config).length > 0 ? { config: record.config } : {}),
    });
  }
  for (const source of [manifestBindings, targetBindings, optionBindings]) {
    if (source === undefined) continue;
    for (const binding of source) {
      byName.set(binding.name, {
        name: binding.name,
        capability: binding.capability,
        serviceName: binding.serviceName,
        ...(binding.config && Object.keys(binding.config).length > 0
          ? { config: { ...binding.config } }
          : {}),
      });
    }
  }
  return [...byName.values()];
}

function collectDeploySecrets(
  manifestSecrets: readonly string[] | undefined,
  targetSecrets: readonly string[] | undefined,
  optionSecrets: readonly string[] | undefined,
): string[] {
  const seen = new Set<string>();
  for (const list of [manifestSecrets, targetSecrets, optionSecrets]) {
    if (list === undefined) continue;
    for (const secret of list) {
      seen.add(secret);
    }
  }
  return [...seen];
}

export async function buildDeployBundle(
  options: BuildDeployBundleOptions = {},
  io: CliIo,
  deps: WasmcloudDeps = DEFAULT_DEPS,
): Promise<DeployBundle> {
  const startDir = options.project?.projectRoot ?? deps.cwd();
  const hasExplicitRegistryOrPublish = Boolean(
    options.registry !== undefined ||
      options.publish !== undefined ||
      options.credentials !== undefined,
  );
  const manifestConfig = loadBundleManifestConfig(startDir, deps.env, hasExplicitRegistryOrPublish);
  const manifest = manifestConfig.manifest;

  const project =
    options.project ??
    (manifest !== undefined && options.name !== undefined
      ? resolveApplication(deps.cwd(), options.name, manifest.workspaceRoot, manifest.discovery)
      : loadProject(deps.cwd()));

  const resolvedCredentials =
    typeof options.credentials === 'function' ? await options.credentials() : options.credentials;

  let target: DeployTarget | undefined;
  let connection: ClusterConnection | undefined;
  const shouldResolveTarget = Boolean(
    options.target ?? manifest?.defaultTarget ?? !hasExplicitRegistryOrPublish,
  );
  if (manifest !== undefined && shouldResolveTarget) {
    target = resolveTarget(manifest, options.target);
    connection = await resolveConnection(target, manifest.workspaceRoot, manifest.path, deps);
  }

  const registryOverride = options.registry ?? resolvedCredentials?.registry;
  const effectiveConnection: ClusterConnection =
    connection !== undefined
      ? {
          ...connection,
          hostgroup: connection.hostgroup ?? `tenant-${project.witName}`,
          ...(registryOverride !== undefined
            ? { registry: materializeRegistry(registryOverride) }
            : {}),
        }
      : {
          target: options.target ?? 'bundle',
          kubeconfig: '',
          namespace: `di-tenant-${project.witName}`,
          hostgroup: `tenant-${project.witName}`,
          registry: materializeRegistry(registryOverride ?? 'localhost:5000'),
        };

  const env = options.env ?? target?.env ?? manifestConfig.env ?? 'prod';
  if (env !== 'prod' && env !== 'staging') {
    invalidUsage('Invalid --env value; expected "prod" or "staging"', String(env));
  }

  const service = deploymentResourceName(project);
  const build = await buildComponent(project, io, deps, {
    deploy: true,
    guestLogging: project.logs !== false,
  });

  const publishContext: BundlePublishContext = {
    project,
    connection: effectiveConnection,
    build,
    io,
    deps,
    tag: options.tag,
    credentials: resolvedCredentials,
  };
  const published = options.publish
    ? await options.publish(publishContext)
    : await publishWithBundleOptions(publishContext);

  const isPublishedImage = (value: PublishedImage | ComponentReference): value is PublishedImage =>
    'pullReference' in value && 'artifactDigest' in value;
  const rawDigest = isPublishedImage(published) ? published.artifactDigest : published.digest;
  const component: ComponentReference = {
    reference: isPublishedImage(published) ? published.pullReference : published.reference,
    digest: normalizeSha256Digest(rawDigest),
  };

  const requirements = requirementsForProject(project, deps);
  const discoveredBindings = discoverBindings(project, deps);
  const actors = discoverActors(project);
  const cronJobs = discoverScheduledJobs(project.projectRoot);
  const queueHandlers = discoverQueueHandlers(project);
  const isWorker = isQueueWorkerProject(project, queueHandlers);
  const publicIngress = project.ingress !== false && !isWorker;

  const manifestYaml = renderWorkloadManifest(
    project,
    effectiveConnection,
    ociReference(effectiveConnection.registry.pull, project.witName, build.deploymentDigest),
    requirements,
    discoveredBindings,
    {
      hasActors: actors.length > 0,
      hasPersistentStorage: project.persistentStorage === true,
    },
    cronJobs,
    queueHandlers,
  );
  const parsedWorkload = parseWorkloadDeploymentYaml(manifestYaml);
  const workload = sanitizeWorkloadForBundle(parsedWorkload, {
    service,
    env,
    component,
    publicIngress,
    labels: options.labels,
    annotations: options.annotations,
  });

  const bindings = collectDeployBindings(
    manifestConfig.bindings,
    target?.bindings,
    discoveredBindings,
    options.bindings,
  );
  const secrets = collectDeploySecrets(manifestConfig.secrets, target?.secrets, options.secrets);

  const bundle: DeployBundle = {
    env,
    service,
    component,
    workload,
    bindings,
    secrets,
  };

  if (options.outputPath !== undefined) {
    const absoluteOut = resolve(deps.cwd(), options.outputPath);
    mkdirSync(dirname(absoluteOut), { recursive: true });
    writeFileSync(absoluteOut, `${JSON.stringify(bundle, null, 2)}\n`);
    io.stdout.write(`Wrote DeployBundle for ${service} (${env}) to ${options.outputPath}\n`);
  }

  return bundle;
}
