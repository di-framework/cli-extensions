import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CliIo, CommandFailure, type JsonValue } from '@di-framework/cli-extension';
import { readEnvFlag, readStringFlag } from './args';
import { resolveControllerSession, wrapControllerError } from './controller';
import { DEFAULT_DEPS, type WasmcloudDeps } from './deps';
import { captureKubectl } from './kubernetes';
import {
  type AccountTarget,
  type ControllerTarget,
  type DeployEnvironment,
  type DeployManifest,
  loadDeployManifest,
  tenantNamespace,
} from './manifest';
import { isNamespace } from './namespace';
import { invalidUsage, matchOption } from './support';
import {
  type ClusterConnection,
  isControllerBackedTarget,
  resolveConnection,
  resolveTarget,
} from './target';

export const BACKING_SERVICE_API_VERSION = 'platform.di-framework.dev/v1alpha1';
export const BACKING_SERVICE_KIND = 'BackingService';
export const BACKING_SERVICE_RESOURCE = 'backingservices.platform.di-framework.dev';
export const BACKING_SERVICE_CLASS_RESOURCE = 'backingserviceclasses.platform.di-framework.dev';

export const SERVICE_TYPES = ['keyvalue', 'messaging', 'blobstore', 'postgres', 'egress'] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];

export const DEFAULT_SERVICE_CLASSES = {
  keyvalue: 'keyvalue-redis',
  messaging: 'messaging-nats',
  blobstore: 'blobstore-nats',
  postgres: 'postgres-dedicated',
  egress: 'egress-public',
} as const satisfies Record<ServiceType, string>;

export const DEFAULT_SERVICE_PROVIDERS = {
  keyvalue: 'redis',
  messaging: 'nats',
  blobstore: 'nats',
  postgres: 'postgres',
  egress: 'platform',
} as const satisfies Record<ServiceType, string>;

export const DEFAULT_WAIT_TIMEOUT_MS = 120_000;
export const WAIT_POLL_INTERVAL_MS = 2_000;

const NAME_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const QUANTITY_PATTERN = /^[0-9]+(\.[0-9]+)?(m|Ki|Mi|Gi|Ti)?$/;
/** `host`, `*.suffix`, optionally with `:port`; matches the BackingService egress schema. */
const DESTINATION_PATTERN =
  /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::([0-9]{1,5}))?$/;
const DELETION_POLICIES = ['Retain', 'Delete'] as const;
export type DeletionPolicy = (typeof DELETION_POLICIES)[number];

export type ServiceSizingParameters = {
  storage?: string;
  memory?: string;
  cpu?: string;
};

export type ServiceCreateOptions = {
  type?: ServiceType;
  name?: string;
  className?: string;
  parameters?: ServiceSizingParameters;
  deletionPolicy?: DeletionPolicy;
  /** Egress only: hosts the workload may reach. */
  destinations?: string[];
  target?: string;
  env?: DeployEnvironment;
  namespace?: string;
  context?: string;
  wait: boolean;
  timeoutMs: number;
};

export type ServiceNameOptions = {
  name?: string;
  target?: string;
  env?: DeployEnvironment;
  namespace?: string;
  context?: string;
};

export type ServiceListOptions = {
  target?: string;
  namespace?: string;
  context?: string;
};

type ReadyCondition = {
  type?: string;
  status?: string;
  reason?: string;
  message?: string;
};

type BackingServiceDocument = {
  metadata?: { name?: string; namespace?: string; deletionTimestamp?: string };
  spec?: {
    type?: string;
    className?: string;
    parameters?: ServiceSizingParameters;
    deletionPolicy?: string;
    destinations?: string[];
  };
  status?: {
    conditions?: ReadyCondition[];
    approved?: string[];
    endpoint?: { host?: string; port?: number; capability?: string };
    classRef?: { name?: string };
    runtimeNamespace?: string;
  };
};

export type ServiceSummary = {
  name: string;
  namespace: string;
  type: string;
  className: string;
  ready: string;
  reason?: string;
  message?: string;
  endpoint?: { host: string; port: number; capability: string };
  deletionPolicy?: string;
  destinations?: string[];
  approved?: string[];
};

export function isServiceType(value: string): value is ServiceType {
  return (SERVICE_TYPES as readonly string[]).includes(value);
}

/** An egress destination: `host`, `*.suffix`, `host:port`, or `*.suffix:port`. */
export function isEgressDestination(value: string): boolean {
  const match = DESTINATION_PATTERN.exec(value);
  if (match === null || value.length > 260) return false;
  return match[1] === undefined || (Number(match[1]) >= 1 && Number(match[1]) <= 65535);
}

