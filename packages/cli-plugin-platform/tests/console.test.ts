import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandFailure } from '@di-framework/cli-extension';
import {
  planEnvironmentDelete,
  planEnvironmentSet,
  planRouteUpdate,
  planSecretReassign,
  summarizeApplications,
  tenantIdentity,
  toSummary,
  type WorkloadDocument,
  workloadInTenantScope,
} from '../src/console/catalog';
import type { ConsoleCluster } from '../src/console/cluster';
import { platformSentence, sanitizePublicText } from '../src/console/errors';
import { parseConsoleArgs, selectConsoleTenant } from '../src/console/run';
import { startConsoleServer } from '../src/console/server';
import type { ConsoleServices, ServiceCreateInput } from '../src/console/services';
import { parseDeployManifest } from '../src/manifest';
import { fakeDeps, makeWorkspace } from './helpers';

const SECRET = 'super-secret-token-value';

function managed(name: string, extra: WorkloadDocument = {}): WorkloadDocument {
  return {
    ...extra,
    metadata: {
      name,
      namespace: 'di-tenant-warehouse',
      labels: { 'app.kubernetes.io/managed-by': 'di-framework', ...(extra.metadata?.labels ?? {}) },
      ...(extra.metadata?.annotations ? { annotations: extra.metadata.annotations } : {}),
    },
    spec: extra.spec,
    status: extra.status,
  };
}

