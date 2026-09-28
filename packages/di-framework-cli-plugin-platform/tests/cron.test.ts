import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverScheduledJobs,
  discoverScheduledJobsInFile,
  normalizeCronExpression,
  renderCronAdapterModule,
  renderCronInvokerModule,
} from '../src/cron';
import type { WasmcloudProject } from '../src/project';
import type { ClusterConnection } from '../src/target';
import { renderWorkloadManifest } from '../src/workload';

describe('wasmCloud @Cron discovery and deployment generation', () => {
  it('normalizes schedules to 5-field cron expressions', () => {
    expect(normalizeCronExpression('0 2 * * *')).toBe('0 2 * * *');
    expect(normalizeCronExpression('*/5 * * * *')).toBe('*/5 * * * *');
    expect(normalizeCronExpression(60000)).toBe('* * * * *');
    expect(normalizeCronExpression(120000)).toBe('*/2 * * * *');
    expect(normalizeCronExpression(300000)).toBe('*/5 * * * *');
  });

  it('discovers @Cron decorated methods from source files with stable job identifiers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cron-discovery-'));
    const srcDir = join(dir, 'src');
    mkdirSync(srcDir, { recursive: true });

    const sourceCode = `
import { Cron } from '@di-framework/core';

export class OrderCleanupService {
  @Cron('0 1 * * *', { name: 'order-cleanup', description: 'Purges cancelled orders', allowConcurrent: false })
  async cleanupOrders() {
    return 'cleaned';
  }

  @Cron(60000)
  syncInventory() {
    return 'synced';
  }
}

export class NotificationService {
  @Cron('*/15 * * * *', { allowConcurrent: true, timeoutMs: 5000 })
  async sendBatchedNotifications() {
    return 'sent';
  }
}
`;

    const filePath = join(srcDir, 'services.ts');
    writeFileSync(filePath, sourceCode);

    const jobs = discoverScheduledJobs(dir);
    expect(jobs.length).toBe(3);

    const orderJob = jobs.find((j) => j.jobId === 'order-cleanup');
    expect(orderJob).toBeDefined();
    expect(orderJob?.className).toBe('OrderCleanupService');
    expect(orderJob?.methodName).toBe('cleanupOrders');
    expect(orderJob?.schedule).toBe('0 1 * * *');
    expect(orderJob?.cronExpression).toBe('0 1 * * *');
    expect(orderJob?.allowConcurrent).toBe(false);
    expect(orderJob?.description).toBe('Purges cancelled orders');
    expect(orderJob?.kebabId).toBe('order-cleanup');

    const syncJob = jobs.find((j) => j.jobId === 'OrderCleanupService.syncInventory');
    expect(syncJob).toBeDefined();
    expect(syncJob?.schedule).toBe(60000);
    expect(syncJob?.cronExpression).toBe('* * * * *');
    expect(syncJob?.kebabId).toBe('order-cleanup-service-sync-inventory');

    const notifJob = jobs.find((j) => j.jobId === 'NotificationService.sendBatchedNotifications');
    expect(notifJob).toBeDefined();
    expect(notifJob?.allowConcurrent).toBe(true);
    expect(notifJob?.timeoutMs).toBe(5000);
    expect(notifJob?.cronExpression).toBe('*/15 * * * *');
  });

  it('renders a private invocation interface module', () => {
    const mockJobs = [
      {
        jobId: 'nightly-reindex',
        kebabId: 'nightly-reindex',
        className: 'SearchIndexer',
        methodName: 'reindexAll',
        schedule: '0 3 * * *',
        cronExpression: '0 3 * * *',
        allowConcurrent: false,
        filePath: 'src/search.ts',
      },
    ];

    const invokerModule = renderCronInvokerModule(mockJobs);
    expect(invokerModule).toContain("container.setCronMode('external')");
    expect(invokerModule).toContain('export async function invokeJob(jobId, context)');
    expect(invokerModule).toContain('container.invokeCronJob(jobId, context)');
    expect(invokerModule).not.toContain('error.message');
    expect(invokerModule).not.toContain("status: 'failure'");
    expect(invokerModule).toContain('nightly-reindex');

    const adapterModule = renderCronAdapterModule(mockJobs);
    expect(adapterModule).toContain("export * from './cron-invoker.js'");
  });

  it('generates deployment configuration for external scheduler dispatch and suppresses endpoint when ingress: false', () => {
    const project: WasmcloudProject = {
      applicationName: 'batch-worker',
      witName: 'batch-worker',
      configPath: '/mock/di-framework.config.json',
      entryPath: '/mock/src/index.ts',
      outputPath: '/mock/dist/batch-worker.wasm',
      bindingsPath: undefined,
      bindingsConfigured: false,
      bindingsRelative: 'src/bindings.ts',
      projectRoot: '/mock',
      version: '1.0.0',
      ingress: false, // Scheduled only! No HTTP ingress
    };

    const connection: ClusterConnection = {
      target: 'dev',
      namespace: 'production',
      kubeconfig: '/mock/kubeconfig',
      registry: {
        push: 'registry.wasmcloud.local',
        pull: 'registry.wasmcloud.local',
        insecure: false,
      },
    };

    const mockJobs = [
      {
        jobId: 'daily-backup',
        kebabId: 'daily-backup',
        className: 'BackupService',
        methodName: 'runBackup',
        schedule: '0 2 * * *',
        cronExpression: '0 2 * * *',
        allowConcurrent: false,
        filePath: 'src/backup.ts',
      },
    ];

    const manifest = renderWorkloadManifest(
      project,
      connection,
      'registry.wasmcloud.local/batch-worker:v1',
      [],
      [],
      undefined,
      mockJobs,
    );

    // Cluster Service is required so the CronJob invoker can reach the Wasm control API.
    expect(manifest).toContain('kind: Service');
    expect(manifest).toContain('targetPort: 80');
    expect(manifest).toContain('service:\n          name: batch-worker');

    // Should contain WorkloadDeployment with external cron mode
    expect(manifest).toContain('kind: WorkloadDeployment');
    expect(manifest).toContain('DI_CRON_MODE');
    expect(manifest).toContain('"external"');

    // Should contain Kubernetes CronJob for scheduler dispatch via HTTP invoker
    expect(manifest).toContain('apiVersion: batch/v1');
    expect(manifest).toContain('kind: CronJob');
    expect(manifest).toContain('name: batch-worker-daily-backup');
    expect(manifest).toContain('schedule: "0 2 * * *"');
    expect(manifest).toContain('concurrencyPolicy: Forbid');
    expect(manifest).toContain('name: DI_CRON_INVOKE_JOB');
    expect(manifest).toContain('value: "daily-backup"');
    expect(manifest).toContain('cron-invoker');
    expect(manifest).toContain('/_di/cron/daily-backup/invoke');
    expect(manifest).toContain('Host: batch-worker.production.svc.cluster.local');
    expect(manifest).toContain('"host": "batch-worker.production.svc.cluster.local"');
    expect(manifest).toContain('DI_CONTROL_REJECT_FORWARDED: "1"');
    expect(manifest).toContain('curlimages/curl:');
    expect(manifest).toContain('name: batch-worker-control');
    expect(manifest).toContain('key: DI_CONTROL_TOKEN');
    expect(manifest).toMatch(/Authorization: Bearer \$\{DI_CONTROL_TOKEN\}/);
    expect(manifest).not.toContain('optional: true');
  });

  it('retains HTTP Service when ingress is enabled along with scheduled jobs', () => {
    const project: WasmcloudProject = {
      applicationName: 'hybrid-app',
      witName: 'hybrid-app',
      configPath: '/mock/di-framework.config.json',
      entryPath: '/mock/src/index.ts',
      outputPath: '/mock/dist/hybrid-app.wasm',
      bindingsPath: undefined,
      bindingsConfigured: false,
      bindingsRelative: 'src/bindings.ts',
      projectRoot: '/mock',
      version: '1.0.0',
      ingress: true,
    };

    const connection: ClusterConnection = {
      target: 'dev',
      namespace: 'default',
      kubeconfig: '/mock/kubeconfig',
      registry: { push: 'registry.local', pull: 'registry.local', insecure: false },
    };

    const mockJobs = [
      {
        jobId: 'sync-cache',
        kebabId: 'sync-cache',
        className: 'CacheService',
        methodName: 'sync',
        schedule: '*/5 * * * *',
        cronExpression: '*/5 * * * *',
        allowConcurrent: true,
        filePath: 'src/cache.ts',
      },
    ];

    const manifest = renderWorkloadManifest(
      project,
      connection,
      'registry.local/hybrid-app:latest',
      [],
      [],
      undefined,
      mockJobs,
    );

    // Has both Service (for HTTP) and CronJob (for external scheduler)
    expect(manifest).toContain('kind: Service');
    expect(manifest).toContain('kind: WorkloadDeployment');
    expect(manifest).toContain('kind: CronJob');
    expect(manifest).toContain('name: hybrid-app-sync-cache');
    expect(manifest).toContain('concurrencyPolicy: Allow');

    for (const ingress of [true, false]) {
      const combined = renderWorkloadManifest(
        { ...project, ingress },
        connection,
        'registry.local/hybrid-app:latest',
        [],
        [],
        { hasActors: true },
        mockJobs,
      );
      const documents = combined
        .split('\n---\n')
        .map((document) => Bun.YAML.parse(document) as any);
      const workload = documents.find((document) => document.kind === 'WorkloadDeployment');
      expect(workload.spec.deployPolicy).toBe('Recreate');
      const spec = workload.spec.template.spec;
      expect(spec.hostSelector.hostgroup).toBe('storage');
      expect(spec.volumes[0].hostPath.path).toBe('/var/lib/di-framework/storage/hybrid-app');
      expect(spec.components[0].localResources.environment.config).toEqual({
        ACTOR_STORAGE_DIR: '/data/actors',
        DI_CONTROL_HTTP_HOST: 'hybrid-app,hybrid-app.default.svc.cluster.local',
        DI_CONTROL_REJECT_FORWARDED: '1',
        DI_CRON_MODE: 'external',
        DI_SQLITE_BACKEND: 'wasm',
        DI_STORAGE_DIR: '/data/actors',
      });
      expect(spec.components[0].localResources.volumeMounts[0]).toEqual({
        name: 'app-storage',
        mountPath: '/data/actors',
      });
      // Control HTTP remains available even when public ingress is disabled.
      expect(documents.some((document) => document.kind === 'Service')).toBe(true);
    }
  });
});

