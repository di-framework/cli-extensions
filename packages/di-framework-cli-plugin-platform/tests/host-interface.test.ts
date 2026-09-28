import { describe, expect, it } from 'bun:test';
import { hostInterfacesFromRequirements, renderHostInterfacesYaml } from '../src/host-interface';
import { renderWorldWit, type WitRequirement } from '../src/wit';

const postgres: WitRequirement = {
  package: 'wasmcloud:postgres',
  version: '0.2.0',
  interfaces: ['query', 'prepared', 'types'],
  direction: 'import',
  instanceName: 'user-database',
  source: 'UserDatabase',
};

describe('host interface overlays', () => {
  it('preserves names for other named host bindings', () => {
    const [entry] = hostInterfacesFromRequirements([
      {
        ...postgres,
        package: 'wasi:keyvalue',
        version: '0.3.0',
        interfaces: ['store'],
        instanceName: 'sessions',
      },
    ]);
    expect(entry?.name).toBe('sessions');
  });
  it('keeps PostgreSQL overlays while matching its unlabeled guest import', () => {
    const [entry] = hostInterfacesFromRequirements([postgres], {}, [
      {
        name: 'user-database',
        className: 'UserDatabase',
        secretFrom: 'orders-user-database',
        configFrom: 'orders-user-database-config',
        config: { database: 'orders' },
      },
    ]);
    expect(entry?.name).toBeUndefined();
    expect(entry?.secretFrom).toEqual([{ name: 'orders-user-database' }]);
    expect(entry?.configFrom).toEqual([{ name: 'orders-user-database-config' }]);
    expect(entry?.config).toEqual({ database: 'orders' });
    const yaml = renderHostInterfacesYaml(entry === undefined ? [] : [entry]);
    expect(yaml).not.toContain('name: "user-database"');
    expect(yaml).toContain('secretFrom:');
    expect(yaml).toContain('configFrom:');
    expect(yaml).toContain('"database": "orders"');
  });
});

const http: WitRequirement = {
  package: 'wasi:http',
  version: '0.3.0',
  interfaces: ['handler'],
  direction: 'export',
  source: 'http-adapter',
};
const client: WitRequirement = {
  ...http,
  interfaces: ['client'],
  direction: 'import',
  source: 'HttpClient',
};

describe('provider discovery', () => {
  it.each(['keyvalue', 'blobstore', 'messaging', 'secrets'])(
    'keeps overlays on an unlabeled wasmcloud:%s host interface',
    (name) => {
      const [entry] = hostInterfacesFromRequirements(
        [{ ...postgres, package: `wasmcloud:${name}` }],
        {},
        [{ name: 'user-database', className: 'UserDatabase', secretFrom: 'provider-secret' }],
      );
      expect(entry?.name).toBeUndefined();
      expect(entry?.secretFrom).toEqual([{ name: 'provider-secret' }]);
    },
  );

  it('keeps key-value types in WIT but excludes them from host discovery', () => {
    const requirement: WitRequirement = {
      package: 'wasmcloud:keyvalue',
      version: '0.2.0',
      interfaces: ['store', 'atomics', 'cas', 'batch', 'types'],
      direction: 'import',
      instanceName: 'cache',
      source: 'Cache',
    };
    const [entry] = hostInterfacesFromRequirements([requirement], {}, [
      { name: 'cache', className: 'Cache', configFrom: 'redis-config' },
    ]);
    expect(entry?.interfaces).toEqual(['store', 'atomics', 'cas', 'batch']);
    expect(entry?.configFrom).toEqual([{ name: 'redis-config' }]);
    expect(renderWorldWit('example', '1.0.0', [requirement])).toContain(
      'import wasmcloud:keyvalue/types@0.2.0;',
    );
    expect(requirement.interfaces).toContain('types');
    expect(hostInterfacesFromRequirements([{ ...requirement, interfaces: ['types'] }])).toEqual([]);
  });

  it('finds unnamed binding overlays by any contributing source class', () => {
    const config: WitRequirement = {
      package: 'wasi:config',
      version: '0.2.0-rc.1',
      interfaces: ['store'],
      direction: 'import',
      source: 'config-adapter',
    };
    const [entry] = hostInterfacesFromRequirements(
      [config, { ...config, source: 'AppConfig' }],
      {},
      [
        { name: 'unrelated', className: 'Unrelated', config: { ignored: 'true' } },
        {
          name: 'app-config',
          className: 'AppConfig',
          config: { message: 'inline' },
          configFrom: 'binding-config',
          secretFrom: 'binding-secret',
        },
      ],
    );
    expect(entry).toEqual({
      namespace: 'wasi',
      package: 'config',
      version: '0.2.0-rc.1',
      interfaces: ['store'],
      config: { message: 'inline' },
      configFrom: [{ name: 'binding-config' }],
      secretFrom: [{ name: 'binding-secret' }],
    });
  });
});

