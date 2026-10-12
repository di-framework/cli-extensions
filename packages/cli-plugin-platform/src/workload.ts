import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CliIo,
  CommandFailure,
  isCommandFailure,
  type JsonValue,
} from '@di-framework/cli-extension';
import { discoverActors } from './actors';
import { type BindingRecord, discoverBindings, requirementsFromBindings } from './bindings';
import { sanitizePublicText } from './console/errors';
import { type DiscoveredCronJob, discoverScheduledJobs } from './cron';
import type { WasmcloudDeps } from './deps';
import {
  applyWorkloadEgress,
  removeWorkloadEgress,
  reportEgressStatus,
  usesPlatformEgress,
  warnIfTenantHostLacksTls,
} from './egress';
import { hostInterfacesFromRequirements, renderHostInterfacesYaml } from './host-interface';
import { captureKubectl, runKubectl } from './kubernetes';
import { applyManagedBindings, cleanupManagedBindings } from './managed-bindings';
import {
  EXCLUSIVE_INSTANCE_KEY,
  isWithin,
  PGLITE_DATA_DIR_ENV,
  warnIfHostIgnoresExclusive,
} from './pglite';
import type { WasmcloudProject } from './project';
import { asWitIdentifier, CONFIG_FILE_NAME } from './project';
import { type DiscoveredQueueHandler, discoverQueueHandlers, isQueueWorkerProject } from './queues';
import { kubectlStatusReason, SECRET_UPDATE_KEYS_MESSAGE } from './secret-admission';
import type { ClusterConnection } from './target';
import {
  defaultProjectRequirements,
  guestLoggingRequirement,
  queueProjectRequirements,
  type WitRequirement,
} from './wit';

export const MANAGED_BY_LABEL = 'di-framework';
export const WAIT_ATTEMPTS = 30;
export const WAIT_INTERVAL_MS = 2_000;
export const WORKLOAD_DEPLOYMENT_RESOURCE = 'workloaddeployment.runtime.wasmcloud.dev';
export const WORKLOAD_REPLICA_SET_RESOURCE = 'workloadreplicaset.runtime.wasmcloud.dev';

/** Host directory where the storage hostgroup mounts the shared PVC. */
export const HOST_STORAGE_ROOT = '/var/lib/di-framework/storage';
/** Dedicated single-replica hostgroup that mounts persistent application storage. */
export const STORAGE_HOSTGROUP = 'storage';
/** Guest mount path for application SQLite storage. */
export const DEFAULT_STORAGE_MOUNT = '/data';
/**
 * Tenant workloads ask the platform for storage instead of naming a host path. The
 * controller creates a tenant-scoped directory per workload and injects the volume and
 * the preopen; tenant credentials cannot set either.
 */
export const PERSISTENT_STORAGE_ANNOTATION = 'di-framework.dev/persistent-storage';
/**
 * "false" when the project opts out of guest logs: the platform publishes no wasi:logging
 * lines for the deployment, only host failure lines.
 */
export const LOGS_ANNOTATION = 'di-framework.dev/logs';
/** Guest mount when it is not the default `/data`; the controller accepts only these two. */
export const STORAGE_MOUNT_ANNOTATION = 'di-framework.dev/storage-mount';
const PLATFORM_STORAGE_MOUNTS = [DEFAULT_STORAGE_MOUNT, `${DEFAULT_STORAGE_MOUNT}/actors`];

/** A tenant target names its host group; its storage belongs to the platform. */
export function usesPlatformStorage(connection: Pick<ClusterConnection, 'hostgroup'>): boolean {
  return connection.hostgroup !== undefined;
}
/** Pinned CronJob invoker image that POSTs to the Wasm HTTP control API. */
export const CRON_INVOKER_IMAGE = 'curlimages/curl:8.11.1';

export function deploymentResourceName(project: WasmcloudProject): string {
  return project.witName;
}

export function generatedManifestPath(project: WasmcloudProject): string {
  return join(project.projectRoot, '.di-framework', 'deploy', 'workload.yaml');
}

export function hostStoragePath(applicationName: string): string {
  return `${HOST_STORAGE_ROOT}/${asWitIdentifier(applicationName)}`;
}

/** Members of one persistent workload share a directory. Other apps keep their own. */
export function storageDirectoryName(project: {
  applicationName: string;
  workload?: string;
  persistentStorage?: boolean;
}): string {
  return project.persistentStorage === true && project.workload
    ? project.workload
    : project.applicationName;
}

export type StorageClaim = {
  metadata?: { name?: string; labels?: Record<string, string> };
  spec?: { template?: { spec?: { volumes?: Array<{ hostPath?: { path?: string } }> } } };
};

/** Another deployment may use the path only when it belongs to the same workload. */
export function storageOwnershipConflict(
  project: { applicationName: string; workload?: string },
  hostPath: string,
  items: readonly StorageClaim[],
): { owner: string } | undefined {
  for (const item of items) {
    const labels = item.metadata?.labels;
    if (
      project.workload !== undefined &&
      labels?.['di-framework.dev/workload'] === project.workload
    ) {
      continue;
    }
    const volumes = item.spec?.template?.spec?.volumes ?? [];
    if (volumes.some((volume) => volume.hostPath?.path === hostPath)) {
      return { owner: item.metadata?.name ?? 'unknown' };
    }
  }
  return undefined;
}

