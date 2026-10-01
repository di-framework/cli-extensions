import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandFailure } from '@di-framework/cli-extension';
import { createSessionStore, readCookie, sessionCookie } from '../src/console/auth';
import {
  assertResourceName,
  type CronJobDocument,
  cronInTenantScope,
  isSensitiveConfigKey,
  listTargetViews,
  parseAppUpdate,
  parseCronUpdate,
  planWorkloadUpdate,
  publicRegistryHost,
  queueSettingBounds,
  queueSettingLabel,
  storagePinsReplicas,
  summarizeCron,
  summarizeWorkload,
  unassignedCronJobs,
  type WorkloadDocument,
  workloadInTenantScope,
} from '../src/console/catalog';
import { createKubectlConsoleCluster } from '../src/console/cluster';
import { sanitizePublicText } from '../src/console/errors';
import {
  consoleAssetsDirectory,
  consolePassword,
  parseConsoleArgs,
  runWasmcloudConsole,
} from '../src/console/run';
import { startConsoleServer } from '../src/console/server';
import { createCliConsoleServices } from '../src/console/services';
import { parseDeployManifest } from '../src/manifest';
import type { ClusterConnection } from '../src/target';
import { captureIo, fakeDeps, makeWorkspace } from './helpers';

const connection = {
  target: 'development',
  kubeconfig: '/tmp/kubeconfig',
  namespace: 'wasmcloud',
  registry: { pull: 'registry.example.com/team', push: 'registry.example.com/team' },
} as ClusterConnection;