it('discovers nested source and ignores unsupported decorators, options, and unreadable files', () => {
  const root = mkdtempSync(join(tmpdir(), 'cron-edge-'));
  try {
    expect(discoverScheduledJobs(join(root, 'missing'))).toEqual([]);
    expect(discoverScheduledJobsInFile(join(root, 'missing.ts'))).toEqual([]);
    mkdirSync(join(root, 'nested'));
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'plain.ts'), 'export const value = 1;');
    writeFileSync(join(root, 'ignored.d.ts'), 'declare class Cron {}');
    writeFileSync(join(root, 'node_modules', 'skip.ts'), 'class X { @Cron(60000) run() {} }');
    writeFileSync(
      join(root, 'nested', 'jobs.ts'),
      `
      class Worker {
        @Cron run() {}
        @Other() other() {}
        @factory['Cron'](60000) unsupported() {}
        @Cron() absent() {}
        @Cron(dynamic) dynamic() {}
        @Cron(60000, { allowConcurrent: dynamic, ...extra, ['name']: 'ignored' }) fallback() {}
        @framework.Cron(60000, { name: 'shared' }) nested() {}
      }
    `,
    );
    writeFileSync(
      join(root, 'duplicate.js'),
      "class Duplicate { @Cron(60000, { name: 'shared' }) run() {} }",
    );
    const jobs = discoverScheduledJobs(root);
    expect(jobs.map((job) => job.jobId).sort()).toEqual(['Worker.fallback', 'shared']);
    expect(jobs.find((job) => job.jobId === 'Worker.fallback')?.allowConcurrent).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