/** Kubernetes Secret that holds DI_CONTROL_TOKEN for a workload. */
export function controlSecretResourceName(workloadName: string): string {
  return `${workloadName}-control`;
}

export interface WorkloadManifestOptions {
  hasActors?: boolean;
  hasPersistentStorage?: boolean;
  replicas?: number;
  storageVolume?: {
    hostPath?: string;
    mountPath?: string;
    volumeName?: string;
  };
  /** Secret name providing control-plane credentials (merged into WASI environment). */
  controlSecretName?: string;
  /**
   * Digest of the control token written on this deploy. Rendered as
   * DI_CONTROL_TOKEN_REVISION so a rotated token changes the template and rolls the workload.
   */
  controlTokenRevision?: string;
  /** Explicit environment config values (string map for localResources.environment.config). */
  environment?: Record<string, string>;
}

export function renderWorkloadManifest(
  project: WasmcloudProject,
  connection: ClusterConnection,
  image: string,
  requirements: readonly WitRequirement[] = defaultProjectRequirements(),
  bindings: readonly BindingRecord[] = [],
  options?: WorkloadManifestOptions | boolean,
  cronJobs: readonly DiscoveredCronJob[] = [],
  queueHandlers: readonly DiscoveredQueueHandler[] = [],
): string {
  const opts: WorkloadManifestOptions =
    typeof options === 'boolean' ? { hasActors: options } : (options ?? {});
  const hasActors = opts.hasActors ?? false;
  const resolvedHandlers =
    queueHandlers.length > 0 ? queueHandlers : discoverQueueHandlers(project);
  const isWorker = isQueueWorkerProject(project, resolvedHandlers);
  const hasQueues = resolvedHandlers.length > 0;
  const pglite = project.pglite;
  // An embedded PostgreSQL data directory needs persistent storage whatever the caller says.
  const needsPersistentStorage =
    pglite !== undefined ||
    (opts.hasPersistentStorage ??
      (hasActors || hasQueues || isWorker || project.persistentStorage === true));
  const needsControlHttp = hasActors || cronJobs.length > 0 || hasQueues || isWorker;
  const publicIngress = project.ingress !== false && !isWorker;
  // Cluster Service is required for cron invokers and queue/actor control even when
  // public ingress is disabled.
  const hasHttp = publicIngress || needsControlHttp || needsPersistentStorage;

  if (needsPersistentStorage) {
    if (opts.replicas !== undefined && opts.replicas !== 1) {
      throw new CommandFailure(
        'WASMCLOUD_STORAGE_REPLICA_CONSTRAINT',
        pglite === undefined
          ? 'SQLite-backed workloads require replicas: 1 because the WASI VFS lacks file locking'
          : 'PGlite workloads require replicas: 1 because each database directory allows one opener',
        2,
        { replicas: opts.replicas },
      );
    }
  }

  const name = deploymentResourceName(project);
  const labels = [
    `    app.kubernetes.io/managed-by: ${MANAGED_BY_LABEL}`,
    `    app.kubernetes.io/name: ${name}`,
    `    di-framework.dev/application: ${yamlQuote(project.applicationName)}`,
    ...(project.workload ? [`    di-framework.dev/workload: ${yamlQuote(project.workload)}`] : []),
  ].join('\n');

  const volumeName = opts.storageVolume?.volumeName ?? 'app-storage';
  const mountPath =
    opts.storageVolume?.mountPath ??
    pglite?.storageMount ??
    (hasActors ? `${DEFAULT_STORAGE_MOUNT}/actors` : DEFAULT_STORAGE_MOUNT);
  if (pglite !== undefined && !isWithin(pglite.dataDir, mountPath)) {
    throw new CommandFailure(
      'WASMCLOUD_PGLITE_STORAGE_MISMATCH',
      `pglite.dataDir ${pglite.dataDir} is outside the storage mount ${mountPath}`,
      2,
      { dataDir: pglite.dataDir, mountPath },
    );
  }
  const hostPath = opts.storageVolume?.hostPath ?? hostStoragePath(storageDirectoryName(project));
  const platformStorage = needsPersistentStorage && usesPlatformStorage(connection);
  if (platformStorage && !PLATFORM_STORAGE_MOUNTS.includes(mountPath)) {
    throw new CommandFailure(
      'WASMCLOUD_STORAGE_MOUNT_UNSUPPORTED',
      `Tenant storage mounts at ${PLATFORM_STORAGE_MOUNTS.join(' or ')}, not ${mountPath}`,
      2,
      { mountPath },
    );
  }
  const annotationLines = [
    ...(platformStorage ? [`    ${PERSISTENT_STORAGE_ANNOTATION}: "true"`] : []),
    ...(platformStorage && mountPath !== DEFAULT_STORAGE_MOUNT
      ? [`    ${STORAGE_MOUNT_ANNOTATION}: ${yamlQuote(mountPath)}`]
      : []),
    ...(project.logs === false ? [`    ${LOGS_ANNOTATION}: "false"`] : []),
  ];
  const annotations = annotationLines.length > 0 ? ['  annotations:', ...annotationLines] : [];

  const environment: Record<string, string> = { ...(opts.environment ?? {}) };
  if (needsPersistentStorage) {
    environment.DI_SQLITE_BACKEND = 'wasm';
    environment.DI_STORAGE_DIR = mountPath;
  }
  if (hasActors) environment.ACTOR_STORAGE_DIR = mountPath;
  if (pglite !== undefined) environment[PGLITE_DATA_DIR_ENV] = pglite.dataDir;
  if (needsPersistentStorage && !hasActors) {
    environment.QUEUE_DB_PATH = `${mountPath}/queue.db`;
    environment.MIGRATION_DB_PATH = `${mountPath}/migrations.db`;
  }
  const controlSecretName =
    opts.controlSecretName ?? (hasHttp ? controlSecretResourceName(name) : undefined);
  const clusterHttpHost = `${name}.${connection.namespace}.svc.cluster.local`;
  const advertisedHttpHost = publicIngress ? project.applicationName : clusterHttpHost;

  if (controlSecretName !== undefined && opts.controlTokenRevision !== undefined) {
    environment.DI_CONTROL_TOKEN_REVISION = opts.controlTokenRevision;
  }
  if (hasHttp) {
    environment.DI_CONTROL_REJECT_FORWARDED = '1';
    environment.DI_CONTROL_HTTP_HOST = [name, clusterHttpHost].join(',');
  }
  if (cronJobs.length > 0) environment.DI_CRON_MODE = 'external';
  if (hasQueues) {
    environment.DI_QUEUE_MODE = 'sqlite';
    for (const handler of resolvedHandlers) {
      const prefix = `DI_QUEUE_${handler.queueName.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;
      if (handler.options.concurrency !== undefined) {
        environment[`${prefix}_CONCURRENCY`] = String(handler.options.concurrency);
      }
      if (handler.options.maxRetries !== undefined) {
        environment[`${prefix}_MAX_RETRIES`] = String(handler.options.maxRetries);
      }
      if (handler.options.backoffMs !== undefined) {
        environment[`${prefix}_BACKOFF_MS`] = String(handler.options.backoffMs);
      }
      if (handler.options.timeoutMs !== undefined) {
        environment[`${prefix}_TIMEOUT_MS`] = String(handler.options.timeoutMs);
      }
    }
  }

  const sections: string[] = [];

  if (hasHttp) {
    sections.push(`apiVersion: v1
kind: Service
metadata:
  name: ${name}
  namespace: ${connection.namespace}
  labels:
${labels}
spec:
  type: ClusterIP
  ports:
    - name: http
      port: 80
      targetPort: 80
      protocol: TCP`);
  }

  const localResourcesLines: string[] = [];
  // Tenant admission rejects these fields; the platform's egress binding writes them.
  const ipNameLookups = usesPlatformEgress(connection) ? undefined : project.allowedIpNameLookups;
  const envKeys = Object.keys(environment).sort();
  if (envKeys.length > 0 || controlSecretName !== undefined) {
    localResourcesLines.push('          localResources:');
    localResourcesLines.push('            environment:');
    if (envKeys.length > 0) {
      localResourcesLines.push('              config:');
      for (const key of envKeys) {
        localResourcesLines.push(`                ${key}: ${yamlQuote(environment[key]!)}`);
      }
    }
    if (controlSecretName !== undefined) {
      localResourcesLines.push('              secretFrom:');
      localResourcesLines.push(`                - name: ${controlSecretName}`);
    }
  } else if (ipNameLookups !== undefined) {
    localResourcesLines.push('          localResources:');
  }

  // The component itself is the exclusive unit (#140): never the service, which admission
  // rejects, and never a separately linked provider, which the host refuses to load.
  if (pglite !== undefined) {
    localResourcesLines.push(
      '            config:',
      `              ${EXCLUSIVE_INSTANCE_KEY}: "true"`,
    );
  }

  if (needsPersistentStorage && !platformStorage) {
    localResourcesLines.push('            volumeMounts:');
    localResourcesLines.push(`              - name: ${volumeName}`);
    localResourcesLines.push(`                mountPath: ${mountPath}`);
  }

  if (ipNameLookups !== undefined) {
    localResourcesLines.push(`            allowedIpNameLookups: ${JSON.stringify(ipNameLookups)}`);
  }

  // A long-lived wasi:cli/run program is a WorkloadService: wash runs it only from
  // spec.template.spec.service, never as a component export.
  const runsAsService =
    !hasHttp &&
    !isWorker &&
    project.workloadEntry?.kind === 'service' &&
    project.workloadEntry.subscriptions === undefined;
  // Deploy builds link the wasi:logging console unless the project opts out of logs
  // (see buildComponent).
  const interfaceRequirements: readonly WitRequirement[] =
    project.logs === false ? requirements : [...requirements, guestLoggingRequirement()];
  const hostInterfaces = renderHostInterfacesYaml(
    hostInterfacesFromRequirements(
      hasHttp &&
        !interfaceRequirements.some((r) => r.package === 'wasi:http' && r.direction === 'export')
        ? [
            ...interfaceRequirements,
            {
              package: 'wasi:http',
              version: '0.3.0',
              interfaces: ['handler'],
              direction: 'export',
              source: 'control-http',
            },
          ]
        : interfaceRequirements,
      {
        ...(hasHttp ? { httpHost: advertisedHttpHost } : {}),
        subscriptions: project.workloadEntry?.subscriptions,
      },
      bindings.map((binding) => ({
        name: binding.name,
        className: binding.className,
        config: binding.config,
        configFrom: binding.configFrom,
        secretFrom: binding.secretFrom,
      })),
    ),
  );

  const workloadDeployment = `apiVersion: runtime.wasmcloud.dev/v1alpha1
kind: WorkloadDeployment
metadata:
  name: ${name}
  namespace: ${connection.namespace}
  labels:
${labels}
${annotations.length > 0 ? `${annotations.join('\n')}\n` : ''}spec:
  replicas: 1
${needsPersistentStorage ? '  deployPolicy: Recreate\n' : ''}  template:
    spec:
      environment: ${yamlQuote(connection.namespace)}
      hostSelector:
        hostgroup: ${needsPersistentStorage && !platformStorage ? (connection.storageHostgroup ?? STORAGE_HOSTGROUP) : (connection.hostgroup ?? 'default')}
${
  needsPersistentStorage && !platformStorage
    ? `      volumes:
        - name: ${volumeName}
          hostPath:
            path: ${yamlQuote(hostPath)}
`
    : ''
}${
  hasHttp
    ? `      kubernetes:
        service:
          name: ${name}
`
    : ''
}${
  runsAsService
    ? `      service:
        image: ${yamlQuote(image)}
${localResourcesLines.length > 0 ? `${localResourcesLines.map((line) => line.slice(2)).join('\n')}\n` : ''}`
    : `      components:
        - name: ${name}
          image: ${yamlQuote(image)}
${localResourcesLines.length > 0 ? `${localResourcesLines.join('\n')}\n` : ''}`
}${hostInterfaces}`;

  sections.push(workloadDeployment);

  for (const job of cronJobs) {
    const jobKebab =
      job.kebabId || asWitIdentifier(job.name || `${job.className}-${job.methodName}`);
    const jobResourceName = `${name}-${jobKebab}`;
    const timeoutSeconds = Math.max(1, Math.ceil((job.timeoutMs ?? 30_000) / 1000));
    // Job deadline must cover image pull + invoke; curl --max-time enforces the app timeout.
    const activeDeadlineSeconds = Math.max(timeoutSeconds + 60, 90);
    const invokeUrl = `http://${name}.${connection.namespace}.svc.cluster.local/_di/cron/${encodeURIComponent(job.jobId)}/invoke`;
    sections.push(`apiVersion: batch/v1
kind: CronJob
metadata:
  name: ${jobResourceName}
  namespace: ${connection.namespace}
  labels:
${labels}
    di-framework.dev/cron-job: ${yamlQuote(job.jobId)}
spec:
  schedule: ${yamlQuote(job.cronExpression)}
  concurrencyPolicy: ${job.allowConcurrent ? 'Allow' : 'Forbid'}
  jobTemplate:
    spec:
      activeDeadlineSeconds: ${activeDeadlineSeconds}
      template:
        metadata:
          labels:
${labels.replace(/^/gm, '        ')}
            di-framework.dev/cron-job: ${yamlQuote(job.jobId)}
        spec:
          restartPolicy: OnFailure
          containers:
            - name: cron-invoker
              image: ${yamlQuote(CRON_INVOKER_IMAGE)}
              env:
                - name: DI_CRON_INVOKE_URL
                  value: ${yamlQuote(invokeUrl)}
                - name: DI_CRON_INVOKE_JOB
                  value: ${yamlQuote(job.jobId)}
                - name: DI_CONTROL_TOKEN
                  valueFrom:
                    secretKeyRef:
                      name: ${controlSecretName ?? `${name}-control`}
                      key: DI_CONTROL_TOKEN
              command:
                - /bin/sh
                - -ec
                - |
                  set -eu
                  response="$(curl -sS -f -X POST \\
                    -H "Host: ${advertisedHttpHost}" \\
                    -H "content-type: application/json" \\
                    -H "Authorization: Bearer \${DI_CONTROL_TOKEN}" \\
                    --max-time ${timeoutSeconds} \\
                    -d '{}' \\
                    "$DI_CRON_INVOKE_URL")"
                  echo "$response"
                  echo "$response" | grep -q '"completed":true\\|\\"ok\\":true'`);
  }

  return sections.join('\n---\n') + '\n';
}

/** Appended to a deploy failure that happened after the control Secret was rewritten. */
export const CONTROL_TOKEN_ROTATED_NOTICE =
  'the control token was rotated; re-run deploy to roll the workload onto it';

/**
 * The control Secret after a deploy: its name and, when deploy wrote a new token, a digest that
 * identifies it. `revision` is undefined when deploy kept the Secret as it was.
 */
export type ControlSecretWrite = { name: string; revision?: string };

/** The keys the CLI owns in every control Secret. */
export const CONTROL_SECRET_CLI_KEYS = ['DI_CONTROL_TOKEN', 'DI_CONTROL_IDENTITY'] as const;

/**
 * The control Secret document. The CLI's keys hold `token` and the workload name; `appData`
 * (already base64, as in a Secret's `data`) carries app-owned keys over, and `resourceVersion`
 * makes the update conditional.
 */
export function controlSecretDocument(
  workloadName: string,
  namespace: string,
  token: string,
  appData: Readonly<Record<string, string>> = {},
  resourceVersion?: string,
): Record<string, unknown> {
  const encode = (value: string) => Buffer.from(value, 'utf8').toString('base64');
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: controlSecretResourceName(workloadName),
      namespace,
      labels: {
        'app.kubernetes.io/managed-by': MANAGED_BY_LABEL,
        'app.kubernetes.io/name': workloadName,
      },
      ...(resourceVersion === undefined ? {} : { resourceVersion }),
    },
    type: 'Opaque',
    data: {
      ...appData,
      DI_CONTROL_TOKEN: encode(token),
      DI_CONTROL_IDENTITY: encode(workloadName),
    },
  };
}

