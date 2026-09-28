import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BINDING_CATALOG } from '@di-framework/bindings';
import { parseBindingsFile, requirementsFromBindings } from '../src/bindings';
import { buildComponent } from '../src/build';
import { nodeCompatibilityPlugin } from '../src/deps';
import { renderGuestsModule } from '../src/guests';
import { hostInterfacesFromRequirements } from '../src/host-interface';
import {
  ASSOCIATION_WORKLOAD_LABEL,
  applyManagedBindings,
  associationName,
  cleanupManagedBindings,
} from '../src/managed-bindings';
import { loadProject } from '../src/project';
import { renderWorldWit } from '../src/wit';
import { captureIo, fakeDeps, makeAssets, makeProject } from './helpers';

const source = `import { Postgres, WasmCloudBinding } from '@di-framework/bindings';
@WasmCloudBinding('orders-db', { serviceName: 'orders' }) export class Orders extends Postgres {}
@WasmCloudBinding('audit-db', { serviceName: 'audit' }) export class Audit extends Postgres {}`;
function setup(text = source) {
  const root = makeProject({ name: 'test-app', entry: 'src/app.ts' });
  const path = join(root, 'src/bindings.ts');
  writeFileSync(path, text);
  const bindings = parseBindingsFile(path, BINDING_CATALOG, 'test-app');
  const project = loadProject(root);
  return { root, path, project, bindings };
}
const connection = {
  target: 'test',
  namespace: 'di-tenant-alpha',
  kubeconfig: '/tmp/test',
  registry: { push: 'http://registry', pull: 'registry', insecure: true },
} as any;

test('two managed PostgreSQL bindings generate independent imports, host entries and JS registry entries', () => {
  const { bindings } = setup();
  const requirements = requirementsFromBindings(bindings);
  const wit = renderWorldWit('test', '1.0.0', requirements);
  for (const name of ['orders-db', 'audit-db'])
    for (const iface of ['query', 'prepared'])
      expect(wit).toContain(`import ${name}-${iface}: wasmcloud:postgres/${iface}@0.2.0;`);
  expect(wit.match(/import wasmcloud:postgres\/types/g)).toHaveLength(1);
  const hosts = hostInterfacesFromRequirements(requirements, {}, bindings);
  expect(hosts).toHaveLength(4);
  expect(hosts.find((h) => h.name === 'orders-db-query')?.secretFrom).toEqual([
    { name: 'di-binding-orders-db-creds' },
  ]);
  expect(hosts.find((h) => h.name === 'audit-db-prepared')?.secretFrom).toEqual([
    { name: 'di-binding-audit-db-creds' },
  ]);
  expect(hosts.find((h) => h.interfaces.includes('types'))?.secretFrom).toBeUndefined();
  expect(renderGuestsModule(bindings)).toContain('from "orders-db-query"');
  expect(renderGuestsModule(bindings)).toContain('from "audit-db-prepared"');
  const plugin = nodeCompatibilityPlugin('/app', '/guests');
  expect(plugin.resolveId('orders-db-query', '/guests')).toEqual({
    id: 'orders-db-query',
    external: true,
  });
  expect(plugin.resolveId('orders-db-query', '/app')).toBeNull();
});

test('rejects invalid managed selections and retains existing manual PostgreSQL behavior', () => {
  for (const options of [
    "serviceName: 'bad/name'",
    'serviceName: []',
    "serviceName: 'orders', secretFrom: 'secret'",
    "serviceName: 'orders', configFrom: 'config'",
    "serviceName: 'orders', config: {}",
    "serviceName: 'orders', configFrom: []",
    "serviceName: 'orders', secretFrom: 42",
  ])
    expect(() => setup(source.replace("serviceName: 'orders'", options))).toThrow();
  expect(() => setup(source.replaceAll('Postgres', 'KeyValue'))).toThrow('requires Postgres');
  expect(() => setup(source.replace('orders-db', 'a'.repeat(55)))).toThrow('54');
  const { bindings } = setup(
    source
      .replaceAll(", { serviceName: 'orders' }", '')
      .replaceAll(", { serviceName: 'audit' }", ''),
  );
  expect(requirementsFromBindings(bindings).some((r) => r.namedImport)).toBe(false);
  expect(renderGuestsModule(bindings)).toContain('from "wasmcloud:postgres/query@0.2.0"');
});

function harness(
  overrides: { service?: object; peers?: any[]; ready?: boolean; error?: boolean } = {},
) {
  const setupValue = setup();
  const calls: string[][] = [];
  let waits = 0;
  const deps = fakeDeps({ cwd: setupValue.root });
  deps.wait = async () => {
    waits++;
  };
  deps.runner = async (_cmd, args) => {
    calls.push([...args]);
    return { exitCode: 0 };
  };
  deps.runCaptured = async (_cmd, args) => {
    calls.push([...args]);
    if (overrides.error) return { exitCode: 1, stdout: '', stderr: 'denied' };
    let result: unknown;
    if (args.includes('backingservices.platform.di-framework.dev'))
      result = overrides.service ?? {
        metadata: { uid: 'service-uid' },
        spec: { type: 'postgres' },
      };
    else if (args.includes('-l') || args[args.indexOf('get') + 2] === '-o')
      result = { items: overrides.peers ?? [] };
    else {
      const name = args[args.indexOf('get') + 2];
      const binding = setupValue.bindings.find(
        (b) => associationName(setupValue.project.witName, b.name) === name,
      )!;
      result = {
        metadata: { name, generation: 2 },
        spec: { serviceName: binding.serviceName },
        status: {
          observedGeneration: overrides.ready === false ? 1 : 2,
          serviceRef: { uid: 'service-uid' },
          conditions: [{ type: 'Ready', status: 'True' }],
        },
      };
    }
    return { exitCode: 0, stdout: JSON.stringify(result), stderr: '' };
  };
  return { ...setupValue, deps, calls, waits: () => waits };
}

