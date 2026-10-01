import { describe, expect, it } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BINDING_CATALOG } from '@di-framework/bindings';
import {
  bindingsPath,
  defaultSecretName,
  discoverBindings,
  parseBindingsFile,
} from '../src/bindings';
import { loadProject } from '../src/project';
import { expectFailure, fakeDeps, makeProject } from './helpers';

const CATALOG = BINDING_CATALOG as unknown as Parameters<typeof parseBindingsFile>[1];

function writeBindings(root: string, source: string, file = 'src/bindings.ts'): string {
  const path = join(root, file);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, source);
  return path;
}

describe('parseBindingsFile', () => {
  it('discovers named postgres and two key-value classes', () => {
    const root = makeProject();
    const path = writeBindings(
      root,
      `import { KeyValue, Postgres, WasmCloudBinding } from '@di-framework/bindings';

@WasmCloudBinding('user-database')
export class UserDatabase extends Postgres {}

@WasmCloudBinding('sessions', { interfaces: ['store', 'atomics'] })
export class Sessions extends KeyValue {}

@WasmCloudBinding('cache')
export class Cache extends KeyValue {}
`,
    );
    const records = parseBindingsFile(path, CATALOG, 'orders');
    expect(records.map((record) => record.name)).toEqual(['user-database', 'sessions', 'cache']);
    expect(records[0]).toMatchObject({
      className: 'UserDatabase',
      kind: 'Postgres',
      secretFrom: 'orders-user-database',
      requirement: {
        package: 'wasmcloud:postgres',
        version: '0.2.0',
        interfaces: ['query', 'prepared', 'types'],
        instanceName: 'user-database',
      },
    });
    expect(records[1]?.requirement.interfaces).toEqual(['store', 'atomics']);
    expect(records[2]?.requirement.instanceName).toBe('cache');
  });

  it('selects a created blobstore through configFrom without a secret', () => {
    const root = makeProject();
    const path = writeBindings(
      root,
      `import { Blobstore, WasmCloudBinding } from '@di-framework/bindings';

@WasmCloudBinding('objects', { configFrom: 'di-binding-objects' })
export class MeshObjects extends Blobstore {}
`,
    );
    const [record] = parseBindingsFile(path, CATALOG, 'mesh');
    expect(record).toMatchObject({
      className: 'MeshObjects',
      kind: 'Blobstore',
      configFrom: 'di-binding-objects',
      requirement: {
        package: 'wasmcloud:blobstore',
        version: '0.1.0',
        interfaces: ['blobstore', 'container', 'types'],
      },
    });
    expect(record?.secretFrom).toBeUndefined();
    expect(record?.serviceName).toBeUndefined();
  });

  it('rejects plaintext secret values in decorator config', () => {
    const root = makeProject();
    expectFailure(
      () =>
        parseBindingsFile(
          writeBindings(
            root,
            `import { Postgres, WasmCloudBinding } from '@di-framework/bindings';
@WasmCloudBinding('users', { config: { password: 'hunter2' } })
export class Users extends Postgres {}
`,
          ),
          CATALOG,
          'app',
        ),
      'WASMCLOUD_BINDING_PLAINTEXT_SECRET',
      2,
    );
    expectFailure(
      () =>
        parseBindingsFile(
          writeBindings(
            root,
            `import { Postgres, WasmCloudBinding } from '@di-framework/bindings';
@WasmCloudBinding('users', { config: { note: 'postgres://localhost/app' } })
export class Users extends Postgres {}
`,
          ),
          CATALOG,
          'app',
        ),
      'WASMCLOUD_BINDING_PLAINTEXT_SECRET',
      2,
    );
  });

  it('resolves aliased imports, property-access decorators, and nested config', () => {
    const root = makeProject();
    const path = writeBindings(
      root,
      `import { KeyValue as Kv, WasmCloudBinding as Bind } from '@di-framework/bindings';
@Bind('cache', { config: { backend: 'in-memory' } })
export class Cache extends Kv {}
`,
    );
    const records = parseBindingsFile(path, CATALOG, 'app');
    expect(records).toEqual([
      expect.objectContaining({
        name: 'cache',
        kind: 'KeyValue',
        config: { backend: 'in-memory' },
      }),
    ]);
  });

  it('ignores computed decorator callees', () => {
    const root = makeProject();
    expectFailure(
      () =>
        parseBindingsFile(
          writeBindings(
            root,
            `import { Postgres, WasmCloudBinding } from '@di-framework/bindings';
@obj['WasmCloudBinding']('users')
export class Users extends Postgres {}
`,
          ),
          CATALOG,
          'app',
        ),
      'WASMCLOUD_BINDING_INVALID_NAME',
      2,
    );
  });

  it('accepts template-literal binding names', () => {
    const root = makeProject();
    const path = writeBindings(
      root,
      "import { Postgres, WasmCloudBinding } from '@di-framework/bindings';\n@WasmCloudBinding(`users`)\nexport class Users extends Postgres {}\n",
    );
    expect(parseBindingsFile(path, CATALOG, 'app')[0]?.name).toBe('users');
  });

  it('accepts namespaced decorator calls', () => {
    const root = makeProject();
    const path = writeBindings(
      root,
      `import { Postgres } from '@di-framework/bindings';
@lib.WasmCloudBinding('users')
export class Users extends Postgres {}
`,
    );
    expect(parseBindingsFile(path, CATALOG, 'app')[0]?.name).toBe('users');
  });

  it('skips classes that do not extend a binding', () => {
    const root = makeProject();
    const path = writeBindings(root, 'export class Service {}\n');
    expect(parseBindingsFile(path, CATALOG, 'app')).toEqual([]);
  });

  it('rejects an empty interface list and a missing catalog entry', () => {
    const root = makeProject();
    expectFailure(
      () =>
        parseBindingsFile(
          writeBindings(
            root,
            `import { Postgres, WasmCloudBinding } from '@di-framework/bindings';
@WasmCloudBinding('users', { interfaces: [] })
export class Users extends Postgres {}
`,
          ),
          CATALOG,
          'app',
        ),
      'WASMCLOUD_BINDING_UNSUPPORTED_INTERFACE',
      2,
    );
    expectFailure(
      () =>
        parseBindingsFile(
          writeBindings(
            root,
            `import { Postgres, WasmCloudBinding } from '@di-framework/bindings';
@WasmCloudBinding('users')
export class Users extends Postgres {}
`,
          ),
          {},
          'app',
        ),
      'WASMCLOUD_BINDING_UNKNOWN_TYPE',
      2,
    );
  });

  it('ignores non-exported classes', () => {
    const root = makeProject();
    const path = writeBindings(
      root,
      `import { Postgres, WasmCloudBinding } from '@di-framework/bindings';
@WasmCloudBinding('hidden')
class Hidden extends Postgres {}
`,
    );
    expect(parseBindingsFile(path, CATALOG, 'app')).toEqual([]);
  });

  it('rejects duplicate names, unknown bases, non-literal names, and bad interfaces', () => {
    const root = makeProject();
    expectFailure(
      () =>
        parseBindingsFile(
          writeBindings(
            root,
            `import { Postgres, WasmCloudBinding } from '@di-framework/bindings';
@WasmCloudBinding('users')
export class A extends Postgres {}
@WasmCloudBinding('users')
export class B extends Postgres {}
`,
          ),
          CATALOG,
          'app',
        ),
      'WASMCLOUD_BINDING_DUPLICATE_NAME',
      2,
    );
    expectFailure(
      () =>
        parseBindingsFile(
          writeBindings(
            root,
            `import { Postgres, WasmCloudBinding } from '@di-framework/bindings';
@WasmCloudBinding('users')
export class Users extends Other {}
`,
          ),
          CATALOG,
          'app',
        ),
      'WASMCLOUD_BINDING_UNKNOWN_TYPE',
      2,
    );
    expectFailure(
      () =>
        parseBindingsFile(
          writeBindings(
            root,
            `import { Postgres, WasmCloudBinding } from '@di-framework/bindings';
const name = 'users';
@WasmCloudBinding(name)
export class Users extends Postgres {}
`,
          ),
          CATALOG,
          'app',
        ),
      'WASMCLOUD_BINDING_INVALID_NAME',
      2,
    );
    expectFailure(
      () =>
        parseBindingsFile(
          writeBindings(
            root,
            `import { KeyValue, WasmCloudBinding } from '@di-framework/bindings';
@WasmCloudBinding('cache', { interfaces: ['not-an-interface'] })
export class Cache extends KeyValue {}
`,
          ),
          CATALOG,
          'app',
        ),
      'WASMCLOUD_BINDING_UNSUPPORTED_INTERFACE',
      2,
    );
    expectFailure(
      () =>
        parseBindingsFile(
          writeBindings(
            root,
            `import { Postgres, WasmCloudBinding } from '@di-framework/bindings';
@WasmCloudBinding('users', { secretFrom: identity() })
export class Users extends Postgres {}
`,
          ),
          CATALOG,
          'app',
        ),
      'WASMCLOUD_BINDING_INVALID_OPTIONS',
      2,
    );
    expectFailure(
      () =>
        parseBindingsFile(
          writeBindings(
            root,
            `import { Postgres } from '@di-framework/bindings';
export class Users extends Postgres {}
`,
          ),
          CATALOG,
          'app',
        ),
      'WASMCLOUD_BINDING_INVALID_NAME',
      2,
    );
    expectFailure(
      () =>
        parseBindingsFile(
          writeBindings(
            root,
            `import { Postgres, WasmCloudBinding } from '@di-framework/bindings';
@WasmCloudBinding('Users')
export class Users extends Postgres {}
`,
          ),
          CATALOG,
          'app',
        ),
      'WASMCLOUD_BINDING_INVALID_NAME',
      2,
    );
  });
});

