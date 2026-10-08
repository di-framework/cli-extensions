import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  copyProviderWit,
  discoverComponentProviders,
  providerDepsDirectory,
  providerNamespaces,
  providerRequirementsFromJavaScript,
  providersToCompose,
} from '../src/components';
import { componentImportExternal } from '../src/deps';

const WIT = `package pqc-subtle:crypto@0.1.0;

interface types {
  record key-pair { public-key: list<u8>, secret-key: list<u8> }
}

interface argon2 {
  use types.{key-pair};
  hash: func(password: list<u8>) -> string;
}

interface ml-kem {
  use types.{key-pair};
  generate-keypair: func() -> key-pair;
}

world pqc-subtle {
  export argon2;
  export ml-kem;
}
`;

/** A project whose only dependency ships a component, installed in a hoisted node_modules. */
function projectWithProvider(
  options: { interfaces?: string[]; witFiles?: Record<string, string> } = {},
) {
  const workspace = mkdtempSync(join(tmpdir(), 'component-provider-'));
  const root = join(workspace, 'apps', 'guest');
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'guest',
      version: '1.0.0',
      dependencies: { '@scope/pqc': '0.2.10', 'plain-dep': '1.0.0' },
      optionalDependencies: { 'missing-dep': '1.0.0' },
    }),
  );
  const pkg = join(workspace, 'node_modules', '@scope', 'pqc');
  mkdirSync(join(pkg, 'component', 'wit'), { recursive: true });
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({
      name: '@scope/pqc',
      component: {
        package: 'pqc-subtle:crypto@0.1.0',
        wasm: 'component/pqc-subtle.wasm',
        wit: 'component/wit',
        ...(options.interfaces ? { interfaces: options.interfaces } : {}),
      },
    }),
  );
  writeFileSync(join(pkg, 'component', 'pqc-subtle.wasm'), 'provider-bytes');
  for (const [name, contents] of Object.entries(options.witFiles ?? { 'world.wit': WIT })) {
    writeFileSync(join(pkg, 'component', 'wit', name), contents);
  }
  const plain = join(workspace, 'node_modules', 'plain-dep');
  mkdirSync(plain, { recursive: true });
  writeFileSync(join(plain, 'package.json'), JSON.stringify({ name: 'plain-dep' }));
  return { workspace, root, pkg };
}

describe('component providers', () => {
  it('discovers direct dependencies that declare a component, through hoisted node_modules', () => {
    const { root, pkg } = projectWithProvider();
    const providers = discoverComponentProviders(root);
    expect(providers).toEqual([
      {
        dependency: '@scope/pqc',
        package: 'pqc-subtle:crypto',
        version: '0.1.0',
        interfaces: ['types', 'argon2', 'ml-kem'],
        wasm: join(pkg, 'component', 'pqc-subtle.wasm'),
        wit: join(pkg, 'component', 'wit'),
      },
    ]);
    expect(providerNamespaces(providers)).toEqual(['pqc-subtle']);
    expect(providerDepsDirectory(providers[0] as never)).toBe('pqc-subtle-crypto');
  });

  it('prefers the manifest interface list and ignores projects without a manifest', () => {
    const { root } = projectWithProvider({ interfaces: ['argon2'] });
    expect(discoverComponentProviders(root)[0]?.interfaces).toEqual(['argon2']);
    expect(discoverComponentProviders(mkdtempSync(join(tmpdir(), 'no-manifest-')))).toEqual([]);
  });

  it('rejects a component package id without a version', () => {
    const { root, pkg } = projectWithProvider();
    writeFileSync(
      join(pkg, 'package.json'),
      JSON.stringify({
        name: '@scope/pqc',
        component: { package: 'pqc-subtle:crypto', wasm: 'c.wasm', wit: 'component/wit' },
      }),
    );
    expect(() => discoverComponentProviders(root)).toThrow('without a version');
  });

  it('copies a single WIT file as package.wit and several by name', () => {
    const single = projectWithProvider();
    const deps = mkdtempSync(join(tmpdir(), 'wit-deps-'));
    copyProviderWit(discoverComponentProviders(single.root), deps);
    expect(readFileSync(join(deps, 'pqc-subtle-crypto', 'package.wit'), 'utf8')).toBe(WIT);

    const several = projectWithProvider({
      witFiles: {
        'package.wit': 'package pqc-subtle:crypto@0.1.0;\n',
        'argon2.wit': 'interface argon2 {}\n',
      },
    });
    const deps2 = mkdtempSync(join(tmpdir(), 'wit-deps-'));
    copyProviderWit(discoverComponentProviders(several.root), deps2);
    expect(readFileSync(join(deps2, 'pqc-subtle-crypto', 'argon2.wit'), 'utf8')).toBe(
      'interface argon2 {}\n',
    );
    expect(readFileSync(join(deps2, 'pqc-subtle-crypto', 'package.wit'), 'utf8')).toContain(
      'package pqc-subtle',
    );

    const empty = projectWithProvider({ witFiles: {} });
    expect(() => copyProviderWit(discoverComponentProviders(empty.root), deps)).toThrow(
      'no .wit file',
    );
  });

  it('turns referenced interfaces into import requirements, with types alongside', () => {
    const providers = discoverComponentProviders(projectWithProvider().root);
    const source = 'import { hash } from "pqc-subtle:crypto/argon2@0.1.0";\n';
    const requirements = providerRequirementsFromJavaScript(source, providers);
    expect(requirements).toEqual([
      {
        package: 'pqc-subtle:crypto',
        version: '0.1.0',
        interfaces: ['types', 'argon2'],
        direction: 'import',
        source: 'component:@scope/pqc',
      },
    ]);
    expect(providerRequirementsFromJavaScript('nothing here', providers)).toEqual([]);
    expect(providersToCompose(providers, requirements)).toEqual(providers);
    expect(providersToCompose(providers, [])).toEqual([]);
  });

  it('widens the external specifier rule with provider namespaces', () => {
    const external = componentImportExternal(['pqc-subtle']);
    expect(external.test('pqc-subtle:crypto/argon2@0.1.0')).toBe(true);
    expect(external.test('wasi:random/random@0.3.0')).toBe(true);
    expect(external.test('@scope/pqc/component')).toBe(false);
    expect(componentImportExternal().test('pqc-subtle:crypto/argon2@0.1.0')).toBe(false);
  });
});
