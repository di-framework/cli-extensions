import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildComponent, requirementsForProject, runWasmcloudBuild } from '../src/build';
import { loadProject } from '../src/project';
import { captureIo, fakeDeps, makeAssets, makeProject, type RunnerInvocation } from './helpers';

describe('buildComponent', () => {
  it('writes the generated WIT world, manifests, bundle, and runs jco componentize', async () => {
    const root = makeProject();
    const assets = makeAssets();
    const invocations: RunnerInvocation[] = [];
    const deps = fakeDeps({ cwd: root, assets, invocations });
    const output = captureIo();

    const summary = await buildComponent(loadProject(root), output.io, deps);

    const generated = join(root, '.di-framework');
    expect(readFileSync(join(generated, 'wit', 'world.wit'), 'utf8')).toBe(
      'package local:demo-app@1.2.3;\n\nworld application {\n  export wasi:http/handler@0.3.0;\n}\n',
    );
    expect(JSON.parse(readFileSync(join(generated, 'oci-config.json'), 'utf8'))).toEqual({
      architecture: 'wasm',
      os: 'wasip2',
    });
    const lock = JSON.parse(readFileSync(join(generated, 'wit.lock.json'), 'utf8')) as {
      componentModel: string;
      requirements: Array<{ package: string; version: string; interfaces: string[] }>;
    };
    expect(lock.componentModel).toBe('0.3');
    expect(lock.requirements).toEqual([
      expect.objectContaining({
        package: 'wasi:http',
        version: '0.3.0',
        interfaces: ['handler'],
        direction: 'export',
      }),
    ]);
    expect(JSON.parse(readFileSync(join(generated, 'build.json'), 'utf8'))).toEqual({
      schemaVersion: 1,
      application: 'Demo App',
      artifactDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      component: join('dist', 'demo-app.wasm'),
      componentModel: '0.3',
      deploymentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      entry: join('src', 'app.ts'),
      profile: 'wasmcloud-http',
    });
    expect(existsSync(join(generated, 'wit', 'deps', 'wasi-http', 'package.wit'))).toBe(true);
    expect(existsSync(join(generated, 'component.js'))).toBe(true);

    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({
      command: '/fake/node',
      cwd: root,
      args: [
        '/fake/jco.js',
        'componentize',
        '--backend',
        'qjs',
        '-w',
        join(generated, 'wit'),
        '-n',
        'application',
        '-o',
        join(root, 'dist', 'demo-app.wasm'),
        join(generated, 'component.js'),
      ],
    });
    expect(summary).toEqual({
      application: 'Demo App',
      artifactDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      component: join('dist', 'demo-app.wasm'),
      componentModel: '0.3',
      deploymentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      entry: join('src', 'app.ts'),
      profile: 'wasmcloud-http',
    });
    expect(output.stdout.join('')).toContain('Building Demo App');
    expect(output.stdout.join('')).toContain('Built dist/demo-app.wasm');
    expect(existsSync(join(generated, 'guests.js'))).toBe(false);
  });

  it('adds wasi:sockets to the guest world when the bundle imports them', async () => {
    const root = makeProject();
    const assets = makeAssets();
    await buildComponent(
      loadProject(root),
      captureIo().io,
      fakeDeps({
        cwd: root,
        assets,
        bundleContents:
          'import { TcpSocket } from "wasi:sockets/types@0.3.0";\nexport const bundled = true;\n',
        componentOutput: () => `\0asm sockets`,
        capturedStdout: {
          wit: `world application {
  export wasi:http/handler@0.3.0;
  import wasi:sockets/types@0.3.0;
}
`,
        },
      }),
    );
    const world = readFileSync(join(root, '.di-framework', 'wit', 'world.wit'), 'utf8');
    expect(world).toContain('export wasi:http/handler@0.3.0;');
    expect(world).toContain('import wasi:sockets/types@0.3.0;');
    expect(world).not.toContain('ip-name-lookup');
    expect(world).not.toContain('wasi:random');
    const lock = JSON.parse(readFileSync(join(root, '.di-framework', 'wit.lock.json'), 'utf8')) as {
      requirements: Array<{ package: string; interfaces: string[] }>;
    };
    expect(lock.requirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ package: 'wasi:sockets', interfaces: ['types'] }),
      ]),
    );
  });

  it('adds wasi:random to the guest world when the bundle imports it', async () => {
    const root = makeProject();
    const assets = makeAssets();
    await buildComponent(
      loadProject(root),
      captureIo().io,
      fakeDeps({
        cwd: root,
        assets,
        bundleContents:
          'import { getRandomBytes } from "wasi:random/random@0.3.0";\nexport const bundled = true;\n',
        componentOutput: () => `\0asm random`,
        capturedStdout: {
          wit: `world application {
  export wasi:http/handler@0.3.0;
  import wasi:random/random@0.3.0;
}
`,
        },
      }),
    );
    const world = readFileSync(join(root, '.di-framework', 'wit', 'world.wit'), 'utf8');
    expect(world).toContain('export wasi:http/handler@0.3.0;');
    expect(world).toContain('import wasi:random/random@0.3.0;');
    expect(world).not.toContain('wasi:sockets');
  });

  it('writes a guests module when bindings are discovered', async () => {
    const root = makeProject();
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'src', 'bindings.ts'),
      `import { Config, Postgres, WasmCloudBinding } from '@di-framework/bindings';
@WasmCloudBinding('user-database')
export class UserDatabase extends Postgres {}
@WasmCloudBinding('app-config')
export class AppConfig extends Config {}
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
      })}\n`,
    );
    const assets = makeAssets();
    const summary = await buildComponent(
      loadProject(root),
      captureIo().io,
      fakeDeps({
        cwd: root,
        assets,
        resolutions: { '@di-framework/bindings/catalog.json': join(root, 'catalog.json') },
      }),
    );
    expect(summary.application).toBe('Demo App');
    const guests = readFileSync(join(root, '.di-framework', 'guests.js'), 'utf8');
    expect(guests).toContain('import * as');
    expect(guests).toContain('wasmcloud:postgres/query@0.2.0');
    expect(guests).toContain('wasi:config/store@0.2.0-rc.1');
    expect(guests).toContain('"user-database"');
    expect(guests).toContain('Symbol.for("di-framework.wasmcloud.guests")');
    expect(readFileSync(join(root, '.di-framework', 'wit', 'world.wit'), 'utf8')).toContain(
      'import wasmcloud:postgres/query@0.2.0;',
    );
    expect(readFileSync(join(root, '.di-framework', 'wit', 'world.wit'), 'utf8')).not.toContain(
      'import user-database:',
    );
  });

  it('inspects real wasm imports and fails when they disagree with the WIT graph', async () => {
    const root = makeProject();
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
    const assets = makeAssets();
    await expect(
      buildComponent(
        loadProject(root),
        captureIo().io,
        fakeDeps({
          cwd: root,
          assets,
          resolutions: { '@di-framework/bindings/catalog.json': join(root, 'catalog.json') },
          componentOutput: () => `\0asm missing-imports`,
          capturedStdout: { wit: 'world application {\n  export wasi:http/handler@0.3.0;\n}\n' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_COMPONENT_IMPORTS_MISMATCH', exitCode: 3 });
  });

  it('accepts a component whose extracted WIT includes declared imports', async () => {
    const root = makeProject();
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
    const assets = makeAssets();
    const summary = await buildComponent(
      loadProject(root),
      captureIo().io,
      fakeDeps({
        cwd: root,
        assets,
        resolutions: { '@di-framework/bindings/catalog.json': join(root, 'catalog.json') },
        componentOutput: () => `\0asm ok`,
        capturedStdout: {
          wit: `world application {
  export wasi:http/handler@0.3.0;
  import wasmcloud:postgres/query@0.2.0;
  import wasmcloud:postgres/prepared@0.2.0;
  import wasmcloud:postgres/types@0.2.0;
}
`,
        },
      }),
    );
    expect(summary.componentModel).toBe('0.3');
  });

  it('fails when component WIT cannot be extracted from a real wasm', async () => {
    const root = makeProject();
    const assets = makeAssets();
    await expect(
      buildComponent(
        loadProject(root),
        captureIo().io,
        fakeDeps({
          cwd: root,
          assets,
          componentOutput: () => `\0asm unreadable`,
          exitCodes: { wit: 1 },
        }),
      ),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_COMPONENT_IMPORTS_UNREADABLE', exitCode: 3 });
  });

  it('keeps the deployment version stable when componentizer bytes vary for identical inputs', async () => {
    const root = makeProject();
    const assets = makeAssets();
    const deps = fakeDeps({
      cwd: root,
      assets,
      componentOutput: (build) => `nondeterministic-component-${build}`,
    });

    const first = await buildComponent(loadProject(root), captureIo().io, deps);
    const second = await buildComponent(loadProject(root), captureIo().io, deps);

    expect(first.artifactDigest).not.toBe(second.artifactDigest);
    expect(first.deploymentDigest).toBe(second.deploymentDigest);
  });

  it('maps bundler failures to WASMCLOUD_BUILD_FAILED', async () => {
    const root = makeProject();
    const deps = fakeDeps({ cwd: root, bundlerError: new Error('rolldown exploded') });
    await expect(buildComponent(loadProject(root), captureIo().io, deps)).rejects.toMatchObject({
      code: 'WASMCLOUD_BUILD_FAILED',
      exitCode: 3,
    });
  });

  it('fails with WASMCLOUD_NODE_REQUIRED when no node binary is available', async () => {
    const root = makeProject();
    const deps = fakeDeps({ cwd: root, nodeBinaryPath: null });
    await expect(buildComponent(loadProject(root), captureIo().io, deps)).rejects.toMatchObject({
      code: 'WASMCLOUD_NODE_REQUIRED',
      exitCode: 3,
    });
  });

  it('maps jco componentize failures to WASMCLOUD_TOOL_FAILED', async () => {
    const root = makeProject();
    const deps = fakeDeps({ cwd: root, exitCodes: { componentize: 1 } });
    await expect(buildComponent(loadProject(root), captureIo().io, deps)).rejects.toMatchObject({
      code: 'WASMCLOUD_TOOL_FAILED',
      exitCode: 3,
    });
  });

  it('componentizes with a resolved patched qjs CLI', async () => {
    const root = makeProject();
    const invocations: RunnerInvocation[] = [];
    await buildComponent(
      loadProject(root),
      captureIo().io,
      fakeDeps({
        cwd: root,
        invocations,
        componentizeQjsPath: '/fake/componentize-qjs',
      }),
    );
    expect(invocations[0]).toMatchObject({
      command: '/fake/componentize-qjs',
      cwd: root,
      args: [
        '--wit',
        join(root, '.di-framework', 'wit'),
        '--js',
        join(root, '.di-framework', 'component.js'),
        '-n',
        'application',
        '-o',
        join(root, 'dist', 'demo-app.wasm'),
      ],
    });
  });
});

describe('requirementsForProject', () => {
  it('returns HTTP adapter requirements when no bindings file exists', () => {
    const root = makeProject();
    const requirements = requirementsForProject(loadProject(root), fakeDeps({ cwd: root }));
    expect(requirements).toEqual([
      expect.objectContaining({
        package: 'wasi:http',
        interfaces: ['handler'],
        direction: 'export',
      }),
    ]);
  });
});

describe('runWasmcloudBuild', () => {
  it('rejects arguments before touching the project', async () => {
    await expect(
      runWasmcloudBuild(['--watch'], captureIo().io, fakeDeps({ cwd: '/nowhere' })),
    ).rejects.toMatchObject({ code: 'INVALID_USAGE', exitCode: 2 });
  });

  it('builds the project found from the working directory', async () => {
    const root = makeProject();
    const result = await runWasmcloudBuild(
      [],
      captureIo().io,
      fakeDeps({ cwd: join(root, 'src') }),
    );
    expect(result.data).toMatchObject({ application: 'Demo App', profile: 'wasmcloud-http' });
    expect(result.text).toContain('Built');
  });
});

it('adds sqlite imports for actor-only HTTP builds when requirements omit them', async () => {
  const root = makeProject();
  writeFileSync(
    join(root, 'src', 'counter.ts'),
    `
import { Actor, ActorMethod } from '@di-framework/actors';
@Actor({ name: 'Counter' })
export class Counter {
  @ActorMethod()
  async increment() { return 1; }
}
`,
  );
  writeFileSync(join(root, 'src', 'app.ts'), 'export { Counter } from "./counter";');
  writeFileSync(
    join(root, 'di-framework.config.json'),
    `${JSON.stringify({ name: 'Actor HTTP', entry: 'src/app.ts' })}\n`,
  );
  const assets = makeAssets();
  mkdirSync(join(assets, 'sqlite'), { recursive: true });
  writeFileSync(join(assets, 'sqlite', 'di-framework-sqlite.wasm'), 'sqlite-provider');
  await buildComponent(
    loadProject(root),
    captureIo().io,
    fakeDeps({
      cwd: root,
      assets,
      componentOutput: () => `\0asm sqlite-import`,
      capturedStdout: {
        wit: `world application {
  export wasi:http/handler@0.3.0;
  import di-framework:sqlite/database@0.1.0;
}
`,
      },
    }),
  );
  const world = readFileSync(join(root, '.di-framework', 'wit', 'world.wit'), 'utf8');
  expect(world).toContain('import di-framework:sqlite/database@0.1.0;');
});

it('writes queue and actor modules and composes sqlite providers for worker builds', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wasmcloud-worker-build-'));
  const srcDir = join(root, 'src');
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(
    join(srcDir, 'worker.ts'),
    `
import { Container } from '@di-framework/core';
import { QueueHandler } from '@di-framework/queues';
@Container()
export class Worker {
  @QueueHandler('jobs')
  async run() {}
}
`,
  );
  writeFileSync(
    join(srcDir, 'counter.ts'),
    `
import { Actor, ActorMethod } from '@di-framework/actors';
@Actor({ name: 'Counter' })
export class Counter {
  @ActorMethod()
  async increment() { return 1; }
}
`,
  );
  writeFileSync(join(srcDir, 'index.ts'), 'export * from "./worker"; export * from "./counter";');
  writeFileSync(
    join(root, 'di-framework.config.json'),
    `${JSON.stringify({ name: 'Worker App', entry: 'src/index.ts', applicationType: 'worker' })}\n`,
  );
  writeFileSync(join(root, 'package.json'), '{ "name": "worker", "version": "1.0.0" }\n');
  const assets = makeAssets();
  mkdirSync(join(assets, 'sqlite'), { recursive: true });
  writeFileSync(join(assets, 'sqlite', 'di-framework-sqlite.wasm'), 'sqlite-provider');
  const invocations: RunnerInvocation[] = [];
  const summary = await buildComponent(
    loadProject(root),
    captureIo().io,
    fakeDeps({
      cwd: root,
      assets,
      invocations,
      componentOutput: () => `\0asm sqlite-import`,
      capturedStdout: {
        wit: `world application {
  export wasi:http/handler@0.3.0;
  import di-framework:sqlite/database@0.1.0;
}
`,
      },
      captures: { wac: undefined },
    }),
  );
  expect(summary.profile).toBe('wasmcloud-worker');
  expect(readFileSync(join(root, '.di-framework', 'queues.js'), 'utf8')).toContain('QueueWorker');
  expect(readFileSync(join(root, '.di-framework', 'actors.js'), 'utf8')).toContain('Counter');
  expect(invocations.some((entry) => entry.args.includes('plug'))).toBe(true);
});

it('composes a dependency that ships a component when the bundle imports its interfaces', async () => {
  const root = makeProject(
    { name: 'Hasher', entry: 'src/app.ts' },
    { name: 'hasher', version: '1.0.0', dependencies: { '@scope/pqc': '0.2.10' } },
  );
  const pkg = join(root, 'node_modules', '@scope', 'pqc');
  mkdirSync(join(pkg, 'component', 'wit'), { recursive: true });
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({
      name: '@scope/pqc',
      component: {
        package: 'pqc-subtle:crypto@0.1.0',
        wasm: 'component/pqc-subtle.wasm',
        wit: 'component/wit',
        interfaces: ['ml-kem', 'ml-dsa', 'argon2'],
      },
    }),
  );
  writeFileSync(join(pkg, 'component', 'pqc-subtle.wasm'), 'pqc-provider');
  writeFileSync(
    join(pkg, 'component', 'wit', 'world.wit'),
    'package pqc-subtle:crypto@0.1.0;\n\ninterface types {}\ninterface argon2 {}\ninterface ml-kem {}\ninterface ml-dsa {}\n',
  );
  const assets = makeAssets();
  const invocations: RunnerInvocation[] = [];
  await buildComponent(
    loadProject(root),
    captureIo().io,
    fakeDeps({
      cwd: root,
      assets,
      invocations,
      bundleContents: 'import { hash } from "pqc-subtle:crypto/argon2@0.1.0";\nexport default 1;\n',
      componentOutput: () => `\0asm pqc-import`,
      capturedStdout: {
        wit: `world application {
  export wasi:http/handler@0.3.0;
  import pqc-subtle:crypto/argon2@0.1.0;
}
`,
      },
      captures: { wac: undefined },
    }),
  );
  const world = readFileSync(join(root, '.di-framework', 'wit', 'world.wit'), 'utf8');
  expect(world).toContain('import pqc-subtle:crypto/argon2@0.1.0;');
  expect(world).not.toContain('ml-kem');
  expect(
    readFileSync(
      join(root, '.di-framework', 'wit', 'deps', 'pqc-subtle-crypto', 'package.wit'),
      'utf8',
    ),
  ).toContain('package pqc-subtle:crypto@0.1.0;');
  const lock = JSON.parse(readFileSync(join(root, '.di-framework', 'wit.lock.json'), 'utf8'));
  expect(lock.packages.map((entry: { id: string }) => entry.id)).toContain('pqc-subtle:crypto');
  const plugs = invocations.filter((entry) => entry.args.includes('plug'));
  expect(plugs).toHaveLength(1);
  expect(plugs[0]?.args).toContain(join(pkg, 'component', 'pqc-subtle.wasm'));
});

it('fails when a composed dependency is missing its component binary', async () => {
  const root = makeProject(
    { name: 'Hasher', entry: 'src/app.ts' },
    { name: 'hasher', version: '1.0.0', dependencies: { '@scope/pqc': '0.2.10' } },
  );
  const pkg = join(root, 'node_modules', '@scope', 'pqc');
  mkdirSync(join(pkg, 'component', 'wit'), { recursive: true });
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({
      name: '@scope/pqc',
      component: {
        package: 'pqc-subtle:crypto@0.1.0',
        wasm: 'component/nope.wasm',
        wit: 'component/wit',
      },
    }),
  );
  writeFileSync(
    join(pkg, 'component', 'wit', 'world.wit'),
    'package pqc-subtle:crypto@0.1.0;\n\ninterface argon2 {}\n',
  );
  await expect(
    buildComponent(
      loadProject(root),
      captureIo().io,
      fakeDeps({
        cwd: root,
        assets: makeAssets(),
        bundleContents: 'import "pqc-subtle:crypto/argon2@0.1.0";\nexport default 1;\n',
        componentOutput: () => `\0asm pqc-import`,
        capturedStdout: {
          wit: 'world application {\n  import pqc-subtle:crypto/argon2@0.1.0;\n}\n',
        },
        captures: { wac: undefined },
      }),
    ),
  ).rejects.toMatchObject({ code: 'WASMCLOUD_COMPONENT_PROVIDER_MISSING' });
});

it('fails sqlite composition when the provider asset or wac plug step is missing', async () => {
  const root = makeProject();
  writeFileSync(
    join(root, 'src', 'sqlite.ts'),
    'import "di-framework:sqlite/database@0.1.0";\nexport default 1;\n',
  );
  const assets = makeAssets();
  await expect(
    buildComponent(
      loadProject(root),
      captureIo().io,
      fakeDeps({
        cwd: root,
        assets,
        bundleContents: 'import "di-framework:sqlite/database@0.1.0";\nexport default 1;\n',
        componentOutput: () => `\0asm sqlite-import`,
        capturedStdout: {
          wit: `world application {
  export wasi:http/handler@0.3.0;
  import di-framework:sqlite/database@0.1.0;
}
`,
        },
      }),
    ),
  ).rejects.toMatchObject({ code: 'WASMCLOUD_SQLITE_PROVIDER_MISSING', exitCode: 3 });

  mkdirSync(join(assets, 'sqlite'), { recursive: true });
  writeFileSync(join(assets, 'sqlite', 'di-framework-sqlite.wasm'), 'sqlite-provider');
  await expect(
    buildComponent(
      loadProject(root),
      captureIo().io,
      fakeDeps({
        cwd: root,
        assets,
        bundleContents: 'import "di-framework:sqlite/database@0.1.0";\nexport default 1;\n',
        componentOutput: () => `\0asm sqlite-import`,
        capturedStdout: {
          wit: `world application {
  export wasi:http/handler@0.3.0;
  import di-framework:sqlite/database@0.1.0;
}
`,
        },
        exitCodes: { '--plug': 1 },
      }),
    ),
  ).rejects.toMatchObject({ code: 'WASMCLOUD_SQLITE_COMPOSE_FAILED', exitCode: 3 });
});

it('writes the cron invoker dependency for ingress-free components without scheduled jobs', async () => {
  const root = makeProject({ name: 'Empty Worker', entry: 'src/app.ts', ingress: false });
  await buildComponent(
    loadProject(root),
    captureIo().io,
    fakeDeps({ cwd: root, assets: makeAssets() }),
  );
  expect(readFileSync(join(root, '.di-framework', 'cron-adapter.js'), 'utf8')).toContain(
    './cron-invoker.js',
  );
  expect(readFileSync(join(root, '.di-framework', 'cron-invoker.js'), 'utf8')).toContain('export');
});
