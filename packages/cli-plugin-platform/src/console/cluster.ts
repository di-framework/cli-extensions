import type { WasmcloudDeps } from '../deps';
import { captureKubectl } from '../kubernetes';
import type { ClusterConnection } from '../target';
import { MANAGED_BY_LABEL, WORKLOAD_DEPLOYMENT_RESOURCE } from '../workload';
import type { CronJobDocument, JsonPatchOp, WorkloadDocument } from './catalog';
import { ConsoleError, sanitizePublicText } from './errors';

export type ConsoleCluster = {
  listWorkloads(connection: ClusterConnection): Promise<WorkloadDocument[]>;
  listCronJobs(connection: ClusterConnection): Promise<CronJobDocument[]>;
  patchWorkload(
    connection: ClusterConnection,
    name: string,
    ops: readonly JsonPatchOp[],
  ): Promise<void>;
  patchCronJob(connection: ClusterConnection, name: string, suspend: boolean): Promise<void>;
};

export function createKubectlConsoleCluster(
  deps: WasmcloudDeps,
  log: (line: string) => void = () => undefined,
): ConsoleCluster {
  const label = `app.kubernetes.io/managed-by=${MANAGED_BY_LABEL}`;
  return {
    async listWorkloads(connection) {
      const body = await kubectlJson(
        deps,
        connection,
        ['get', WORKLOAD_DEPLOYMENT_RESOURCE, '-l', label, '-o', 'json'],
        log,
      );
      return items(body) as WorkloadDocument[];
    },
    async listCronJobs(connection) {
      const body = await kubectlJson(
        deps,
        connection,
        ['get', 'cronjob', '-l', label, '-o', 'json'],
        log,
      );
      return items(body) as CronJobDocument[];
    },
    async patchWorkload(connection, name, ops) {
      await kubectlOk(
        deps,
        connection,
        ['patch', WORKLOAD_DEPLOYMENT_RESOURCE, name, '--type=json', `-p=${JSON.stringify(ops)}`],
        log,
      );
    },
    async patchCronJob(connection, name, suspend) {
      await kubectlOk(
        deps,
        connection,
        [
          'patch',
          'cronjob',
          name,
          '--type=json',
          `-p=${JSON.stringify([{ op: 'replace', path: '/spec/suspend', value: suspend }])}`,
        ],
        log,
      );
    },
  };
}

async function kubectlJson(
  deps: WasmcloudDeps,
  connection: ClusterConnection,
  args: readonly string[],
  log: (line: string) => void,
): Promise<unknown> {
  const result = await captureKubectl(deps, connection, args, deps.cwd());
  if (result.exitCode !== 0) {
    log(sanitizePublicText(result.stderr || result.stdout || 'kubectl failed'));
    throw new ConsoleError(502, 'CLUSTER_REQUEST_FAILED', 'The cluster request failed.');
  }
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    log('kubectl returned unparseable JSON');
    throw new ConsoleError(502, 'CLUSTER_REQUEST_FAILED', 'The cluster request failed.');
  }
}

async function kubectlOk(
  deps: WasmcloudDeps,
  connection: ClusterConnection,
  args: readonly string[],
  log: (line: string) => void,
): Promise<void> {
  const result = await captureKubectl(deps, connection, args, deps.cwd());
  if (result.exitCode !== 0) {
    log(sanitizePublicText(result.stderr || result.stdout || 'kubectl failed'));
    throw new ConsoleError(502, 'CLUSTER_REQUEST_FAILED', 'The cluster request failed.');
  }
}

function items(body: unknown): unknown[] {
  if (body === null || typeof body !== 'object' || !('items' in body)) {
    throw new ConsoleError(502, 'CLUSTER_REQUEST_FAILED', 'The cluster request failed.');
  }
  const list = (body as { items?: unknown }).items;
  if (!Array.isArray(list)) {
    throw new ConsoleError(502, 'CLUSTER_REQUEST_FAILED', 'The cluster request failed.');
  }
  return list;
}