function request(
  port: number,
  options: {
    path: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    origin?: boolean;
  },
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {
    host: `127.0.0.1:${port}`,
    ...(options.origin === false ? {} : { origin: `http://127.0.0.1:${port}` }),
    ...options.headers,
  };
  if (options.body !== undefined)
    headers['content-length'] = String(Buffer.byteLength(options.body));
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path: options.path, method, headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

function sessionCookieHeader(setCookie: string | string[] | undefined): string {
  const value = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return (value ?? '').split(';')[0] ?? '';
}

describe('console branches', () => {
  it('covers session expiry, login windows, and cookie decoding', () => {
    const store = createSessionStore();
    const first = store.create();
    expect(store.read(first.id, first.session.expiresAt)).toBeUndefined();
    expect(store.read(undefined, 0)).toBeUndefined();
    expect(store.read('missing', 0)).toBeUndefined();
    store.destroy(undefined);
    for (let index = 0; index < 100; index += 1) store.create();
    expect(store.create().id.length).toBeGreaterThan(10);

    expect(store.loginAllowed('client', 0)).toBe(true);
    store.recordFailure('client', 0);
    store.recordFailure('client', 1);
    for (let index = 0; index < 6; index += 1) store.recordFailure('client', 2);
    expect(store.loginAllowed('client', 2)).toBe(false);
    expect(store.loginAllowed('client', 15 * 60 * 1000 + 3)).toBe(true);
    store.clearFailures('client');
    expect(store.loginAllowed('client', 3)).toBe(true);

    expect(readCookie(undefined, 'di_console_session')).toBeUndefined();
    expect(
      readCookie('other=1; broken; di_console_session=%E0%A4%A', 'di_console_session'),
    ).toBeUndefined();
    expect(readCookie('di_console_session=operator', 'missing')).toBeUndefined();
    expect(sessionCookie('operator', 10)).toContain('Max-Age=10');
  });

  it('redacts credential-shaped text and validates catalog updates', () => {
    const long = 'a'.repeat(50);
    const sanitized = sanitizePublicText(`Bearer ${long} token=${long} ${'word '.repeat(100)}`, 80);
    expect(sanitized.endsWith('…')).toBe(true);
    expect(sanitized).not.toContain(long);

    expect(() => assertResourceName('Not_A_Name', 'Application name')).toThrow('DNS label');
    expect(isSensitiveConfigKey('API_KEY')).toBe(true);
    expect(queueSettingLabel('UNRELATED')).toBe('UNRELATED');
    expect(queueSettingLabel('DI_QUEUE_MAIL_MAX_RETRIES')).toBe('mail max retries');
    expect(queueSettingLabel('DI_QUEUE_MAIL_BACKOFF_MS')).toBe('mail backoff (ms)');
    expect(queueSettingLabel('DI_QUEUE_MAIL_TIMEOUT_MS')).toBe('mail timeout (ms)');
    expect(queueSettingBounds('DI_QUEUE_MAIL_MAX_RETRIES')).toEqual({ min: 0, max: 100 });
    expect(queueSettingBounds('DI_QUEUE_MAIL_BACKOFF_MS')?.max).toBe(3_600_000);
    expect(queueSettingBounds('DI_QUEUE_MAIL_TIMEOUT_MS')?.min).toBe(1);
    expect(queueSettingBounds('OTHER')).toBeUndefined();
    expect(publicRegistryHost('registry.example.com')).toBe('registry.example.com');

    const manifest = parseDeployManifest(
      '/workspace/di-framework.deploy.toml',
      `default-target = "local"\n[targets.local]\nplatform = "deploy/platform"\nstack = "dev"\n[targets.edge]\nkubeconfig = "/tmp/kubeconfig"\nnamespace = "wasmcloud"\nhostgroup = "tenant-development"\nregistry = "registry.example.com/team"\n`,
      {},
    );
    expect(listTargetViews(manifest).map((target) => target.kind)).toEqual(['external', 'managed']);

    expect(
      storagePinsReplicas({
        spec: {
          template: {
            spec: {
              components: [
                { localResources: { environment: { config: { ACTOR_STORAGE_DIR: '/actors' } } } },
              ],
            },
          },
        },
      }),
    ).toBe(true);
    expect(
      storagePinsReplicas({
        spec: {
          template: {
            spec: {
              components: [
                { localResources: { environment: { config: { QUEUE_DB_PATH: '/queue' } } } },
              ],
            },
          },
        },
      }),
    ).toBe(true);
    expect(storagePinsReplicas({})).toBe(false);
    expect(
      workloadInTenantScope(
        { metadata: { namespace: 'di-tenant-other' } },
        { namespace: 'di-tenant-warehouse', hostgroup: 'tenant-warehouse' },
      ),
    ).toBe(false);
    expect(
      workloadInTenantScope(
        {
          metadata: { namespace: 'di-tenant-warehouse' },
          spec: { template: { spec: { hostSelector: { hostgroup: 'other' } } } },
        },
        { namespace: 'di-tenant-warehouse', hostgroup: 'tenant-warehouse' },
      ),
    ).toBe(false);
    expect(
      workloadInTenantScope(
        { metadata: { namespace: 'di-tenant-warehouse' } },
        { namespace: 'di-tenant-warehouse', hostgroup: 'tenant-warehouse' },
      ),
    ).toBe(true);
    expect(
      cronInTenantScope({ metadata: { namespace: 'di-tenant-other' } }, 'di-tenant-warehouse'),
    ).toBe(false);
    expect(cronInTenantScope({}, 'di-tenant-warehouse')).toBe(true);

    const bare: WorkloadDocument = {
      metadata: {
        name: 'bare',
        labels: { 'app.kubernetes.io/managed-by': 'di-framework' },
      },
      spec: { template: { spec: { components: [{ name: 'bare' }] } } },
      status: {
        replicas: { ready: 1 },
        conditions: [{ type: 'Ready', status: 'True', message: 'm'.repeat(250) }],
      },
    };
    const bareView = summarizeWorkload(bare, 'development', []);
    expect(bareView?.pinnedReplicas).toBe(false);
    expect(bareView?.message?.endsWith('…')).toBe(true);
    expect(summarizeWorkload({}, 'development')).toBeUndefined();
    expect(summarizeWorkload({ metadata: { name: 'x' } }, 'development')).toBeUndefined();
    expect(summarizeCron({})).toBeUndefined();
    expect(
      summarizeCron({
        metadata: { name: 'job', labels: { 'app.kubernetes.io/managed-by': 'other' } },
      }),
    ).toBeUndefined();
    expect(
      summarizeCron({
        metadata: { name: 'job', labels: { 'app.kubernetes.io/managed-by': 'di-framework' } },
      }),
    ).toBeUndefined();
    const cron = summarizeCron({
      metadata: { name: 'job', labels: { 'app.kubernetes.io/managed-by': 'di-framework' } },
      spec: { schedule: '0 * * * *' },
    });
    expect(
      unassignedCronJobs(
        [],
        [
          cron
            ? {
                metadata: {
                  name: 'job',
                  labels: { 'app.kubernetes.io/managed-by': 'di-framework' },
                },
                spec: { schedule: '0 * * * *' },
              }
            : {},
        ],
      ),
    ).toHaveLength(1);

    const sensitiveHost: WorkloadDocument = {
      metadata: { name: 'edge', labels: { 'app.kubernetes.io/managed-by': 'di-framework' } },
      spec: {
        template: {
          spec: {
            components: [
              {
                hostInterfaces: [
                  {
                    namespace: 'wasi',
                    package: 'http',
                    config: { host: 'http://user:secret@example.com', API_KEY: 'visible-name' },
                  },
                ],
                localResources: {
                  environment: {
                    config: { DI_QUEUE_MAIL_CONCURRENCY: 'nope', PLAIN: 'value' },
                  },
                },
              },
            ],
          },
        },
      },
    };
    expect(summarizeWorkload(sensitiveHost, 'development')?.httpHost).toBeUndefined();

    expect(() => parseAppUpdate(null)).toThrow('object');
    expect(() =>
      parseAppUpdate({ namespace: 'kube-system', target: 'development', replicas: 1 }),
    ).toThrow('unsupported');
    expect(() => parseAppUpdate({ target: '' })).toThrow('target');
    expect(() => parseAppUpdate({ target: 'development', replicas: 1.5 })).toThrow('Replicas');
    expect(() => parseAppUpdate({ target: 'development', allowedIpNameLookups: 'echo' })).toThrow(
      'DNS',
    );
    expect(() => parseAppUpdate({ target: 'development', allowedIpNameLookups: ['*'] })).toThrow(
      'hostname',
    );
    expect(() =>
      parseAppUpdate({
        target: 'development',
        allowedIpNameLookups: Array.from({ length: 33 }, () => 'a.example.com'),
      }),
    ).toThrow('32');
    expect(() => parseAppUpdate({ target: 'development', queueSettings: {} })).toThrow('list');
    expect(() => parseAppUpdate({ target: 'development', queueSettings: [null] })).toThrow(
      'key and value',
    );
    expect(() =>
      parseAppUpdate({ target: 'development', queueSettings: [{ key: 'NOPE', value: 1 }] }),
    ).toThrow('already declared');
    expect(() =>
      parseAppUpdate({
        target: 'development',
        queueSettings: [{ key: 'DI_QUEUE_MAIL_CONCURRENCY', value: '2' }],
      }),
    ).toThrow('whole numbers');
    expect(() => parseAppUpdate({ target: 'development' })).toThrow('at least one');

    expect(planWorkloadUpdate(bare, { replicas: 2 })[0]?.op).toBe('add');
    expect(planWorkloadUpdate(bare, { replicas: 1 })).toEqual([]);
    expect(planWorkloadUpdate(bare, { allowedIpNameLookups: ['api.example.com'] })[0]?.op).toBe(
      'add',
    );
    expect(() =>
      planWorkloadUpdate(
        { metadata: { name: 'empty', labels: { 'app.kubernetes.io/managed-by': 'di-framework' } } },
        { allowedIpNameLookups: ['api.example.com'] },
      ),
    ).toThrow('no component');
    const withConfig: WorkloadDocument = {
      metadata: { name: 'queue', labels: { 'app.kubernetes.io/managed-by': 'di-framework' } },
      spec: {
        template: {
          spec: {
            components: [
              {
                localResources: {
                  environment: { config: { DI_QUEUE_MAIL_TIMEOUT_MS: '10' } },
                },
              },
            ],
          },
        },
      },
    };
    expect(() =>
      planWorkloadUpdate(withConfig, {
        queueSettings: [{ key: 'DI_QUEUE_MAIL_TIMEOUT_MS', value: 0 }],
      }),
    ).toThrow('timeout');
    expect(
      planWorkloadUpdate(withConfig, {
        queueSettings: [{ key: 'DI_QUEUE_MAIL_TIMEOUT_MS', value: 10 }],
      }),
    ).toEqual([]);

    expect(() => parseCronUpdate([])).toThrow('object');
    expect(() => parseCronUpdate({ target: 'development', suspend: true, extra: 1 })).toThrow(
      'unsupported',
    );
    expect(() => parseCronUpdate({ target: '', suspend: true })).toThrow('target');
    expect(() => parseCronUpdate({ target: 'development', suspend: 'yes' })).toThrow('suspend');
  });

  it('reports kubectl failures without returning cluster stderr', async () => {
    const logs: string[] = [];
    const cluster = createKubectlConsoleCluster(
      fakeDeps({
        cwd: '/tmp',
        capturedStdout: {
          'kubectl get': '{"items":[{"metadata":{"name":"greeter"}}]}',
          kubectl: '',
        },
      }),
      (line) => logs.push(line),
    );
    expect(await cluster.listWorkloads(connection)).toHaveLength(1);
    expect(await cluster.listCronJobs(connection)).toHaveLength(1);
    await cluster.patchWorkload(connection, 'greeter', []);
    await cluster.patchCronJob(connection, 'greeter-nightly', true);

    const failing = createKubectlConsoleCluster(
      fakeDeps({
        cwd: '/tmp',
        exitCodes: { 'kubectl get': 1, kubectl: 1 },
        capturedStdout: { 'kubectl get': 'Bearer secret-token-value', kubectl: '' },
      }),
      (line) => logs.push(line),
    );
    await expect(failing.listWorkloads(connection)).rejects.toMatchObject({
      code: 'CLUSTER_REQUEST_FAILED',
    });
    await expect(failing.patchWorkload(connection, 'greeter', [])).rejects.toMatchObject({
      status: 502,
    });
    expect(logs.join('\n')).toContain('[redacted]');

    const malformed = createKubectlConsoleCluster(
      fakeDeps({ cwd: '/tmp', capturedStdout: { 'kubectl get': '{' } }),
      (line) => logs.push(line),
    );
    await expect(malformed.listCronJobs(connection)).rejects.toMatchObject({ status: 502 });
    const missingItems = createKubectlConsoleCluster(
      fakeDeps({ cwd: '/tmp', capturedStdout: { 'kubectl get': '{"items":{}}' } }),
      () => undefined,
    );
    await expect(missingItems.listWorkloads(connection)).rejects.toMatchObject({ status: 502 });
    const notAList = createKubectlConsoleCluster(
      fakeDeps({ cwd: '/tmp', capturedStdout: { 'kubectl get': 'null' } }),
      () => undefined,
    );
    await expect(notAList.listWorkloads(connection)).rejects.toMatchObject({ status: 502 });

    const base = fakeDeps({
      cwd: '/tmp',
      capturedStdout: { 'kubectl get': '{"items":[{"metadata":{"name":"greeter"}}]}' },
    });
    const forbiddenCron = createKubectlConsoleCluster(
      {
        ...base,
        runCaptured: async (command, args, options) => {
          if (args.includes('cronjob')) {
            return {
              exitCode: 1,
              stdout: '',
              stderr:
                'Error from server (Forbidden): cronjobs.batch is forbidden: User cannot list resource "cronjobs"',
            };
          }
          return base.runCaptured(command, args, options);
        },
      },
      (line) => logs.push(line),
    );
    expect(await forbiddenCron.listCronJobs(connection)).toEqual([]);
  });

  it('reads backing services through the service commands', async () => {
    const workspace = makeWorkspace({
      manifest: `[targets.development]\nkubeconfig = "\${kubeconfig}"\nnamespace = "wasmcloud"\nhostgroup = "tenant-development"\nregistry = "registry.example.com/team"\n`,
    });
    const listed = JSON.stringify({
      items: [
        {
          metadata: { name: 'stock', namespace: 'wasmcloud' },
          spec: { type: 'keyvalue', className: 'keyvalue-redis', deletionPolicy: 'Retain' },
          status: {
            conditions: [
              {
                type: 'Ready',
                status: 'True',
                reason: 'Ready',
                message: `Bearer ${'c'.repeat(40)}`,
              },
            ],
            endpoint: { host: 'stock.runtime.svc', port: 6379, capability: 'keyvalue' },
          },
        },
        { metadata: { namespace: 'wasmcloud' } },
        'skip-me',
      ],
    });
    const services = createCliConsoleServices(
      fakeDeps({
        cwd: workspace.root,
        env: { kubeconfig: workspace.kubeconfig },
        exitCodes: { 'kubectl get backingservice name': 1 },
        capturedStdout: {
          'kubectl get backingservices': listed,
          'kubectl get backingserviceclasses': JSON.stringify({
            items: [
              {
                metadata: { name: 'keyvalue-redis' },
                spec: { type: 'keyvalue', provider: 'redis', default: true },
              },
              { metadata: { name: 'broken' } },
            ],
          }),
          'kubectl get backingservice': JSON.stringify({
            metadata: { name: 'stock', namespace: 'wasmcloud' },
            spec: { type: 'keyvalue', deletionPolicy: 'Delete' },
          }),
        },
      }),
      captureIo().io,
    );
    const views = await services.list('development');
    expect(views[0]?.endpoint?.host).toBe('stock.runtime.svc');
    expect(JSON.stringify(views)).not.toContain('c'.repeat(40));
    const classes = await services.classes('development');
    expect(classes.fromCluster).toBe(true);
    expect(classes.classes.some((entry) => entry.name === 'keyvalue-redis')).toBe(true);
    const created = await services.create({
      target: 'development',
      type: 'keyvalue',
      name: 'orders',
      className: 'keyvalue-redis',
      memory: '256Mi',
      storage: '1Gi',
      cpu: '100m',
      deletionPolicy: 'Retain',
    });
    expect(created.name).toBe('orders');
    expect(await services.delete('development', 'stock')).toMatchObject({
      deletionPolicy: 'Delete',
    });
  });

  it('serves the remaining console routes and rejects bad requests', async () => {
    const workspace = makeWorkspace({
      manifest: `[targets.development]\nkubeconfig = "\${kubeconfig}"\nnamespace = "wasmcloud"\nhostgroup = "tenant-development"\nregistry = "registry.example.com/team"\n[targets.other]\nkubeconfig = "\${kubeconfig}"\nnamespace = "other"\nregistry = "registry.example.com/team"\n`,
    });
    const assets = mkdtempSync(join(tmpdir(), 'console-assets-'));
    writeFileSync(join(assets, 'index.html'), '<!doctype html><title>console</title>');
    for (const extension of ['.js', '.css', '.svg', '.woff', '.woff2', '.ttf', '.map']) {
      writeFileSync(join(assets, `asset${extension}`), 'asset');
    }
    mkdirSync(join(assets, 'nested'));
    const document: WorkloadDocument = {
      metadata: { name: 'greeter', labels: { 'app.kubernetes.io/managed-by': 'di-framework' } },
      spec: { replicas: 1, template: { spec: { components: [{ name: 'greeter' }] } } },
    };
    let workloads = [document];
    let failList = false;
    const defaults = await startConsoleServer({
      host: '127.0.0.1',
      port: 0,
      target: 'development',
      password: 'correct horse battery',
      assetsDirectory: assets,
      deps: fakeDeps({ cwd: workspace.root, env: { kubeconfig: workspace.kubeconfig } }),
    });
    await defaults.close();

    const server = await startConsoleServer({
      host: '127.0.0.1',
      port: 0,
      target: 'development',
      password: 'correct horse battery',
      assetsDirectory: assets,
      deps: fakeDeps({ cwd: workspace.root, env: { kubeconfig: workspace.kubeconfig } }),
      now: () => 1_000,
      cluster: {
        async listWorkloads() {
          if (failList) throw new Error('cluster unavailable');
          return workloads;
        },
        async listCronJobs() {
          return [
            {
              metadata: {
                name: 'nightly',
                labels: {
                  'app.kubernetes.io/managed-by': 'di-framework',
                  'app.kubernetes.io/name': 'greeter',
                },
              },
              spec: { schedule: '0 3 * * *', suspend: false },
            },
          ];
        },
        async patchWorkload() {
          workloads = [];
        },
        async patchCronJob() {
          return undefined;
        },
      },
      services: {
        async list() {
          return [];
        },
        async classes() {
          return { classes: [], fromCluster: false };
        },
        async create(input) {
          if (input.name === 'conflict') {
            throw new CommandFailure('WASMCLOUD_SERVICE_ALREADY_EXISTS', 'exists', 2);
          }
          if (input.name === 'missing-target') {
            throw new CommandFailure('WASMCLOUD_TARGET_NOT_FOUND', 'missing target', 2);
          }
          if (input.name === 'denied') {
            throw new CommandFailure('WASMCLOUD_SERVICE_UNAUTHORIZED', 'denied', 1);
          }
          if (input.name === 'busy')
            throw new CommandFailure('WASMCLOUD_SERVICE_IN_USE', 'busy', 1);
          if (input.name === 'usage') throw new CommandFailure('WASMCLOUD_USAGE', 'bad flag', 2);
          if (input.name === 'down') throw new CommandFailure('WASMCLOUD_TOOL_FAILED', 'down', 3);
          if (input.name === 'odd') throw 'odd failure';
          return {
            name: input.name,
            namespace: 'wasmcloud',
            type: input.type,
            className: input.className ?? '',
            ready: 'Unknown',
            target: input.target,
          };
        },
        async delete(_target, name) {
          if (name === 'missing')
            throw new CommandFailure('WASMCLOUD_SERVICE_NOT_FOUND', 'missing', 2);
          return { name };
        },
      },
    });

    try {
      expect((await request(server.port, { path: '/applications' })).status).toBe(200);
      expect((await request(server.port, { path: '/favicon.ico' })).status).toBe(404);
      expect((await request(server.port, { path: '/assets/missing.js' })).status).toBe(404);
      expect((await request(server.port, { path: '/assets/nested' })).status).toBe(404);
      expect((await request(server.port, { path: '/assets/%E0%A4%A' })).status).toBe(404);
      for (const extension of ['.js', '.css', '.svg', '.woff', '.woff2', '.ttf', '.map']) {
        expect((await request(server.port, { path: `/assets/asset${extension}` })).status).toBe(
          200,
        );
      }

      const broken = await startConsoleServer({
        host: '127.0.0.1',
        port: 0,
        target: 'development',
        password: 'correct horse battery',
        assetsDirectory: null as unknown as string,
        deps: fakeDeps({ cwd: workspace.root, env: { kubeconfig: workspace.kubeconfig } }),
        cluster: {
          async listWorkloads() {
            return [];
          },
          async listCronJobs() {
            return [];
          },
          async patchWorkload() {},
          async patchCronJob() {},
        },
        services: {
          async list() {
            return [];
          },
          async classes() {
            return { classes: [], fromCluster: false };
          },
          async create(input) {
            return {
              name: input.name,
              namespace: '',
              type: input.type,
              className: '',
              ready: 'Unknown',
              target: input.target,
            };
          },
          async delete(_target, name) {
            return { name };
          },
        },
      });
      expect((await request(broken.port, { path: '/' })).status).toBe(500);
      await broken.close();

      const emptyAssets = mkdtempSync(join(tmpdir(), 'console-empty-'));
      const missingPage = await startConsoleServer({
        host: '127.0.0.1',
        port: 0,
        target: 'development',
        password: 'correct horse battery',
        assetsDirectory: emptyAssets,
        deps: fakeDeps({ cwd: workspace.root, env: { kubeconfig: workspace.kubeconfig } }),
        cluster: {
          async listWorkloads() {
            return [];
          },
          async listCronJobs() {
            return [];
          },
          async patchWorkload() {},
          async patchCronJob() {},
        },
        services: {
          async list() {
            return [];
          },
          async classes() {
            return { classes: [], fromCluster: false };
          },
          async create(input) {
            return {
              name: input.name,
              namespace: '',
              type: input.type,
              className: '',
              ready: 'Unknown',
              target: input.target,
            };
          },
          async delete(_target, name) {
            return { name };
          },
        },
      });
      expect((await request(missingPage.port, { path: '/' })).status).toBe(404);
      await missingPage.close();

      expect(
        (
          await request(server.port, {
            path: '/api/login',
            method: 'POST',
            body: JSON.stringify({ password: 'nope' }),
            origin: false,
          })
        ).status,
      ).toBe(403);
      expect(
        (await request(server.port, { path: '/api/login', method: 'POST', body: '[]' })).status,
      ).toBe(401);
      expect(
        (await request(server.port, { path: '/api/login', method: 'POST', body: '{' })).status,
      ).toBe(400);
      expect(
        (
          await request(server.port, {
            path: '/api/login',
            method: 'POST',
            body: `{"password":"${'x'.repeat(70_000)}"}`,
          })
        ).status,
      ).toBe(413);
      for (let attempt = 0; attempt < 7; attempt += 1) {
        expect(
          (
            await request(server.port, {
              path: '/api/login',
              method: 'POST',
              body: JSON.stringify({ password: 'nope' }),
            })
          ).status,
        ).toBe(401);
      }
      expect(
        (
          await request(server.port, {
            path: '/api/login',
            method: 'POST',
            body: JSON.stringify({ password: 'correct horse battery' }),
          })
        ).status,
      ).toBe(429);

      const fresh = await startConsoleServer({
        host: '127.0.0.1',
        port: 0,
        target: 'development',
        password: 'correct horse battery',
        assetsDirectory: assets,
        deps: fakeDeps({ cwd: workspace.root, env: { kubeconfig: workspace.kubeconfig } }),
        cluster: {
          async listWorkloads() {
            if (failList) throw 'cluster down';
            return workloads;
          },
          async listCronJobs(): Promise<CronJobDocument[]> {
            return [
              {
                metadata: {
                  name: 'nightly',
                  labels: {
                    'app.kubernetes.io/managed-by': 'di-framework',
                    'app.kubernetes.io/name': 'greeter',
                  },
                },
                spec: { schedule: '0 3 * * *', suspend: true },
              },
              {
                metadata: {
                  name: 'orphan',
                  labels: { 'app.kubernetes.io/managed-by': 'di-framework' },
                },
                spec: { schedule: '0 4 * * *' },
              },
            ];
          },
          async patchWorkload() {
            workloads = [];
          },
          async patchCronJob() {},
        },
        services: {
          async list() {
            return [];
          },
          async classes() {
            return { classes: [], fromCluster: false };
          },
          async create(input) {
            if (input.name === 'conflict')
              throw new CommandFailure('WASMCLOUD_SERVICE_ALREADY_EXISTS', 'exists', 2);
            if (input.name === 'missing-target')
              throw new CommandFailure('WASMCLOUD_TARGET_NOT_FOUND', 'missing target', 2);
            if (input.name === 'denied')
              throw new CommandFailure('WASMCLOUD_SERVICE_UNAUTHORIZED', 'denied', 1);
            if (input.name === 'busy')
              throw new CommandFailure('WASMCLOUD_SERVICE_IN_USE', 'busy', 1);
            if (input.name === 'usage') throw new CommandFailure('WASMCLOUD_USAGE', 'bad flag', 2);
            if (input.name === 'down') throw new CommandFailure('WASMCLOUD_TOOL_FAILED', 'down', 3);
            if (input.name === 'odd') throw 'odd failure';
            return {
              name: input.name,
              namespace: 'wasmcloud',
              type: input.type,
              className: input.className ?? '',
              ready: 'Unknown',
              target: input.target,
            };
          },
          async delete(_target, name) {
            if (name === 'missing')
              throw new CommandFailure('WASMCLOUD_SERVICE_NOT_FOUND', 'missing', 2);
            return { name };
          },
        },
      });
      const signedIn = await request(fresh.port, {
        path: '/api/login',
        method: 'POST',
        body: JSON.stringify({ password: 'correct horse battery' }),
      });
      const cookie = sessionCookieHeader(signedIn.headers['set-cookie']);
      const csrf = (JSON.parse(signedIn.body) as { csrfToken: string }).csrfToken;
      const auth = { cookie, 'x-di-console-csrf': csrf };
      expect((await request(fresh.port, { path: '/api/session', headers: auth })).body).toContain(
        '"authenticated":true',
      );
      expect(
        (await request(fresh.port, { path: '/api/apps/greeter?target=development', headers: auth }))
          .status,
      ).toBe(200);
      expect(
        (await request(fresh.port, { path: '/api/apps/missing?target=development', headers: auth }))
          .status,
      ).toBe(404);
      expect(
        (await request(fresh.port, { path: '/api/apps/%E0%A4%A', headers: auth })).status,
      ).toBe(404);
      expect(
        (await request(fresh.port, { path: '/api/apps/Not_Name', method: 'GET', headers: auth }))
          .status,
      ).toBe(400);
      expect(
        (
          await request(fresh.port, {
            path: '/api/apps/greeter',
            method: 'PATCH',
            headers: auth,
            body: JSON.stringify({ target: 'development', replicas: 2 }),
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await request(fresh.port, {
            path: '/api/apps/missing',
            method: 'PATCH',
            headers: auth,
            body: JSON.stringify({ target: 'development', replicas: 1 }),
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await request(fresh.port, {
            path: '/api/cronjobs/nightly',
            method: 'PATCH',
            headers: auth,
            body: JSON.stringify({ target: 'development', suspend: true }),
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await request(fresh.port, {
            path: '/api/cronjobs/missing',
            method: 'PATCH',
            headers: auth,
            body: JSON.stringify({ target: 'development', suspend: true }),
          })
        ).status,
      ).toBe(404);
      expect((await request(fresh.port, { path: '/api/services', headers: auth })).status).toBe(
        400,
      );
      expect(
        (await request(fresh.port, { path: '/api/services?target=development', headers: auth }))
          .status,
      ).toBe(200);
      expect(
        (await request(fresh.port, { path: '/api/services?target=unknown', headers: auth })).status,
      ).toBe(404);
      expect(
        (
          await request(fresh.port, {
            path: '/api/service-classes?target=development',
            headers: auth,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await request(fresh.port, {
            path: '/api/services',
            method: 'POST',
            headers: auth,
            body: JSON.stringify({ target: 'development', type: 'keyvalue', name: 'orders' }),
          })
        ).status,
      ).toBe(201);
      expect(
        (
          await request(fresh.port, {
            path: '/api/services',
            method: 'POST',
            headers: auth,
            body: 'null',
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await request(fresh.port, {
            path: '/api/services',
            method: 'POST',
            headers: auth,
            body: JSON.stringify({
              target: 'development',
              type: 'keyvalue',
              name: 'orders',
              namespace: 'kube-system',
            }),
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await request(fresh.port, {
            path: '/api/services',
            method: 'POST',
            headers: auth,
            body: JSON.stringify({ type: 'keyvalue', name: 'orders' }),
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await request(fresh.port, {
            path: '/api/services',
            method: 'POST',
            headers: auth,
            body: JSON.stringify({ target: 'development', type: 'cache', name: 'orders' }),
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await request(fresh.port, {
            path: '/api/services',
            method: 'POST',
            headers: auth,
            body: JSON.stringify({ target: 'development', type: 'keyvalue', name: 'NOT_A_NAME' }),
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await request(fresh.port, {
            path: '/api/services',
            method: 'POST',
            headers: auth,
            body: JSON.stringify({
              target: 'development',
              type: 'keyvalue',
              name: 'orders',
              className: '',
            }),
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await request(fresh.port, {
            path: '/api/services',
            method: 'POST',
            headers: auth,
            body: JSON.stringify({
              target: 'development',
              type: 'keyvalue',
              name: 'orders',
              className: 'BAD_CLASS',
            }),
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await request(fresh.port, {
            path: '/api/services',
            method: 'POST',
            headers: auth,
            body: JSON.stringify({
              target: 'development',
              type: 'keyvalue',
              name: 'orders',
              deletionPolicy: 'Drop',
            }),
          })
        ).status,
      ).toBe(400);
      for (const name of ['conflict', 'missing-target', 'denied', 'busy', 'usage', 'down', 'odd']) {
        const status = (
          await request(fresh.port, {
            path: '/api/services',
            method: 'POST',
            headers: auth,
            body: JSON.stringify({ target: 'development', type: 'keyvalue', name }),
          })
        ).status;
        expect(status).toBeGreaterThanOrEqual(400);
      }
      expect(
        (
          await request(fresh.port, {
            path: '/api/services/NOT_A_NAME',
            method: 'DELETE',
            headers: auth,
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await request(fresh.port, {
            path: '/api/services/orders?target=development',
            method: 'DELETE',
            headers: auth,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await request(fresh.port, {
            path: '/api/services/missing?target=development',
            method: 'DELETE',
            headers: auth,
          })
        ).status,
      ).toBe(404);
      expect((await request(fresh.port, { path: '/api/nope', headers: auth })).status).toBe(404);
      failList = true;
      expect(
        (await request(fresh.port, { path: '/api/apps?target=other', headers: auth })).status,
      ).toBe(404);
      expect(
        (await request(fresh.port, { path: '/api/apps?target=development', headers: auth })).body,
      ).toContain('cluster request failed');
      expect(
        (await request(fresh.port, { path: '/api/logout', method: 'POST', headers: auth })).status,
      ).toBe(200);
      await fresh.close();
    } finally {
      await server.close();
    }
  });

  it('starts the console command and stops on SIGINT', async () => {
    expect(() => parseConsoleArgs(['--host', '127.0.0.1', '--host', 'localhost'])).toThrow(
      CommandFailure,
    );
    expect(() => parseConsoleArgs(['--port', '8787', '--port', '8788'])).toThrow(CommandFailure);
    expect(() => parseConsoleArgs(['extra'])).toThrow(CommandFailure);
    expect(parseConsoleArgs(['--host', '::1', '--port', '8791']).host).toBe('::1');
    expect(parseConsoleArgs(['--host', '10.1.1.8']).host).toBe('10.1.1.8');
    expect(parseConsoleArgs(['--host', 'console.internal']).host).toBe('console.internal');
    expect(() => parseConsoleArgs(['--host', '::'])).toThrow(CommandFailure);
    expect(() => parseConsoleArgs(['--host', '[::]'])).toThrow(CommandFailure);
    expect(() => parseConsoleArgs(['--host', 'not a host'])).toThrow(CommandFailure);
    expect(() => consolePassword({ DI_CONSOLE_PASSWORD: 'short' }, '127.0.0.1')).toThrow(
      CommandFailure,
    );
    expect(() => consolePassword({ DI_CONSOLE_PASSWORD: 'x'.repeat(201) }, '127.0.0.1')).toThrow(
      CommandFailure,
    );
    expect(consoleAssetsDirectory()).toContain('console-ui');

    const workspace = makeWorkspace({
      manifest: `default-target = "development"\n[targets.development]\nkubeconfig = "\${kubeconfig}"\nnamespace = "wasmcloud"\nhostgroup = "tenant-development"\nregistry = "registry.example.com/team"\n`,
    });
    const bundle = join(import.meta.dir, '../dist/console-ui');
    mkdirSync(bundle, { recursive: true });
    const indexPath = join(bundle, 'index.html');
    const previous = await Bun.file(indexPath).exists();
    const previousBody = previous ? await Bun.file(indexPath).text() : '';
    writeFileSync(indexPath, '<!doctype html><title>console</title>');
    const captured = captureIo();
    const port = 18787 + Math.floor(Math.random() * 1000);
    const running = runWasmcloudConsole(
      ['--port', String(port)],
      captured.io,
      fakeDeps({
        cwd: workspace.root,
        env: { kubeconfig: workspace.kubeconfig, DI_CONSOLE_PASSWORD: 'correct horse battery' },
      }),
    );
    const started = Date.now();
    while (!captured.stdout.join('').includes('Console listening') && Date.now() - started < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    process.emit('SIGINT');
    const stopped = await running;
    expect(stopped.text).toContain('Console stopped');
    expect(captured.stdout.join('')).toContain('DI_CONSOLE_PASSWORD');
    expect(captured.stdout.join('')).toContain('namespace wasmcloud');
    expect(captured.stdout.join('')).toContain('tenant-development');

    const generated = captureIo();
    const again = runWasmcloudConsole(
      ['--port', String(port)],
      generated.io,
      fakeDeps({ cwd: workspace.root, env: { kubeconfig: workspace.kubeconfig } }),
    );
    const marked = Date.now();
    while (!generated.stdout.join('').includes('one-time password') && Date.now() - marked < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    process.emit('SIGTERM');
    expect((await again).text).toContain('Console stopped');

    const hidden = `${indexPath}.aside`;
    renameSync(indexPath, hidden);
    try {
      await expect(
        runWasmcloudConsole([], captureIo().io, fakeDeps({ cwd: workspace.root, env: {} })),
      ).rejects.toMatchObject({ code: 'WASMCLOUD_CONSOLE_ASSETS_MISSING' });
    } finally {
      renameSync(hidden, indexPath);
      if (previous) writeFileSync(indexPath, previousBody);
      else unlinkSync(indexPath);
    }
  });
});