describe('HTTP host discovery', () => {
  it.each([false, true])(
    'combines ingress and client overlays (client first: %s)',
    (clientFirst) => {
      const requirements = clientFirst ? [client, http] : [http, client];
      const overlays = [
        { name: 'http-client', className: 'HttpClient', configFrom: 'outgoing-policy' },
      ];
      const entries = hostInterfacesFromRequirements(
        requirements,
        { httpHost: 'outgoing-http' },
        overlays,
      );
      expect(entries).toEqual([
        {
          namespace: 'wasi',
          package: 'http',
          version: '0.3.0',
          interfaces: ['handler'],
          config: { host: 'outgoing-http' },
          configFrom: [{ name: 'outgoing-policy' }],
        },
      ]);
      const yaml = renderHostInterfacesYaml(entries);
      expect(yaml.match(/package: http/g)).toHaveLength(1);
      expect(yaml).not.toContain('- client');
      expect(yaml).toContain('name: "outgoing-policy"');
      expect(renderWorldWit('example', '1.0.0', requirements)).toContain(
        'import wasi:http/client@0.3.0;',
      );
      expect(client.interfaces).toEqual(['client']);
      expect(overlays[0]?.configFrom).toBe('outgoing-policy');
    },
  );

  it('merges configuration and references from both directions in requirement order', () => {
    const [entry] = hostInterfacesFromRequirements(
      [http, { ...client, interfaces: ['client', 'handler'] }],
      { httpHost: 'default' },
      [
        {
          name: 'ingress',
          className: 'http-adapter',
          config: { host: 'ingress', keep: 'yes' },
          configFrom: 'ingress-config',
          secretFrom: 'ingress-secret',
        },
        {
          name: 'outgoing',
          className: 'HttpClient',
          config: { host: 'override' },
          configFrom: 'outgoing-config',
          secretFrom: 'outgoing-secret',
        },
      ],
    );
    expect(entry?.interfaces).toEqual(['handler']);
    expect(entry?.config).toEqual({ host: 'override', keep: 'yes' });
    expect(entry?.configFrom).toEqual([{ name: 'ingress-config' }, { name: 'outgoing-config' }]);
    expect(entry?.secretFrom).toEqual([{ name: 'ingress-secret' }, { name: 'outgoing-secret' }]);
  });

  it('adds client secret references when ingress has none', () => {
    const [entry] = hostInterfacesFromRequirements([http, client], {}, [
      { name: 'outgoing', className: 'HttpClient', secretFrom: 'outgoing-secret' },
    ]);
    expect(entry?.secretFrom).toEqual([{ name: 'outgoing-secret' }]);
    expect(entry?.config).toBeUndefined();
    expect(entry?.configFrom).toBeUndefined();
  });

  it('keeps named bindings, versions, and other packages separate', () => {
    const requirements: WitRequirement[] = [
      { ...http, instanceName: 'named' },
      { ...http, version: '0.2.0' },
      { ...http, package: 'other:http' },
      { ...http, package: 'wasi:custom' },
      http,
      client,
      { ...http, instanceName: 'second' },
    ];
    const entries = hostInterfacesFromRequirements(requirements);
    expect(entries).toHaveLength(6);
    expect(
      entries.map((entry) => [entry.namespace, entry.package, entry.version, entry.name]),
    ).toEqual([
      ['wasi', 'http', '0.3.0', 'named'],
      ['wasi', 'http', '0.2.0', undefined],
      ['other', 'http', '0.3.0', undefined],
      ['wasi', 'custom', '0.3.0', undefined],
      ['wasi', 'http', '0.3.0', undefined],
      ['wasi', 'http', '0.3.0', 'second'],
    ]);
  });

  it('omits a standalone core-linked client from host discovery', () => {
    expect(hostInterfacesFromRequirements([client])).toEqual([]);
    expect(renderHostInterfacesYaml(hostInterfacesFromRequirements([client]))).toBe('');
  });
});
