import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandFailure } from '@di-framework/cli-extension';
import { createSessionStore, readCookie, sessionCookie, tokensMatch } from '../src/console/auth';
import type { WorkloadDocument } from '../src/console/catalog';
import { type ConsoleCluster, createKubectlConsoleCluster } from '../src/console/cluster';
import { consoleAssetsDirectory, parseConsoleArgs, runWasmcloudConsole } from '../src/console/run';
import { egressWorkload, startConsoleServer } from '../src/console/server';
import { type ConsoleServices, createCliConsoleServices } from '../src/console/services';
import type { ClusterConnection } from '../src/target';
import { captureIo, fakeDeps, makeWorkspace } from './helpers';

const connection = {
  target: 'warehouse',
  kubeconfig: '/tmp/kubeconfig',
  namespace: 'di-tenant-warehouse',
  hostgroup: 'tenant-warehouse',
  registry: { push: 'registry.example', pull: 'registry.example' },
} as ClusterConnection;

function clusterFrom(
  respond: (args: readonly string[]) => { exitCode?: number; stdout?: string; stderr?: string },
) {
  const logs: string[] = [];
  const base = fakeDeps({ cwd: '/tmp' });
  const cluster = createKubectlConsoleCluster(
    {
      ...base,
      runCaptured: async (_command, args) => {
        const result = respond(args);
        return {
          exitCode: result.exitCode ?? 0,
          stdout: result.stdout ?? '',
          stderr: result.stderr ?? '',
        };
      },
    },
    (line) => logs.push(line),
  );
  return { cluster, logs };
}

