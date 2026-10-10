import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CliIo, CommandFailure } from '@di-framework/cli-extension';
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
import type { WasmcloudProject } from './project';
import { asWitIdentifier } from './project';
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
  const needsPersistentStorage =
    opts.hasPersistentStorage ??
    (hasActors || hasQueues || isWorker || project.persistentStorage === true);
  const needsControlHttp = hasActors || cronJobs.length > 0 || hasQueues || isWorker;
  const publicIngress = project.ingress !== false && !isWorker;
  // Cluster Service is required for cron invokers and queue/actor control even when
  // public ingress is disabled.
  const hasHttp = publicIngress || needsControlHttp || needsPersistentStorage;

  if (needsPersistentStorage) {
    if (opts.replicas !== undefined && opts.replicas !== 1) {
      throw new CommandFailure(
        'WASMCLOUD_STORAGE_REPLICA_CONSTRAINT',
        'SQLite-backed workloads require replicas: 1 because the WASI VFS lacks file locking',
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
    (hasActors ? `${DEFAULT_STORAGE_MOUNT}/actors` : DEFAULT_STORAGE_MOUNT);
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

/** Control Secret written on deploy: its name and a digest that identifies the token. */
export type ControlSecretWrite = { name: string; revision: string };

/** The full control Secret the CLI owns; nothing in it is read back from the cluster. */
export function controlSecretDocument(
  workloadName: string,
  namespace: string,
  token: string,
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
    },
    type: 'Opaque',
    data: {
      DI_CONTROL_TOKEN: encode(token),
      DI_CONTROL_IDENTITY: encode(workloadName),
    },
  };
}

function secretsPath(namespace: string, name?: string): string {
  const collection = `/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets`;
  return name === undefined ? collection : `${collection}/${encodeURIComponent(name)}`;
}

/**
 * Tenant developers may create, update and delete Secrets but never get, list, watch or
 * patch them (platform#112). The control Secret is therefore written blind: POST the full
 * document and, if it already exists, PUT the same document without a resourceVersion. A
 * Secret allows such an unconditional update, so no read is needed to learn the version,
 * and the Secret never disappears the way delete-then-create would make it. Both requests
 * go through `--raw` because `kubectl replace -f` GETs the object first to fill in its
 * resourceVersion. The token is regenerated on every deploy since the old one cannot be read.
 */
export async function writeControlSecret(
  project: WasmcloudProject,
  connection: ClusterConnection,
  deps: WasmcloudDeps,
): Promise<ControlSecretWrite> {
  const workloadName = deploymentResourceName(project);
  const name = controlSecretResourceName(workloadName);
  const token = randomBytes(32).toString('base64url');
  const directory = mkdtempSync(join(tmpdir(), 'di-control-secret-'));
  try {
    const path = join(directory, 'secret.json');
    writeFileSync(
      path,
      JSON.stringify(controlSecretDocument(workloadName, connection.namespace, token)),
      { mode: 0o600 },
    );
    const created = await captureKubectl(
      deps,
      connection,
      ['create', '--raw', secretsPath(connection.namespace), '-f', path],
      project.projectRoot,
    );
    if (created.exitCode !== 0) {
      if (kubectlStatusReason(created.stderr) !== 'AlreadyExists') {
        throw controlSecretWriteFailed('kubectl create', name, connection, created, token);
      }
      const replaced = await captureKubectl(
        deps,
        connection,
        ['replace', '--raw', secretsPath(connection.namespace, name), '-f', path],
        project.projectRoot,
      );
      if (replaced.exitCode !== 0) {
        throw controlSecretWriteFailed('kubectl replace', name, connection, replaced, token);
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  return { name, revision: createHash('sha256').update(token).digest('hex').slice(0, 16) };
}

/**
 * A failed control Secret write, with kubectl's reason. Kubernetes errors for these requests
 * name the object, not its data, but the stderr is still scrubbed of the token (raw and
 * base64) and of credential-shaped text before it is shown, in case a response echoes the body.
 */
function controlSecretWriteFailed(
  command: string,
  name: string,
  connection: ClusterConnection,
  result: { exitCode: number; stderr: string },
  token: string,
): CommandFailure {
  const stderr = sanitizePublicText(
    [token, Buffer.from(token, 'utf8').toString('base64')]
      .reduce((text, secret) => text.split(secret).join('[redacted]'), result.stderr)
      .trim(),
  );
  if (stderr.includes(SECRET_UPDATE_KEYS_MESSAGE)) {
    // The platform's `tenant-secret-update` policy refuses a replace that drops a key, so a
    // control Secret someone added keys to can no longer be rotated in place.
    return new CommandFailure(
      'WASMCLOUD_CONTROL_SECRET_FOREIGN_KEYS',
      `The control Secret ${name} has keys this CLI didn't write; delete it with ` +
        `\`kubectl delete secret ${name} --namespace ${connection.namespace}\` and redeploy`,
      2,
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
    hasActors || queueHandlers.length > 0 || project.persistentStorage === true;
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
  const associations = await applyManagedBindings(project, connection, bindings, deps);
  const egress = await applyWorkloadEgress(project, connection, deps);
  if (egress !== undefined) associations.add(egress);
  await assertStorageOwnership(project, connection, deps, {
    hasActors,
    hasQueues: queueHandlers.length > 0,
    hasPersistentStorage,
  });
  const controlSecret = needsHttp ? await writeControlSecret(project, connection, deps) : undefined;
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
  const path = generatedManifestPath(project);
  mkdirSync(join(project.projectRoot, '.di-framework', 'deploy'), { recursive: true });
  writeFileSync(path, manifest);
  const name = deploymentResourceName(project);
  io.stdout.write(`Applying WorkloadDeployment ${name} in ${connection.namespace}...\n`);
  await runKubectl(deps, connection, ['apply', '-f', path], project.projectRoot);
  await waitForReady(project, connection, deps, io);
  await cleanupManagedBindings(project, connection, associations, deps);
  if (egress === undefined) await removeWorkloadEgress(project, connection, deps);
  else await reportEgressStatus(project, connection, io, deps);
  return path;
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
