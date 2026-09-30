import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandFailure } from '@di-framework/cli-extension';
import {
  planWorkloadUpdate,
  publicRegistryHost,
  summarizeWorkload,
  type WorkloadDocument,
} from '../src/console/catalog';
import type { ConsoleCluster } from '../src/console/cluster';
import { consolePassword, parseConsoleArgs, selectConsoleTenant } from '../src/console/run';
import { startConsoleServer } from '../src/console/server';
import type { ConsoleServices, ServiceCreateInput } from '../src/console/services';
import { parseDeployManifest } from '../src/manifest';
import { fakeDeps, makeWorkspace } from './helpers';

const SECRET = 'super-secret-token-value';

function workload(): WorkloadDocument {
  return {
    metadata: {
      name: 'greeter',
      namespace: 'wasmcloud',
      labels: {
        'app.kubernetes.io/managed-by': 'di-framework',
        'app.kubernetes.io/name': 'greeter',
        'di-framework.dev/application': 'greeter',
        'di-framework.dev/workload': 'edge',
      },
    },
    spec: {
      replicas: 1,
      deployPolicy: 'Recreate',
      template: {
        spec: {
          environment: 'wasmcloud',
          hostSelector: { hostgroup: 'storage' },
          volumes: [
            { name: 'app-storage', hostPath: { path: '/var/lib/di-framework/storage/greeter' } },
          ],
          components: [
            {
              name: 'greeter',
              image: 'registry.example.com/team/greeter:sha256-abc',
              localResources: {
                environment: {
                  config: {
                    DI_SQLITE_BACKEND: 'wasm',
                    DI_STORAGE_DIR: '/data',
                    DI_CONTROL_REJECT_FORWARDED: '1',
                    DI_CONTROL_HTTP_HOST: 'greeter,greeter.wasmcloud.svc.cluster.local',
                    DI_CONTROL_TOKEN: SECRET,
                    DI_QUEUE_MAIL_CONCURRENCY: '2',
                    DATABASE_URL: `postgres://app:${SECRET}@db/app`,
                  },
                  secretFrom: [{ name: 'greeter-control' }],
                },
                volumeMounts: [{ name: 'app-storage', mountPath: '/data' }],
                allowedIpNameLookups: ['echo.wasmcloud.svc.cluster.local'],
              },
              hostInterfaces: [
                {
                  namespace: 'wasi',
                  package: 'http',
                  version: '0.3.0',
                  interfaces: ['handler'],
                  config: { host: 'greeter' },
                },
              ],
            },
          ],
        },
      },
    },
    status: {
      readyReplicas: 1,
      conditions: [{ type: 'Available', status: 'True', reason: 'Ready', message: 'serving' }],
    },
  };
}

function assets(): string {
  const root = mkdtempSync(join(tmpdir(), 'console-assets-'));
  writeFileSync(
    join(root, 'index.html'),
    '<!doctype html><title>DI Framework console</title><div id="root"></div>',
  );
  writeFileSync(join(root, 'app.js'), 'globalThis.consoleReady = true;\n');
  writeFileSync(join(root, 'app.css'), 'body { margin: 0; }\n');
  mkdirSync(join(root, 'nested'), { recursive: true });
  return root;
}

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
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

function cookie(setCookie: string | string[] | undefined): string {
  const value = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return (value ?? '').split(';')[0] ?? '';
}