function secretsPath(namespace: string, name?: string): string {
  const collection = `/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets`;
  return name === undefined ? collection : `${collection}/${encodeURIComponent(name)}`;
}

type KubectlResult = { exitCode: number; stdout: string; stderr: string };

/**
 * Writes the workload's control Secret on deploy and returns whether the token rotated.
 *
 * The Secret holds the CLI's `DI_CONTROL_TOKEN` and `DI_CONTROL_IDENTITY` plus the app-owned keys
 * the project declares in `controlSecretKeys` (cli-extensions#69). Any other key is refused: the
 * Secret is injected whole into the workload's environment, so an undeclared key is either a
 * mistake or a value nobody vouched for.
 *
 * - A new Secret is created with the CLI's keys and a fresh token.
 * - An existing Secret the caller may read (an admin) is read, checked for undeclared keys, and
 *   updated with a fresh token and its declared keys carried over, conditional on the
 *   `resourceVersion` that was read.
 * - Tenant developers may create, update and delete Secrets but never get, list, watch or patch
 *   them (platform#112), and the platform's `tenant-secret-update` admission policy refuses an
 *   update that drops a key. So an existing Secret is replaced blind with the CLI's keys and a
 *   fresh token. When that is refused because the Secret holds more keys, a dry-run update that
 *   also names every declared key asks the same policy whether all of the extra keys are
 *   declared. If they are, the Secret is kept as it is, token included, since a blind writer
 *   cannot carry over values it cannot read; otherwise deploy stops.
 *
 * Every request goes through `--raw`: `kubectl replace -f` would GET the object first.
 */