describe('console branches', () => {
  it('covers session expiry and cookie decoding', () => {
    const store = createSessionStore();
    const first = store.create(0);
    expect(store.read(first.id, first.session.expiresAt)).toBeUndefined();
    expect(store.read(undefined, 0)).toBeUndefined();
    expect(store.read('', 0)).toBeUndefined();
    expect(store.read('missing', 0)).toBeUndefined();
    store.destroy(undefined);
    store.destroy(first.id);
    for (let index = 0; index < 100; index += 1) store.create(10);
    expect(store.create(10).id.length).toBeGreaterThan(10);
    expect(tokensMatch(undefined, 'expected')).toBe(false);
    expect(tokensMatch('expected', 'expected')).toBe(true);
    expect(readCookie(undefined, 'di_console_session')).toBeUndefined();
    expect(
      readCookie('other=1; broken; di_console_session=%E0%A4%A', 'di_console_session'),
    ).toBeUndefined();
    expect(readCookie('di_console_session=operator', 'missing')).toBeUndefined();
    expect(sessionCookie('operator', 10)).toContain('Max-Age=10');
  });

  it('reports request failures without returning sensitive command output', async () => {
    const listed = '{"items":[{"metadata":{"name":"greeter"}}]}';
    const ok = clusterFrom((args) => {
      if (args.includes('auth')) return { stdout: 'yes\n' };
      if (args.includes('configmap') && args.some((arg) => arg.includes('projection=logs'))) {
        return {
          stdout: JSON.stringify({ items: [{ data: { lines: 'hello\nnext', ignored: 1 } }] }),
        };
      }
      if (args.includes('configmap') && args.some((arg) => arg.includes('projection=signals'))) {
        return {
          stdout: JSON.stringify({
            items: [{ data: { success: '2', error: '1', compute: '1,2' } }],
          }),
        };
      }
      if (args.includes('servicebindings.platform.di-framework.dev') && args.includes('get'))
        return { stdout: listed };
      return { stdout: listed };
    });
    expect(await ok.cluster.listWorkloads(connection)).toHaveLength(1);
    expect(await ok.cluster.listBindings(connection)).toHaveLength(1);
    await ok.cluster.patchWorkload(connection, 'greeter', []);
    await ok.cluster.reassignSecret(connection, 'db-password', 'next-value');
    expect(await ok.cluster.canWrite(connection)).toBe(true);
    expect(await ok.cluster.readLogs(connection, 'greeter')).toEqual(['hello', 'next']);
    expect(await ok.cluster.readSignals(connection, 'greeter')).toEqual({
      success: 2,
      error: 1,
      compute: [1, 2],
    });
    await ok.cluster.bindService(connection, {
      workload: 'greeter',
      binding: 'orders-db',
      service: 'orders',
      capability: 'postgres',
    });
    await ok.cluster.unbindService(connection, 'greeter', 'orders-db');

    const denied = clusterFrom(() => ({
      exitCode: 1,
      stderr: 'Error from server (Forbidden): cannot list',
    }));
    expect(await denied.cluster.listBindings(connection)).toEqual([]);
    await expect(denied.cluster.listWorkloads(connection)).rejects.toMatchObject({ status: 502 });
    await expect(denied.cluster.patchWorkload(connection, 'greeter', [])).rejects.toMatchObject({
      status: 403,
    });
    await expect(denied.cluster.readLogs(connection, 'greeter')).resolves.toBeUndefined();
    expect(await denied.cluster.canWrite(connection)).toBe(false);

    const missingSecret = clusterFrom(() => ({
      exitCode: 1,
      stderr: 'Error from server (NotFound): secret missing',
    }));
    await expect(
      missingSecret.cluster.reassignSecret(connection, 'db-password', 'next-value'),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      missingSecret.cluster.unbindService(connection, 'greeter', 'orders-db'),
    ).rejects.toMatchObject({ status: 404 });

    const broken = clusterFrom(() => ({
      exitCode: 1,
      stdout: 'Bearer secret-token-value-with-enough-length',
    }));
    await expect(
      broken.cluster.bindService(connection, {
        workload: 'greeter',
        binding: 'orders-db',
        service: 'orders',
        capability: 'postgres',
      }),
    ).rejects.toMatchObject({ status: 502 });
    expect(broken.logs.join('\n')).toContain('[redacted]');

    const malformed = clusterFrom(() => ({ stdout: '{' }));
    await expect(malformed.cluster.listWorkloads(connection)).rejects.toMatchObject({
      status: 502,
    });
    await expect(malformed.cluster.listBindings(connection)).rejects.toMatchObject({ status: 502 });
    await expect(malformed.cluster.readLogs(connection, 'greeter')).rejects.toMatchObject({
      status: 502,
    });
    const missingItems = clusterFrom(() => ({ stdout: '{"items":{}}' }));
    await expect(missingItems.cluster.listWorkloads(connection)).rejects.toMatchObject({
      status: 502,
    });
    const notAList = clusterFrom(() => ({ stdout: 'null' }));
    await expect(notAList.cluster.listWorkloads(connection)).rejects.toMatchObject({ status: 502 });
    const unpublished = clusterFrom((args) => {
      if (args.includes('configmap'))
        return {
          stdout: JSON.stringify({ items: [{ data: { success: 'no', error: '1', compute: '' } }] }),
        };
      return { stdout: '{"items":[]}' };
    });
    expect(await unpublished.cluster.readLogs(connection, 'greeter')).toBeUndefined();
    expect(await unpublished.cluster.readSignals(connection, 'greeter')).toBeUndefined();
    const partialSignals = clusterFrom(() => ({
      stdout: JSON.stringify({ items: [{ data: { success: '1', error: '0', compute: '1,no' } }] }),
    }));
    expect(await partialSignals.cluster.readSignals(connection, 'greeter')).toEqual({
      success: 1,
      error: 0,
    });
    const noData = clusterFrom(() => ({ stdout: JSON.stringify({ items: [{}] }) }));
    expect(await noData.cluster.readLogs(connection, 'greeter')).toBeUndefined();
    const resourceMissing = clusterFrom(() => ({
      exitCode: 1,
      stderr: 'the server does not have a resource type "servicebindings"',
    }));
    expect(await resourceMissing.cluster.listBindings(connection)).toEqual([]);
    const unsafeNumber = clusterFrom(() => ({
      stdout: JSON.stringify({ items: [{ data: { success: '1', error: '9007199254740993' } }] }),
    }));
    expect(await unsafeNumber.cluster.readSignals(connection, 'greeter')).toBeUndefined();

    const failed = clusterFrom(() => ({ exitCode: 1, stderr: 'connection timed out' }));
    await expect(failed.cluster.listBindings(connection)).rejects.toMatchObject({
      status: 502,
      message: 'Backing services could not be read.',
    });
    await expect(
      failed.cluster.reassignSecret(connection, 'db-password', 'next-value'),
    ).rejects.toMatchObject({
      status: 502,
      message: 'The credential could not be reassigned.',
    });
    await expect(
      failed.cluster.unbindService(connection, 'greeter', 'orders-db'),
    ).rejects.toMatchObject({
      status: 502,
      message: 'The backing service could not be unbound.',
    });
    await expect(failed.cluster.readLogs(connection, 'greeter')).rejects.toMatchObject({
      status: 502,
      message: 'The application could not be read.',
    });
    await expect(failed.cluster.readSignals(connection, 'greeter')).rejects.toMatchObject({
      status: 502,
    });
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

  it('rejects malformed console requests', async () => {
    const workspace = makeWorkspace({
      manifest: `[targets.development]\nkubeconfig = "\${kubeconfig}"\nnamespace = "wasmcloud"\nhostgroup = "tenant-development"\nregistry = "registry.example.com/team"\n`,
    });
    const bundle = assets();
    let failList = false;
    let explodeRead = false;
    const server = await startConsoleServer({
      host: '127.0.0.1',
      port: 0,
      target: 'development',
      assetsDirectory: bundle,
      deps: fakeDeps({ cwd: workspace.root, env: { kubeconfig: workspace.kubeconfig } }),
      cluster: {
        async listWorkloads() {
          if (failList) throw new Error('backend failed');
          return [
            {
              metadata: {
                name: 'greeter',
                namespace: 'wasmcloud',
                labels: { 'app.kubernetes.io/managed-by': 'di-framework' },
              },
              spec: {
                replicas: 1,
                template: {
                  spec: {
                    components: [
                      {
                        name: 'greeter',
                        localResources: { environment: { config: { COLOR: 'blue' } } },
                      },
                    ],
                  },
                },
              },
              status: { readyReplicas: 1 },
            },
          ] as WorkloadDocument[];
        },
        async listBindings() {
          return [];
        },
        async patchWorkload() {
          return undefined;
        },
        async reassignSecret() {
          return undefined;
        },
        async canWrite() {
          return true;
        },
        async readLogs() {
          if (explodeRead) throw new Error('backend exploded');
          return ['line'];
        },
        async readSignals() {
          return undefined;
        },
        async bindService() {
          return undefined;
        },
        async unbindService() {
          throw new CommandFailure('WASMCLOUD_TARGET_NOT_FOUND', 'missing target', 1);
        },
      },
      services: {
        async list() {
          return [];
        },
        async classes() {
          return { classes: [], fromCluster: false };
        },
        async create() {
          throw new CommandFailure('WASMCLOUD_OTHER', 'bad size', 2);
        },
        async delete() {
          return { name: 'gone' };
        },
      },
    });
    try {
      const opened = await request(server.port, { path: '/api/session' });
      const session = cookie(opened.headers['set-cookie']);
      const csrf = (JSON.parse(opened.body) as { csrfToken: string }).csrfToken;
      const auth = { cookie: session, 'x-di-console-csrf': csrf };
      expect(
        (
          await request(server.port, {
            path: '/api/applications/nope',
            headers: { cookie: session },
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await request(server.port, {
            path: '/api/applications/Bad',
            headers: { cookie: session },
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await request(server.port, {
            path: '/api/applications/greeter/nope',
            headers: { cookie: session },
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await request(server.port, {
            path: '/api/applications/%E0%A4%A',
            headers: { cookie: session },
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await request(server.port, {
            path: '/api/applications/greeter/routes/missing',
            method: 'PATCH',
            headers: auth,
            body: JSON.stringify({ enabled: 'yes' }),
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await request(server.port, {
            path: '/api/applications/greeter/environment',
            method: 'PUT',
            headers: { cookie: session },
            body: JSON.stringify({ key: 'COLOR', value: 'blue' }),
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await request(server.port, {
            path: '/api/applications/greeter/environment',
            method: 'PUT',
            headers: auth,
            origin: false,
            body: JSON.stringify({ key: 'COLOR', value: 'blue' }),
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await request(server.port, {
            path: '/api/applications/greeter/environment',
            method: 'PUT',
            headers: auth,
            body: '{',
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await request(server.port, {
            path: '/api/applications/greeter/environment',
            method: 'PUT',
            headers: auth,
            body: JSON.stringify({ key: 'COLOR', value: 'blue', extra: true }),
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await request(server.port, {
            path: '/api/applications/greeter/environment',
            method: 'PUT',
            headers: auth,
            body: JSON.stringify({ key: 1, value: 'blue' }),
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await request(server.port, {
            path: '/api/applications/greeter/environment',
            method: 'PUT',
            headers: auth,
            body: '[]',
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await request(server.port, {
            path: '/api/backing-services',
            method: 'POST',
            headers: auth,
            body: JSON.stringify({ type: 'nope', name: 'orders' }),
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await request(server.port, {
            path: '/api/backing-services',
            method: 'POST',
            headers: auth,
            body: JSON.stringify({ type: 'postgres', name: 'Bad' }),
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await request(server.port, {
            path: '/api/backing-services',
            method: 'POST',
            headers: auth,
            body: JSON.stringify({
              type: 'postgres',
              name: 'orders',
              className: 'NOT',
              memory: 'x'.repeat(41),
            }),
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await request(server.port, {
            path: '/api/backing-services',
            method: 'POST',
            headers: auth,
            body: JSON.stringify({ type: 'postgres', name: 'orders', memory: '' }),
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await request(server.port, {
            path: '/api/backing-services/NOT',
            method: 'DELETE',
            headers: auth,
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await request(server.port, {
            path: '/api/applications/greeter/bindings',
            method: 'POST',
            headers: auth,
            body: JSON.stringify({ binding: 'orders', service: 'orders', capability: 'nope' }),
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await request(server.port, {
            path: '/api/applications/greeter/bindings',
            method: 'POST',
            headers: auth,
            body: JSON.stringify({ binding: 'Bad', service: 'orders', capability: 'postgres' }),
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await request(server.port, {
            path: '/api/applications/greeter/bindings',
            method: 'POST',
            headers: auth,
            body: JSON.stringify({ binding: 'orders', service: 'Bad', capability: 'postgres' }),
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await request(server.port, {
            path: '/api/applications/greeter/bindings',
            method: 'POST',
            headers: auth,
            body: JSON.stringify({ binding: 'egress', service: 'outbound', capability: 'egress' }),
          })
        ).status,
      ).toBe(200);
      const egressCreate = await request(server.port, {
        path: '/api/backing-services',
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ type: 'egress', name: 'outbound' }),
      });
      expect(egressCreate.status).toBe(400);
      expect(egressCreate.body).toContain('platform service create egress');
      expect(
        (
          await request(server.port, {
            path: '/api/applications/greeter/bindings/missing',
            method: 'DELETE',
            headers: auth,
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await request(server.port, {
            path: '/api/applications/greeter/secrets/missing',
            method: 'POST',
            headers: auth,
            body: JSON.stringify({ value: 1 }),
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await request(server.port, {
            path: '/api/backing-services',
            method: 'POST',
            headers: auth,
            body: 'x'.repeat(70_000),
          })
        ).status,
      ).toBe(413);
      expect(
        (
          await request(server.port, {
            path: '/api/backing-services/%E0%A4%A',
            headers: { cookie: session },
          })
        ).status,
      ).toBe(404);
      explodeRead = true;
      const brokenRead = await request(server.port, {
        path: '/api/applications/greeter',
        headers: { cookie: session },
      });
      expect(brokenRead.status).toBe(502);
      expect(brokenRead.body).toContain('could not be read');
      explodeRead = false;
      failList = true;
      expect(
        (await request(server.port, { path: '/api/applications', headers: { cookie: session } }))
          .body,
      ).toContain('could not be read');
      expect((await request(server.port, { path: '/assets/nested' })).status).toBe(404);
      expect((await request(server.port, { path: '/assets/asset.svg' })).status).toBe(200);
      expect((await request(server.port, { path: '/favicon.ico' })).status).toBe(404);
    } finally {
      await server.close();
      await server.close();
    }
  });

  it('keeps a viewer from writing and reports a broken request', async () => {
    const workspace = tenantWorkspace();
    const bundle = assets();
    const empty = mkdtempSync(join(tmpdir(), 'console-empty-'));
    const plain = makeWorkspace();
    const captured = captureIo();
    let checks = 0;
    const viewer = await openConsole(
      workspace,
      bundle,
      idleCluster(async () => false),
    );
    const denied = await openConsole(
      workspace,
      bundle,
      idleCluster(async () => {
        checks += 1;
        throw new Error(`token=${'a'.repeat(40)}`);
      }),
      captured.io,
    );
    const unscoped = await openConsole(plain, bundle, idleCluster());
    const missing = await openConsole(workspace, empty, idleCluster());
    const quiet = await openConsole(workspace, bundle, idleCluster(), undefined, false);
    try {
      const opened = await request(viewer.port, { path: '/api/session' });
      const session = cookie(opened.headers['set-cookie']);
      const body = JSON.parse(opened.body) as { csrfToken: string; writable: boolean };
      expect(body.writable).toBe(false);
      const refused = await request(viewer.port, {
        path: '/api/applications/greeter/environment',
        method: 'PUT',
        headers: { cookie: session, 'x-di-console-csrf': body.csrfToken },
        body: JSON.stringify({ key: 'COLOR', value: 'blue' }),
      });
      expect(refused.status).toBe(403);
      expect(refused.body).toContain('cannot change the application');

      const openedDenied = await request(denied.port, { path: '/api/session' });
      expect(JSON.parse(openedDenied.body).writable).toBe(false);
      const deniedSession = cookie(openedDenied.headers['set-cookie']);
      const deniedToken = (JSON.parse(openedDenied.body) as { csrfToken: string }).csrfToken;
      const failedWrite = await request(denied.port, {
        path: '/api/applications/greeter/environment',
        method: 'PUT',
        headers: { cookie: deniedSession, 'x-di-console-csrf': deniedToken },
        body: JSON.stringify({ key: 'COLOR', value: 'blue' }),
      });
      expect(failedWrite.status).toBe(403);
      expect(checks).toBe(2);
      expect(captured.stderr.join('')).toContain('[redacted]');
      expect(captured.stderr.join('')).not.toContain('a'.repeat(40));

      const scoped = await request(unscoped.port, { path: '/api/session' });
      expect(scoped.status).toBe(404);
      expect(scoped.body).toContain('one tenant');
      expect((await request(missing.port, { path: '/' })).status).toBe(404);
      const raw = await rawRequest(
        viewer.port,
        `GET http://example.com:99999/x HTTP/1.1\r\nHost: 127.0.0.1:${viewer.port}\r\nConnection: close\r\n\r\n`,
      );
      expect(raw).toContain('CONSOLE_REQUEST_FAILED');
    } finally {
      await viewer.close();
      await denied.close();
      await unscoped.close();
      await missing.close();
      await quiet.close();
    }
  });

  it('starts the console command and stops on SIGINT', async () => {
    expect(() => parseConsoleArgs(['--target', 'warehouse', '--target', 'other'])).toThrow(
      CommandFailure,
    );
    expect(() => parseConsoleArgs(['--host', '127.0.0.1', '--host', 'localhost'])).toThrow(
      CommandFailure,
    );
    expect(() => parseConsoleArgs(['--port', '8787', '--port', '8788'])).toThrow(CommandFailure);
    expect(() => parseConsoleArgs(['extra'])).toThrow(CommandFailure);
    expect(() => parseConsoleArgs(['--host', '::'])).toThrow(CommandFailure);
    expect(() => parseConsoleArgs(['--host', '[::]'])).toThrow(CommandFailure);
    expect(() => parseConsoleArgs(['--host', 'not a host'])).toThrow(CommandFailure);
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
    const live: string[] = [];
    const running = runWasmcloudConsole(
      [],
      captured.io,
      fakeDeps({ cwd: workspace.root, env: { kubeconfig: workspace.kubeconfig } }),
      { write: (chunk: string) => live.push(chunk) },
    );
    const started = Date.now();
    while (!live.join('').includes('Console listening') && Date.now() - started < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const banner = live.join('');
    const address = /Console listening on (http:\/\/127\.0\.0\.1:(\d+))\n/.exec(banner);
    expect(Number(address?.[2])).toBeGreaterThan(0);
    const page = await fetch(`${address?.[1]}/`);
    expect(page.status).toBe(200);
    await page.text();
    process.emit('SIGINT');
    const stopped = await running;
    expect(stopped.text).toContain(`Console stopped (${address?.[1]})`);
    expect(captured.stdout.join('')).toBe('');
    expect(banner).toContain('tenant development');
    expect(banner).toContain('tenant-development');
    expect(banner).not.toContain('namespace');

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

  it('binds egress to the single WorkloadDeployment of an application', () => {
    expect(egressWorkload([{ metadata: { name: 'mesh-site' } }] as WorkloadDocument[])).toBe(
      'mesh-site',
    );
    for (const members of [[], [{ metadata: { name: 'a' } }, { metadata: { name: 'b' } }], [{}]])
      expect(() => egressWorkload(members as WorkloadDocument[])).toThrow(
        'Egress is granted per part',
      );
  });

  it('unbinds the deploy-named egress binding when no console binding exists', async () => {
    const deleted: string[] = [];
    const { cluster } = clusterFrom((args) => {
      const name = args[args.indexOf('delete') + 2] ?? '';
      deleted.push(name);
      return name.startsWith('di-bind-')
        ? { exitCode: 1, stderr: 'Error from server (NotFound): not found' }
        : {};
    });
    await cluster.unbindService(connection, 'mesh-site', 'egress');
    expect(deleted).toEqual([expect.stringMatching(/^di-bind-/), 'mesh-site-egress']);
  });
});

function tenantWorkspace() {
  return makeWorkspace({
    manifest: `[targets.development]\nkubeconfig = "\${kubeconfig}"\nnamespace = "wasmcloud"\nhostgroup = "tenant-development"\nregistry = "registry.example.com/team"\n`,
  });
}

function idleCluster(canWrite: ConsoleCluster['canWrite'] = async () => true): ConsoleCluster {
  return {
    async listWorkloads() {
      return [];
    },
    async listBindings() {
      return [];
    },
    async patchWorkload() {
      return undefined;
    },
    async reassignSecret() {
      return undefined;
    },
    canWrite,
    async readLogs() {
      return undefined;
    },
    async readSignals() {
      return undefined;
    },
    async bindService() {
      return undefined;
    },
    async unbindService() {
      return undefined;
    },
  };
}

function idleServices(): ConsoleServices {
  return {
    async list() {
      return [];
    },
    async classes() {
      return { classes: [], fromCluster: false };
    },
    async create() {
      return {
        name: 'orders',
        namespace: 'wasmcloud',
        type: 'postgres',
        className: 'postgres-dedicated',
        ready: 'Unknown',
        target: 'development',
      };
    },
    async delete(_target, name) {
      return { name };
    },
  };
}

function openConsole(
  workspace: ReturnType<typeof makeWorkspace>,
  bundle: string,
  cluster: ConsoleCluster,
  io?: ReturnType<typeof captureIo>['io'],
  withServices = true,
) {
  return startConsoleServer({
    host: '127.0.0.1',
    port: 0,
    target: 'development',
    assetsDirectory: bundle,
    deps: fakeDeps({ cwd: workspace.root, env: { kubeconfig: workspace.kubeconfig } }),
    cluster,
    ...(withServices ? { services: idleServices() } : {}),
    ...(io ? { io } : {}),
  });
}

function rawRequest(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(payload);
    });
    const chunks: Buffer[] = [];
    socket.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.on('error', reject);
  });
}

function assets(): string {
  const root = mkdtempSync(join(tmpdir(), 'console-assets-'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>console</title>');
  writeFileSync(join(root, 'asset.svg'), '<svg />');
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
  const host = `127.0.0.1:${port}`;
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