describe('console catalog', () => {
  it('hides credentials and pins sqlite replicas', () => {
    const view = summarizeWorkload(workload(), 'development', [
      {
        metadata: {
          name: 'greeter-nightly',
          labels: {
            'app.kubernetes.io/managed-by': 'di-framework',
            'app.kubernetes.io/name': 'greeter',
            'di-framework.dev/cron-job': 'nightly',
          },
        },
        spec: { schedule: '0 3 * * *', suspend: false, concurrencyPolicy: 'Forbid' },
      },
    ]);
    expect(view).toBeDefined();
    const encoded = JSON.stringify(view);
    expect(encoded).not.toContain(SECRET);
    expect(encoded).not.toContain('greeter-control');
    expect(view?.pinnedReplicas).toBe(true);
    expect(view?.credentialsConfigured).toBe(true);
    expect(view?.config.find((entry) => entry.key === 'DI_CONTROL_TOKEN')).toBeUndefined();
    expect(view?.config.find((entry) => entry.key === 'DATABASE_URL')?.sensitive).toBe(true);
    expect(view?.config.find((entry) => entry.key === 'DI_STORAGE_DIR')?.value).toBe('/data');
    expect(view?.queueSettings[0]?.value).toBe(2);
    expect(view?.cronJobs[0]?.jobId).toBe('nightly');
    expect(view?.httpHost).toBe('greeter');
    expect(() => planWorkloadUpdate(workload(), { replicas: 2 })).toThrow('1 replica');
  });

  it('plans a queue setting and DNS lookup change', () => {
    const ops = planWorkloadUpdate(workload(), {
      replicas: 1,
      allowedIpNameLookups: ['api.internal.example.com', '*.svc.cluster.local'],
      queueSettings: [{ key: 'DI_QUEUE_MAIL_CONCURRENCY', value: 4 }],
    });
    expect(ops.map((op) => op.path)).toEqual([
      '/spec/template/spec/components/0/localResources/allowedIpNameLookups',
      '/spec/template/spec/components/0/localResources/environment/config/DI_QUEUE_MAIL_CONCURRENCY',
    ]);
    expect(() =>
      planWorkloadUpdate(workload(), { queueSettings: [{ key: 'DI_CONTROL_TOKEN', value: 1 }] }),
    ).toThrow('already declared');
  });

  it('strips registry userinfo from the public host', () => {
    expect(publicRegistryHost('https://user:pass@registry.example.com/team')).toBe(
      'registry.example.com',
    );
  });
});

describe('console command options', () => {
  it('defaults to loopback and requires a password off-loopback', () => {
    expect(parseConsoleArgs([])).toEqual({ host: '127.0.0.1', port: 8787 });
    expect(parseConsoleArgs(['--target', 'warehouse'])).toMatchObject({ target: 'warehouse' });
    expect(() => parseConsoleArgs(['--target', 'warehouse', '--target', 'other'])).toThrow(
      CommandFailure,
    );
    expect(() => parseConsoleArgs(['--host', '0.0.0.0'])).toThrow(CommandFailure);
    expect(() => parseConsoleArgs(['--port', '0'])).toThrow(CommandFailure);
    const generated = consolePassword({}, '127.0.0.1');
    expect(generated.generated).toBe(true);
    expect(generated.password.length).toBeGreaterThanOrEqual(12);
    expect(() => consolePassword({}, '10.1.1.8')).toThrow(CommandFailure);
    expect(consolePassword({ DI_CONSOLE_PASSWORD: 'correct horse battery' }, '10.1.1.8')).toEqual({
      password: 'correct horse battery',
      generated: false,
    });
    const tenant = parseDeployManifest(
      '/workspace/di-framework.deploy.toml',
      `default-target = "local"\n[targets.local]\nplatform = "deploy/platform"\n[targets.warehouse]\nkubeconfig = "/tmp/kubeconfig"\nnamespace = "di-tenant-warehouse"\nhostgroup = "tenant-warehouse"\nregistry = "registry.example.com/warehouse"\n`,
      {},
    );
    expect(selectConsoleTenant(tenant, 'warehouse').namespace).toBe('di-tenant-warehouse');
    expect(() => selectConsoleTenant(tenant, 'local')).toThrow('tenant kubeconfig');
    expect(() => selectConsoleTenant(tenant, undefined)).toThrow('tenant kubeconfig');
    const unscoped = parseDeployManifest(
      '/workspace/di-framework.deploy.toml',
      `[targets.edge]\nkubeconfig = "/tmp/kubeconfig"\nnamespace = "wasmcloud"\nregistry = "registry.example.com/team"\n`,
      {},
    );
    expect(() => selectConsoleTenant(unscoped, 'edge')).toThrow('tenant kubeconfig');
  });
});

