import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type CliIo, CommandFailure } from '@di-framework/cli-extension';
import type { WasmcloudDeps } from './deps';
import { captureKubectl, runKubectl } from './kubernetes';
import { ASSOCIATION_WORKLOAD_LABEL } from './managed-bindings';
import type { WasmcloudProject } from './project';
import {
  BACKING_SERVICE_API_VERSION,
  BACKING_SERVICE_KIND,
  BACKING_SERVICE_RESOURCE,
  isBackingServiceName,
} from './service';
import type { ClusterConnection } from './target';
import type { WitLock } from './wit';

/**
 * Tenant workloads cannot name outbound hosts themselves. The CLI turns the project's
 * `allowedIpNameLookups` into an egress BackingService plus a ServiceBinding; the platform
 * approves the destinations against its class policy and patches the WorkloadDeployment.
 */
export const EGRESS_BINDING_NAME = 'egress';
/** Marks the BackingService the CLI owns for one WorkloadDeployment. */
export const EGRESS_WORKLOAD_LABEL = 'di-framework.dev/egress-workload';
const BINDING_RESOURCE = 'servicebindings.platform.di-framework.dev';
const STATUS_ATTEMPTS = 5;
const STATUS_INTERVAL_MS = 2_000;
/** Tag marker for a tenant host image built with a wasi:tls provider. */
export const TLS_HOST_IMAGE_MARKER = 'wasi-tls';

/** A tenant target names its host group; outbound access is a platform grant there. */
export function usesPlatformEgress(connection: Pick<ClusterConnection, 'hostgroup'>): boolean {
  return connection.hostgroup !== undefined;
}

/** BackingService and ServiceBinding name for a WorkloadDeployment's egress grant. */
export function egressResourceName(workloadName: string): string {
  return `${workloadName}-egress`;
}

type OwnedDocument = {
  metadata?: { labels?: Record<string, string> };
  spec?: { type?: string; capability?: string };
};

type EgressServiceDocument = {
  status?: {
    approved?: string[];
    conditions?: { type?: string; status?: string; reason?: string; message?: string }[];
  };
};

function egressFailure(message: string, details: Record<string, string> = {}): never {
  throw new CommandFailure('WASMCLOUD_EGRESS_FAILED', message, 2, details);
}

function ownedBy(document: OwnedDocument, label: string, workload: string): boolean {
  const labels = document.metadata?.labels;
  return labels?.['app.kubernetes.io/managed-by'] === 'di-framework' && labels[label] === workload;
}

async function assertAdoptable(
  project: WasmcloudProject,
  connection: ClusterConnection,
  resource: string,
  kind: string,
  name: string,
  label: string,
  deps: WasmcloudDeps,
): Promise<void> {
  const result = await captureKubectl(
    deps,
    connection,
    ['get', resource, name, '-o', 'json', '--ignore-not-found'],
    project.projectRoot,
  );
  if (result.exitCode !== 0)
    egressFailure(
      `Cannot read ${kind} ${name}; install the platform backing-service CRDs and check tenant permissions`,
      { name, namespace: connection.namespace },
    );
  if (!result.stdout.trim()) return;
  const document = JSON.parse(result.stdout) as OwnedDocument;
  if (!ownedBy(document, label, project.witName))
    egressFailure(
      `Refusing to adopt ${kind} ${name}; it was not created by di-framework deploy for ${project.witName}`,
      { name, namespace: connection.namespace },
    );
}

/**
 * Ensure the egress BackingService and ServiceBinding for a tenant deploy. Returns the
 * ServiceBinding name to keep, or undefined when the target or project has no egress.
 */
export async function applyWorkloadEgress(
  project: WasmcloudProject,
  connection: ClusterConnection,
  deps: WasmcloudDeps,
): Promise<string | undefined> {
  const destinations = project.allowedIpNameLookups ?? [];
  if (!usesPlatformEgress(connection) || destinations.length === 0) return undefined;
  if (destinations.includes('*'))
    egressFailure(
      'allowedIpNameLookups "*" cannot be granted on a tenant target; list the hosts or *.suffix names the workload calls',
    );
  const workload = project.witName;
  const name = egressResourceName(workload);
  if (!isBackingServiceName(name))
    egressFailure(
      `Egress BackingService name ${name} is longer than 40 characters; shorten the application name to use allowedIpNameLookups on a tenant target`,
      { name },
    );
  await assertAdoptable(
    project,
    connection,
    BACKING_SERVICE_RESOURCE,
    'BackingService',
    name,
    EGRESS_WORKLOAD_LABEL,
    deps,
  );
  await assertAdoptable(
    project,
    connection,
    BINDING_RESOURCE,
    'ServiceBinding',
    name,
    ASSOCIATION_WORKLOAD_LABEL,
    deps,
  );
  const items = [
    {
      apiVersion: BACKING_SERVICE_API_VERSION,
      kind: BACKING_SERVICE_KIND,
      metadata: {
        name,
        namespace: connection.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'di-framework',
          [EGRESS_WORKLOAD_LABEL]: workload,
        },
      },
      spec: { type: 'egress', destinations: [...destinations] },
    },
    {
      apiVersion: BACKING_SERVICE_API_VERSION,
      kind: 'ServiceBinding',
      metadata: {
        name,
        namespace: connection.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'di-framework',
          [ASSOCIATION_WORKLOAD_LABEL]: workload,
        },
      },
      spec: {
        serviceName: name,
        bindingName: EGRESS_BINDING_NAME,
        capability: 'egress',
        workloadName: workload,
      },
    },
  ];
  const directory = join(project.projectRoot, '.di-framework', 'deploy');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'egress.json');
  writeFileSync(path, JSON.stringify({ apiVersion: 'v1', kind: 'List', items }, null, 2));
  await runKubectl(deps, connection, ['apply', '-f', path], project.projectRoot);
  return name;
}

