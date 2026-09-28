import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostInterfacesFromRequirements, renderHostInterfacesYaml } from '../src/host-interface';
import {
  aggregateRequirements,
  buildWitLock,
  defaultProjectRequirements,
  parsePackageId,
  queueProjectRequirements,
  renderWorldWit,
  sqliteProjectRequirements,
  type WitRequirement,
} from '../src/wit';

const namedStores: WitRequirement[] = [
  {
    package: 'wasi:keyvalue',
    version: '0.2.0-draft',
    interfaces: ['store'],
    direction: 'import',
    instanceName: 'cache',
    source: 'kv-cache',
  },
  {
    package: 'wasi:keyvalue',
    version: '0.2.0-draft',
    interfaces: ['store'],
    direction: 'import',
    instanceName: 'durable',
    source: 'kv-durable',
  },
];

const kvGroup: WitRequirement[] = [
  {
    package: 'wasi:keyvalue',
    version: '0.2.0-draft',
    interfaces: ['store'],
    direction: 'import',
    source: 'kv',
  },
  {
    package: 'wasi:keyvalue',
    version: '0.2.0-draft',
    interfaces: ['atomics', 'batch'],
    direction: 'import',
    source: 'kv',
  },
];

describe('WIT requirement registry', () => {
  it('adds sqlite imports for queue workers and actor storage helpers', () => {
    const queueReqs = queueProjectRequirements();
    expect(queueReqs.some((req) => req.package === 'di-framework:sqlite')).toBe(true);
    expect(sqliteProjectRequirements()).toEqual(
      queueReqs.filter((req) => req.package === 'di-framework:sqlite'),
    );
  });

  it('keeps HTTP package version independent of the component-model preview', () => {
    const [http] = defaultProjectRequirements();
    expect(http?.package).toBe('wasi:http');
    expect(http?.version).toBe('0.3.0');
    expect(http?.interfaces).toEqual(['handler']);
  });

  it('renders the default HTTP export world from requirements', () => {
    expect(renderWorldWit('demo-app', '1.2.3', defaultProjectRequirements())).toBe(
      'package local:demo-app@1.2.3;\n\nworld application {\n  export wasi:http/handler@0.3.0;\n}\n',
    );
  });

  it('keeps named hostInterfaces while the guest world stays unlabeled', () => {
    const world = renderWorldWit('demo-app', '1.0.0', namedStores);
    expect(world).toContain('import wasi:keyvalue/store@0.2.0-draft;');
    expect(world).not.toContain('import cache:');
    expect(world).not.toContain('import durable:');
    expect(world.match(/import wasi:keyvalue\/store@0\.2\.0-draft;/g)).toHaveLength(1);
    const hosts = hostInterfacesFromRequirements(namedStores);
    expect(hosts.map((entry) => entry.name)).toEqual(['cache', 'durable']);
    expect(hosts.every((entry) => entry.version === '0.2.0-draft')).toBe(true);
  });

  it('merges interface groups that share package, version, and instance', () => {
    const [group] = aggregateRequirements(kvGroup);
    expect(group?.interfaces).toEqual(['store', 'atomics', 'batch']);
    expect(group?.sources).toEqual(['kv']);
    const yaml = renderHostInterfacesYaml(hostInterfacesFromRequirements(kvGroup));
    expect(yaml).toContain('- store');
    expect(yaml).toContain('- atomics');
    expect(yaml).toContain('- batch');
    expect(yaml.match(/package: keyvalue/g)).toHaveLength(1);
  });

  it('does not assume WASI 0.3 for non-HTTP packages', () => {
    const mixed: WitRequirement[] = [
      ...defaultProjectRequirements(),
      {
        package: 'wasmcloud:messaging',
        version: '0.2.0',
        interfaces: ['consumer'],
        direction: 'import',
        source: 'messaging',
      },
    ];
    const world = renderWorldWit('demo-app', '1.0.0', mixed);
    expect(world).toContain('export wasi:http/handler@0.3.0;');
    expect(world).toContain('import wasmcloud:messaging/consumer@0.2.0;');
    expect(world).not.toContain('wasmcloud:messaging/consumer@0.3.0');
  });

  it('records vendored package digests in the WIT lock', () => {
    const root = mkdtempSync(join(tmpdir(), 'wit-lock-'));
    mkdirSync(join(root, 'wasi-http'), { recursive: true });
    writeFileSync(join(root, 'wasi-http', 'package.wit'), 'package wasi:http@0.3.0;\n');
    const lock = buildWitLock(defaultProjectRequirements(), root);
    expect(lock.componentModel).toBe('0.3');
    expect(lock.packages).toEqual([
      expect.objectContaining({
        id: 'wasi:http',
        version: '0.3.0',
        source: 'bundled',
        path: 'wit/deps/wasi-http/package.wit',
        digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
  });

  it('skips empty interface groups and unlabeled named imports with several interfaces', () => {
    expect(
      aggregateRequirements([
        {
          package: 'wasi:http',
          version: '0.3.0',
          interfaces: [],
          direction: 'export',
          source: 'empty',
        },
      ]),
    ).toEqual([]);
    const world = renderWorldWit('demo-app', '1.0.0', [
      {
        package: 'wasi:keyvalue',
        version: '0.2.0-draft',
        interfaces: ['store', 'atomics'],
        direction: 'import',
        instanceName: 'cache',
        source: 'kv',
      },
    ]);
    expect(world).toContain('import wasi:keyvalue/store@0.2.0-draft;');
    expect(world).toContain('import wasi:keyvalue/atomics@0.2.0-draft;');
    expect(world).not.toContain('import cache:');
  });

  it('merges duplicate sources and interfaces across requirement groups', () => {
    const store = kvGroup[0] ?? {
      package: 'wasi:keyvalue',
      version: '0.2.0-draft',
      interfaces: ['store'],
      direction: 'import' as const,
      source: 'kv',
    };
    const [group] = aggregateRequirements([
      store,
      store,
      {
        package: 'wasi:keyvalue',
        version: '0.2.0-draft',
        interfaces: ['store', 'watch'],
        direction: 'import',
        source: 'kv-extra',
      },
    ]);
    expect(group?.interfaces).toEqual(['store', 'watch']);
    expect(group?.sources).toEqual(['kv', 'kv-extra']);
  });

  it('rejects invalid WIT package ids', () => {
    expect(() => parsePackageId('http')).toThrow('Invalid WIT package id "http"');
    expect(() => parsePackageId(':http')).toThrow('Invalid WIT package id ":http"');
    expect(() => parsePackageId('wasi:')).toThrow('Invalid WIT package id "wasi:"');
  });

  it('skips unreadable and unversioned WIT packages when locking', () => {
    const root = mkdtempSync(join(tmpdir(), 'wit-lock-skip-'));
    writeFileSync(join(root, 'notes.txt'), 'not a package directory\n');
    mkdirSync(join(root, 'missing-wit'));
    mkdirSync(join(root, 'unversioned'));
    writeFileSync(join(root, 'unversioned', 'package.wit'), 'package wasi:http;\n');
    mkdirSync(join(root, 'wasi-http'));
    writeFileSync(join(root, 'wasi-http', 'package.wit'), 'package wasi:http@0.3.0;\n');
    const lock = buildWitLock(defaultProjectRequirements(), root);
    expect(lock.packages.map((entry) => entry.id)).toEqual(['wasi:http']);
  });

  it('dedupes unlabeled imports when two named instances share a package', () => {
    const world = renderWorldWit('orders', '1.0.0', [
      {
        package: 'wasmcloud:keyvalue',
        version: '0.2.0',
        interfaces: ['store', 'atomics', 'types'],
        direction: 'import',
        instanceName: 'sessions',
        source: 'Sessions',
      },
      {
        package: 'wasmcloud:keyvalue',
        version: '0.2.0',
        interfaces: ['store', 'atomics', 'types'],
        direction: 'import',
        instanceName: 'cache',
        source: 'Cache',
      },
    ]);
    expect(world).toContain('import wasmcloud:keyvalue/store@0.2.0;');
    expect(world).not.toContain('import sessions:');
    expect(world).not.toContain('import cache:');
    expect(world.match(/import wasmcloud:keyvalue\/store@0\.2\.0;/g)).toHaveLength(1);
    expect(world.match(/import wasmcloud:keyvalue\/atomics@0\.2\.0;/g)).toHaveLength(1);
  });

  it('renders named host interface YAML entries', () => {
    const yaml = renderHostInterfacesYaml(hostInterfacesFromRequirements(namedStores));
    expect(yaml).toContain('- name: "cache"');
    expect(yaml).toContain('- name: "durable"');
    expect(yaml).toContain('namespace: wasi');
    expect(renderHostInterfacesYaml([])).toBe('');
  });
});