/** DNS-label rules aligned with the BackingService CRD metadata.name schema (max 40). */
export function isBackingServiceName(value: string, max = 40): boolean {
  return value.length >= 1 && value.length <= max && NAME_PATTERN.test(value);
}

export function serviceTypeDiscoveryText(): string {
  const lines = [
    'Supported resource types:',
    '  keyvalue    default class keyvalue-redis',
    '  messaging   default class messaging-nats',
    '  blobstore   default class blobstore-nats',
    '  postgres    default class postgres-dedicated',
    '  egress      default class egress-public (needs --destination)',
    '',
    'Usage: di-framework platform service create <type> --name=<name> [--class=<class>]',
    '       di-framework platform service create egress <name> --destination <host[:port]> [--destination …]',
    'Discover classes: di-framework platform service classes',
  ];
  return `${lines.join('\n')}\n`;
}

export function buildBackingServiceManifest(options: {
  name: string;
  type: ServiceType;
  className?: string;
  parameters?: ServiceSizingParameters;
  deletionPolicy?: DeletionPolicy;
  destinations?: readonly string[];
}): Record<string, unknown> {
  const spec: Record<string, unknown> = { type: options.type };
  if (options.destinations !== undefined) spec.destinations = [...options.destinations];
  if (options.className !== undefined) spec.className = options.className;
  if (options.parameters !== undefined && Object.keys(options.parameters).length > 0) {
    spec.parameters = options.parameters;
  }
  if (options.deletionPolicy !== undefined) spec.deletionPolicy = options.deletionPolicy;
  return {
    apiVersion: BACKING_SERVICE_API_VERSION,
    kind: BACKING_SERVICE_KIND,
    metadata: { name: options.name },
    spec,
  };
}

const SERVICE_CREATE_STRING_FLAGS = {
  '--name': 'name',
  '--class': 'className',
  '--target': 'target',
  '--namespace': 'namespace',
  '--context': 'context',
} as const;

const SERVICE_SIZING_FLAGS = {
  '--memory': 'memory',
  '--storage': 'storage',
  '--cpu': 'cpu',
} as const;

const SERVICE_LIST_STRING_FLAGS = {
  '--target': 'target',
  '--namespace': 'namespace',
  '--context': 'context',
} as const;

export function parseServiceCreateArgs(args: readonly string[]): ServiceCreateOptions {
  let type: ServiceType | undefined;
  const values: Partial<
    Record<(typeof SERVICE_CREATE_STRING_FLAGS)[keyof typeof SERVICE_CREATE_STRING_FLAGS], string>
  > = {};
  let deletionPolicy: DeletionPolicy | undefined;
  let env: DeployEnvironment | undefined;
  let wait = false;
  let timeoutMs = DEFAULT_WAIT_TIMEOUT_MS;
  let timeoutExplicit = false;
  const parameters: ServiceSizingParameters = {};
  const destinations: string[] = [];

  let position = 0;
  while (position < args.length) {
    const token = args[position] as string;
    const nextStringPos = readStringFlag(
      args,
      position,
      token,
      SERVICE_CREATE_STRING_FLAGS,
      values,
    );
    if (nextStringPos !== undefined) {
      position = nextStringPos;
      continue;
    }
    const nextSizingPos = readStringFlag(args, position, token, SERVICE_SIZING_FLAGS, parameters);
    if (nextSizingPos !== undefined) {
      position = nextSizingPos;
      continue;
    }
    const envOpt = readEnvFlag(args, position, token, env, 'platform service create');
    if (envOpt) {
      env = envOpt.value;
      position = envOpt.nextPosition;
      continue;
    }
    const deletionOpt = matchOption(args, position, token, '--deletion-policy');
    if (deletionOpt) {
      if (deletionPolicy !== undefined)
        invalidUsage('Option may be provided only once: --deletion-policy', '--deletion-policy');
      if (!(DELETION_POLICIES as readonly string[]).includes(deletionOpt.value)) {
        invalidUsage('deletionPolicy must be Retain or Delete', deletionOpt.value, {
          command: 'platform service create',
        });
      }
      deletionPolicy = deletionOpt.value as DeletionPolicy;
      position = deletionOpt.consumedThrough + 1;
      continue;
    }
    const timeoutOpt = matchOption(args, position, token, '--timeout');
    if (timeoutOpt) {
      if (timeoutExplicit) invalidUsage('Option may be provided only once: --timeout', '--timeout');
      timeoutExplicit = true;
      const parsed = Number(timeoutOpt.value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        invalidUsage('--timeout must be a positive number of seconds', timeoutOpt.value);
      }
      timeoutMs = Math.floor(parsed * 1000);
      position = timeoutOpt.consumedThrough + 1;
      continue;
    }
    const destinationOpt = matchOption(args, position, token, '--destination');
    if (destinationOpt) {
      destinations.push(destinationOpt.value);
      position = destinationOpt.consumedThrough + 1;
      continue;
    }
    if (token === '--wait') {
      if (wait) invalidUsage('Option may be provided only once: --wait', '--wait');
      wait = true;
      position += 1;
      continue;
    }
    if (token.startsWith('--')) {
      invalidUsage(`Unknown option: ${token}`, token, { command: 'platform service create' });
    }
    if (type !== undefined) {
      // `service create egress <name>`: the name may follow the type instead of --name.
      if (values.name !== undefined)
        invalidUsage(`Unexpected argument: ${token}`, token, {
          command: 'platform service create',
        });
      values.name = token;
      position += 1;
      continue;
    }
    if (!isServiceType(token)) {
      invalidUsage(
        `Unknown service type "${token}". Supported types: ${SERVICE_TYPES.join(', ')}`,
        token,
        { command: 'platform service create', types: [...SERVICE_TYPES] },
      );
    }
    type = token;
    position += 1;
  }

  return {
    type,
    name: values.name,
    className: values.className,
    deletionPolicy,
    target: values.target,
    ...(env ? { env } : {}),
    namespace: values.namespace,
    context: values.context,
    wait,
    timeoutMs,
    parameters: Object.keys(parameters).length > 0 ? parameters : undefined,
    ...(destinations.length > 0 ? { destinations } : {}),
  };
}

