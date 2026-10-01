import type { DeployManifest, DeployTarget } from '../manifest';
import { materializeRegistry, registryReferenceHost } from '../registry';
import { STORAGE_HOSTGROUP } from '../workload';
import { ConsoleError } from './errors';

const RESOURCE_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const LOOKUP_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/i;
const QUEUE_SETTING = /^DI_QUEUE_([A-Z0-9_]+)_(CONCURRENCY|MAX_RETRIES|BACKOFF_MS|TIMEOUT_MS)$/;
const SENSITIVE_KEY = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|API_KEY|_KEY$)/i;
const USERINFO = /:\/\/[^/\s:]+:[^/\s@]+@/;
const PLATFORM_VISIBLE_CONTROL = new Set(['DI_CONTROL_REJECT_FORWARDED', 'DI_CONTROL_HTTP_HOST']);

export type JsonPatchOp = {
  op: 'add' | 'replace';
  path: string;
  value: unknown;
};

export type ConfigEntry = {
  key: string;
  sensitive: boolean;
  value?: string;
};

export type QueueSetting = {
  key: string;
  label: string;
  value: number;
  min: number;
  max: number;
};

export type HostInterfaceView = {
  name?: string;
  reference: string;
  interfaces: string[];
  config: ConfigEntry[];
};

export type CronView = {
  name: string;
  schedule: string;
  suspend: boolean;
  jobId?: string;
  application?: string;
  concurrencyPolicy?: string;
};

export type AppView = {
  target: string;
  namespace: string;
  name: string;
  application?: string;
  workload?: string;
  ready: boolean;
  reason?: string;
  message?: string;
  desiredReplicas: number;
  readyReplicas: number;
  pinnedReplicas: boolean;
  deployPolicy?: string;
  environmentName?: string;
  hostgroup?: string;
  httpHost?: string;
  image?: string;
  credentialsConfigured: boolean;
  controlPlane: boolean;
  allowedIpNameLookups: string[];
  config: ConfigEntry[];
  queueSettings: QueueSetting[];
  hostInterfaces: HostInterfaceView[];
  volumes: Array<{ name: string; hostPath?: string; mountPath?: string }>;
  cronJobs: CronView[];
};

export type TargetView = {
  name: string;
  kind: 'managed' | 'external';
  default: boolean;
  namespace?: string;
  context?: string;
  hostgroup?: string;
  stack?: string;
  platform?: string;
  registryHost?: string;
};

export type WorkloadDocument = {
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string> };
  spec?: {
    replicas?: number;
    deployPolicy?: string;
    template?: {
      spec?: {
        environment?: string;
        hostSelector?: { hostgroup?: string };
        volumes?: Array<{ name?: string; hostPath?: { path?: string } }>;
        components?: WorkloadComponent[];
      };
    };
  };
  status?: {
    readyReplicas?: number;
    replicas?: { ready?: number };
    conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }>;
  };
};

type WorkloadComponent = {
  name?: string;
  image?: string;
  localResources?: {
    environment?: {
      config?: Record<string, string>;
      secretFrom?: unknown[];
    };
    volumeMounts?: Array<{ name?: string; mountPath?: string }>;
    allowedIpNameLookups?: string[];
  };
  hostInterfaces?: Array<{
    name?: string;
    namespace?: string;
    package?: string;
    version?: string;
    interfaces?: string[];
    config?: Record<string, string>;
  }>;
};

export type CronJobDocument = {
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string> };
  spec?: { schedule?: string; suspend?: boolean; concurrencyPolicy?: string };
};

export type AppUpdate = {
  replicas?: number;
  allowedIpNameLookups?: string[];
  queueSettings?: Array<{ key: string; value: number }>;
};

const UPDATE_FIELDS = new Set(['target', 'replicas', 'allowedIpNameLookups', 'queueSettings']);

export function assertResourceName(name: string, label: string): void {
  if (!isResourceName(name)) {
    throw new ConsoleError(
      400,
      'INVALID_NAME',
      `${label} must be a DNS label of at most 63 characters.`,
    );
  }
}

export function isResourceName(name: string): boolean {
  return name.length >= 1 && name.length <= 63 && RESOURCE_NAME.test(name);
}