describe('console server', () => {
  it('authenticates, redacts workload data, and applies configuration', async () => {
    const workspace = makeWorkspace({
      manifest: `default-target = "development"

[targets.development]
kubeconfig = "\${kubeconfig}"
context = "team-development"
namespace = "wasmcloud"
hostgroup = "storage"
registry = "https://user:${SECRET}@registry.example.com/team"
`,
    });
    const documents = [
      workload(),
      {
        metadata: {
          name: 'other-tenant-app',
          namespace: 'di-tenant-other',
          labels: { 'app.kubernetes.io/managed-by': 'di-framework' },
        },
        spec: {
          template: {
            spec: {
              hostSelector: { hostgroup: 'tenant-other' },
              components: [{ name: 'other-tenant-app' }],
            },
          },
        },
      },
    ];
    const cronJobs = [
      {
        metadata: {
          name: 'greeter-nightly',
          labels: {
            'app.kubernetes.io/managed-by': 'di-framework',
            'app.kubernetes.io/name': 'greeter',
            'di-framework.dev/cron-job': 'nightly',
          },
        },
        spec: { schedule: '0 3 * * *', suspend: false, concurrencyPolicy: 'Forbid' },
      },
    ];
    const patches: Array<{ name: string; ops: unknown }> = [];
    const cluster: ConsoleCluster = {
      async listWorkloads() {
        return structuredClone(documents);
      },
      async listCronJobs() {
        return structuredClone(cronJobs);
      },
      async patchWorkload(_connection, name, ops) {
        patches.push({ name, ops });
        const config =
          documents[0]?.spec?.template?.spec?.components?.[0]?.localResources?.environment?.config;
        for (const op of ops) {
          if (op.path === '/spec/replicas' && documents[0]?.spec)
            documents[0].spec.replicas = op.value as number;
          if (op.path.endsWith('allowedIpNameLookups')) {
            const resources = documents[0]?.spec?.template?.spec?.components?.[0]?.localResources;
            if (resources) resources.allowedIpNameLookups = op.value as string[];
          }
          if (op.path.endsWith('DI_QUEUE_MAIL_CONCURRENCY') && config) {
            config.DI_QUEUE_MAIL_CONCURRENCY = String(op.value);
          }
        }
      },
      async patchCronJob(_connection, name, suspend) {
        const job = cronJobs.find((entry) => entry.metadata.name === name);
        if (job) job.spec.suspend = suspend;
      },
    };
    const created: ServiceCreateInput[] = [];
    const services: ConsoleServices = {
      async list(target) {
        return [
          {
            name: 'stock',
            namespace: 'wasmcloud',
            type: 'keyvalue',
            className: 'keyvalue-redis',
            ready: 'True',
            target,
            endpoint: { host: 'stock.runtime.svc', port: 6379, capability: 'keyvalue' },
          },
        ];
      },
      async classes() {
        return {
          classes: [{ name: 'keyvalue-redis', type: 'keyvalue', provider: 'redis', default: true }],
          fromCluster: false,
        };
      },
      async create(input) {
        created.push(input);
        return {
          name: input.name,
          namespace: 'wasmcloud',
          type: input.type,
          className: input.className ?? 'keyvalue-redis',
          ready: 'Unknown',
          target: input.target,
        };
      },
      async delete(_target, name) {
        return { name, deletionPolicy: 'Retain' };
      },
    };
    const server = await startConsoleServer({
      host: '127.0.0.1',
      port: 0,
      target: 'development',
      password: 'correct horse battery',
      assetsDirectory: assets(),
      deps: fakeDeps({ cwd: workspace.root, env: { kubeconfig: workspace.kubeconfig } }),
      cluster,
      services,
    });

    try {
      const anonymousSession = await request(server.port, { path: '/api/session' });
      expect(anonymousSession.status).toBe(200);
      expect(JSON.parse(anonymousSession.body)).toEqual({ authenticated: false });

      const anonymous = await request(server.port, { path: '/api/targets' });
      expect(anonymous.status).toBe(401);
      expect(anonymous.headers['content-security-policy']).toContain("script-src 'self'");
      expect(anonymous.body).not.toContain(SECRET);

      const wrong = await request(server.port, {
        path: '/api/login',
        method: 'POST',
        body: JSON.stringify({ password: 'nope' }),
      });
      expect(wrong.status).toBe(401);

      const signedIn = await request(server.port, {
        path: '/api/login',
        method: 'POST',
        body: JSON.stringify({ password: 'correct horse battery' }),
      });
      expect(signedIn.status).toBe(200);
      const session = cookie(signedIn.headers['set-cookie']);
      expect(String(signedIn.headers['set-cookie'])).toContain('HttpOnly');
      expect(String(signedIn.headers['set-cookie'])).toContain('SameSite=Strict');
      const csrf = (JSON.parse(signedIn.body) as { csrfToken: string }).csrfToken;
      const auth = { cookie: session, 'x-di-console-csrf': csrf };

      const targets = await request(server.port, {
        path: '/api/targets',
        headers: { cookie: session },
      });
      expect(targets.status).toBe(200);
      expect(targets.body).toContain('registry.example.com');
      expect(targets.body).not.toContain(SECRET);
      expect(targets.body).not.toContain(workspace.kubeconfig);

      const listed = await request(server.port, {
        path: '/api/apps?target=development',
        headers: { cookie: session },
      });
      expect(listed.status).toBe(200);
      expect(listed.body).toContain('greeter');
      expect(listed.body).not.toContain('other-tenant-app');
      expect(listed.body).not.toContain(SECRET);
      expect(listed.body).not.toContain('greeter-control');

      const forbidden = await request(server.port, {
        path: '/api/apps/greeter',
        method: 'PATCH',
        headers: { cookie: session },
        body: JSON.stringify({ target: 'development', replicas: 1 }),
      });
      expect(forbidden.status).toBe(403);

      const pinned = await request(server.port, {
        path: '/api/apps/greeter',
        method: 'PATCH',
        headers: auth,
        body: JSON.stringify({ target: 'development', replicas: 2 }),
      });
      expect(pinned.status).toBe(400);
      expect(patches).toHaveLength(0);

      const updated = await request(server.port, {
        path: '/api/apps/greeter',
        method: 'PATCH',
        headers: auth,
        body: JSON.stringify({
          target: 'development',
          allowedIpNameLookups: ['api.internal.example.com'],
          queueSettings: [{ key: 'DI_QUEUE_MAIL_CONCURRENCY', value: 4 }],
        }),
      });
      expect(updated.status).toBe(200);
      expect(updated.body).toContain('api.internal.example.com');
      expect(updated.body).not.toContain(SECRET);
      expect(patches).toHaveLength(1);

      const cron = await request(server.port, {
        path: '/api/cronjobs/greeter-nightly',
        method: 'PATCH',
        headers: auth,
        body: JSON.stringify({ target: 'development', suspend: true }),
      });
      expect(cron.status).toBe(200);
      expect(JSON.parse(cron.body)).toMatchObject({ cronJob: { suspend: true } });

      const createdService = await request(server.port, {
        path: '/api/services',
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          target: 'development',
          type: 'keyvalue',
          name: 'orders',
          className: 'keyvalue-redis',
        }),
      });
      expect(createdService.status).toBe(201);
      expect(created[0]?.name).toBe('orders');

      const extraField = await request(server.port, {
        path: '/api/services',
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          target: 'development',
          type: 'keyvalue',
          name: 'orders',
          namespace: 'kube-system',
        }),
      });
      expect(extraField.status).toBe(400);

      const evil = await request(server.port, {
        path: '/api/apps',
        headers: { host: 'evil.example', cookie: session },
        origin: false,
      });
      expect(evil.status).toBe(403);

      const page = await request(server.port, { path: '/', origin: false });
      expect(page.status).toBe(200);
      expect(page.headers['content-type']).toContain('text/html');
      expect(page.headers['x-frame-options']).toBe('DENY');
      const script = await request(server.port, { path: '/assets/app.js', origin: false });
      expect(script.status).toBe(200);
      expect(script.body).toContain('consoleReady');
      const escaped = await request(server.port, { path: '/assets/../app.js', origin: false });
      expect(escaped.status).not.toBe(200);
    } finally {
      await server.close();
    }
  });
});