export function parseServiceNameArgs(args: readonly string[], command: string): ServiceNameOptions {
  let name: string | undefined;
  const values: ServiceListOptions = {};
  let env: DeployEnvironment | undefined;

  let position = 0;
  while (position < args.length) {
    const token = args[position] as string;
    const nextPos = readStringFlag(args, position, token, SERVICE_LIST_STRING_FLAGS, values);
    if (nextPos !== undefined) {
      position = nextPos;
      continue;
    }
    const envOpt = readEnvFlag(args, position, token, env, command);
    if (envOpt) {
      env = envOpt.value;
      position = envOpt.nextPosition;
      continue;
    }
    if (token.startsWith('--')) {
      invalidUsage(`Unknown option: ${token}`, token, { command });
    }
    if (name !== undefined) {
      invalidUsage(`Unexpected argument: ${token}`, token, { command });
    }
    name = token;
    position += 1;
  }

  return {
    name,
    target: values.target,
    ...(env ? { env } : {}),
    namespace: values.namespace,
    context: values.context,
  };
}

export function parseServiceListArgs(args: readonly string[]): ServiceListOptions {
  const values: ServiceListOptions = {};

  let position = 0;
  while (position < args.length) {
    const token = args[position] as string;
    const nextPos = readStringFlag(args, position, token, SERVICE_LIST_STRING_FLAGS, values);
    if (nextPos !== undefined) {
      position = nextPos;
      continue;
    }
    if (token.startsWith('--')) {
      invalidUsage(`Unknown option: ${token}`, token, { command: 'platform service list' });
    }
    invalidUsage(`Unexpected argument: ${token}`, token, { command: 'platform service list' });
  }

  return {
    target: values.target,
    namespace: values.namespace,
    context: values.context,
  };
}

function validateSizing(parameters: ServiceSizingParameters | undefined): void {
  if (!parameters) return;
  for (const [key, value] of Object.entries(parameters)) {
    if (typeof value !== 'string' || !QUANTITY_PATTERN.test(value)) {
      invalidUsage(`parameters.${key} must be a Kubernetes quantity`, String(value), {
        command: 'platform service create',
      });
    }
  }
}

function validateDestinations(type: ServiceType, options: ServiceCreateOptions): void {
  const command = { command: 'platform service create' };
  if (type !== 'egress') {
    if (options.destinations !== undefined)
      invalidUsage('--destination applies only to egress services', '--destination', command);
    return;
  }
  if (options.destinations === undefined)
    invalidUsage(
      'Missing required --destination for an egress service (host, *.suffix, host:port, or *.suffix:port)',
      '--destination',
      command,
    );
  for (const destination of options.destinations) {
    if (!isEgressDestination(destination))
      invalidUsage(
        `Invalid destination "${destination}". Use host, *.suffix, host:port, or *.suffix:port`,
        destination,
        command,
      );
  }
  if (options.parameters !== undefined || options.deletionPolicy !== undefined)
    invalidUsage('Egress services take no sizing or deletion-policy options', 'egress', command);
}

