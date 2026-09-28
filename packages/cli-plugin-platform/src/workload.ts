import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type CliIo, CommandFailure } from '@di-framework/cli-extension';
import { discoverActors } from './actors';
import { type BindingRecord, discoverBindings, requirementsFromBindings } from './bindings';
import { type DiscoveredCronJob, discoverScheduledJobs } from './cron';
import type { WasmcloudDeps } from './deps';
import { hostInterfacesFromRequirements, renderHostInterfacesYaml } from './host-interface';
import { captureKubectl, runKubectl } from './kubernetes';
import { applyManagedBindings, cleanupManagedBindings } from './managed-bindings';
import type { WasmcloudProject } from './project';
import { asWitIdentifier } from './project';
import { type DiscoveredQueueHandler, discoverQueueHandlers, isQueueWorkerProject } from './queues';
import type { ClusterConnection } from './target';
import { defaultProjectRequirements, queueProjectRequirements, type WitRequirement } from './wit';

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
  const hostPath = opts.storageVolume?.hostPath ?? hostStoragePath(project.applicationName);

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
  } else if (project.allowedIpNameLookups !== undefined) {
    localResourcesLines.push('          localResources:');
  }

  if (needsPersistentStorage) {
    localResourcesLines.push('            volumeMounts:');
    localResourcesLines.push(`              - name: ${volumeName}`);
    localResourcesLines.push(`                mountPath: ${mountPath}`);
  }

  if (project.allowedIpNameLookups !== undefined) {
    localResourcesLines.push(
      `            allowedIpNameLookups: ${JSON.stringify(project.allowedIpNameLookups)}`,
    );
  }

  const hostInterfaces = renderHostInterfacesYaml(
    hostInterfacesFromRequirements(
      hasHttp && !requirements.some((r) => r.package === 'wasi:http' && r.direction === 'export')
        ? [
            ...requirements,
            {
              package: 'wasi:http',
              version: '0.3.0',
              interfaces: ['handler'],
              direction: 'export',
              source: 'control-http',
            },
          ]
        : requirements,
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
spec:
  replicas: 1
${needsPersistentStorage ? '  deployPolicy: Recreate\n' : ''}  template:
    spec:
      environment: ${yamlQuote(connection.namespace)}
      hostSelector:
        hostgroup: ${needsPersistentStorage ? (connection.storageHostgroup ?? STORAGE_HOSTGROUP) : (connection.hostgroup ?? 'default')}
${
  needsPersistentStorage
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
}      components:
        - name: ${name}
          image: ${yamlQuote(image)}
${localResourcesLines.length > 0 ? `${localResourcesLines.join('\n')}\n` : ''}${hostInterfaces}`;

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

async function ensureControlSecret(
  project: WasmcloudProject,
  connection: ClusterConnection,
  deps: WasmcloudDeps,
): Promise<string> {
  const name = deploymentResourceName(project);
  const secretName = controlSecretResourceName(name);
  const existing = await captureKubectl(
    deps,
    connection,
    ['get', 'secret', secretName],
    project.projectRoot,
  );
  if (existing.exitCode !== 0) {
    const token = randomBytes(32).toString('base64url');
    await runKubectl(
      deps,
      connection,
      [
        'create',
        'secret',
        'generic',
        secretName,
        `--from-literal=DI_CONTROL_TOKEN=${token}`,
        `--from-literal=DI_CONTROL_IDENTITY=${name}`,
      ],
      project.projectRoot,
    );
  }
  await runKubectl(
    deps,
    connection,
    [
      'label',
      'secret',
      secretName,
      `app.kubernetes.io/managed-by=${MANAGED_BY_LABEL}`,
      `app.kubernetes.io/name=${name}`,
      '--overwrite',
    ],
    project.projectRoot,
  );
  return secretName;
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
  const associations = await applyManagedBindings(project, connection, bindings, deps);
  await assertStorageOwnership(project, connection, deps, {
    hasActors,
    hasQueues: queueHandlers.length > 0,
    hasPersistentStorage,
  });
  const controlSecretName = needsHttp
    ? await ensureControlSecret(project, connection, deps)
    : undefined;
  const manifest = renderWorkloadManifest(
    project,
    connection,
    image,
    requirements,
    bindings,
    { hasActors, hasPersistentStorage, controlSecretName },
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
  return path;
}

async function assertStorageOwnership(
  project: WasmcloudProject,
  connection: ClusterConnection,
  deps: WasmcloudDeps,
  flags: { hasActors: boolean; hasQueues: boolean; hasPersistentStorage?: boolean },
): Promise<void> {
  if (!flags.hasActors && !flags.hasQueues && !flags.hasPersistentStorage) return;
  const name = deploymentResourceName(project);
  const hostPath = hostStoragePath(project.applicationName);
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
    const list = JSON.parse(result.stdout) as {
      items?: Array<{
        metadata?: { name?: string };
        spec?: { template?: { spec?: { volumes?: Array<{ hostPath?: { path?: string } }> } } };
      }>;
    };
    let conflict: CommandFailure | undefined;
    for (const item of list.items ?? []) {
      for (const volume of item.spec?.template?.spec?.volumes ?? []) {
        if (volume.hostPath?.path === hostPath) {
          conflict = new CommandFailure(
            'WASMCLOUD_STORAGE_OWNERSHIP_CONFLICT',
            `Storage path ${hostPath} is already claimed by WorkloadDeployment ${item.metadata?.name ?? 'unknown'}`,
            2,
            { application: project.applicationName, path: hostPath, owner: item.metadata?.name },
          );
        }
      }
    }
    if (conflict) throw conflict;
  } catch (error) {
    if (error instanceof CommandFailure) throw error;
  }
  void name;
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
      `${WORKLOAD_DEPLOYMENT_RESOURCE},service,cronjob,secret`,
      '-l',
      `app.kubernetes.io/name=${name}`,
      '--ignore-not-found',
      '--wait=true',
      '--timeout=180s',
    ],
    project.projectRoot,
  );
  await cleanupManagedBindings(project, connection, new Set(), deps);
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
