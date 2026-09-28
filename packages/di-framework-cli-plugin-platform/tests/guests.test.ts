import { describe, expect, it } from 'bun:test';
import type { BindingKind, BindingRecord } from '../src/bindings';
import { emptyGuestsModule, renderGuestsModule, WASMCLOUD_GUESTS_GLOBAL } from '../src/guests';

function binding(
  name: string,
  pkg: string,
  version: string,
  interfaces: string[],
  instanceName: string | undefined,
  kind: BindingKind,
): BindingRecord {
  return {
    className: name,
    name,
    kind,
    requirement: {
      package: pkg,
      version,
      interfaces,
      direction: 'import',
      instanceName,
      source: name,
    },
  };
}

describe('renderGuestsModule', () => {
  it('emits real WIT imports and installs guests on globalThis', () => {
    const source = renderGuestsModule([
      binding(
        'user-database',
        'wasmcloud:postgres',
        '0.2.0',
        ['query', 'prepared'],
        'user-database',
        'Postgres',
      ),
      binding('app-config', 'wasi:config', '0.2.0-rc.1', ['store'], undefined, 'Config'),
    ]);
    expect(source).toContain('import * as guest0 from "wasmcloud:postgres/query@0.2.0";');
    expect(source).toContain('import * as guest1 from "wasmcloud:postgres/prepared@0.2.0";');
    expect(source).toContain('import * as guest2 from "wasi:config/store@0.2.0-rc.1";');
    expect(source).toContain('"user-database": Object.assign({}, guest0, guest1)');
    expect(source).toContain('"app-config": guest2');
    expect(source).toContain(`Symbol.for("${WASMCLOUD_GUESTS_GLOBAL}")`);
    expect(source).toContain('export { guests };');
  });

  it('reuses a specifier imported by two bindings', () => {
    const source = renderGuestsModule([
      binding('sessions', 'wasmcloud:keyvalue', '0.2.0', ['store'], 'sessions', 'KeyValue'),
      binding('cache', 'wasmcloud:keyvalue', '0.2.0', ['store'], 'cache', 'KeyValue'),
    ]);
    expect(source.match(/import \* as guest0 from "wasmcloud:keyvalue\/store@0\.2\.0";/g)).toEqual([
      'import * as guest0 from "wasmcloud:keyvalue/store@0.2.0";',
    ]);
    expect(source).not.toContain('guest1');
    expect(source).toContain('"sessions": guest0');
    expect(source).toContain('"cache": guest0');
  });

  it('writes an empty guests module that still registers the global', () => {
    expect(emptyGuestsModule()).toContain(`Symbol.for("${WASMCLOUD_GUESTS_GLOBAL}")`);
    expect(emptyGuestsModule()).toContain('const guests = {};');
  });

  it('does not import the types-only WIT package as a JS module', () => {
    const source = renderGuestsModule([
      binding(
        'user-database',
        'wasmcloud:postgres',
        '0.2.0',
        ['query', 'prepared', 'types'],
        'user-database',
        'Postgres',
      ),
    ]);
    expect(source).toContain('import * as guest0 from "wasmcloud:postgres/query@0.2.0";');
    expect(source).toContain('import * as guest1 from "wasmcloud:postgres/prepared@0.2.0";');
    expect(source).not.toContain('wasmcloud:postgres/types@0.2.0');
    expect(source).toContain('"user-database": Object.assign({}, guest0, guest1)');
  });
});