export function listTargetViews(manifest: DeployManifest): TargetView[] {
  return Object.values(manifest.targets)
    .map((target) => targetView(target, manifest.defaultTarget))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function targetView(target: DeployTarget, defaultTarget: string | undefined): TargetView {
  if (target.kind === 'managed') {
    return {
      name: target.name,
      kind: 'managed',
      default: target.name === defaultTarget,
      stack: target.stack,
      platform: target.platform,
    };
  }
  const registry = materializeRegistry(target.registry);
  return {
    name: target.name,
    kind: 'external',
    default: target.name === defaultTarget,
    namespace: target.namespace,
    ...(target.context ? { context: target.context } : {}),
    ...(target.hostgroup ? { hostgroup: target.hostgroup } : {}),
    registryHost: publicRegistryHost(registry.pull),
  };
}

/** A tenant credential is one namespace. Persistent workloads use the storage host group. */
export function workloadInTenantScope(
  document: WorkloadDocument,
  scope: { namespace: string; hostgroup?: string; storageHostgroup?: string },
): boolean {
  const namespace = document.metadata?.namespace;
  if (namespace !== undefined && namespace !== scope.namespace) return false;
  const hostgroup = document.spec?.template?.spec?.hostSelector?.hostgroup;
  if (scope.hostgroup === undefined || hostgroup === undefined) return true;
  const storageHostgroup = scope.storageHostgroup ?? STORAGE_HOSTGROUP;
  return hostgroup === scope.hostgroup || hostgroup === storageHostgroup;
}

export function cronInTenantScope(document: CronJobDocument, namespace: string): boolean {
  const actual = document.metadata?.namespace;
  return actual === undefined || actual === namespace;
}

export function publicRegistryHost(reference: string): string {
  let host = registryReferenceHost(reference);
  const at = host.lastIndexOf('@');
  if (at !== -1) host = host.slice(at + 1);
  const slash = host.indexOf('/');
  if (slash !== -1) host = host.slice(0, slash);
  return host;
}

export function isSensitiveConfigKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

export function queueSettingLabel(key: string): string {
  const match = QUEUE_SETTING.exec(key);
  if (match === null) return key;
  const queue = (match[1] ?? '').toLowerCase().replace(/_/g, ' ');
  const kind = match[2];
  const suffix =
    kind === 'CONCURRENCY'
      ? 'concurrency'
      : kind === 'MAX_RETRIES'
        ? 'max retries'
        : kind === 'BACKOFF_MS'
          ? 'backoff (ms)'
          : 'timeout (ms)';
  return `${queue} ${suffix}`;
}

export function queueSettingBounds(key: string): { min: number; max: number } | undefined {
  if (!QUEUE_SETTING.test(key)) return undefined;
  if (key.endsWith('_CONCURRENCY')) return { min: 1, max: 64 };
  if (key.endsWith('_MAX_RETRIES')) return { min: 0, max: 100 };
  if (key.endsWith('_BACKOFF_MS')) return { min: 0, max: 3_600_000 };
  if (key.endsWith('_TIMEOUT_MS')) return { min: 1, max: 3_600_000 };
  return undefined;
}

export function storagePinsReplicas(document: WorkloadDocument): boolean {
  const spec = document.spec?.template?.spec;
  if ((spec?.volumes ?? []).some((volume) => volume.hostPath?.path !== undefined)) return true;
  const config = componentConfig(document);
  return (
    config.DI_SQLITE_BACKEND !== undefined ||
    config.ACTOR_STORAGE_DIR !== undefined ||
    config.QUEUE_DB_PATH !== undefined
  );
}

export function summarizeWorkload(
  document: WorkloadDocument,
  target: string,
  cronJobs: readonly CronJobDocument[] = [],
): AppView | undefined {
  const name = document.metadata?.name;
  const labels = document.metadata?.labels ?? {};
  if (name === undefined || !isResourceName(name)) return undefined;
  if (labels['app.kubernetes.io/managed-by'] !== 'di-framework') return undefined;

  const component = document.spec?.template?.spec?.components?.[0];
  const config = component?.localResources?.environment?.config ?? {};
  const entries = configEntries(config);
  const queueSettings = queueSettingsFrom(config);
  const lookups = (component?.localResources?.allowedIpNameLookups ?? []).filter(
    (entry): entry is string => typeof entry === 'string',
  );
  const condition = readiness(document);
  const mounts = new Map(
    (component?.localResources?.volumeMounts ?? [])
      .filter((mount) => typeof mount.name === 'string')
      .map((mount) => [mount.name as string, mount.mountPath]),
  );
  const application = labels['di-framework.dev/application'];
  const workload = labels['di-framework.dev/workload'];
  const httpHost = httpHostFrom(component);

  return {
    target,
    namespace: document.metadata?.namespace ?? '',
    name,
    ...(typeof application === 'string' ? { application } : {}),
    ...(typeof workload === 'string' ? { workload } : {}),
    ready: condition.ready,
    ...(condition.reason ? { reason: condition.reason } : {}),
    ...(condition.message ? { message: condition.message } : {}),
    desiredReplicas: document.spec?.replicas ?? 1,
    readyReplicas: document.status?.readyReplicas ?? document.status?.replicas?.ready ?? 0,
    pinnedReplicas: storagePinsReplicas(document),
    ...(document.spec?.deployPolicy ? { deployPolicy: document.spec.deployPolicy } : {}),
    ...(document.spec?.template?.spec?.environment
      ? { environmentName: document.spec.template.spec.environment }
      : {}),
    ...(document.spec?.template?.spec?.hostSelector?.hostgroup
      ? { hostgroup: document.spec.template.spec.hostSelector.hostgroup }
      : {}),
    ...(httpHost ? { httpHost } : {}),
    ...(component?.image ? { image: component.image } : {}),
    credentialsConfigured: (component?.localResources?.environment?.secretFrom?.length ?? 0) > 0,
    controlPlane:
      (component?.localResources?.environment?.secretFrom?.length ?? 0) > 0 ||
      config.DI_CONTROL_REJECT_FORWARDED !== undefined,
    allowedIpNameLookups: lookups,
    config: entries,
    queueSettings,
    hostInterfaces: (component?.hostInterfaces ?? []).map(hostInterfaceView),
    volumes: (document.spec?.template?.spec?.volumes ?? []).map((volume) => ({
      name: volume.name ?? '',
      ...(volume.hostPath?.path ? { hostPath: volume.hostPath.path } : {}),
      ...(volume.name !== undefined && mounts.get(volume.name) !== undefined
        ? { mountPath: mounts.get(volume.name) }
        : {}),
    })),
    cronJobs: cronJobs
      .map(summarizeCron)
      .filter((job): job is CronView => job !== undefined && job.application === name),
  };
}

export function summarizeCron(document: CronJobDocument): CronView | undefined {
  const name = document.metadata?.name;
  const labels = document.metadata?.labels ?? {};
  if (name === undefined || !isResourceName(name)) return undefined;
  if (labels['app.kubernetes.io/managed-by'] !== 'di-framework') return undefined;
  const schedule = document.spec?.schedule;
  if (typeof schedule !== 'string' || schedule.length === 0) return undefined;
  const jobId = labels['di-framework.dev/cron-job'];
  const application = labels['app.kubernetes.io/name'];
  return {
    name,
    schedule,
    suspend: document.spec?.suspend === true,
    ...(typeof jobId === 'string' ? { jobId } : {}),
    ...(typeof application === 'string' ? { application } : {}),
    ...(document.spec?.concurrencyPolicy
      ? { concurrencyPolicy: document.spec.concurrencyPolicy }
      : {}),
  };
}

export function unassignedCronJobs(
  apps: readonly AppView[],
  cronJobs: readonly CronJobDocument[],
): CronView[] {
  const assigned = new Set(apps.flatMap((app) => app.cronJobs.map((job) => job.name)));
  return cronJobs
    .map(summarizeCron)
    .filter((job): job is CronView => job !== undefined && !assigned.has(job.name));
}

export function parseAppUpdate(body: unknown): AppUpdate & { target: string } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ConsoleError(400, 'INVALID_BODY', 'Request body must be an object.');
  }
  const record = body as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !UPDATE_FIELDS.has(key));
  if (unknown.length > 0) {
    throw new ConsoleError(400, 'INVALID_BODY', 'The request contains unsupported fields.');
  }
  if (typeof record.target !== 'string' || record.target.length === 0) {
    throw new ConsoleError(400, 'INVALID_BODY', 'A deployment target is required.');
  }
  const update: AppUpdate & { target: string } = { target: record.target };
  if ('replicas' in record) {
    if (!isInteger(record.replicas, 0, 10)) {
      throw new ConsoleError(
        400,
        'INVALID_REPLICAS',
        'Replicas must be a whole number from 0 through 10.',
      );
    }
    update.replicas = record.replicas;
  }
  if ('allowedIpNameLookups' in record) {
    update.allowedIpNameLookups = parseLookups(record.allowedIpNameLookups);
  }
  if ('queueSettings' in record) {
    update.queueSettings = parseQueueUpdates(record.queueSettings);
  }
  if (
    update.replicas === undefined &&
    update.allowedIpNameLookups === undefined &&
    update.queueSettings === undefined
  ) {
    throw new ConsoleError(400, 'INVALID_BODY', 'Choose at least one setting to update.');
  }
  return update;
}