function assets(): string {
  const root = mkdtempSync(join(tmpdir(), 'console-assets-'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>DI Framework console</title>');
  writeFileSync(join(root, 'app.js'), 'globalThis.consoleReady = true;\n');
  writeFileSync(join(root, 'app.css'), 'body { margin: 0; }\n');
  for (const extension of ['.svg', '.woff', '.woff2', '.ttf', '.map']) {
    writeFileSync(join(root, `asset${extension}`), 'asset');
  }
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
    host?: string;
  },
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  const method = options.method ?? 'GET';
  const host = options.host ?? `127.0.0.1:${port}`;
  const headers: Record<string, string> = {
    host,
    ...(options.origin === false ? {} : { origin: `http://${host}` }),
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
  it('describes an application as parts, routes, environment, and bindings', () => {
    const greeter = managed('greeter', {
      metadata: { labels: { 'di-framework.dev/workload': 'edge' } },
      spec: {
        replicas: 1,
        template: {
          spec: {
            hostSelector: { hostgroup: 'tenant-warehouse' },
            components: [
              {
                name: 'http',
                localResources: {
                  environment: {
                    config: {
                      COLOR: 'blue',
                      DI_CONTROL_TOKEN: SECRET,
                      DI_QUEUE_MAIL_CONCURRENCY: '2',
                      DATABASE_URL: `postgres://app:${SECRET}@db/app`,
                      API_TOKEN: 'hidden',
                    },
                    secretFrom: [
                      { name: 'greeter-control' },
                      { name: 'db-password' },
                      { name: 'di-binding-orders-creds' },
                    ],
                  },
                },
                hostInterfaces: [
                  {
                    namespace: 'wasi',
                    package: 'http',
                    interfaces: ['handler'],
                    config: {
                      host: 'greeter',
                      'host-aliases': 'alias.example',
                      localRoute: 'greeter/admin,local',
                    },
                  },
                ],
              },
            ],
          },
        },
      },
      status: {
        readyReplicas: 1,
        conditions: [{ type: 'Available', status: 'True', message: 'serving' }],
      },
    });
    const worker = managed('orders-worker', {
      metadata: { labels: { 'di-framework.dev/workload': 'orders' } },
      spec: {
        template: {
          spec: {
            service: {
              name: 'worker',
              hostInterfaces: [
                {
                  name: 'inventory.reserve',
                  namespace: 'app',
                  package: 'inventory',
                  interfaces: ['reserve'],
                },
                {
                  name: 'stock',
                  namespace: 'wasmcloud',
                  package: 'keyvalue',
                  interfaces: ['store'],
                },
                { namespace: 'wasi', package: 'cli', interfaces: ['run'] },
              ],
            },
            components: [
              {
                name: 'http',
                hostInterfaces: [
                  {
                    namespace: 'wasi',
                    package: 'http',
                    interfaces: ['handler'],
                    config: { host: 'orders' },
                  },
                ],
              },
            ],
          },
        },
      },
      status: {
        conditions: [
          { type: 'Ready', status: 'False', message: 'waiting for the orders database' },
        ],
      },
    });
    const sibling = managed('orders-http', {
      metadata: { labels: { 'di-framework.dev/workload': 'orders' } },
      spec: {
        template: { spec: { components: [{ name: 'http' }, { name: 'http', service: {} }] } },
      },
      status: { readyReplicas: 1 },
    });
    const messaging = managed('mailer', {
      spec: {
        template: {
          spec: {
            components: [
              {
                name: 'mailer',
                hostInterfaces: [
                  { namespace: 'wasmcloud', package: 'messaging', interfaces: ['handler'] },
                ],
              },
            ],
          },
        },
      },
    });
    const queued = managed('queued', {
      spec: {
        template: {
          spec: {
            components: [
              {
                name: 'queued',
                localResources: { environment: { config: { DI_QUEUE_MODE: 'sqlite' } } },
              },
            ],
          },
        },
      },
    });
    const dropped = managed('elsewhere', {
      metadata: {
        namespace: 'di-tenant-other',
        labels: { 'app.kubernetes.io/managed-by': 'di-framework' },
      },
      spec: { template: { spec: { hostSelector: { hostgroup: 'tenant-other' } } } },
    });
    expect(
      workloadInTenantScope(dropped, {
        namespace: 'di-tenant-warehouse',
        hostgroup: 'tenant-warehouse',
      }),
    ).toBe(false);
    expect(
      workloadInTenantScope(
        {
          metadata: { namespace: 'di-tenant-warehouse' },
          spec: { template: { spec: { hostSelector: { hostgroup: 'storage' } } } },
        },
        { namespace: 'di-tenant-warehouse', hostgroup: 'tenant-warehouse' },
      ),
    ).toBe(true);
    expect(
      workloadInTenantScope(
        { spec: { template: { spec: {} } } },
        { namespace: 'di-tenant-warehouse', hostgroup: 'tenant-warehouse' },
      ),
    ).toBe(true);
    expect(
      workloadInTenantScope(
        {
          metadata: { namespace: 'di-tenant-warehouse' },
          spec: { template: { spec: { hostSelector: { hostgroup: 'nope' } } } },
        },
        { namespace: 'di-tenant-warehouse' },
      ),
    ).toBe(true);
    expect(
      workloadInTenantScope(greeter, {
        namespace: 'di-tenant-warehouse',
        hostgroup: 'tenant-warehouse',
        storageHostgroup: 'tenant-warehouse-storage',
      }),
    ).toBe(true);
    expect(tenantIdentity('tenant-warehouse', 'warehouse')).toEqual({
      tenant: 'warehouse',
      hostgroup: 'tenant-warehouse',
    });
    expect(tenantIdentity('storage', 'warehouse').tenant).toBe('storage');
    expect(tenantIdentity(undefined, 'warehouse')).toEqual({ tenant: 'warehouse' });
    expect(tenantIdentity('tenant-', 'warehouse').tenant).toBe('tenant-');

    const views = summarizeApplications(
      [
        greeter,
        worker,
        sibling,
        messaging,
        queued,
        dropped,
        { metadata: { name: 'skip' } },
        managed('!!!'),
      ],
      [
        {
          spec: {
            bindingName: 'orders-db',
            serviceName: 'orders',
            capability: 'postgres',
            workloadName: 'orders-worker',
          },
          status: { conditions: [{ type: 'Ready', status: 'False', message: '0/1 pods ready' }] },
        },
        { spec: { bindingName: 'other', serviceName: 'other', workloadName: 'missing' } },
        { spec: { bindingName: 'partial' } },
      ],
    );
    const edge = views.find((entry) => entry.name === 'greeter');
    expect(edge?.components).toBe(1);
    expect(edge?.services).toBe(0);
    expect(edge?.ready).toBe(true);
    expect(edge?.environment).toEqual([{ key: 'COLOR', value: 'blue', part: 'http' }]);
    expect(edge?.secrets.map((entry) => entry.name)).toEqual([
      'API_TOKEN',
      'DATABASE_URL',
      'db-password',
    ]);
    expect(JSON.stringify(edge)).not.toContain(SECRET);
    expect(edge?.routes.map((route) => `${route.host}${route.path}`).sort()).toEqual([
      'alias.example/',
      'greeter/',
      'greeter/admin',
      'local/',
    ]);
    const orders = views.find((entry) => entry.name === 'orders');
    expect(orders?.services).toBe(2);
    expect(orders?.components).toBeGreaterThan(0);
    expect(orders?.detail).toBe('waiting for the orders database');
    expect(orders?.backingServices[0]).toMatchObject({ name: 'orders-db', ready: false });
    expect(orders?.backingServices[0]?.detail).toBeUndefined();
    expect(orders?.privateBindings).toEqual([
      { name: 'inventory.reserve', contract: 'app:inventory', bound: true },
    ]);
    expect(views.find((entry) => entry.name === 'mailer')?.parts[0]?.kind).toBe('service');
    expect(views.find((entry) => entry.name === 'queued')?.parts[0]?.lifetime).toBe('long-lived');
    expect(edge).toBeDefined();
    if (edge !== undefined) expect(toSummary(edge).routeCount).toBe(4);

    const id = Buffer.from('greeter\n/').toString('base64url');
    const disabled = planRouteUpdate([greeter], id, false);
    expect(disabled.ops.some((op) => op.path.includes('config'))).toBe(true);
    expect(planRouteUpdate([greeter], id, true).ops).toEqual([]);
    expect(() => planRouteUpdate([greeter], 'missing', false)).toThrow('No route');

    const remembered = managed('paused', {
      metadata: {
        annotations: {
          'di-framework.dev/routes-off': JSON.stringify([{ host: 'paused', path: '/' }]),
        },
      },
      spec: { template: { spec: { components: [{ name: 'paused' }] } } },
    });
    const pausedView = summarizeApplications([remembered])[0];
    expect(pausedView?.routes).toEqual([
      {
        id: Buffer.from('paused\n/').toString('base64url'),
        host: 'paused',
        path: '/',
        enabled: false,
      },
    ]);
    const enabled = planRouteUpdate(
      [remembered],
      Buffer.from('paused\n/').toString('base64url'),
      true,
    );
    expect(enabled.ops[0]?.path).toBe('/spec/template/spec/hostInterfaces');
    const noted = managed('noted', {
      metadata: {
        annotations: {
          'di-framework.dev/routes-off': JSON.stringify([{ host: 'noted', path: '/admin' }]),
        },
      },
      spec: {
        template: {
          spec: {
            hostInterfaces: [
              {
                namespace: 'wasi',
                package: 'http',
                interfaces: ['handler'],
                config: { host: 'noted' },
              },
            ],
          },
        },
      },
    });
    const restored = planRouteUpdate(
      [noted],
      Buffer.from('noted\n/admin').toString('base64url'),
      true,
    );
    expect(restored.ops.some((op) => String(op.path).includes('routes-off'))).toBe(true);
    const aliased = managed('aliased', {
      metadata: {
        annotations: {
          'di-framework.dev/routes-off': JSON.stringify([{ host: 'alias.example', path: '/' }]),
        },
      },
      spec: {
        template: {
          spec: {
            hostInterfaces: [
              {
                namespace: 'wasi',
                package: 'http',
                interfaces: ['handler'],
                config: { host: 'aliased' },
              },
            ],
          },
        },
      },
    });
    const aliasOn = planRouteUpdate(
      [aliased],
      Buffer.from('alias.example\n/').toString('base64url'),
      true,
    );
    expect(JSON.stringify(aliasOn.ops)).toContain('host-aliases');
    expect(
      planRouteUpdate([noted], Buffer.from('noted\n/').toString('base64url'), true).ops,
    ).toEqual([]);

    const bare = managed('bare', {
      spec: { template: { spec: { components: [{ name: 'bare' }] } } },
    });
    expect(planEnvironmentSet([bare], 'COLOR', 'blue').ops[0]?.op).toBe('add');
    const withResources = managed('bare', {
      spec: { template: { spec: { components: [{ name: 'bare', localResources: {} }] } } },
    });
    expect(planEnvironmentSet([withResources], 'COLOR', 'blue').ops[0]?.path).toContain(
      'environment',
    );
    const withEnvironment = managed('bare', {
      spec: {
        template: { spec: { components: [{ name: 'bare', localResources: { environment: {} } }] } },
      },
    });
    expect(planEnvironmentSet([withEnvironment], 'COLOR', 'blue').ops[0]?.path).toContain('config');
    const withConfig = managed('bare', {
      spec: {
        template: {
          spec: {
            service: {
              name: 'bare',
              localResources: { environment: { config: { COLOR: 'blue' } } },
            },
          },
        },
      },
    });
    expect(planEnvironmentSet([withConfig], 'COLOR', 'green').ops[0]?.op).toBe('replace');
    expect(planEnvironmentSet([withConfig], 'SIZE', '1').ops[0]?.op).toBe('add');
    expect(planEnvironmentDelete([withConfig], 'COLOR').ops[0]?.op).toBe('remove');
    expect(() => planEnvironmentDelete([withConfig], 'MISSING')).toThrow('No environment');
    expect(() => planEnvironmentSet([withConfig], '1bad', 'x')).toThrow('letters');
    expect(() => planEnvironmentSet([withConfig], 'DI_CONTROL_TOKEN', 'x')).toThrow(
      'not an environment',
    );
    expect(() =>
      planEnvironmentSet([withConfig], 'COLOR', `postgres://app:${SECRET}@db/app`),
    ).toThrow('Secrets');
    expect(() => planEnvironmentSet([withConfig], 'API_TOKEN', 'x')).toThrow('Secrets');
    expect(() => planEnvironmentSet([withConfig], 'COLOR', '')).toThrow('1 to 4096');
    expect(() => planEnvironmentSet([managed('empty')], 'COLOR', 'blue')).toThrow(
      'no configurable',
    );
    expect(planSecretReassign([greeter], 'API_TOKEN', 'next-value')).toMatchObject({
      workload: 'greeter',
    });
    expect(planSecretReassign([greeter], 'db-password', 'next-value')).toEqual({
      secret: 'db-password',
    });
    expect(() => planSecretReassign([greeter], 'missing', 'next-value')).toThrow('No credential');
    expect(() => planSecretReassign([greeter], 'API_TOKEN', '')).toThrow('new credential');
    const ghost = managed('ghost', {
      spec: {
        template: {
          spec: {
            components: [
              {
                name: 'ghost',
                localResources: {
                  environment: { config: { API_TOKEN: undefined as unknown as string } },
                },
              },
            ],
          },
        },
      },
    });
    expect(() => planSecretReassign([ghost], 'API_TOKEN', 'next-value')).toThrow('No credential');

    const broken = managed('broken', {
      metadata: { annotations: { 'di-framework.dev/routes-off': '{' } },
      spec: { template: { spec: { components: [{ name: 'broken' }] } } },
      status: { conditions: [{ type: 'Ready', status: 'False', message: '0/1 pods are pending' }] },
    });
    const summarized = summarizeApplications([broken])[0];
    expect(summarized?.detail).toBe('This application is not ready yet.');
    expect(summarized?.routes).toEqual([]);
    expect(platformSentence('waiting for the orders database')).toBe(
      'waiting for the orders database',
    );
    expect(platformSentence('0/1 pods ready')).toBeUndefined();
    expect(platformSentence(`Bearer ${'a'.repeat(40)}`)).toBeUndefined();
    expect(sanitizePublicText(`token=${SECRET}`)).toContain('[redacted]');
  });
});

function routeId(host: string, path = '/'): string {
  return Buffer.from(`${host}\n${path}`).toString('base64url');
}

function site(extra: WorkloadDocument = {}): WorkloadDocument {
  return managed('mesh-site', {
    metadata: { annotations: { 'di-framework.dev/routes-off': '[]' } },
    spec: {
      template: {
        spec: {
          components: [{ name: 'mesh-site' }],
          hostInterfaces: [
            {
              namespace: 'wasi',
              package: 'http',
              version: '0.3.0',
              interfaces: ['handler'],
              config: { host: 'mesh-site' },
            },
            { namespace: 'wasi', package: 'logging', interfaces: ['logging'] },
          ],
        },
      },
    },
    ...extra,
  });
}

describe('console route changes', () => {
  it('removes the wasi:http interface with the last route and restores it', () => {
    const live = site();
    const off = planRouteUpdate([live], routeId('mesh-site'), false);
    expect(off).toEqual({
      workload: 'mesh-site',
      ops: [
        { op: 'remove', path: '/spec/template/spec/hostInterfaces/0' },
        {
          op: 'replace',
          path: '/metadata/annotations/di-framework.dev~1routes-off',
          value: JSON.stringify([{ host: 'mesh-site', path: '/' }]),
        },
        {
          op: 'add',
          path: '/metadata/annotations/di-framework.dev~1http-off',
          value: JSON.stringify({
            array: '/spec/template/spec/hostInterfaces',
            entry: {
              namespace: 'wasi',
              package: 'http',
              version: '0.3.0',
              interfaces: ['handler'],
            },
          }),
        },
      ],
    });
    expect(JSON.stringify(off.ops)).not.toContain('"config":{}');

    const paused = site({
      metadata: {
        annotations: {
          'di-framework.dev/routes-off': JSON.stringify([{ host: 'mesh-site', path: '/' }]),
          'di-framework.dev/http-off': JSON.stringify({
            array: '/spec/template/spec/hostInterfaces',
            entry: {
              namespace: 'wasi',
              package: 'http',
              version: '0.3.0',
              interfaces: ['handler'],
            },
          }),
        },
      },
    });
    const spec = paused.spec?.template?.spec;
    if (spec) spec.hostInterfaces = spec.hostInterfaces?.slice(1);
    expect(summarizeApplications([paused])[0]?.routes).toEqual([
      { id: routeId('mesh-site'), host: 'mesh-site', path: '/', enabled: false },
    ]);
    expect(planRouteUpdate([paused], routeId('mesh-site'), true).ops).toEqual([
      {
        op: 'add',
        path: '/spec/template/spec/hostInterfaces/-',
        value: {
          namespace: 'wasi',
          package: 'http',
          version: '0.3.0',
          interfaces: ['handler'],
          config: { host: 'mesh-site' },
        },
      },
      { op: 'replace', path: '/metadata/annotations/di-framework.dev~1routes-off', value: '[]' },
      { op: 'remove', path: '/metadata/annotations/di-framework.dev~1http-off' },
    ]);
  });

  it('keeps a host on the interface while other routes remain', () => {
    const aliased = site({
      spec: {
        template: {
          spec: {
            hostInterfaces: [
              {
                namespace: 'wasi',
                package: 'http',
                config: { host: 'one', 'host-aliases': 'two,three', localRoute: 'two/admin' },
              },
            ],
          },
        },
      },
    });
    expect(planRouteUpdate([aliased], routeId('one'), false).ops[0]).toEqual({
      op: 'replace',
      path: '/spec/template/spec/hostInterfaces/0/config',
      value: { host: 'two', 'host-aliases': 'three', localRoute: 'two/admin' },
    });
    const single = site({
      spec: {
        template: {
          spec: {
            hostInterfaces: [
              {
                namespace: 'wasi',
                package: 'http',
                config: { host: 'one', 'host-aliases': 'two' },
              },
            ],
          },
        },
      },
    });
    expect(planRouteUpdate([single], routeId('one'), false).ops[0]?.value).toEqual({
      host: 'two',
    });
    const paths = site({
      spec: {
        template: {
          spec: {
            hostInterfaces: [
              {
                namespace: 'wasi',
                package: 'http',
                config: { host: 'one', localRoute: 'one/admin' },
              },
            ],
          },
        },
      },
    });
    expect(() => planRouteUpdate([paths], routeId('one'), false)).toThrow(
      expect.objectContaining({ status: 409, code: 'ROUTE_REQUIRED' }),
    );
    expect(planRouteUpdate([paths], routeId('one', '/admin'), false).ops[0]?.value).toEqual({
      host: 'one',
    });
  });

  it('remembers component and service interfaces with their other settings', () => {
    const component = managed('worker', {
      spec: {
        template: {
          spec: {
            components: [
              {
                name: 'worker',
                hostInterfaces: [
                  {
                    namespace: 'wasi',
                    package: 'http',
                    interfaces: ['handler'],
                    config: { host: 'worker', timeout: '5s' },
                  },
                ],
              },
            ],
          },
        },
      },
    });
    const off = planRouteUpdate([component], routeId('worker'), false);
    expect(off.ops).toEqual([
      { op: 'remove', path: '/spec/template/spec/components/0/hostInterfaces/0' },
      {
        op: 'add',
        path: '/metadata/annotations',
        value: {
          'di-framework.dev/routes-off': JSON.stringify([{ host: 'worker', path: '/' }]),
          'di-framework.dev/http-off': JSON.stringify({
            array: '/spec/template/spec/components/0/hostInterfaces',
            entry: {
              namespace: 'wasi',
              package: 'http',
              interfaces: ['handler'],
              config: { timeout: '5s' },
            },
          }),
        },
      },
    ]);
    const restored = managed('worker', {
      metadata: {
        annotations: {
          'di-framework.dev/routes-off': JSON.stringify([{ host: 'worker', path: '/' }]),
          'di-framework.dev/http-off': JSON.stringify({
            array: '/spec/template/spec/components/0/hostInterfaces',
            entry: { namespace: 'wasi', package: 'http', config: { timeout: '5s' } },
          }),
        },
      },
      spec: { template: { spec: { components: [{ name: 'worker' }] } } },
    });
    expect(planRouteUpdate([restored], routeId('worker'), true).ops[0]).toEqual({
      op: 'add',
      path: '/spec/template/spec/components/0/hostInterfaces',
      value: [{ namespace: 'wasi', package: 'http', config: { timeout: '5s', host: 'worker' } }],
    });

    const service = (httpOff: unknown, spec: WorkloadDocument['spec']) =>
      managed('daemon', {
        metadata: {
          annotations: {
            'di-framework.dev/routes-off': JSON.stringify([{ host: 'daemon', path: '/' }]),
            'di-framework.dev/http-off':
              typeof httpOff === 'string' ? httpOff : JSON.stringify(httpOff),
          },
        },
        spec,
      });
    const serviceSpec = {
      template: {
        spec: {
          service: { name: 'daemon', hostInterfaces: [{ namespace: 'wasi', package: 'cli' }] },
        },
      },
    };
    expect(
      planRouteUpdate(
        [
          service(
            {
              array: '/spec/template/spec/service/hostInterfaces',
              entry: { namespace: 'wasi', package: 'http' },
            },
            serviceSpec,
          ),
        ],
        routeId('daemon'),
        true,
      ).ops[0],
    ).toEqual({
      op: 'add',
      path: '/spec/template/spec/service/hostInterfaces/-',
      value: { namespace: 'wasi', package: 'http', config: { host: 'daemon' } },
    });
    const fallback = {
      op: 'add' as const,
      path: '/spec/template/spec/hostInterfaces',
      value: [
        {
          namespace: 'wasi',
          package: 'http',
          version: '0.3.0',
          interfaces: ['handler'],
          config: { host: 'daemon' },
        },
      ],
    };
    for (const broken of [
      '{',
      '',
      { array: '/metadata', entry: { namespace: 'wasi', package: 'http' } },
      { array: '/spec/template/spec/hostInterfaces', entry: null },
      { array: '/spec/template/spec/hostInterfaces', entry: [] },
      { array: '/spec/template/spec/hostInterfaces', entry: { namespace: 'wasi', package: 'cli' } },
      {
        array: '/spec/template/spec/components/3/hostInterfaces',
        entry: { namespace: 'wasi', package: 'http' },
      },
    ]) {
      expect(
        planRouteUpdate([service(broken, serviceSpec)], routeId('daemon'), true).ops[0],
      ).toEqual(fallback);
    }
  });
});

describe('console environment parts', () => {
  const site = managed('mesh-site', {
    metadata: { labels: { 'di-framework.dev/workload': 'mesh' } },
    spec: {
      template: {
        spec: {
          components: [
            { name: 'mesh-site', localResources: { environment: { config: { MODE: 'site' } } } },
            { name: 'mesh-site' },
          ],
        },
      },
    },
  });
  const collector = managed('mesh-collector', {
    metadata: { labels: { 'di-framework.dev/workload': 'mesh' } },
    spec: {
      template: {
        spec: {
          service: {
            image: 'collector',
            localResources: { environment: { config: { MODE: 'c' } } },
          },
          components: [{}],
        },
      },
    },
  });

  it('lists each variable with its part, named like the parts', () => {
    const [view] = summarizeApplications([site, collector]);
    expect(view?.parts.map((part) => part.name)).toEqual([
      'mesh-collector',
      'component',
      'mesh-site',
      'mesh-site-2',
    ]);
    expect(view?.environment).toEqual([
      { key: 'MODE', value: 'c', part: 'mesh-collector' },
      { key: 'MODE', value: 'site', part: 'mesh-site' },
    ]);
  });

  it('sets and removes a variable on the chosen part', () => {
    expect(planEnvironmentSet([site, collector], 'TOPICS', 'a', 'mesh-site-2')).toEqual({
      workload: 'mesh-site',
      ops: [
        {
          op: 'add',
          path: '/spec/template/spec/components/1/localResources',
          value: { environment: { config: { TOPICS: 'a' } } },
        },
      ],
    });
    // Without a part a new variable goes to the first part, and an existing one stays where it is.
    expect(planEnvironmentSet([site, collector], 'TOPICS', 'a').workload).toBe('mesh-collector');
    expect(planEnvironmentSet([collector, site], 'MODE', 'b').ops[0]?.path).toBe(
      '/spec/template/spec/service/localResources/environment/config/MODE',
    );
    expect(() => planEnvironmentSet([site], 'TOPICS', 'a', 'missing')).toThrow(
      expect.objectContaining({ status: 404, code: 'PART_NOT_FOUND' }),
    );
    expect(planEnvironmentDelete([site, collector], 'MODE', 'mesh-site')).toEqual({
      workload: 'mesh-site',
      ops: [
        {
          op: 'remove',
          path: '/spec/template/spec/components/0/localResources/environment/config/MODE',
        },
      ],
    });
    expect(() => planEnvironmentDelete([site, collector], 'MODE', 'mesh-site-2')).toThrow(
      'No environment variable',
    );
    expect(() => planEnvironmentDelete([site], 'MODE', 'missing')).toThrow('No part');
    expect(planEnvironmentDelete([managed('nameless'), site], 'MODE').workload).toBe('mesh-site');
  });
});

describe('console host failures', () => {
  const member = (name: string, replicaSet?: string) =>
    managed(name, {
      metadata: { labels: { 'di-framework.dev/workload': 'mesh' } },
      spec: { template: { spec: { components: [{ name }] } } },
      status: {
        conditions: [{ type: 'Ready', status: 'True' }],
        ...(replicaSet === undefined ? {} : { currentReplicaSet: { name: replicaSet } }),
      },
    });
  const failure = (workload: string, message = 'service did not properly execute') => ({
    workload,
    time: '2026-10-01T19:19:39Z',
    level: 'WARN' as const,
    message,
  });

  it('marks the part whose current revision failed and the application with it', () => {
    const [view] = summarizeApplications(
      [member('mesh-collector', 'mesh-collector-ff55d9589'), member('mesh-site', 'mesh-site-64f')],
      [],
      new Map([
        ['mesh-collector', failure('mesh-collector-ff55d9589-795c7b5cd6')],
        ['mesh-site', failure('mesh-site-dd5fc4dc-558f5d4b4', 'no host header found')],
      ]),
    );
    expect(view?.ready).toBe(false);
    expect(view?.failed).toBe(true);
    expect(view?.detail).toBe('mesh-collector failed: service did not properly execute');
    expect(view?.parts).toEqual([
      {
        name: 'mesh-collector',
        kind: 'component',
        lifetime: 'on-demand',
        failure: 'service did not properly execute',
      },
      { name: 'mesh-site', kind: 'component', lifetime: 'on-demand' },
    ]);
    if (view) expect(toSummary(view)).toMatchObject({ ready: false, failed: true });
  });

  it('ignores failures of older revisions and members without a replica set', () => {
    const [view] = summarizeApplications(
      [member('mesh-site', 'mesh-site-64f85bb94f'), member('mesh-collector')],
      [],
      new Map([
        ['mesh-site', failure('mesh-site-dd5fc4dc-558f5d4b4')],
        ['mesh-collector', failure('mesh-collector-ff55d9589-1')],
      ]),
    );
    expect(view?.ready).toBe(true);
    expect(view?.failed).toBeUndefined();
    if (view) expect(toSummary(view).failed).toBeUndefined();
    const [blank] = summarizeApplications(
      [member('mesh-site', 'mesh-site-64f85bb94f')],
      [],
      new Map([['mesh-site', failure('mesh-site-64f85bb94f-1', '  ')]]),
    );
    expect(blank?.detail).toBe('mesh-site failed: The host could not start it.');
    const [redacted] = summarizeApplications(
      [member('mesh-site', 'mesh-site-64f85bb94f')],
      [],
      new Map([['mesh-site', failure('mesh-site-64f85bb94f-1', `token=${SECRET}`)]]),
    );
    expect(redacted?.detail).not.toContain(SECRET);
  });
});

describe('console command options', () => {
  it('binds loopback and requires a tenant credential', () => {
    expect(parseConsoleArgs([])).toEqual({ host: '127.0.0.1', port: 0 });
    expect(parseConsoleArgs(['--port', '0']).port).toBe(0);
    expect(parseConsoleArgs(['--host', 'localhost', '--port', '8791']).host).toBe('localhost');
    expect(parseConsoleArgs(['--host', '::1']).host).toBe('::1');
    expect(() => parseConsoleArgs(['--host', '0.0.0.0'])).toThrow(CommandFailure);
    expect(() => parseConsoleArgs(['--host', '10.1.1.8'])).toThrow('loopback');
    expect(() => parseConsoleArgs(['--port', '-1'])).toThrow(CommandFailure);
    expect(() => parseConsoleArgs(['--port', '65536'])).toThrow(CommandFailure);
    const tenant = parseDeployManifest(
      '/workspace/di-framework.deploy.toml',
      `default-target = "local"\n[targets.local]\nplatform = "deploy/platform"\n[targets.warehouse]\nkubeconfig = "/tmp/kubeconfig"\nnamespace = "di-tenant-warehouse"\nhostgroup = "tenant-warehouse"\nregistry = "registry.example.com/warehouse"\n`,
      {},
    );
    expect(selectConsoleTenant(tenant, 'warehouse').namespace).toBe('di-tenant-warehouse');
    expect(() => selectConsoleTenant(tenant, 'local')).toThrow("tenant user's kubeconfig");
    expect(() => selectConsoleTenant(tenant, undefined)).toThrow("tenant user's kubeconfig");
  });
});

describe('console server', () => {
  it('serves one tenant without a login and keeps secret values out of responses', async () => {
    const workspace = makeWorkspace({
      manifest: `default-target = "warehouse"
[targets.warehouse]
kubeconfig = "\${kubeconfig}"
namespace = "di-tenant-warehouse"
hostgroup = "tenant-warehouse"
registry = "registry.example.com/warehouse"
[targets.other]
kubeconfig = "\${kubeconfig}"
namespace = "other"
registry = "registry.example.com/team"
`,
    });
    const documents: WorkloadDocument[] = [
      managed('greeter', {
        spec: {
          replicas: 1,
          template: {
            spec: {
              hostSelector: { hostgroup: 'tenant-warehouse' },
              components: [
                {
                  name: 'http',
                  localResources: {
                    environment: {
                      config: { COLOR: 'blue', API_TOKEN: SECRET },
                      secretFrom: [{ name: 'db-password' }],
                    },
                  },
                  hostInterfaces: [
                    {
                      namespace: 'wasi',
                      package: 'http',
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
          conditions: [{ type: 'Ready', status: 'True', message: 'serving' }],
        },
      }),
      managed('stored', {
        spec: {
          template: {
            spec: {
              hostSelector: { hostgroup: 'storage' },
              components: [{ name: 'stored' }],
            },
          },
        },
        status: { readyReplicas: 1 },
      }),
      managed('other-app', {
        metadata: { namespace: 'di-tenant-other' },
        spec: {
          template: {
            spec: {
              hostSelector: { hostgroup: 'tenant-other' },
              components: [{ name: 'other-app' }],
            },
          },
        },
      }),
    ];
    const patches: Array<{ name: string; ops: unknown }> = [];
    const writable = true;
    let logs: string[] | undefined;
    let signals: { success: number; error: number; compute?: number[] } | undefined;
    const cluster: ConsoleCluster = {
      async readFailures() {
        return new Map();
      },
      async listWorkloads() {
        return structuredClone(documents);
      },
      async listBindings() {
        return [
          {
            spec: {
              bindingName: 'orders-db',
              serviceName: 'orders',
              capability: 'postgres',
              workloadName: 'greeter',
            },
            status: { conditions: [{ type: 'Ready', status: 'True', message: 'ready' }] },
          },
        ];
      },
      async patchWorkload(_connection, name, ops) {
        patches.push({ name, ops });
      },
      async reassignSecret() {
        return undefined;
      },
      async canWrite() {
        return writable;
      },
      async readLogs() {
        return logs;
      },
      async readSignals(_connection, name) {
        if (name === 'stored') throw new Error('projection failed');
        return signals;
      },
      async bindService() {
        return undefined;
      },
      async unbindService() {
        return undefined;
      },
    };
    const created: ServiceCreateInput[] = [];
    let servicesFail = false;
    const services: ConsoleServices = {
      async list() {
        if (servicesFail) throw new Error('service list failed');
        return [
          {
            name: 'orders',
            namespace: 'di-tenant-warehouse',
            type: 'postgres',
            className: 'postgres-dedicated',
            ready: 'True',
            target: 'warehouse',
            endpoint: { host: 'orders.example', port: 5432, capability: 'postgres' },
            message: '0/1 pods ready',
          },
        ];
      },
      async classes() {
        return {
          classes: [
            { name: 'postgres-dedicated', type: 'postgres', provider: 'postgres', default: true },
          ],
          fromCluster: true,
        };
      },
      async create(input) {
        created.push(input);
        if (input.name === 'taken') {
          throw new CommandFailure(
            'WASMCLOUD_SERVICE_ALREADY_EXISTS',
            'exists in namespace di-tenant-warehouse',
            1,
          );
        }
        return {
          name: input.name,
          namespace: 'di-tenant-warehouse',
          type: input.type,
          className: input.className ?? '',
          ready: 'Unknown',
          target: input.target,
        };
      },
      async delete(_target, name) {
        if (name === 'missing')
          throw new CommandFailure('WASMCLOUD_SERVICE_NOT_FOUND', 'missing', 1);
        if (name === 'busy') throw new CommandFailure('WASMCLOUD_SERVICE_IN_USE', 'bound', 1);
        if (name === 'denied')
          throw new CommandFailure('WASMCLOUD_SERVICE_UNAUTHORIZED', 'forbidden', 1);
        if (name === 'weird') throw new CommandFailure('WASMCLOUD_OTHER', 'pod exploded', 1);
        if (name === 'plain')
          throw new CommandFailure('WASMCLOUD_OTHER', 'waiting for the orders database', 1);
        return { name };
      },
    };
    let now = 1_000;
    const server = await startConsoleServer({
      host: '127.0.0.1',
      port: 0,
      target: 'warehouse',
      assetsDirectory: assets(),
      deps: fakeDeps({ cwd: workspace.root, env: { kubeconfig: workspace.kubeconfig } }),
      cluster,
      services,
      now: () => now,
    });
    try {
      const opened = await request(server.port, { path: '/api/session' });
      expect(opened.status).toBe(200);
      const session = cookie(opened.headers['set-cookie']);
      expect(String(opened.headers['set-cookie'])).toContain('HttpOnly');
      const body = JSON.parse(opened.body) as {
        csrfToken: string;
        tenant: string;
        writable: boolean;
      };
      expect(body.tenant).toBe('warehouse');
      expect(body.writable).toBe(true);
      expect(opened.body).not.toContain('di-tenant-warehouse');
      const auth = { cookie: session, 'x-di-console-csrf': body.csrfToken };
      const again = await request(server.port, {
        path: '/api/session',
        headers: { cookie: session },
      });
      expect(JSON.parse(again.body).csrfToken).toBe(body.csrfToken);

      const listed = await request(server.port, {
        path: '/api/applications',
        headers: { cookie: session },
      });
      expect(listed.status).toBe(200);
      expect(listed.body).toContain('greeter');
      expect(listed.body).toContain('stored');
      expect(listed.body).not.toContain('other-app');
      expect(listed.body).not.toContain(SECRET);
      expect(listed.headers['content-security-policy']).toContain("script-src 'self'");

      const detail = await request(server.port, {
        path: '/api/applications/greeter',
        headers: { cookie: session },
      });
      expect(detail.status).toBe(200);
      const application = JSON.parse(detail.body).application as {
        parts: Array<{ kind: string; lifetime: string }>;
        routes: Array<{ id: string; host: string; path: string }>;
        secrets: Array<{ name: string }>;
        logs: { unpublished?: boolean };
        signals?: unknown;
        backingServices: Array<{ name: string; service: string; className: string }>;
      };
      expect(application.backingServices).toEqual([
        expect.objectContaining({
          name: 'orders-db',
          service: 'orders',
          className: 'postgres-dedicated',
        }),
      ]);
      servicesFail = true;
      const unclassed = await request(server.port, {
        path: '/api/applications/greeter',
        headers: { cookie: session },
      });
      servicesFail = false;
      expect(JSON.parse(unclassed.body).application.backingServices[0].className).toBe('');
      expect(application.parts[0]).toMatchObject({ kind: 'component', lifetime: 'on-demand' });
      expect(application.logs).toEqual({ unpublished: true });
      expect(application.signals).toBeUndefined();
      expect(detail.body).not.toContain(SECRET);
      expect(application.secrets.some((entry) => entry.name === 'API_TOKEN')).toBe(true);

      logs = ['hello from greeter', `token=${SECRET}`];
      signals = { success: 4, error: 1, compute: [1, 2] };
      const refreshed = await request(server.port, {
        path: '/api/applications/greeter/logs',
        headers: { cookie: session },
      });
      expect(refreshed.status).toBe(200);
      expect(refreshed.body).toContain('hello from greeter');
      expect(refreshed.body).not.toContain(SECRET);
      const withSignals = await request(server.port, {
        path: '/api/applications/greeter',
        headers: { cookie: session },
      });
      expect(withSignals.body).toContain('"success":4');
      const dashboardSignals = await request(server.port, {
        path: '/api/signals',
        headers: { cookie: session },
      });
      expect(dashboardSignals.status).toBe(200);
      expect(JSON.parse(dashboardSignals.body)).toEqual({
        signals: [{ application: 'greeter', success: 4, error: 1, compute: [1, 2] }],
      });
      signals = undefined;
      expect(
        JSON.parse(
          (await request(server.port, { path: '/api/signals', headers: { cookie: session } })).body,
        ),
      ).toEqual({ signals: [] });
      signals = { success: 4, error: 1, compute: [1, 2] };

      const routeId = application.routes[0]?.id ?? '';
      const toggled = await request(server.port, {
        path: `/api/applications/greeter/routes/${routeId}`,
        method: 'PATCH',
        headers: auth,
        body: JSON.stringify({ enabled: false }),
      });
      expect(toggled.status).toBe(200);
      expect(patches.length).toBe(1);

      const env = await request(server.port, {
        path: '/api/applications/greeter/environment',
        method: 'PUT',
        headers: auth,
        body: JSON.stringify({ key: 'COLOR', value: 'green' }),
      });
      expect(env.status).toBe(200);
      const onPart = await request(server.port, {
        path: '/api/applications/greeter/environment',
        method: 'PUT',
        headers: auth,
        body: JSON.stringify({ key: 'SIZE', value: '2', part: 'http' }),
      });
      expect(onPart.status).toBe(200);
      expect(patches.at(-1)).toEqual({
        name: 'greeter',
        ops: [
          {
            op: 'add',
            path: '/spec/template/spec/components/0/localResources/environment/config/SIZE',
            value: '2',
          },
        ],
      });
      const badPart = await request(server.port, {
        path: '/api/applications/greeter/environment',
        method: 'PUT',
        headers: auth,
        body: JSON.stringify({ key: 'SIZE', value: '2', part: 3 }),
      });
      expect(badPart.status).toBe(400);
      const unknownPart = await request(server.port, {
        path: '/api/applications/greeter/environment',
        method: 'PUT',
        headers: auth,
        body: JSON.stringify({ key: 'SIZE', value: '2', part: 'nope' }),
      });
      expect(unknownPart.status).toBe(404);
      const removedFromPart = await request(server.port, {
        path: '/api/applications/greeter/environment/http/COLOR',
        method: 'DELETE',
        headers: auth,
      });
      expect(removedFromPart.status).toBe(200);
      const removed = await request(server.port, {
        path: '/api/applications/greeter/environment/COLOR',
        method: 'DELETE',
        headers: auth,
      });
      expect(removed.status).toBe(200);
      const reassigned = await request(server.port, {
        path: '/api/applications/greeter/secrets/API_TOKEN',
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ value: 'replacement-secret' }),
      });
      expect(reassigned.status).toBe(200);
      expect(reassigned.body).not.toContain('replacement-secret');
      const secretRef = await request(server.port, {
        path: '/api/applications/greeter/secrets/db-password',
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ value: 'replacement-secret' }),
      });
      expect(secretRef.body).toBe('{"name":"db-password"}');

      const bound = await request(server.port, {
        path: '/api/applications/greeter/bindings',
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ binding: 'orders-db', service: 'orders', capability: 'postgres' }),
      });
      expect(bound.status).toBe(200);
      const unbound = await request(server.port, {
        path: '/api/applications/greeter/bindings/orders-db',
        method: 'DELETE',
        headers: auth,
      });
      expect(unbound.status).toBe(200);

      const catalog = await request(server.port, {
        path: '/api/backing-services',
        headers: { cookie: session },
      });
      expect(catalog.body).toContain('orders');
      expect(catalog.body).not.toContain('orders.example');
      expect(catalog.body).not.toContain('pods');
      const classes = await request(server.port, {
        path: '/api/backing-service-classes',
        headers: { cookie: session },
      });
      expect(classes.body).toContain('postgres-dedicated');
      expect(classes.body).not.toContain('provider');
      const createdService = await request(server.port, {
        path: '/api/backing-services',
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          type: 'postgres',
          name: 'audit',
          className: 'postgres-dedicated',
          memory: '512Mi',
        }),
      });
      expect(createdService.status).toBe(201);
      expect(created[0]?.name).toBe('audit');
      const createdStore = await request(server.port, {
        path: '/api/backing-services',
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ type: 'blobstore', name: 'catalog', className: 'blobstore-nats' }),
      });
      expect(createdStore.status).toBe(201);
      expect(created[1]).toMatchObject({ name: 'catalog', type: 'blobstore' });
      const boundStore = await request(server.port, {
        path: '/api/applications/greeter/bindings',
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ binding: 'objects', service: 'catalog', capability: 'blobstore' }),
      });
      expect(boundStore.status).toBe(200);
      expect(
        (
          await request(server.port, {
            path: '/api/backing-services/audit',
            method: 'DELETE',
            headers: auth,
          })
        ).status,
      ).toBe(200);

      expect(
        (
          await request(server.port, {
            path: '/api/backing-services',
            method: 'POST',
            headers: auth,
            body: JSON.stringify({ type: 'postgres', name: 'taken' }),
          })
        ).status,
      ).toBe(409);
      for (const [name, status] of [
        ['missing', 404],
        ['busy', 409],
        ['denied', 403],
        ['weird', 502],
        ['plain', 502],
      ] as const) {
        expect(
          (
            await request(server.port, {
              path: `/api/backing-services/${name}`,
              method: 'DELETE',
              headers: auth,
            })
          ).status,
        ).toBe(status);
      }
      const plain = await request(server.port, {
        path: '/api/backing-services/plain',
        method: 'DELETE',
        headers: auth,
      });
      expect(plain.body).toContain('waiting for the orders database');
      const weird = await request(server.port, {
        path: '/api/backing-services/weird',
        method: 'DELETE',
        headers: auth,
      });
      expect(weird.body).not.toContain('pod');

      expect((await request(server.port, { path: '/applications/greeter' })).status).toBe(200);
      expect((await request(server.port, { path: '/assets/app.js' })).body).toContain(
        'consoleReady',
      );
      expect(
        (await request(server.port, { path: '/assets/app.css' })).headers['content-type'],
      ).toContain('text/css');
      expect(
        (await request(server.port, { path: '/assets/asset.woff' })).headers['content-type'],
      ).toContain('font/woff');
      expect(
        (await request(server.port, { path: '/assets/asset.woff2' })).headers['content-type'],
      ).toContain('font/woff2');
      expect(
        (await request(server.port, { path: '/assets/asset.ttf' })).headers['content-type'],
      ).toContain('font/ttf');
      expect((await request(server.port, { path: '/assets/asset.map' })).status).toBe(200);
      expect((await request(server.port, { path: '/assets/a..b' })).status).toBe(404);
      expect(
        (
          await request(server.port, {
            path: '/api/applications',
            headers: { host: 'evil.test' },
            host: 'evil.test',
          })
        ).status,
      ).toBe(403);
      expect(
        (await request(server.port, { path: '/api/missing', headers: { cookie: session } })).status,
      ).toBe(404);
      expect(
        (await request(server.port, { path: '/api/applications', origin: false })).status,
      ).toBe(401);
      now = 1_000 + 8 * 60 * 60 * 1000 + 1;
      expect(
        (await request(server.port, { path: '/api/applications', headers: { cookie: session } }))
          .status,
      ).toBe(401);
    } finally {
      await server.close();
    }
  });
});
