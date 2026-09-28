import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildComponent } from '../src/build';
import { DEFAULT_DEPS } from '../src/deps';
import { loadProject } from '../src/project';
import { captureIo, fakeDeps, makeProject, patchedComponentizeQjsPath } from './helpers';

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST_ASSETS = join(PLUGIN_ROOT, 'dist', 'assets');
const WASMCLOUD_PKG = dirname(
  fileURLToPath(import.meta.resolve('@di-framework/bindings/package.json')),
);

const CONFIG_CATALOG = {
  Config: {
    kind: 'Config',
    package: 'wasi:config',
    version: '0.2.0-rc.1',
    interfaces: ['store'],
    primaryInterface: 'store',
    namedInstance: false,
    sharedResources: [],
    witDep: 'wasi-config',
    usesSecret: false,
    configKeys: [],
  },
};

function writeConfigProject(root: string): void {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'src', 'bindings.ts'),
    `import { Config, WasmCloudBinding } from '@di-framework/bindings';
@WasmCloudBinding('app-config')
export class AppConfig extends Config {}
`,
  );
  writeFileSync(join(root, 'catalog.json'), `${JSON.stringify(CONFIG_CATALOG)}\n`);
}

describe('config binding guest wiring', () => {
  it('writes a guests module with a real wasi:config import', async () => {
    const root = makeProject();
    writeConfigProject(root);
    await buildComponent(
      loadProject(root),
      captureIo().io,
      fakeDeps({
        cwd: root,
        resolutions: { '@di-framework/bindings/catalog.json': join(root, 'catalog.json') },
      }),
    );
    const guests = readFileSync(join(root, '.di-framework', 'guests.js'), 'utf8');
    expect(guests).toContain('import * as guest0 from "wasi:config/store@0.2.0-rc.1";');
    expect(guests).toContain('"app-config": guest0');
  });

  it('componentizes unlabeled wasi:config with the real qjs toolchain', async () => {
    const qjs = patchedComponentizeQjsPath();
    if (qjs === undefined) return;
    if (!existsSync(join(DIST_ASSETS, 'http-adapter.js'))) return;
    if (DEFAULT_DEPS.nodeBinaryPath() === undefined) return;

    const root = makeProject();
    writeConfigProject(root);
    const deps = {
      ...DEFAULT_DEPS,
      cwd: () => root,
      assetsDirectory: () => DIST_ASSETS,
      componentizeQjsPath: () => qjs,
      resolveFromProject: (_projectRoot: string, specifier: string) =>
        specifier === '@di-framework/bindings/catalog.json'
          ? join(root, 'catalog.json')
          : undefined,
    };
    await buildComponent(loadProject(root), captureIo().io, deps);
    const inspected = await DEFAULT_DEPS.runCaptured(
      DEFAULT_DEPS.nodeBinaryPath() ?? 'node',
      [DEFAULT_DEPS.jcoCliPath(), 'wit', join(root, 'dist', 'demo-app.wasm')],
      { cwd: root },
    );
    expect(inspected.exitCode).toBe(0);
    expect(`${inspected.stdout}\n${inspected.stderr}`).toContain('wasi:config/store@0.2.0-rc.1');
  }, 60_000);

  it('componentizes unlabeled async wasmcloud:postgres with a wasmtime-48 qjs CLI', async () => {
    const qjs = patchedComponentizeQjsPath();
    if (qjs === undefined) return;
    if (!existsSync(join(DIST_ASSETS, 'http-adapter.js'))) return;
    if (DEFAULT_DEPS.nodeBinaryPath() === undefined) return;

    const root = makeProject();
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'src', 'bindings.ts'),
      `import { Postgres, WasmCloudBinding } from '@di-framework/bindings';
@WasmCloudBinding('user-database')
export class UserDatabase extends Postgres {}
`,
    );
    writeFileSync(
      join(root, 'catalog.json'),
      `${JSON.stringify({
        Postgres: {
          kind: 'Postgres',
          package: 'wasmcloud:postgres',
          version: '0.2.0',
          interfaces: ['query', 'prepared', 'types'],
          primaryInterface: 'query',
          namedInstance: true,
          sharedResources: [],
          witDep: 'wasmcloud-postgres',
          usesSecret: true,
          configKeys: [],
        },
      })}\n`,
    );
    const deps = {
      ...DEFAULT_DEPS,
      cwd: () => root,
      assetsDirectory: () => DIST_ASSETS,
      componentizeQjsPath: () => qjs,
      resolveFromProject: (_projectRoot: string, specifier: string) =>
        specifier === '@di-framework/bindings/catalog.json'
          ? join(root, 'catalog.json')
          : undefined,
    };
    await buildComponent(loadProject(root), captureIo().io, deps);
    const inspected = await DEFAULT_DEPS.runCaptured(
      DEFAULT_DEPS.nodeBinaryPath() ?? 'node',
      [DEFAULT_DEPS.jcoCliPath(), 'wit', join(root, 'dist', 'demo-app.wasm')],
      { cwd: root },
    );
    expect(inspected.exitCode).toBe(0);
    const wit = `${inspected.stdout}\n${inspected.stderr}`;
    expect(wit).toContain('wasmcloud:postgres/query@0.2.0');
  }, 120_000);

  it('initializes guests before a module-level binding and serves host config on wasmtime', async () => {
    const wasmtime = DEFAULT_DEPS.wasmtimeBinaryPath();
    if (wasmtime === undefined) return;
    if (!existsSync(join(DIST_ASSETS, 'http-adapter.js'))) return;
    if (DEFAULT_DEPS.nodeBinaryPath() === undefined) return;
    if (!existsSync(join(WASMCLOUD_PKG, 'dist', 'index.js'))) return;

    const root = makeProject();
    writeConfigProject(root);
    writeFileSync(
      join(root, 'src', 'app.ts'),
      `import { AppConfig } from './bindings.ts';
const config = new AppConfig();
export default async (request: Request): Promise<Response> => {
  const key = new URL(request.url).searchParams.get('key') ?? 'greeting';
  const value = await Promise.resolve(config.get(key));
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
  });
};
`,
    );
    mkdirSync(join(root, 'node_modules', '@di-framework'), { recursive: true });
    symlinkSync(WASMCLOUD_PKG, join(root, 'node_modules', '@di-framework', 'bindings'));

    const deps = {
      ...DEFAULT_DEPS,
      cwd: () => root,
      assetsDirectory: () => DIST_ASSETS,
      resolveFromProject: (_projectRoot: string, specifier: string) =>
        specifier === '@di-framework/bindings/catalog.json'
          ? join(root, 'catalog.json')
          : undefined,
    };
    await buildComponent(loadProject(root), captureIo().io, deps);

    const port = 18000 + Math.floor(Math.random() * 1000);
    const child = Bun.spawn(
      [
        wasmtime,
        'serve',
        '-S',
        'cli',
        '-S',
        'p3',
        '-S',
        'config',
        '-S',
        'config-var=greeting=from-host',
        '--addr',
        `127.0.0.1:${port}`,
        join(root, 'dist', 'demo-app.wasm'),
      ],
      { cwd: root, stdout: 'pipe', stderr: 'pipe' },
    );
    try {
      const deadline = Date.now() + 15_000;
      let body = '';
      while (Date.now() < deadline) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/?key=greeting`);
          if (response.ok) {
            body = await response.text();
            break;
          }
        } catch {
          await DEFAULT_DEPS.wait(200);
        }
      }
      expect(body).toContain('from-host');
    } finally {
      child.kill();
      await child.exited;
    }
  }, 120_000);
});

it('preserves two named PostgreSQL interface pairs through real compilation and SQLite composition', async () => {
  const qjs = patchedComponentizeQjsPath();
  if (!qjs || !existsSync(join(DIST_ASSETS, 'http-adapter.js'))) return;
  const root = makeProject();
  mkdirSync(join(root, 'node_modules', '@di-framework'), { recursive: true });
  symlinkSync(WASMCLOUD_PKG, join(root, 'node_modules', '@di-framework', 'bindings'), 'dir');
  writeFileSync(
    join(root, 'src/bindings.ts'),
    `import {Postgres,WasmCloudBinding} from '@di-framework/bindings';
@WasmCloudBinding('orders-db',{serviceName:'orders'}) export class Orders extends Postgres {}
@WasmCloudBinding('audit-db',{serviceName:'audit'}) export class Audit extends Postgres {}`,
  );
  writeFileSync(
    join(root, 'src/app.ts'),
    `import {Orders,Audit} from './bindings';
export default async () => Response.json([await new Orders().query('SELECT 1'), await new Audit().query('SELECT 2')]);`,
  );
  const deps = {
    ...DEFAULT_DEPS,
    cwd: () => root,
    componentizeQjsPath: () => qjs,
    assetsDirectory: () => DIST_ASSETS,
  };
  await buildComponent(loadProject(root), captureIo().io, deps);
  const inspected = await deps.runCaptured(
    deps.nodeBinaryPath() ?? 'node',
    [deps.jcoCliPath(), 'wit', join(root, 'dist/demo-app.wasm')],
    { cwd: root },
  );
  expect(inspected.exitCode).toBe(0);
  for (const name of ['orders-db', 'audit-db'])
    for (const iface of ['query', 'prepared'])
      expect(inspected.stdout).toContain(
        `import ${name}-${iface}: wasmcloud:postgres/${iface}@0.2.0`,
      );
  expect(inspected.stdout).not.toContain('import di-framework:sqlite/database');
}, 60_000);