export function planWorkloadUpdate(document: WorkloadDocument, update: AppUpdate): JsonPatchOp[] {
  const ops: JsonPatchOp[] = [];
  if (update.replicas !== undefined) {
    if (storagePinsReplicas(document) && update.replicas !== 1) {
      throw new ConsoleError(
        400,
        'REPLICAS_PINNED',
        'SQLite-backed workloads stay at 1 replica so the volume is not shared across hosts.',
      );
    }
    if ((document.spec?.replicas ?? 1) !== update.replicas) {
      ops.push({
        op: document.spec?.replicas === undefined ? 'add' : 'replace',
        path: '/spec/replicas',
        value: update.replicas,
      });
    }
  }
  if (update.allowedIpNameLookups !== undefined) {
    const component = document.spec?.template?.spec?.components?.[0];
    if (component === undefined) {
      throw new ConsoleError(
        400,
        'NOT_CONFIGURABLE',
        'This workload has no component to configure.',
      );
    }
    const current = component.localResources?.allowedIpNameLookups ?? [];
    if (!sameStrings(current, update.allowedIpNameLookups)) {
      if (component.localResources === undefined) {
        ops.push({
          op: 'add',
          path: '/spec/template/spec/components/0/localResources',
          value: { allowedIpNameLookups: update.allowedIpNameLookups },
        });
      } else {
        ops.push({
          op: component.localResources.allowedIpNameLookups === undefined ? 'add' : 'replace',
          path: '/spec/template/spec/components/0/localResources/allowedIpNameLookups',
          value: update.allowedIpNameLookups,
        });
      }
    }
  }
  if (update.queueSettings !== undefined) {
    const config = componentConfig(document);
    for (const setting of update.queueSettings) {
      const bounds = queueSettingBounds(setting.key);
      if (bounds === undefined || config[setting.key] === undefined) {
        throw new ConsoleError(
          400,
          'INVALID_QUEUE_SETTING',
          'Queue settings can only change values already declared on the workload.',
        );
      }
      if (!isInteger(setting.value, bounds.min, bounds.max)) {
        throw new ConsoleError(
          400,
          'INVALID_QUEUE_SETTING',
          `${queueSettingLabel(setting.key)} must be a whole number from ${bounds.min} through ${bounds.max}.`,
        );
      }
      if (Number(config[setting.key]) !== setting.value) {
        ops.push({
          op: 'replace',
          path: `/spec/template/spec/components/0/localResources/environment/config/${setting.key}`,
          value: String(setting.value),
        });
      }
    }
  }
  return ops;
}