function validateCreateOptions(options: ServiceCreateOptions): {
  type: ServiceType;
  name: string;
} {
  if (options.type === undefined) {
    throw new CommandFailure(
      'INVALID_USAGE',
      `Missing service type.\n${serviceTypeDiscoveryText().trimEnd()}`,
      2,
      {
        command: 'platform service create',
        types: [...SERVICE_TYPES],
        defaultClasses: { ...DEFAULT_SERVICE_CLASSES },
      },
    );
  }
  if (options.name === undefined) {
    invalidUsage('Missing required --name for platform service create', '--name', {
      command: 'platform service create',
    });
  }
  if (!isBackingServiceName(options.name)) {
    invalidUsage(
      `Invalid service name "${options.name}". Names must be DNS labels: lowercase alphanumeric segments separated by hyphens, at most 40 characters`,
      options.name,
      { command: 'platform service create' },
    );
  }
  if (options.className !== undefined && !isBackingServiceName(options.className)) {
    invalidUsage(
      `Invalid class name "${options.className}". Class names must be DNS labels of at most 40 characters`,
      options.className,
      { command: 'platform service create' },
    );
  }
  validateSizing(options.parameters);
  validateDestinations(options.type, options);
  return { type: options.type, name: options.name };
}

async function resolveServiceConnection(
  options: { target?: string; namespace?: string; context?: string },
  deps: WasmcloudDeps,
): Promise<ClusterConnection> {
  const manifest = loadDeployManifest(deps.cwd(), deps.env);
  const target = resolveTarget(manifest, options.target);
  const connection = await resolveConnection(target, manifest.workspaceRoot, manifest.path, deps);
  if (options.namespace !== undefined) {
    if (!isNamespace(options.namespace)) {
      invalidUsage(
        'namespace must be a Kubernetes namespace (a DNS label of at most 63 characters)',
        options.namespace,
      );
    }
    connection.namespace = options.namespace;
  }
  if (options.context !== undefined) {
    connection.context = options.context;
  }
  return connection;
}

function kubectlFailure(
  verb: string,
  result: { exitCode: number; stdout: string; stderr: string },
  details: Record<string, JsonValue> = {},
): CommandFailure {
  const rawDetail =
    result.stderr.trim() || result.stdout.trim() || `kubectl exited ${result.exitCode}`;
  const detail = rawDetail.split('\n').slice(0, 12).join('\n');
  const lower = detail.toLowerCase();
  if (lower.includes('alreadyexists') || lower.includes('already exists')) {
    return new CommandFailure(
      'WASMCLOUD_SERVICE_ALREADY_EXISTS',
      `BackingService already exists: ${detail}`,
      2,
      { ...details, stderr: detail },
    );
  }
  if (
    lower.includes('forbidden') ||
    lower.includes('unauthorized') ||
    lower.includes('access denied')
  ) {
    return new CommandFailure(
      'WASMCLOUD_SERVICE_UNAUTHORIZED',
      `Not authorized to ${verb} BackingService: ${detail}`,
      3,
      { ...details, stderr: detail },
    );
  }
  if (lower.includes('not found') && verb === 'get') {
    return new CommandFailure(
      'WASMCLOUD_SERVICE_NOT_FOUND',
      `BackingService not found: ${detail}`,
      2,
      { ...details, stderr: detail },
    );
  }
  if (
    lower.includes('being used') ||
    lower.includes('in use') ||
    lower.includes('finalizer') ||
    lower.includes('cannot delete')
  ) {
    return new CommandFailure(
      'WASMCLOUD_SERVICE_IN_USE',
      `BackingService could not be deleted (in use or retention finalizers): ${detail}`,
      3,
      { ...details, stderr: detail },
    );
  }
  return new CommandFailure(
    'WASMCLOUD_TOOL_FAILED',
    `kubectl ${verb} failed with exit code ${result.exitCode}: ${detail}`,
    3,
    { command: `kubectl ${verb}`, exitCode: result.exitCode, stderr: detail, ...details },
  );
}