describe('discoverBindings', () => {
  it('returns no bindings when src/bindings.ts is absent', () => {
    const root = makeProject();
    expect(discoverBindings(loadProject(root), fakeDeps({ cwd: root }))).toEqual([]);
  });

  it('fails when a configured bindings file is missing', () => {
    const root = makeProject({
      name: 'Demo App',
      entry: 'src/app.ts',
      bindings: 'src/missing-bindings.ts',
    });
    expectFailure(
      () => discoverBindings(loadProject(root), fakeDeps({ cwd: root })),
      'WASMCLOUD_BINDINGS_NOT_FOUND',
      2,
    );
  });

  it('requires the wasmcloud package when bindings exist', () => {
    const root = makeProject();
    writeBindings(
      root,
      `import { Postgres, WasmCloudBinding } from '@di-framework/bindings';
@WasmCloudBinding('users')
export class Users extends Postgres {}
`,
    );
    expectFailure(
      () => discoverBindings(loadProject(root), fakeDeps({ cwd: root })),
      'WASMCLOUD_BINDING_CATALOG_MISSING',
      2,
    );
  });

  it('loads catalog.json from the resolved package', () => {
    const root = makeProject();
    writeBindings(
      root,
      `import { Postgres, WasmCloudBinding } from '@di-framework/bindings';
@WasmCloudBinding('users')
export class Users extends Postgres {}
`,
    );
    const catalogPath = join(root, 'catalog.json');
    writeFileSync(catalogPath, `${JSON.stringify(BINDING_CATALOG)}\n`);
    const records = discoverBindings(
      loadProject(root),
      fakeDeps({
        cwd: root,
        resolutions: { '@di-framework/bindings/catalog.json': catalogPath },
      }),
    );
    expect(records).toHaveLength(1);
    expect(records[0]?.secretFrom).toBe(defaultSecretName('Demo App', 'users'));
  });

  it('loads catalog.json next to a resolved package entry', () => {
    const root = makeProject();
    writeBindings(
      root,
      `import { Postgres, WasmCloudBinding } from '@di-framework/bindings';
@WasmCloudBinding('users')
export class Users extends Postgres {}
`,
    );
    const pkg = join(root, 'node_modules', '@di-framework', 'bindings', 'index.js');
    mkdirSync(join(pkg, '..'), { recursive: true });
    writeFileSync(pkg, 'export {}\n');
    writeFileSync(join(pkg, '..', 'catalog.json'), `${JSON.stringify(BINDING_CATALOG)}\n`);
    const records = discoverBindings(
      loadProject(root),
      fakeDeps({ cwd: root, resolutions: { '@di-framework/bindings': pkg } }),
    );
    expect(records).toHaveLength(1);
  });

  it('returns undefined when the resolved package has no catalog.json', () => {
    const root = makeProject();
    writeBindings(
      root,
      `import { Postgres, WasmCloudBinding } from '@di-framework/bindings';
@WasmCloudBinding('users')
export class Users extends Postgres {}
`,
    );
    const pkg = join(root, 'index.js');
    writeFileSync(pkg, 'export {}\n');
    expectFailure(
      () =>
        discoverBindings(
          loadProject(root),
          fakeDeps({ cwd: root, resolutions: { '@di-framework/bindings': pkg } }),
        ),
      'WASMCLOUD_BINDING_CATALOG_MISSING',
      2,
    );
  });
});

describe('parseBindingsFile errors', () => {
  it('maps unreadable bindings files to WASMCLOUD_BINDINGS_UNREADABLE', () => {
    const root = makeProject();
    expectFailure(
      () => parseBindingsFile(join(root, 'src'), CATALOG, 'app'),
      'WASMCLOUD_BINDINGS_UNREADABLE',
      2,
    );
  });
});

describe('bindingsPath', () => {
  it('exposes the project bindings path', () => {
    const root = makeProject();
    const project = loadProject(root);
    expect(bindingsPath(project)).toBe(project.bindingsPath);
  });
});
