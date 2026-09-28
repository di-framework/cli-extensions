import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BindingRecord } from '../src/bindings';
import type { HostInterface } from '../src/host-interface';
import { loadProject } from '../src/project';
import { renderWashDevYaml, writeWashDevConfig } from '../src/wash-dev';
import type { WitRequirement } from '../src/wit';
import { makeProject } from './helpers';

const http: HostInterface = {
  namespace: 'wasi',
  package: 'http',
  version: '0.3.0',
  interfaces: ['handler'],
  config: { host: '127.0.0.1' },
};

const postgres: HostInterface = {
  name: 'user-database',
  namespace: 'wasmcloud',
  package: 'postgres',
  version: '0.2.0',
  interfaces: ['query', 'prepared', 'types'],
  secretFrom: [{ name: 'orders-user-database' }],
};

describe('wash 2.5.2 dev config', () => {
  it('writes address, component path, and host interfaces without a secrets URL', () => {
    const yaml = renderWashDevYaml([http, postgres], {
      componentPath: 'dist/orders.wasm',
      host: '127.0.0.1',
      port: '8000',
    });
    expect(yaml).toContain('command: "true"');
    expect(yaml).toContain('component_path: "dist/orders.wasm"');
    expect(yaml).toContain('address: "127.0.0.1:8000"');
    expect(yaml).toContain('component-model-async');
    expect(yaml).toContain('name: "user-database"');
    expect(yaml).toContain('package: postgres');
    expect(yaml).not.toContain('postgres_url');
    expect(yaml).not.toContain('password');
  });

  it('renders configFrom names on host interfaces', () => {
    const yaml = renderWashDevYaml(
      [
        {
          name: 'sessions',
          namespace: 'wasi',
          package: 'keyvalue',
          version: '0.3.0',
          interfaces: ['store'],
          configFrom: [{ name: 'kv-config' }],
        },
      ],
      {
        componentPath: 'dist/app.wasm',
        host: '127.0.0.1',
        port: '8000',
      },
    );
    expect(yaml).toContain('configFrom:');
    expect(yaml).toContain('name: "kv-config"');
  });

  it('includes postgres_url only when provided by the environment', () => {
    const yaml = renderWashDevYaml([], {
      componentPath: 'dist/app.wasm',
      host: '0.0.0.0',
      port: '9',
      postgresUrl: 'postgres://localhost/app',
    });
    expect(yaml).toContain('postgres_url: "postgres://localhost/app"');
  });

  it('writes the generated config under .di-framework', () => {
    const root = makeProject();
    const requirements: WitRequirement[] = [
      {
        package: 'wasi:http',
        version: '0.3.0',
        interfaces: ['handler'],
        direction: 'export',
        source: 'http-adapter',
      },
    ];
    const path = writeWashDevConfig(loadProject(root), requirements, [], {
      host: '127.0.0.1',
      port: '8123',
    });
    expect(path).toBe(join(root, '.di-framework', 'wash-dev.yaml'));
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toContain('address: "127.0.0.1:8123"');
  });

  it('overlays binding config, configFrom, and secretFrom onto named host interfaces', () => {
    const root = makeProject();
    const requirement: WitRequirement = {
      package: 'wasi:keyvalue',
      version: '0.3.0',
      interfaces: ['store'],
      direction: 'import',
      source: 'binding',
      instanceName: 'sessions',
    };
    const bindings: BindingRecord[] = [
      {
        className: 'Sessions',
        name: 'sessions',
        kind: 'KeyValue',
        requirement,
        config: { bucket: 'sess' },
        configFrom: 'kv-config',
        secretFrom: 'kv-secret',
      },
    ];
    const path = writeWashDevConfig(loadProject(root), [requirement], bindings, {
      host: '127.0.0.1',
      port: '8000',
    });
    const yaml = readFileSync(path, 'utf8');
    expect(yaml).toContain('name: "sessions"');
    expect(yaml).toContain('"bucket": "sess"');
    expect(yaml).toContain('name: "kv-config"');
    expect(yaml).toContain('name: "kv-secret"');
  });
});