function readyCondition(document: BackingServiceDocument): ReadyCondition | undefined {
  return (document.status?.conditions ?? []).find((condition) => condition.type === 'Ready');
}

export function summarizeService(document: BackingServiceDocument): ServiceSummary {
  const ready = readyCondition(document);
  const endpoint = document.status?.endpoint;
  const defaultClass =
    document.spec?.type && isServiceType(document.spec.type)
      ? DEFAULT_SERVICE_CLASSES[document.spec.type]
      : '';
  const className = document.spec?.className || document.status?.classRef?.name || defaultClass;
  return {
    name: document.metadata?.name ?? '',
    namespace: document.metadata?.namespace ?? '',
    type: document.spec?.type ?? '',
    className,
    ready: ready?.status ?? 'Unknown',
    ...(ready?.reason ? { reason: ready.reason } : {}),
    ...(ready?.message ? { message: ready.message } : {}),
    ...(endpoint?.host !== undefined && endpoint.port !== undefined
      ? {
          endpoint: {
            host: endpoint.host,
            port: endpoint.port,
            capability: endpoint.capability ?? document.spec?.type ?? '',
          },
        }
      : {}),
    ...(document.spec?.deletionPolicy ? { deletionPolicy: document.spec.deletionPolicy } : {}),
    ...(document.spec?.destinations ? { destinations: document.spec.destinations } : {}),
    ...(document.status?.approved ? { approved: document.status.approved } : {}),
  };
}