export function parseCronUpdate(body: unknown): { target: string; suspend: boolean } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ConsoleError(400, 'INVALID_BODY', 'Request body must be an object.');
  }
  const record = body as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => key !== 'target' && key !== 'suspend');
  if (unknown.length > 0) {
    throw new ConsoleError(400, 'INVALID_BODY', 'The request contains unsupported fields.');
  }
  if (typeof record.target !== 'string' || record.target.length === 0) {
    throw new ConsoleError(400, 'INVALID_BODY', 'A deployment target is required.');
  }
  if (typeof record.suspend !== 'boolean') {
    throw new ConsoleError(400, 'INVALID_BODY', 'suspend must be true or false.');
  }
  return { target: record.target, suspend: record.suspend };
}

function componentConfig(document: WorkloadDocument): Record<string, string> {
  return document.spec?.template?.spec?.components?.[0]?.localResources?.environment?.config ?? {};
}

function configEntries(config: Record<string, string>): ConfigEntry[] {
  const entries: ConfigEntry[] = [];
  for (const key of Object.keys(config).sort()) {
    const value = config[key] ?? '';
    if (key.startsWith('DI_CONTROL_') && !PLATFORM_VISIBLE_CONTROL.has(key)) continue;
    if (queueSettingBounds(key) !== undefined) continue;
    if (isSensitiveConfigKey(key) || containsCredential(value)) {
      entries.push({ key, sensitive: true });
      continue;
    }
    entries.push({ key, sensitive: false, value });
  }
  return entries;
}

