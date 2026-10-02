import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { getSnapshot } from 'mobx-state-tree';
import { ApiError, createClient, messageOf } from '../console-ui/src/api';
import { ACTIVITY_LIMIT, ConsoleStore, type ConsoleStoreInstance } from '../console-ui/src/store';
import type { ApplicationDetail } from '../console-ui/src/types';

type Reply = { status?: number; body: unknown };
type Handler = (request: { body: unknown; headers: Record<string, string> }) => Reply;
type Seen = { method: string; path: string; headers: Record<string, string>; body: unknown };

const realFetch = globalThis.fetch;
let routes: Map<string, Handler>;
let seen: Seen[];

function route(method: string, path: string, handler: Handler | Reply) {
  routes.set(`${method} ${path}`, typeof handler === 'function' ? handler : () => handler);
}

beforeEach(() => {
  routes = new Map();
  seen = [];
  globalThis.fetch = (async (input: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    const headers = init.headers as Record<string, string>;
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    seen.push({ method, path: input, headers, body });
    const handler = routes.get(`${method} ${input}`);
    if (!handler) return Response.json({ error: `No route ${method} ${input}` }, { status: 404 });
    const reply = handler({ body, headers });
    return Response.json(reply.body, { status: reply.status ?? 200 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const session = { csrfToken: 'token-1', writable: true, tenant: 'warehouse', hostgroup: 'hg' };

function detail(overrides: Partial<ApplicationDetail> = {}): ApplicationDetail {
  return {
    name: 'mesh',
    ready: true,
    services: 1,
    components: 1,
    routeCount: 1,
    parts: [{ name: 'mesh-site', kind: 'component', lifetime: 'on-demand' }],
    routes: [{ id: 'r1', host: 'mesh.local', path: '/', enabled: true }],
    environment: [{ key: 'MODE', value: 'prod', part: 'mesh-site' }],
    secrets: [{ name: 'token' }],
    backingServices: [],
    privateBindings: [{ name: 'objects', contract: 'wasmcloud:blobstore', bound: true }],
    logs: { unpublished: true },
    ...overrides,
  };
}

function serveTenant() {
  route('GET', '/api/session', { body: session });
  route('GET', '/api/applications', {
    body: {
      applications: [
        { name: 'mesh', ready: true, services: 1, components: 1, routeCount: 1 },
        { name: 'greeter', ready: false, services: 0, components: 1, routeCount: 0 },
        {
          name: 'cron',
          ready: false,
          detail: 'Waiting for host',
          services: 0,
          components: 1,
          routeCount: 0,
        },
      ],
    },
  });
  route('GET', '/api/backing-services', {
    body: {
      services: [
        { name: 'cache', className: 'keyvalue-redis', type: 'keyvalue', ready: true },
        { name: 'queue', className: 'messaging-nats', type: 'messaging', ready: false },
        {
          name: 'db',
          className: 'postgres-dedicated',
          type: 'postgres',
          ready: false,
          detail: 'Provisioning',
        },
      ],
    },
  });
  route('GET', '/api/backing-service-classes', {
    body: {
      classes: [
        { name: 'keyvalue-redis', type: 'keyvalue', default: false },
        { name: 'messaging-nats', type: 'messaging', default: true },
      ],
    },
  });
  route('GET', '/api/signals', {
    body: { signals: [{ application: 'mesh', success: 3, error: 1, compute: [1, 2] }] },
  });
  route('GET', '/api/applications/mesh', { body: { application: detail() } });
}

async function started(): Promise<ConsoleStoreInstance> {
  serveTenant();
  const store = ConsoleStore.create();
  await store.start();
  return store;
}

describe('console store loading', () => {
  test('opens the session and loads the tenant', async () => {
    const store = await started();
    expect(store.session?.tenant).toBe('warehouse');
    expect(store.writable).toBe(true);
    expect(store.applications.map((app) => app.name)).toEqual(['mesh', 'greeter', 'cron']);
    expect(store.services).toHaveLength(3);
    expect(store.defaultServiceClass).toBe('messaging-nats');
    expect(store.signals?.[0]?.success).toBe(3);
    expect(store.ui.refreshing).toBe(false);
    expect(store.ui.error).toBeUndefined();
    expect(store.activity.map((entry) => entry.text)).toEqual([
      'db: Provisioning',
      'queue: not ready',
      'cron: Waiting for host',
      'greeter: not ready',
      'Connected to tenant warehouse.',
    ]);
  });

  test('a failed session leaves the store closed with the error', async () => {
    route('GET', '/api/session', { status: 401, body: { error: 'Sign in again.' } });
    const store = ConsoleStore.create();
    await store.start();
    expect(store.session).toBeUndefined();
    expect(store.ui.error).toBe('Sign in again.');
    expect(seen).toHaveLength(1);
  });

  test('a partial application list keeps its error', async () => {
    serveTenant();
    route('GET', '/api/applications', { body: { applications: [], error: 'Cron is forbidden.' } });
    const store = ConsoleStore.create();
    await store.start();
    const entry = store.activity.find((item) => item.text === 'Cron is forbidden.');
    expect(entry?.status).toBe('danger');
    // A full refresh that succeeds clears the banner.
    expect(store.ui.error).toBeUndefined();
  });

  test('a failed refresh reports the error and stops refreshing', async () => {
    const store = await started();
    route('GET', '/api/backing-services', { status: 502, body: {} });
    await store.refreshAll();
    expect(store.ui.error).toBe('The request failed.');
    expect(store.ui.refreshing).toBe(false);
  });

  test('unavailable signals become an empty list and an activity warning', async () => {
    serveTenant();
    route('GET', '/api/signals', { status: 503, body: { error: 'Signals are unavailable.' } });
    const store = ConsoleStore.create();
    await store.start();
    expect(store.signals).toHaveLength(0);
    expect(store.activity[0]?.text).toBe('Signals are unavailable.');
    await store.refreshSignals();
    expect(store.signals).toHaveLength(0);
  });

  test('without a default class the first class is offered, and none means empty', async () => {
    const store = await started();
    route('GET', '/api/backing-service-classes', {
      body: { classes: [{ name: 'keyvalue-redis', type: 'keyvalue', default: false }] },
    });
    store.navigate('backing-services');
    await Bun.sleep(0);
    expect(store.defaultServiceClass).toBe('keyvalue-redis');
    route('GET', '/api/backing-service-classes', { body: { classes: [] } });
    store.navigate('backing-services');
    await Bun.sleep(0);
    expect(store.defaultServiceClass).toBe('');
  });

  test('activity is capped and can be cleared', async () => {
    const store = await started();
    for (let index = 0; index < ACTIVITY_LIMIT; index += 1) await store.refreshAll();
    expect(store.activity).toHaveLength(ACTIVITY_LIMIT);
    store.clearActivity();
    expect(store.activity).toHaveLength(0);
  });
});

describe('console store refresh', () => {
  test('refresh re-reads the open application', async () => {
    const pending = {
      name: 'state',
      service: 'cache',
      className: 'keyvalue-redis',
      ready: false,
    };
    serveTenant();
    route('GET', '/api/applications/mesh', {
      body: { application: detail({ backingServices: [pending] }) },
    });
    const store = ConsoleStore.create();
    await store.start();
    await store.openApplication('mesh');
    const node = store.application;
    expect(node?.backingServices[0]?.ready).toBe(false);
    route('GET', '/api/applications/mesh', {
      body: { application: detail({ backingServices: [{ ...pending, ready: true }] }) },
    });
    await store.refreshAll();
    expect(store.application).toBe(node);
    expect(store.application?.backingServices[0]?.ready).toBe(true);

    // An application closed while its refresh is in flight stays closed.
    const refreshing = store.refreshAll();
    store.navigate('dashboard');
    await refreshing;
    expect(store.application).toBeUndefined();
  });

  test('the services list polls while a service is not ready', async () => {
    const store = await started();
    const reads = () => seen.filter((request) => request.path === '/api/backing-services').length;
    const before = reads();
    route('GET', '/api/backing-services', {
      body: {
        services: [
          { name: 'cache', className: 'keyvalue-redis', type: 'keyvalue', ready: true },
          { name: 'queue', className: 'messaging-nats', type: 'messaging', ready: true },
          { name: 'db', className: 'postgres-dedicated', type: 'postgres', ready: false },
        ],
      },
    });
    store.startServicePolling(5);
    while (store.services.find((service) => service.name === 'queue')?.ready !== true) {
      await Bun.sleep(5);
    }
    expect(store.activity[0]?.text).toBe('Backing service queue is ready.');
    route('GET', '/api/backing-services', {
      body: {
        services: [
          { name: 'cache', className: 'keyvalue-redis', type: 'keyvalue', ready: true },
          { name: 'queue', className: 'messaging-nats', type: 'messaging', ready: true },
          { name: 'db', className: 'postgres-dedicated', type: 'postgres', ready: true },
        ],
      },
    });
    while (store.services.some((service) => !service.ready)) await Bun.sleep(5);
    expect(store.activity[0]?.text).toBe('Backing service db is ready.');
    const settled = reads();
    expect(settled).toBeGreaterThan(before);
    await Bun.sleep(30);
    // Every service is ready, so the ticks no longer read.
    expect(reads()).toBe(settled);
    store.stopServicePolling();
    store.stopServicePolling();
  });

  test('a poll skips while one is in flight and reports failures', async () => {
    const store = await started();
    const before = seen.length;
    await Promise.all([store.pollServices(), store.pollServices()]);
    expect(seen.length - before).toBe(1);
    route('GET', '/api/backing-services', { status: 502, body: { error: 'Services failed.' } });
    await store.pollServices();
    expect(store.ui.error).toBe('Services failed.');
  });
});

describe('console store navigation', () => {
  test('navigating clears the open application and loads services on demand', async () => {
    const store = await started();
    await store.openApplication('mesh');
    expect(store.ui.section).toBe('applications');
    expect(store.application?.name).toBe('mesh');
    store.selectTab('logs');
    expect(store.ui.selectedTab).toBe('logs');
    store.navigate('dashboard');
    expect(store.application).toBeUndefined();
    expect(store.ui.selectedApplication).toBeUndefined();
    const before = seen.length;
    store.navigate('backing-services');
    await Bun.sleep(0);
    expect(seen.slice(before).map((request) => request.path)).toEqual([
      '/api/backing-services',
      '/api/backing-service-classes',
    ]);
  });

  test('a failed service load on navigation shows the error', async () => {
    const store = await started();
    route('GET', '/api/backing-service-classes', { status: 403, body: { error: 'Forbidden.' } });
    store.navigate('backing-services');
    await Bun.sleep(0);
    expect(store.ui.error).toBe('Forbidden.');
  });

  test('opening an application resets the tab and survives a superseded load', async () => {
    const store = await started();
    store.selectTab('secrets');
    route('GET', '/api/applications/greeter', {
      body: { application: detail({ name: 'greeter' }) },
    });
    const first = store.openApplication('mesh');
    const second = store.openApplication('greeter');
    await Promise.all([first, second]);
    expect(store.ui.selectedTab).toBe('overview');
    expect(store.application?.name).toBe('greeter');
  });

  test('a failed application load shows the error', async () => {
    const store = await started();
    await store.openApplication('missing');
    expect(store.application).toBeUndefined();
    expect(store.ui.error).toBe('No route GET /api/applications/missing');
  });

  test('logs refresh into the open application', async () => {
    const store = await started();
    await store.refreshLogs();
    await store.openApplication('mesh');
    expect(store.application?.logs.published).toBe(false);
    route('GET', '/api/applications/mesh/logs', { body: { lines: ['ready', 'connected'] } });
    await store.refreshLogs();
    const logs = store.application?.logs;
    expect(logs && getSnapshot(logs)).toEqual({ published: true, lines: ['ready', 'connected'] });
    route('GET', '/api/applications/mesh/logs', { status: 500, body: { error: 'Logs failed.' } });
    await store.refreshLogs();
    expect(store.ui.error).toBe('Logs failed.');
  });

  test('logs that arrive after the application closed are dropped', async () => {
    const store = await started();
    await store.openApplication('mesh');
    route('GET', '/api/applications/mesh/logs', { body: { lines: ['late'] } });
    const pending = store.refreshLogs();
    store.navigate('dashboard');
    await pending;
    expect(store.application).toBeUndefined();
  });
});

describe('console store changes', () => {
  test('application changes replace the open node from the response and send the token', async () => {
    const store = await started();
    await store.openApplication('mesh');
    const node = store.application;
    route('PATCH', '/api/applications/mesh/routes/r1', ({ body }) => ({
      body: {
        csrfToken: 'token-2',
        application: detail({
          routes: [
            {
              id: 'r1',
              host: 'mesh.local',
              path: '/',
              enabled: (body as { enabled: boolean }).enabled,
            },
          ],
        }),
      },
    }));
    expect(await store.setRoute('r1', 'mesh.local/', false)).toBe(true);
    expect(store.application).toBe(node);
    expect(store.application?.routes[0]?.enabled).toBe(false);
    expect(seen.at(-1)?.headers['x-di-console-csrf']).toBe('token-1');
    expect(store.session?.csrfToken).toBe('token-2');
    expect(store.activity[0]?.text).toBe('Disabled route mesh.local/ on mesh.');

    route('PATCH', '/api/applications/mesh/routes/r1', { body: { application: detail() } });
    await store.setRoute('r1', 'mesh.local/', true);
    expect(seen.at(-1)?.headers['x-di-console-csrf']).toBe('token-2');
    expect(store.activity[0]?.text).toBe('Enabled route mesh.local/ on mesh.');
  });

  test('environment, secrets, and bindings', async () => {
    const store = await started();
    await store.openApplication('mesh');
    route('PUT', '/api/applications/mesh/environment', ({ body }) => ({
      body: {
        application: detail({
          environment: [body as { key: string; value: string; part: string }],
        }),
      },
    }));
    expect(await store.setEnvironment('LEVEL', 'debug', 'mesh-site')).toBe(true);
    expect(seen.at(-1)?.body).toEqual({ key: 'LEVEL', value: 'debug', part: 'mesh-site' });
    expect(store.application?.environment.map((entry) => `${entry.part}/${entry.key}`)).toEqual([
      'mesh-site/LEVEL',
    ]);
    expect(store.activity[0]?.text).toBe('Set LEVEL on mesh-site in mesh.');

    route('DELETE', '/api/applications/mesh/environment/mesh-site/LEVEL', {
      body: { application: detail({ environment: [] }) },
    });
    expect(await store.deleteEnvironment('LEVEL', 'mesh-site')).toBe(true);
    expect(store.application?.environment).toHaveLength(0);
    expect(store.activity[0]?.text).toBe('Removed LEVEL from mesh-site in mesh.');

    route('POST', '/api/applications/mesh/secrets/token', { body: { name: 'token' } });
    expect(await store.reassignSecret('token', 's3cret')).toBe(true);
    expect(seen.at(-1)?.body).toEqual({ value: 's3cret' });
    expect(store.activity[0]?.text).toBe('Reassigned secret token on mesh.');

    route('POST', '/api/applications/mesh/bindings', ({ body }) => ({
      body: {
        application: detail({
          backingServices: [
            {
              name: (body as { binding: string }).binding,
              service: 'cache',
              className: 'keyvalue-redis',
              ready: true,
            },
          ],
        }),
      },
    }));
    expect(await store.bind('state', 'cache')).toBe(true);
    expect(seen.at(-1)?.body).toEqual({
      binding: 'state',
      service: 'cache',
      capability: 'keyvalue',
    });
    expect(store.application?.backingServices[0]?.name).toBe('state');
    expect(await store.bind('state', 'missing')).toBe(false);

    route('DELETE', '/api/applications/mesh/bindings/state', { body: { application: detail() } });
    expect(await store.unbind('state')).toBe(true);
    expect(store.application?.backingServices).toHaveLength(0);
    expect(store.activity[0]?.text).toBe('Unbound state from mesh.');
  });

  test('a rejected change keeps the node and reports the error', async () => {
    const store = await started();
    await store.openApplication('mesh');
    route('PUT', '/api/applications/mesh/environment', {
      status: 409,
      body: { error: 'MODE is managed by the platform.' },
    });
    expect(await store.setEnvironment('MODE', 'dev', 'mesh-site')).toBe(false);
    expect(store.application?.environment[0]?.value).toBe('prod');
    expect(store.ui.error).toBe('MODE is managed by the platform.');
  });

  test('application changes need an open application', async () => {
    const store = await started();
    expect(await store.setEnvironment('A', 'b', 'mesh-site')).toBe(false);
    expect(await store.reassignSecret('token', 'value')).toBe(false);
  });

  test('backing services are added, replaced, and removed from responses', async () => {
    const store = await started();
    route('POST', '/api/backing-services', ({ body }) => ({
      body: {
        service: {
          name: (body as { name: string }).name,
          className: 'keyvalue-redis',
          type: 'keyvalue',
          ready: false,
        },
      },
    }));
    expect(
      await store.createService({
        type: 'keyvalue',
        name: 'sessions',
        className: 'keyvalue-redis',
      }),
    ).toBe(true);
    expect(store.services.map((service) => service.name)).toContain('sessions');
    expect(await store.createService({ type: 'keyvalue', name: 'cache' })).toBe(true);
    expect(store.services.find((service) => service.name === 'cache')?.ready).toBe(false);
    expect(store.services).toHaveLength(4);

    route('DELETE', '/api/backing-services/sessions', { body: { name: 'sessions' } });
    expect(await store.deleteService('sessions')).toBe(true);
    expect(store.services.map((service) => service.name)).not.toContain('sessions');
    route('DELETE', '/api/backing-services/gone', { body: { name: 'gone' } });
    expect(await store.deleteService('gone')).toBe(true);
    expect(store.services).toHaveLength(3);
    expect(store.activity[0]?.text).toBe('Deleted backing service gone.');
  });
});

describe('console client', () => {
  test('reads never send the token and a token without a session is ignored', async () => {
    const store = ConsoleStore.create();
    route('GET', '/api/signals', { body: { signals: [], csrfToken: 'early' } });
    await store.refreshSignals();
    expect(store.session).toBeUndefined();
    expect(seen[0]?.headers['x-di-console-csrf']).toBeUndefined();
  });

  test('changes without a token omit the header', async () => {
    const tokens: string[] = [];
    const client = createClient({ csrfToken: () => '', receiveCsrfToken: (t) => tokens.push(t) });
    route('DELETE', '/api/backing-services/a%20b', { body: { name: 'a b' } });
    await client.deleteBackingService('a b');
    expect(seen[0]?.headers['x-di-console-csrf']).toBeUndefined();
    expect(seen[0]?.headers['content-type']).toBeUndefined();
    expect(tokens).toEqual([]);
  });

  test('errors carry the status and message', async () => {
    const client = createClient({ csrfToken: () => 't', receiveCsrfToken: () => {} });
    route('GET', '/api/applications', { status: 503, body: { error: 'Cluster unreachable.' } });
    const error = await client.applications().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(503);
    expect(messageOf(error)).toBe('Cluster unreachable.');
    expect(messageOf(new Error('boom'))).toBe('The console request failed.');
  });
});