function formatServiceTable(services: ServiceSummary[]): string {
  if (services.length === 0) return 'No BackingService resources found.\n';
  const headers = ['NAME', 'TYPE', 'CLASS', 'READY', 'ENDPOINT'];
  const rows = services.map((service) => [
    service.name,
    service.type,
    service.className || '-',
    service.ready,
    service.endpoint
      ? `${service.endpoint.host}:${service.endpoint.port}`
      : (service.destinations?.join(',') ?? '-'),
  ]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const line = (cells: string[]) =>
    cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join('  ');
  return `${[line(headers), ...rows.map(line)].join('\n')}\n`;
}

function formatServiceDetail(summary: ServiceSummary): string {
  const lines = [
    `Name: ${summary.name}`,
    `Namespace: ${summary.namespace}`,
    `Type: ${summary.type}`,
    `Class: ${summary.className || '-'}`,
    `Ready: ${summary.ready}${summary.reason ? ` (${summary.reason})` : ''}`,
  ];
  if (summary.message) lines.push(`Message: ${summary.message}`);
  if (summary.endpoint) {
    lines.push(
      `Endpoint: ${summary.endpoint.host}:${summary.endpoint.port} (${summary.endpoint.capability})`,
    );
  }
  if (summary.deletionPolicy) lines.push(`Deletion policy: ${summary.deletionPolicy}`);
  if (summary.destinations) lines.push(`Destinations: ${summary.destinations.join(', ')}`);
  if (summary.approved) lines.push(`Approved: ${summary.approved.join(', ') || '-'}`);
  return `${lines.join('\n')}\n`;
}

function isServiceReady(document: BackingServiceDocument): boolean {
  return readyCondition(document)?.status === 'True';
}

async function waitForServiceReady(
  connection: ClusterConnection,
  name: string,
  timeoutMs: number,
  deps: WasmcloudDeps,
  io: CliIo,
): Promise<BackingServiceDocument> {
  const deadline = Date.now() + timeoutMs;
  let last: BackingServiceDocument | undefined;
  while (Date.now() <= deadline) {
    const result = await captureKubectl(
      deps,
      connection,
      ['get', BACKING_SERVICE_RESOURCE, name, '-o', 'json'],
      deps.cwd(),
    );
    if (result.exitCode === 0) {
      try {
        last = JSON.parse(result.stdout) as BackingServiceDocument;
        if (isServiceReady(last)) return last;
        const ready = readyCondition(last);
        if (ready?.status === 'False' && ready.reason === 'Failed') {
          throw new CommandFailure(
            'WASMCLOUD_SERVICE_PROVISIONING_FAILED',
            `BackingService ${name} failed provisioning: ${ready.message ?? ready.reason}`,
            3,
            {
              name,
              namespace: connection.namespace,
              reason: ready.reason,
              message: ready.message,
            },
          );
        }
      } catch (error) {
        if (error instanceof CommandFailure) throw error;
      }
    }
    await deps.wait(WAIT_POLL_INTERVAL_MS);
  }
  const summary = last ? summarizeService(last) : undefined;
  if (io !== undefined) {
    io.stderr.write(
      `BackingService ${name} did not become Ready within ${Math.floor(timeoutMs / 1000)}s` +
        (summary?.message ? `: ${summary.message}` : '') +
        '\n',
    );
  }
  throw new CommandFailure(
    'WASMCLOUD_SERVICE_NOT_READY',
    `BackingService ${name} in ${connection.namespace} did not become Ready within ${Math.floor(timeoutMs / 1000)}s`,
    3,
    {
      name,
      namespace: connection.namespace,
      ...(summary ? { status: summary as unknown as JsonValue } : {}),
    },
  );
}

async function getServiceDocument(
  connection: ClusterConnection,
  name: string,
  deps: WasmcloudDeps,
): Promise<BackingServiceDocument> {
  const result = await captureKubectl(
    deps,
    connection,
    ['get', BACKING_SERVICE_RESOURCE, name, '-o', 'json'],
    deps.cwd(),
  );
  if (result.exitCode !== 0) {
    throw kubectlFailure('get', result, { name, namespace: connection.namespace });
  }
  try {
    return JSON.parse(result.stdout) as BackingServiceDocument;
  } catch {
    throw new CommandFailure(
      'WASMCLOUD_TOOL_FAILED',
      `kubectl get returned unparseable JSON for BackingService ${name}`,
      3,
      { name, namespace: connection.namespace },
    );
  }
}

async function runControllerServiceCreate(
  type: ServiceType,
  name: string,
  options: ServiceCreateOptions,
  target: AccountTarget | ControllerTarget,
  deployManifest: DeployManifest,
  deps: WasmcloudDeps,
) {
  try {
    const { credential, client } = await resolveControllerSession({ target }, deps);
    const env = options.env ?? target.env ?? deployManifest.env ?? 'prod';
    const created = await client.createService({
      env,
      type,
      name,
      className: options.className,
      parameters: options.parameters,
      deletionPolicy: options.deletionPolicy,
      destinations: options.destinations,
    });
    const data = {
      name: created.name,
      type: created.type,
      className: created.className,
      env: created.env,
      account: credential.account,
      namespace: tenantNamespace(credential.account),
      target: target.name,
      ...(created.parameters ? { parameters: created.parameters } : {}),
      ...(created.deletionPolicy ? { deletionPolicy: created.deletionPolicy } : {}),
      ...(created.destinations ? { destinations: created.destinations } : {}),
      wait: options.wait,
      ready: 'True',
      createdAt: created.createdAt,
      resource: { apiVersion: BACKING_SERVICE_API_VERSION, kind: BACKING_SERVICE_KIND },
    };
    const text = `Created ${created.type} service ${created.name} (${created.className}) in ${created.env} (${credential.account}).`;
    return { data, text };
  } catch (error) {
    wrapControllerError(error);
  }
}

export async function runWasmcloudServiceCreate(
  args: readonly string[],
  io: CliIo,
  deps: WasmcloudDeps = DEFAULT_DEPS,
) {
  const options = parseServiceCreateArgs(args);
  const { type, name } = validateCreateOptions(options);
  const deployManifest = loadDeployManifest(deps.cwd(), deps.env);
  const target = resolveTarget(deployManifest, options.target);

  if (isControllerBackedTarget(target)) {
    return runControllerServiceCreate(type, name, options, target, deployManifest, deps);
  }

  const connection = await resolveServiceConnection(options, deps);
  const existing = await captureKubectl(
    deps,
    connection,
    ['get', BACKING_SERVICE_RESOURCE, name, '-o', 'name'],
    deps.cwd(),
  );
  if (existing.exitCode === 0) {
    throw new CommandFailure(
      'WASMCLOUD_SERVICE_ALREADY_EXISTS',
      `BackingService "${name}" already exists in namespace ${connection.namespace}. Choose a different --name or delete the existing resource first.`,
      2,
      { name, namespace: connection.namespace, target: connection.target },
    );
  }

  const manifest = buildBackingServiceManifest({
    name,
    type,
    className: options.className,
    parameters: options.parameters,
    deletionPolicy: options.deletionPolicy,
    destinations: options.destinations,
  });
  const dir = mkdtempSync(join(tmpdir(), 'di-backing-service-'));
  const path = join(dir, `${name}.json`);
  try {
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    io.stdout.write(`Creating BackingService ${name} (${type}) in ${connection.namespace}...\n`);
    const created = await captureKubectl(deps, connection, ['create', '-f', path], deps.cwd());
    if (created.exitCode !== 0) {
      throw kubectlFailure('create', created, {
        name,
        namespace: connection.namespace,
        target: connection.target,
      });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  let document: BackingServiceDocument | undefined;
  if (options.wait) {
    document = await waitForServiceReady(connection, name, options.timeoutMs, deps, io);
  }

  const summary = document
    ? summarizeService(document)
    : {
        name,
        namespace: connection.namespace,
        type,
        className: options.className ?? DEFAULT_SERVICE_CLASSES[type],
        ready: 'Unknown',
        ...(options.deletionPolicy ? { deletionPolicy: options.deletionPolicy } : {}),
      };

  const context = options.context ?? connection.context;
  return {
    data: {
      name,
      type,
      className: summary.className,
      namespace: connection.namespace,
      target: connection.target,
      ...(context !== undefined ? { context } : {}),
      ...(options.parameters ? { parameters: options.parameters } : {}),
      ...(options.deletionPolicy ? { deletionPolicy: options.deletionPolicy } : {}),
      ...(options.destinations ? { destinations: options.destinations } : {}),
      wait: options.wait,
      ready: summary.ready,
      ...(summary.endpoint ? { endpoint: summary.endpoint } : {}),
      resource: {
        apiVersion: BACKING_SERVICE_API_VERSION,
        kind: BACKING_SERVICE_KIND,
      },
    },
    text: options.wait
      ? `Created BackingService ${name} in ${connection.namespace} (Ready=${summary.ready}).`
      : `Created BackingService ${name} in ${connection.namespace}. Use --wait to block until Ready.`,
  };
}

export async function runWasmcloudServiceList(
  args: readonly string[],
  _io: CliIo,
  deps: WasmcloudDeps = DEFAULT_DEPS,
) {
  const options = parseServiceListArgs(args);
  const connection = await resolveServiceConnection(options, deps);
  const result = await captureKubectl(
    deps,
    connection,
    ['get', BACKING_SERVICE_RESOURCE, '-o', 'json'],
    deps.cwd(),
  );
  if (result.exitCode !== 0) {
    throw kubectlFailure('get', result, { namespace: connection.namespace });
  }
  let items: BackingServiceDocument[] = [];
  try {
    const list = JSON.parse(result.stdout) as { items?: BackingServiceDocument[] };
    items = list.items ?? [];
  } catch {
    throw new CommandFailure(
      'WASMCLOUD_TOOL_FAILED',
      'kubectl get returned unparseable JSON for BackingService list',
      3,
      { namespace: connection.namespace },
    );
  }
  const services = items.map(summarizeService);
  return {
    data: {
      namespace: connection.namespace,
      target: connection.target,
      services: services as unknown as JsonValue,
    },
    text: formatServiceTable(services),
  };
}

export async function runWasmcloudServiceGet(
  args: readonly string[],
  _io: CliIo,
  deps: WasmcloudDeps = DEFAULT_DEPS,
) {
  const options = parseServiceNameArgs(args, 'platform service get');
  if (options.name === undefined) {
    invalidUsage('Missing service name for platform service get', 'get', {
      command: 'platform service get',
    });
  }
  if (!isBackingServiceName(options.name)) {
    invalidUsage(
      `Invalid service name "${options.name}". Names must be DNS labels of at most 40 characters`,
      options.name,
      { command: 'platform service get' },
    );
  }
  const connection = await resolveServiceConnection(options, deps);
  const document = await getServiceDocument(connection, options.name, deps);
  const summary = summarizeService({
    ...document,
    metadata: {
      ...document.metadata,
      namespace: document.metadata?.namespace ?? connection.namespace,
    },
  });
  return {
    data: {
      ...summary,
      target: connection.target,
    } as unknown as JsonValue,
    text: formatServiceDetail(summary),
  };
}

async function runControllerServiceDelete(
  name: string,
  options: ServiceNameOptions,
  target: AccountTarget | ControllerTarget,
  deployManifest: DeployManifest,
  deps: WasmcloudDeps,
) {
  try {
    const { credential, client } = await resolveControllerSession({ target }, deps);
    const env = options.env ?? target.env ?? deployManifest.env ?? 'prod';
    await client.deleteService(env, name);
    const data = {
      name,
      env,
      account: credential.account,
      namespace: tenantNamespace(credential.account),
      target: target.name,
      deleted: true,
    };
    const text = `Deleted BackingService ${name} from ${env} (${credential.account}).`;
    return { data, text };
  } catch (error) {
    wrapControllerError(error);
  }
}

export async function runWasmcloudServiceDelete(
  args: readonly string[],
  io: CliIo,
  deps: WasmcloudDeps = DEFAULT_DEPS,
) {
  const options = parseServiceNameArgs(args, 'platform service delete');
  if (options.name === undefined) {
    invalidUsage('Missing service name for platform service delete', 'delete', {
      command: 'platform service delete',
    });
  }
  if (!isBackingServiceName(options.name)) {
    invalidUsage(
      `Invalid service name "${options.name}". Names must be DNS labels of at most 40 characters`,
      options.name,
      { command: 'platform service delete' },
    );
  }
  const deployManifest = loadDeployManifest(deps.cwd(), deps.env);
  const target = resolveTarget(deployManifest, options.target);
  if (isControllerBackedTarget(target)) {
    return runControllerServiceDelete(options.name, options, target, deployManifest, deps);
  }

  const connection = await resolveServiceConnection(options, deps);
  let deletionPolicy: string | undefined;
  try {
    const existing = await getServiceDocument(connection, options.name, deps);
    // Egress provisions nothing, so there is nothing to retain.
    if (existing.spec?.type !== 'egress')
      deletionPolicy = existing.spec?.deletionPolicy ?? 'Retain';
  } catch (error) {
    if (error instanceof CommandFailure && error.code === 'WASMCLOUD_SERVICE_NOT_FOUND') {
      throw error;
    }
  }

  io.stdout.write(`Deleting BackingService ${options.name} from ${connection.namespace}...\n`);
  const result = await captureKubectl(
    deps,
    connection,
    ['delete', BACKING_SERVICE_RESOURCE, options.name],
    deps.cwd(),
  );
  if (result.exitCode !== 0) {
    throw kubectlFailure('delete', result, {
      name: options.name,
      namespace: connection.namespace,
    });
  }

  const retentionNote =
    deletionPolicy === 'Retain'
      ? ' DeletionPolicy=Retain: provisioned infrastructure may be retained after the custom resource is removed.'
      : deletionPolicy === 'Delete'
        ? ' DeletionPolicy=Delete: provisioned infrastructure should be cleaned up by the controller.'
        : '';

  return {
    data: {
      name: options.name,
      namespace: connection.namespace,
      target: connection.target,
      deleted: true,
      ...(deletionPolicy ? { deletionPolicy } : {}),
    },
    text: `Deleted BackingService ${options.name} from ${connection.namespace}.${retentionNote}`,
  };
}

export async function runWasmcloudServiceClasses(
  args: readonly string[],
  _io: CliIo,
  deps: WasmcloudDeps = DEFAULT_DEPS,
) {
  const options = parseServiceListArgs(args);
  const connection = await resolveServiceConnection(options, deps);
  const result = await captureKubectl(
    deps,
    connection,
    ['get', BACKING_SERVICE_CLASS_RESOURCE, '-o', 'json'],
    deps.cwd(),
  );

  type ClassItem = {
    metadata?: { name?: string };
    spec?: { type?: string; provider?: string; default?: boolean };
  };

  let items: ClassItem[] = [];
  if (result.exitCode === 0) {
    try {
      items = (JSON.parse(result.stdout) as { items?: ClassItem[] }).items ?? [];
    } catch {
      items = [];
    }
  }

  const classes =
    items.length > 0
      ? items.map((item) => ({
          name: item.metadata?.name ?? '',
          type: item.spec?.type ?? '',
          provider: item.spec?.provider ?? '',
          default: item.spec?.default === true,
        }))
      : SERVICE_TYPES.map((type) => ({
          name: DEFAULT_SERVICE_CLASSES[type],
          type,
          provider: DEFAULT_SERVICE_PROVIDERS[type],
          default: true,
        }));

  const headers = ['NAME', 'TYPE', 'PROVIDER', 'DEFAULT'];
  const rows = classes.map((cls) => [
    cls.name,
    cls.type,
    cls.provider,
    cls.default ? 'true' : 'false',
  ]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const line = (cells: string[]) =>
    cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join('  ');
  const fallbackNote =
    result.exitCode !== 0 ? 'Cluster classes unavailable; showing platform defaults.\n' : '';

  return {
    data: {
      namespace: connection.namespace,
      target: connection.target,
      classes: classes as unknown as JsonValue,
      fromCluster: result.exitCode === 0,
    },
    text: `${fallbackNote}${[line(headers), ...rows.map(line)].join('\n')}\n`,
  };
}