test('validates references, applies deterministic workload associations and waits for current readiness', async () => {
  const h = harness();
  const desired = await applyManagedBindings(h.project, connection, h.bindings, h.deps);
  expect(desired.size).toBe(2);
  expect(associationName('test-app', 'orders-db')).not.toBe(
    associationName('other-app', 'orders-db'),
  );
  const manifest = JSON.parse(
    readFileSync(join(h.root, '.di-framework/deploy/service-bindings.json'), 'utf8'),
  );
  expect(manifest.items[0].spec).toEqual({
    serviceName: 'orders',
    bindingName: 'orders-db',
    capability: 'postgres',
    workloadName: 'test-app',
  });
  expect(h.calls.findIndex((args) => args.includes('apply'))).toBeGreaterThan(
    h.calls.findIndex((args) => args.includes('audit')),
  );
  const pending = harness({ ready: false });
  await expect(
    applyManagedBindings(pending.project, connection, pending.bindings, pending.deps),
  ).rejects.toThrow('did not become ready');
  expect(pending.waits()).toBe(90);
});

test('rejects deleting or incompatible services, conflicts and unowned associations before apply', async () => {
  const scenarios = [
    { service: { metadata: { uid: 'x', deletionTimestamp: 'now' }, spec: { type: 'postgres' } } },
    { service: { metadata: { uid: 'x' }, spec: { type: 'messaging' } } },
    {
      peers: [
        {
          metadata: { name: 'other' },
          spec: { bindingName: 'orders-db', serviceName: 'different', capability: 'postgres' },
        },
      ],
    },
    {
      peers: [
        {
          metadata: { name: associationName('test-app', 'orders-db') },
          spec: { bindingName: 'orders-db', serviceName: 'orders' },
        },
      ],
    },
    { error: true },
  ];
  for (const scenario of scenarios) {
    const h = harness(scenario);
    await expect(applyManagedBindings(h.project, connection, h.bindings, h.deps)).rejects.toThrow();
    expect(h.calls.some((args) => args.includes('apply'))).toBe(false);
  }
});

test('cleanup removes only obsolete associations owned by the deploying workload', async () => {
  const owned = (name: string, workload = 'test-app') => ({
    metadata: {
      name,
      labels: {
        [ASSOCIATION_WORKLOAD_LABEL]: workload,
        'app.kubernetes.io/managed-by': 'di-framework',
      },
    },
    spec: {},
  });
  const h = harness({ peers: [owned('old'), owned('keep'), owned('shared', 'another')] });
  await cleanupManagedBindings(h.project, connection, new Set(['keep']), h.deps);
  expect(
    h.calls
      .filter((args) => args.includes('delete'))
      .map((args) => args[args.indexOf('delete') + 2]),
  ).toEqual(['old']);
  expect(await applyManagedBindings(h.project, connection, [], h.deps)).toEqual(new Set());
});

test('handles missing services, terminating associations and cleanup API failures', async () => {
  const missing = harness();
  const original = missing.deps.runCaptured;
  missing.deps.runCaptured = async (cmd, args, opts) =>
    args.includes('backingservices.platform.di-framework.dev')
      ? { exitCode: 1, stdout: '', stderr: 'missing' }
      : original(cmd, args, opts);
  await expect(
    applyManagedBindings(missing.project, connection, missing.bindings, missing.deps),
  ).rejects.toThrow('unavailable');
  const peer = {
    metadata: {
      name: associationName('test-app', 'orders-db'),
      labels: {
        [ASSOCIATION_WORKLOAD_LABEL]: 'test-app',
        'app.kubernetes.io/managed-by': 'di-framework',
      },
    },
    spec: { bindingName: 'orders-db', serviceName: 'orders', capability: 'postgres' },
  };
  const own = harness({ peers: [peer] });
  await applyManagedBindings(own.project, connection, own.bindings, own.deps);
  const terminating = harness({
    peers: [{ ...peer, metadata: { ...peer.metadata, deletionTimestamp: 'now' } }],
  });
  await expect(
    applyManagedBindings(terminating.project, connection, terminating.bindings, terminating.deps),
  ).rejects.toThrow('still deleting');
  const cleanup = harness({ error: true });
  await expect(
    cleanupManagedBindings(cleanup.project, connection, new Set(), cleanup.deps),
  ).rejects.toThrow('Cannot list');
  cleanup.deps.runCaptured = async () => ({
    exitCode: 1,
    stdout: '',
    stderr: "the server doesn't have a resource type servicebindings",
  });
  await cleanupManagedBindings(cleanup.project, connection, new Set(), cleanup.deps);
});

test('managed PostgreSQL composition explains when the required compiler is missing', async () => {
  const { root, project } = setup();
  const assets = makeAssets();
  mkdirSync(join(assets, 'sqlite'), { recursive: true });
  writeFileSync(join(assets, 'sqlite', 'di-framework-sqlite.wasm'), 'provider');
  writeFileSync(join(root, 'catalog.json'), JSON.stringify(BINDING_CATALOG));
  await expect(
    buildComponent(
      project,
      captureIo().io,
      fakeDeps({
        cwd: root,
        assets,
        resolutions: { '@di-framework/bindings/catalog.json': join(root, 'catalog.json') },
        bundleContents: 'import "di-framework:sqlite/database@0.1.0";',
      }),
    ),
  ).rejects.toMatchObject({ code: 'WASMCLOUD_COMPILER_REQUIRED' });
});
