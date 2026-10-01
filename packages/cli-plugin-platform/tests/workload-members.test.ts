import { describe, expect, it } from 'bun:test';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BINDING_CATALOG } from '@di-framework/bindings';
import { buildComponent, requirementsForProject } from '../src/build';
import { runWasmcloudDeploy } from '../src/deploy';
import { hostInterfacesFromRequirements } from '../src/host-interface';
import { loadProject } from '../src/project';
import { writeWorkloadManifest } from '../src/workload-members';
import { captureIo, fakeDeps, makeAssets, makeProject, makeWorkspace } from './helpers';

function member(name: string, declaration: string) {
  const root = makeProject({ name, entry: 'src/app.ts', workload: 'warehouse' });
  writeFileSync(
    join(root, 'src/app.ts'),
    `import { WorkloadComponent, WorkloadService } from '@di-framework/bindings';\n${declaration}\n`,
  );
  return loadProject(root);
}

describe('implicit workloads', () => {
  it('deploys a discovered messaging member and writes its workload manifest', async () => {
    const { root, greeter } = makeWorkspace();
    writeFileSync(
      join(greeter, 'di-framework.config.json'),
      JSON.stringify({ name: 'greeter', entry: 'src/app.ts', workload: 'warehouse' }),
    );
    writeFileSync(
      join(greeter, 'src/app.ts'),
      `import { WorkloadService } from '@di-framework/bindings';
export const sync = WorkloadService({ path: '/sync', subscriptions: ['warehouse.stock'] })(async () => {});`,
    );
    const assets = makeAssets();
    cpSync(
      new URL('../assets/wit/deps/wasmcloud-messaging', import.meta.url),
      join(assets, 'wit/deps/wasmcloud-messaging'),
      { recursive: true },
    );
    await runWasmcloudDeploy(
      ['greeter', '--target', 'development'],
      captureIo().io,
      fakeDeps({ cwd: root, assets }),
    );
    const manifest = JSON.parse(
      readFileSync(join(root, '.di-framework/workloads/warehouse.json'), 'utf8'),
    );
    expect(manifest.members).toHaveLength(1);
    expect(manifest.paths).toEqual({ '/sync': 'greeter' });
    const yaml = readFileSync(join(greeter, '.di-framework/deploy/workload.yaml'), 'utf8');
    expect(yaml).toContain('warehouse.stock');
    expect(yaml).toContain('handler');
    expect(yaml).not.toContain('kind: Service');
  });

  it('builds a run service without messaging or HTTP exports', async () => {
    const project = member(
      'run',
      "export const run = WorkloadService({ path: '/run' })(async () => {});",
    );
    const assets = makeAssets();
    cpSync(
      new URL('../assets/wit/deps/wasi-cli', import.meta.url),
      join(assets, 'wit/deps/wasi-cli'),
      { recursive: true },
    );
    await buildComponent(project, captureIo().io, fakeDeps({ cwd: project.projectRoot, assets }));
    const adapter = readFileSync(
      join(project.projectRoot, '.di-framework/cron-adapter.js'),
      'utf8',
    );
    expect(adapter).toContain('export const run');
    expect(adapter).not.toContain('handleMessage');
  });

  it('derives membership and routes without executing members', () => {
    const take = member(
      'take',
      "export const fetch = WorkloadComponent({ path: '/take' })(() => { throw new Error('do not execute'); });",
    );
    const receive = member(
      'receive',
      "export const fetch = WorkloadComponent({ path: '/receive' })(() => {});",
    );
    const sync = member(
      'sync',
      "export const onMessage = WorkloadService({ path: '/sync', subscriptions: ['warehouse.stock'] })(async () => {});",
    );
    expect(sync.ingress).toBe(false);
    expect(take.ingress).toBe(true);
    const path = writeWorkloadManifest(take.projectRoot, 'warehouse', [take, sync, receive]);
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    expect(manifest.name).toBe('warehouse');
    expect(manifest.paths).toEqual({ '/receive': 'receive', '/sync': 'sync', '/take': 'take' });
    expect(manifest.routes).toEqual({ '/receive': 'receive', '/take': 'take' });
    expect(manifest.members.map((p: { name: string }) => p.name)).toEqual([
      'receive',
      'sync',
      'take',
    ]);
    expect(manifest.members[1]).toMatchObject({
      kind: 'service',
      path: '/sync',
      exportName: 'onMessage',
      subscriptions: ['warehouse.stock'],
    });
  });

  it('rejects ambiguous route claims and conflicting source membership', () => {
    const a = member('a', "export const fetch = WorkloadComponent({ path: '/take' })(() => {});");
    const b = member('b', "export const fetch = WorkloadComponent({ path: '/take' })(() => {});");
    expect(() => writeWorkloadManifest(a.projectRoot, 'warehouse', [a, b])).toThrow(
      'both claim /take',
    );
    expect(() =>
      member(
        'c',
        "export const fetch = WorkloadComponent({ workload: 'other', path: '/c' })(() => {});",
      ),
    ).toThrow('must match');
    expect(() =>
      member(
        'd',
        "export const run = WorkloadService({ path: '/sync', subscriptions: [] })(() => {});",
      ),
    ).toThrow('nonempty');
  });

  it('requires paths on both kinds and rejects component/service path collisions', () => {
    for (const decorator of ['WorkloadComponent', 'WorkloadService']) {
      expect(() => member('missing', `export const run = ${decorator}({})(() => {});`)).toThrow(
        'must declare a path',
      );
      for (const path of ['relative', '//host', '/bad path', '/a?b']) {
        expect(() =>
          member(
            'invalid',
            `export const run = ${decorator}({ path: ${JSON.stringify(path)} })(() => {});`,
          ),
        ).toThrow('absolute path');
      }
    }
    const component = member(
      'component',
      "export const fetch = WorkloadComponent({ path: '/same' })(() => {});",
    );
    const service = member(
      'service',
      "export const run = WorkloadService({ path: '/same' })(async () => {});",
    );
    expect(() =>
      writeWorkloadManifest(component.projectRoot, 'warehouse', [component, service]),
    ).toThrow('both claim /same');
  });

  it('validates workload names before using them as manifest paths', () => {
    const root = makeProject({ name: 'bad', entry: 'src/app.ts', workload: '../outside' });
    expect(() => loadProject(root)).toThrow('DNS label');
  });

  it('builds service handler exports without importing a default HTTP entrypoint', async () => {
    const project = member(
      'sync',
      "export const onMessage = WorkloadService({ path: '/sync', subscriptions: ['warehouse.stock'] })(async () => {});",
    );
    const assets = makeAssets();
    cpSync(
      new URL('../assets/wit/deps/wasmcloud-messaging', import.meta.url),
      join(assets, 'wit/deps/wasmcloud-messaging'),
      { recursive: true },
    );
    const deps = fakeDeps({ cwd: project.projectRoot, assets });
    expect(requirementsForProject(project, deps)).toEqual([
      expect.objectContaining({
        package: 'wasmcloud:messaging',
        interfaces: ['handler'],
        direction: 'export',
      }),
    ]);
    await buildComponent(project, captureIo().io, deps);
    const adapter = readFileSync(
      join(project.projectRoot, '.di-framework/cron-adapter.js'),
      'utf8',
    );
    expect(adapter).toContain('onMessage as invoke');
    expect(adapter).toContain('handleMessage');
    expect(adapter).not.toContain('import application');
    expect(
      readFileSync(join(project.projectRoot, '.di-framework/wit/world.wit'), 'utf8'),
    ).not.toContain('wasi:http');
  });

  it('adapts a named HTTP component and enforces its route claim', async () => {
    const project = member(
      'take',
      "export const fetch = WorkloadComponent({ path: '/take' })(async () => new Response('ok'));",
    );
    await buildComponent(
      project,
      captureIo().io,
      fakeDeps({ cwd: project.projectRoot, assets: makeAssets() }),
    );
    const entry = readFileSync(
      join(project.projectRoot, '.di-framework/application-entry.js'),
      'utf8',
    );
    expect(entry).toContain('fetch as invoke');
    expect(entry).toContain('pathname !== "/take"');
    expect(entry).toContain('status: 404');
  });

  it('lets a root workload component serve the rest of its host', async () => {
    const project = member(
      'site',
      "export const fetch = WorkloadComponent({ path: '/' })(async () => new Response('ok'));",
    );
    await buildComponent(
      project,
      captureIo().io,
      fakeDeps({ cwd: project.projectRoot, assets: makeAssets() }),
    );
    const entry = readFileSync(
      join(project.projectRoot, '.di-framework/application-entry.js'),
      'utf8',
    );
    expect(entry).toContain('fetch as invoke');
    expect(entry).not.toContain('pathname !==');
  });

  it('merges messaging imports and exports into one host interface with subscriptions', () => {
    const entries = hostInterfacesFromRequirements(
      [
        {
          package: 'wasmcloud:messaging',
          version: '0.3.0',
          interfaces: ['consumer'],
          direction: 'import',
          source: 'Sync',
        },
        {
          package: 'wasmcloud:messaging',
          version: '0.3.0',
          interfaces: ['handler'],
          direction: 'export',
          source: 'workload-service',
        },
      ],
      { subscriptions: ['warehouse.stock'] },
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      interfaces: ['consumer', 'handler'],
      config: { subscriptions: 'warehouse.stock' },
    });
  });
});

it('discovers managed PostgreSQL imports for inferred workload members', () => {
  const project = member(
    'orders',
    "export const read = WorkloadComponent({ path: '/orders' })(() => {});",
  );
  writeFileSync(
    join(project.projectRoot, 'src/bindings.ts'),
    `import { Postgres, WasmCloudBinding } from '@di-framework/bindings';
@WasmCloudBinding('orders-db', { serviceName: 'orders' }) export class Orders extends Postgres {}`,
  );
  const catalog = join(project.projectRoot, 'catalog.json');
  writeFileSync(catalog, JSON.stringify(BINDING_CATALOG));
  const requirements = requirementsForProject(
    project,
    fakeDeps({
      cwd: project.projectRoot,
      resolutions: { '@di-framework/bindings/catalog.json': catalog },
    }),
  );
  expect(requirements.filter((r) => r.namedImport).map((r) => r.instanceName)).toEqual([
    'orders-db-query',
    'orders-db-prepared',
  ]);
});