/**
 * Remove the deploy-owned egress BackingService once its binding is gone. Only resources
 * labelled for this WorkloadDeployment are touched.
 */
export async function removeWorkloadEgress(
  project: WasmcloudProject,
  connection: ClusterConnection,
  deps: WasmcloudDeps,
): Promise<void> {
  if (!usesPlatformEgress(connection)) return;
  const result = await captureKubectl(
    deps,
    connection,
    [
      'delete',
      BACKING_SERVICE_RESOURCE,
      '-l',
      `${EGRESS_WORKLOAD_LABEL}=${project.witName},app.kubernetes.io/managed-by=di-framework`,
      '--ignore-not-found',
      '--wait=true',
      '--timeout=180s',
    ],
    project.projectRoot,
  );
  if (
    result.exitCode !== 0 &&
    !/the server doesn't have a resource type|could not find the requested resource/i.test(
      result.stderr,
    )
  )
    egressFailure(`Cannot remove the egress BackingService for ${project.witName}`, {
      name: egressResourceName(project.witName),
    });
}

/**
 * Tell the developer whether the platform approved the egress destinations. A missing
 * approval never fails the deploy: the workload runs, its outbound calls stay blocked.
 */
export async function reportEgressStatus(
  project: WasmcloudProject,
  connection: ClusterConnection,
  io: CliIo,
  deps: WasmcloudDeps,
): Promise<void> {
  const name = egressResourceName(project.witName);
  let condition: { status?: string; reason?: string; message?: string } | undefined;
  let approved: string[] = [];
  for (let attempt = 0; attempt < STATUS_ATTEMPTS; attempt++) {
    const result = await captureKubectl(
      deps,
      connection,
      ['get', BACKING_SERVICE_RESOURCE, name, '-o', 'json'],
      project.projectRoot,
    );
    if (result.exitCode === 0) {
      try {
        const document = JSON.parse(result.stdout) as EgressServiceDocument;
        condition = document.status?.conditions?.find((entry) => entry.type === 'Ready');
        approved = document.status?.approved ?? [];
      } catch {
        condition = undefined;
      }
    }
    if (condition?.status === 'True' || condition?.reason === 'NotApproved') break;
    await deps.wait(STATUS_INTERVAL_MS);
  }
  if (condition?.status === 'True') {
    io.stdout.write(`Egress approved for ${project.witName}: ${approved.join(', ')}\n`);
    return;
  }
  if (condition?.reason === 'NotApproved') {
    io.stderr.write(
      `Note: egress for ${project.witName} is not approved${condition.message ? ` (${condition.message})` : ''}. ` +
        "A platform admin must allow the destination in the platform's egressAllowedDestinations; " +
        'until then outbound connections from this workload stay blocked.\n',
    );
    return;
  }
  io.stderr.write(
    `Note: egress BackingService ${name} is not Ready yet` +
      (condition?.message ? ` (${condition.message})` : '') +
      `; check it with: di-framework platform service get ${name}\n`,
  );
}

function importsWasiTls(project: WasmcloudProject): boolean {
  try {
    const lock = JSON.parse(
      readFileSync(join(project.projectRoot, '.di-framework', 'wit.lock.json'), 'utf8'),
    ) as WitLock;
    return lock.requirements.some(
      (requirement) => requirement.package === 'wasi:tls' && requirement.direction === 'import',
    );
  } catch {
    return false;
  }
}

/**
 * Warn when a component that imports wasi:tls goes to a tenant host without a TLS provider.
 * The host image is read from the tenant host pods in `di-runtime-<tenant>`; a tag carrying
 * `wasi-tls` (e.g. `…:2.8.0-wasi-tls`) counts as TLS-capable. Stock wash images do not.
 * Anything unreadable stays silent.
 */
export async function warnIfTenantHostLacksTls(
  project: WasmcloudProject,
  connection: ClusterConnection,
  io: CliIo,
  deps: WasmcloudDeps,
): Promise<void> {
  const hostgroup = connection.hostgroup;
  if (hostgroup === undefined || !hostgroup.startsWith('tenant-')) return;
  if (!importsWasiTls(project)) return;
  const runtime = { ...connection, namespace: `di-runtime-${hostgroup.slice('tenant-'.length)}` };
  const result = await captureKubectl(
    deps,
    runtime,
    ['get', 'pods', '-l', `wasmcloud.com/hostgroup=${hostgroup}`, '-o', 'json'],
    project.projectRoot,
  );
  if (result.exitCode !== 0) return;
  let images: string[];
  try {
    const list = JSON.parse(result.stdout) as {
      items?: { spec?: { containers?: { image?: string }[] } }[];
    };
    images = (list.items ?? []).flatMap((pod) =>
      (pod.spec?.containers ?? []).flatMap((container) =>
        typeof container.image === 'string' ? [container.image] : [],
      ),
    );
  } catch {
    return;
  }
  const image = images[0];
  if (image === undefined || images.some(hasTlsTag)) return;
  io.stderr.write(
    `Warning: ${project.applicationName} imports wasi:tls, but host group ${hostgroup} runs ${image}, ` +
      `which has no wasi:tls provider. TLS connections from this workload will fail until a platform ` +
      `admin switches the tenant host to an image built with wasi-tls (tagged *-${TLS_HOST_IMAGE_MARKER}).\n`,
  );
}

function hasTlsTag(image: string): boolean {
  const tag = image.split('@')[0]?.split('/').pop()?.split(':')[1];
  return tag?.includes(TLS_HOST_IMAGE_MARKER) === true;
}