export async function writeControlSecret(
  project: WasmcloudProject,
  connection: ClusterConnection,
  deps: WasmcloudDeps,
): Promise<ControlSecretWrite> {
  const workloadName = deploymentResourceName(project);
  const name = controlSecretResourceName(workloadName);
  const declared = project.controlSecretKeys ?? [];
  const token = randomBytes(32).toString('base64url');
  const rotated = { name, revision: createHash('sha256').update(token).digest('hex').slice(0, 16) };
  /** Values that must never appear in an error: the token and any value read from the cluster. */
  const secrets = [token];
  const directory = mkdtempSync(join(tmpdir(), 'di-control-secret-'));
  let written = 0;
  const send = async (
    verb: 'create' | 'replace',
    document: Record<string, unknown>,
    query = '',
  ): Promise<KubectlResult> => {
    const path = join(directory, `secret-${written++}.json`);
    writeFileSync(path, JSON.stringify(document), { mode: 0o600 });
    const target =
      verb === 'create'
        ? secretsPath(connection.namespace)
        : secretsPath(connection.namespace, name);
    return captureKubectl(
      deps,
      connection,
      [verb, '--raw', `${target}${query}`, '-f', path],
      project.projectRoot,
    );
  };
  const failed = (command: string, result: KubectlResult) =>
    controlSecretWriteFailed(command, name, connection, result, secrets);
  try {
    const document = controlSecretDocument(workloadName, connection.namespace, token);
    const created = await send('create', document);
    if (created.exitCode === 0) return rotated;
    if (kubectlStatusReason(created.stderr) !== 'AlreadyExists') {
      throw failed('kubectl create', created);
    }

    const stored = await readControlSecret(project, connection, deps, name, secrets);
    if (stored !== undefined) {
      const undeclared = Object.keys(stored.data).filter(
        (key) =>
          !(CONTROL_SECRET_CLI_KEYS as readonly string[]).includes(key) && !declared.includes(key),
      );
      if (undeclared.length > 0) throw controlSecretForeignKeys(name, connection, undeclared);
      const appData = Object.fromEntries(
        Object.entries(stored.data).filter(([key]) => declared.includes(key)),
      );
      const merged = controlSecretDocument(
        workloadName,
        connection.namespace,
        token,
        appData,
        stored.resourceVersion,
      );
      const updated = await send('replace', merged);
      if (updated.exitCode !== 0) throw failed('kubectl replace', updated);
      return rotated;
    }

    const replaced = await send('replace', document);
    if (replaced.exitCode === 0) return rotated;
    if (!replaced.stderr.includes(SECRET_UPDATE_KEYS_MESSAGE)) {
      throw failed('kubectl replace', replaced);
    }
    if (declared.length === 0) throw controlSecretForeignKeys(name, connection);
    // Values are placeholders: a dry run stores nothing, and the policy compares key names only.
    const probe = controlSecretDocument(
      workloadName,
      connection.namespace,
      token,
      Object.fromEntries(declared.map((key) => [key, ''])),
    );
    const checked = await send('replace', probe, '?dryRun=All');
    if (checked.exitCode === 0) return { name };
    if (checked.stderr.includes(SECRET_UPDATE_KEYS_MESSAGE)) {
      throw controlSecretForeignKeys(name, connection);
    }
    throw failed('kubectl replace --dry-run', checked);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * The stored control Secret's keys (base64 values) and `resourceVersion` when the caller may read
 * it, or undefined when it may not. `kubectl auth can-i` asks first, so a tenant developer never
 * sends a Secret read the platform forbids. Values read here are added to `secrets` so no error
 * can show them; nothing read is ever printed.
 */
async function readControlSecret(
  project: WasmcloudProject,
  connection: ClusterConnection,
  deps: WasmcloudDeps,
  name: string,
  secrets: string[],
): Promise<{ data: Record<string, string>; resourceVersion?: string } | undefined> {
  const allowed = await captureKubectl(
    deps,
    connection,
    ['auth', 'can-i', 'get', `secrets/${name}`],
    project.projectRoot,
  );
  if (allowed.exitCode !== 0 || allowed.stdout.trim() !== 'yes') return undefined;
  const read = await captureKubectl(
    deps,
    connection,
    ['get', '--raw', secretsPath(connection.namespace, name)],
    project.projectRoot,
  );
  if (read.exitCode !== 0) {
    throw controlSecretWriteFailed('kubectl get', name, connection, read, secrets);
  }
  let stored: { metadata?: { resourceVersion?: unknown }; data?: unknown };
  try {
    stored = JSON.parse(read.stdout) as typeof stored;
  } catch {
    throw new CommandFailure(
      'WASMCLOUD_TOOL_FAILED',
      `kubectl get returned a control Secret ${name} that is not JSON`,
      3,
      { command: 'kubectl get', name },
    );
  }
  const data: Record<string, string> = {};
  if (stored.data !== null && typeof stored.data === 'object') {
    for (const [key, value] of Object.entries(stored.data as Record<string, unknown>)) {
      if (typeof value !== 'string') continue;
      data[key] = value;
      secrets.push(value, Buffer.from(value, 'base64').toString('utf8'));
    }
  }
  const resourceVersion = stored.metadata?.resourceVersion;
  return typeof resourceVersion === 'string' ? { data, resourceVersion } : { data };
}

/**
 * The control Secret holds keys that are neither the CLI's nor declared in `controlSecretKeys`.
 * `keys` names them when the Secret could be read; a tenant developer only learns that some exist.
 */
function controlSecretForeignKeys(
  name: string,
  connection: ClusterConnection,
  keys?: readonly string[],
): CommandFailure {
  const which =
    keys === undefined ? "keys this CLI didn't write" : `undeclared keys ${keys.join(', ')}`;
  return new CommandFailure(
    'WASMCLOUD_CONTROL_SECRET_FOREIGN_KEYS',
    `The control Secret ${name} has ${which}; declare app-owned keys in "controlSecretKeys" ` +
      `of ${CONFIG_FILE_NAME}, or delete the Secret with ` +
      `\`kubectl delete secret ${name} --namespace ${connection.namespace}\` and redeploy`,
    2,
    { name, namespace: connection.namespace, ...(keys === undefined ? {} : { keys: [...keys] }) },
  );
}

/**
 * A failed control Secret request, with kubectl's reason. Kubernetes errors for these requests
 * name the object, not its data, but the stderr is still scrubbed of `secrets` (the token raw and
 * base64, and any value read from the cluster) and of credential-shaped text before it is shown,
 * in case a response echoes the body.
 */
function controlSecretWriteFailed(
  command: string,
  name: string,
  connection: ClusterConnection,
  result: { exitCode: number; stderr: string },
  secrets: readonly string[],
): CommandFailure {
  const scrub = secrets
    .flatMap((secret) => [secret, Buffer.from(secret, 'utf8').toString('base64')])
    .filter((secret) => secret.length >= 4)
    .sort((a, b) => b.length - a.length);
  const stderr = sanitizePublicText(
    scrub.reduce((text, secret) => text.split(secret).join('[redacted]'), result.stderr).trim(),
  );
  if (kubectlStatusReason(stderr) === 'Conflict') {
    return new CommandFailure(
      'WASMCLOUD_CONTROL_SECRET_CHANGED',
      `The control Secret ${name} in ${connection.namespace} changed while deploy was updating it; re-run deploy`,
      3,
      { name, namespace: connection.namespace, command, exitCode: result.exitCode, stderr },
    );
  }
  const reason = stderr.length > 0 ? `: ${stderr}` : '';
  return new CommandFailure(
    'WASMCLOUD_TOOL_FAILED',
    `${command} failed with exit code ${result.exitCode}${reason}`,
    3,
    { command, exitCode: result.exitCode, stderr },
  );
}

/**
 * Deletes the control Secret by name. A label-selected delete would LIST Secrets and the
 * default `--wait=true` would GET it afterwards, both forbidden to tenant developers.
 */
export async function deleteControlSecret(
  project: WasmcloudProject,
  connection: ClusterConnection,
  deps: WasmcloudDeps,
): Promise<void> {
  await runKubectl(
    deps,
    connection,
    [
      'delete',
      'secret',
      controlSecretResourceName(deploymentResourceName(project)),
      '--ignore-not-found',
      '--wait=false',
    ],
    project.projectRoot,
  );
}

export async function applyWorkload(
  project: WasmcloudProject,
  connection: ClusterConnection,
  image: string,
  io: CliIo,
  deps: WasmcloudDeps,
): Promise<string> {
  const bindings = discoverBindings(project, deps);
  const queueHandlers = discoverQueueHandlers(project);
  const isWorker = isQueueWorkerProject(project, queueHandlers);
  const hasActors = discoverActors(project).length > 0 || project.actors === true;
  const cronJobs = discoverScheduledJobs(project.projectRoot);
  const hasPersistentStorage =
    hasActors ||
    queueHandlers.length > 0 ||
    project.persistentStorage === true ||
    project.pglite !== undefined;
  const needsHttp =
    (project.ingress !== false && !isWorker) ||
    hasActors ||
    cronJobs.length > 0 ||
    queueHandlers.length > 0 ||
    hasPersistentStorage;
  const baseRequirements = needsHttp
    ? defaultProjectRequirements()
    : isWorker
      ? queueProjectRequirements()
      : [];
  const requirements: WitRequirement[] = [
    ...baseRequirements,
    ...requirementsFromBindings(bindings),
  ];
  if (project.workloadEntry?.subscriptions)
    requirements.push({
      package: 'wasmcloud:messaging',
      version: '0.3.0',
      interfaces: ['handler'],
      direction: 'export',
      source: 'workload-service',
    });
  await warnIfTenantHostLacksTls(project, connection, io, deps);
  await warnIfHostIgnoresExclusive(project, connection, io, deps);
  const associations = await applyManagedBindings(project, connection, bindings, deps);
  const egress = await applyWorkloadEgress(project, connection, deps);
  if (egress !== undefined) associations.add(egress);
  await assertStorageOwnership(project, connection, deps, {
    hasActors,
    hasQueues: queueHandlers.length > 0,
    hasPersistentStorage,
  });
  const controlSecret = needsHttp ? await writeControlSecret(project, connection, deps) : undefined;
  if (controlSecret !== undefined && controlSecret.revision === undefined) {
    io.stdout.write(
      `Kept control Secret ${controlSecret.name}: it holds declared app keys this deploy cannot read, so the control token was not rotated\n`,
    );
  }
  // From here on the cron invokers already use the new token, which the running workload
  // rejects until it rolls out with this manifest.
  let path: string;
  try {
    const manifest = renderWorkloadManifest(
      project,
      connection,
      image,
      requirements,
      bindings,
      {
        hasActors,
        hasPersistentStorage,
        controlSecretName: controlSecret?.name,
        controlTokenRevision: controlSecret?.revision,
      },
      cronJobs,
      queueHandlers,
    );
    path = generatedManifestPath(project);
    mkdirSync(join(project.projectRoot, '.di-framework', 'deploy'), { recursive: true });
    writeFileSync(path, manifest);
    const name = deploymentResourceName(project);
    io.stdout.write(`Applying WorkloadDeployment ${name} in ${connection.namespace}...\n`);
    await runKubectl(deps, connection, ['apply', '-f', path], project.projectRoot);
    await waitForReady(project, connection, deps, io);
  } catch (error) {
    throw controlSecret?.revision === undefined ? error : withRotatedTokenNotice(error);
  }
  await cleanupManagedBindings(project, connection, associations, deps);
  if (egress === undefined) await removeWorkloadEgress(project, connection, deps);
  else await reportEgressStatus(project, connection, io, deps);
  return path;
}

/**
 * A deploy that fails after the control Secret was written leaves the running workload on the
 * old token while its cron invokers (which read the Secret when they start) carry the new one,
 * so every cron invocation is refused until a deploy succeeds. Say so in the failure.
 */
function withRotatedTokenNotice(error: unknown): unknown {
  if (!isCommandFailure(error)) return error;
  // Every failure on this path (kubectl, readiness) carries an object of details.
  const details = error.details as Record<string, JsonValue> | undefined;
  return new CommandFailure(
    error.code,
    `${error.message}; ${CONTROL_TOKEN_ROTATED_NOTICE}`,
    error.exitCode,
    { ...details, controlTokenRotated: true },
  );
}

async function assertStorageOwnership(
  project: WasmcloudProject,
  connection: ClusterConnection,
  deps: WasmcloudDeps,
  flags: { hasActors: boolean; hasQueues: boolean; hasPersistentStorage?: boolean },
): Promise<void> {
  if (!flags.hasActors && !flags.hasQueues && !flags.hasPersistentStorage) return;
  // The platform keys tenant storage by workload, so another app cannot reach this path.
  if (usesPlatformStorage(connection)) return;
  const hostPath = hostStoragePath(storageDirectoryName(project));
  const result = await captureKubectl(
    deps,
    connection,
    [
      'get',
      WORKLOAD_DEPLOYMENT_RESOURCE,
      '-o',
      'json',
      '-l',
      `di-framework.dev/application!=${project.applicationName}`,
    ],
    project.projectRoot,
  );
  if (result.exitCode !== 0) return;
  try {
    const list = JSON.parse(result.stdout) as { items?: StorageClaim[] };
    const conflict = storageOwnershipConflict(project, hostPath, list.items ?? []);
    if (conflict) {
      throw new CommandFailure(
        'WASMCLOUD_STORAGE_OWNERSHIP_CONFLICT',
        `Storage path ${hostPath} is already claimed by WorkloadDeployment ${conflict.owner}`,
        2,
        { application: project.applicationName, path: hostPath, owner: conflict.owner },
      );
    }
  } catch (error) {
    if (error instanceof CommandFailure) throw error;
  }
}

export async function deleteWorkload(
  project: WasmcloudProject,
  connection: ClusterConnection,
  io: CliIo,
  deps: WasmcloudDeps,
): Promise<void> {
  const name = deploymentResourceName(project);
  io.stdout.write(`Removing WorkloadDeployment ${name} from ${connection.namespace}...\n`);
  await runKubectl(
    deps,
    connection,
    [
      'delete',
      `${WORKLOAD_DEPLOYMENT_RESOURCE},service,cronjob`,
      '-l',
      `app.kubernetes.io/name=${name}`,
      '--ignore-not-found',
      '--wait=true',
      '--timeout=180s',
    ],
    project.projectRoot,
  );
  // After the workload and its cron invokers are gone, so nothing still mounts the token.
  await deleteControlSecret(project, connection, deps);
  await cleanupManagedBindings(project, connection, new Set(), deps);
  await removeWorkloadEgress(project, connection, deps);
}

export async function waitForReady(
  project: WasmcloudProject,
  connection: ClusterConnection,
  deps: WasmcloudDeps,
  io?: CliIo,
): Promise<void> {
  const name = deploymentResourceName(project);
  for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt++) {
    const result = await captureKubectl(
      deps,
      connection,
      ['get', WORKLOAD_DEPLOYMENT_RESOURCE, name, '-o', 'json'],
      project.projectRoot,
    );
    if (result.exitCode === 0 && isReady(result.stdout)) return;
    await deps.wait(WAIT_INTERVAL_MS);
  }
  const diagnostics = await deploymentDiagnostics(project, connection, deps);
  if (io !== undefined) {
    io.stderr.write(
      `WorkloadDeployment ${name} did not become ready. Kubernetes diagnostics follow:\n${diagnostics}\n`,
    );
  }
  throw new CommandFailure(
    'WASMCLOUD_DEPLOYMENT_NOT_READY',
    `WorkloadDeployment ${name} in ${connection.namespace} did not become ready`,
    3,
    {
      application: project.applicationName,
      namespace: connection.namespace,
      name,
      diagnostics,
    },
  );
}

export function isReady(stdout: string): boolean {
  try {
    const document = JSON.parse(stdout) as {
      spec?: { replicas?: number };
      status?: {
        readyReplicas?: number;
        replicas?: { ready?: number; expected?: number };
        conditions?: Array<{ type?: string; status?: string }>;
      };
    };
    const replicas = document.spec?.replicas ?? 1;
    if ((document.status?.readyReplicas ?? 0) >= replicas) return true;
    if ((document.status?.replicas?.ready ?? 0) >= replicas) return true;
    return (document.status?.conditions ?? []).some(
      (condition) =>
        (condition.type === 'Ready' || condition.type === 'Available') &&
        condition.status === 'True',
    );
  } catch {
    return false;
  }
}

async function deploymentDiagnostics(
  project: WasmcloudProject,
  connection: ClusterConnection,
  deps: WasmcloudDeps,
): Promise<string> {
  const name = deploymentResourceName(project);
  const commands: Array<{ title: string; args: string[] }> = [
    {
      title: 'WorkloadDeployment',
      args: ['get', WORKLOAD_DEPLOYMENT_RESOURCE, name, '-o', 'yaml'],
    },
    {
      title: 'WorkloadReplicaSets',
      args: [
        'get',
        WORKLOAD_REPLICA_SET_RESOURCE,
        '-l',
        `runtime.wasmcloud.dev/workload-deployment=${name}`,
        '-o',
        'wide',
      ],
    },
    {
      title: 'wasmCloud host pods',
      args: ['get', 'pods', '-l', 'wasmcloud.com/hostgroup', '-o', 'wide'],
    },
    {
      title: 'wasmCloud storage host logs',
      args: [
        'logs',
        `deployment/hostgroup-${connection.storageHostgroup ?? STORAGE_HOSTGROUP}`,
        '--tail=100',
      ],
    },
  ];
  const sections: string[] = [];
  for (const command of commands) {
    const result = await captureKubectl(deps, connection, command.args, project.projectRoot);
    const output =
      result.stdout.trim() || result.stderr.trim() || `(kubectl exited ${result.exitCode})`;
    sections.push(`--- ${command.title} ---\n${output}`);
  }
  return sections.join('\n');
}

function yamlQuote(value: string): string {
  return JSON.stringify(value);
}