function queueSettingsFrom(config: Record<string, string>): QueueSetting[] {
  const settings: QueueSetting[] = [];
  for (const key of Object.keys(config).sort()) {
    const bounds = queueSettingBounds(key);
    if (bounds === undefined) continue;
    const parsed = Number(config[key]);
    if (!Number.isInteger(parsed)) continue;
    settings.push({ key, label: queueSettingLabel(key), value: parsed, ...bounds });
  }
  return settings;
}

function hostInterfaceView(
  entry: NonNullable<WorkloadComponent['hostInterfaces']>[number],
): HostInterfaceView {
  const namespace = entry.namespace ?? '';
  const pkg = entry.package ?? '';
  const version = entry.version ?? '';
  const config: ConfigEntry[] = [];
  for (const key of Object.keys(entry.config ?? {}).sort()) {
    const value = entry.config?.[key] ?? '';
    if (isSensitiveConfigKey(key) || containsCredential(value)) {
      config.push({ key, sensitive: true });
    } else {
      config.push({ key, sensitive: false, value });
    }
  }
  return {
    ...(entry.name ? { name: entry.name } : {}),
    reference: `${namespace}:${pkg}@${version}`,
    interfaces: entry.interfaces ?? [],
    config,
  };
}

function httpHostFrom(component: WorkloadComponent | undefined): string | undefined {
  for (const entry of component?.hostInterfaces ?? []) {
    if (entry.namespace === 'wasi' && entry.package === 'http') {
      const host = entry.config?.host;
      if (typeof host === 'string' && host.length > 0 && !containsCredential(host)) return host;
    }
  }
  return undefined;
}

function readiness(document: WorkloadDocument): {
  ready: boolean;
  reason?: string;
  message?: string;
} {
  const desired = document.spec?.replicas ?? 1;
  const readyCount = document.status?.readyReplicas ?? document.status?.replicas?.ready ?? 0;
  const condition = (document.status?.conditions ?? []).find(
    (entry) => entry.type === 'Ready' || entry.type === 'Available',
  );
  const ready = readyCount >= desired || condition?.status === 'True';
  const message =
    typeof condition?.message === 'string' && condition.message.length > 0
      ? truncate(condition.message, 200)
      : undefined;
  return {
    ready,
    ...(condition?.reason ? { reason: condition.reason } : {}),
    ...(message ? { message } : {}),
  };
}

function containsCredential(value: string): boolean {
  return USERINFO.test(value);
}

function parseLookups(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 32) {
    throw new ConsoleError(
      400,
      'INVALID_LOOKUPS',
      'DNS lookups must be a list of at most 32 hostnames.',
    );
  }
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !isLookupName(entry)) {
      throw new ConsoleError(
        400,
        'INVALID_LOOKUPS',
        'Each DNS lookup must be a hostname or a wildcard suffix such as *.example.com.',
      );
    }
    names.push(entry);
  }
  return names;
}

function isLookupName(value: string): boolean {
  if (value.length === 0 || value.length > 253) return false;
  const body = value.startsWith('*.') ? value.slice(2) : value;
  if (body.length === 0 || body.includes('*')) return false;
  return body.split('.').every((label) => LOOKUP_LABEL.test(label));
}

function parseQueueUpdates(value: unknown): Array<{ key: string; value: number }> {
  if (!Array.isArray(value)) {
    throw new ConsoleError(400, 'INVALID_QUEUE_SETTING', 'Queue settings must be a list.');
  }
  return value.map((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ConsoleError(
        400,
        'INVALID_QUEUE_SETTING',
        'Each queue setting needs a key and value.',
      );
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.key !== 'string' || queueSettingBounds(record.key) === undefined) {
      throw new ConsoleError(
        400,
        'INVALID_QUEUE_SETTING',
        'Queue settings can only change values already declared on the workload.',
      );
    }
    if (typeof record.value !== 'number') {
      throw new ConsoleError(
        400,
        'INVALID_QUEUE_SETTING',
        'Queue setting values must be whole numbers.',
      );
    }
    return { key: record.key, value: record.value };
  });
}

function isInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
