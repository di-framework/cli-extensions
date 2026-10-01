import { describe, expect, it } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDevArgs, runWasmcloudDev } from '../src/dev';
import { captureIo, expectFailure, fakeDeps, makeProject, type RunnerInvocation } from './helpers';

describe('parseDevArgs', () => {
  it('applies defaults and reads explicit values', () => {
    expect(parseDevArgs([])).toEqual({ host: '127.0.0.1', port: '8000' });
    expect(parseDevArgs(['--host', '0.0.0.0', '--port', '9000'])).toEqual({
      host: '0.0.0.0',
      port: '9000',
    });
  });

  it('rejects duplicates, missing values, and unknown tokens', () => {
    expectFailure(() => parseDevArgs(['--host', 'a', '--host', 'b']), 'INVALID_USAGE', 2);
    expectFailure(() => parseDevArgs(['--port', '1', '--port', '2']), 'INVALID_USAGE', 2);
    expectFailure(() => parseDevArgs(['--port']), 'INVALID_USAGE', 2);
    expectFailure(() => parseDevArgs(['--host', '--port']), 'INVALID_USAGE', 2);
    expectFailure(() => parseDevArgs(['serve']), 'INVALID_USAGE', 2);
  });
});

describe('runWasmcloudDev', () => {
  for (const contents of [undefined, '{', '{}']) {
    it(`reports an unusable generated WIT lock (${contents ?? 'missing'}) without starting a server`, async () => {
      const root = makeProject();
      const lockPath = join(root, '.di-framework', 'wit.lock.json');
      const invocations: RunnerInvocation[] = [];
      const output = captureIo();
      await expect(
        runWasmcloudDev(
          [],
          output.io,
          fakeDeps({
            cwd: root,
            invocations,
            componentOutput: () => {
              if (contents === undefined) rmSync(lockPath);
              else writeFileSync(lockPath, contents);
              return 'fake-wasm-component';
            },
          }),
        ),
      ).rejects.toMatchObject({
        code: 'WASMCLOUD_WIT_LOCK_INVALID',
        exitCode: 3,
        message: expect.stringContaining('Rerun platform build'),
        details: { path: lockPath, cause: expect.any(String) },
      });
      expect(invocations).toHaveLength(1);
      expect(output.stdout.join('')).not.toContain('Serving on');
    });
  }

  it('enables host TLS and network access when the built component imports TLS', async () => {
    const root = makeProject();
    const invocations: RunnerInvocation[] = [];
    await runWasmcloudDev(
      [],
      captureIo().io,
      fakeDeps({
        cwd: root,
        invocations,
        bundleContents:
          "import { Connector } from 'wasi:tls/client@0.3.0-draft'; export const connector = Connector;",
      }),
    );
    expect(invocations[1]?.args).toContain('tls=y,inherit-network=y,allow-ip-name-lookup=y');
  });

  it('selects wash when the built component imports wasmCloud host interfaces', async () => {
    const root = makeProject();
    writeFileSync(
      join(root, 'src', 'bindings.ts'),
      `import { KeyValue, WasmCloudBinding } from '@di-framework/bindings';
@WasmCloudBinding('stock')
export class Stock extends KeyValue {}
`,
    );
    const catalogPath = join(root, 'catalog.json');
    writeFileSync(
      catalogPath,
      `${JSON.stringify({
        KeyValue: {
          kind: 'KeyValue',
          package: 'wasmcloud:keyvalue',
          version: '0.2.0',
          interfaces: ['store', 'atomics', 'cas', 'batch', 'types'],
          primaryInterface: 'store',
          namedInstance: true,
          sharedResources: [],
          witDep: 'wasmcloud-keyvalue',
          usesSecret: false,
          configKeys: [],
        },
      })}\n`,
    );
    const invocations: RunnerInvocation[] = [];
    const output = captureIo();
    const deps = fakeDeps({
      cwd: root,
      invocations,
      washBinaryPath: '/fake/wash',
      resolutions: { '@di-framework/bindings/catalog.json': catalogPath },
    });
    const bundles: (boolean | undefined)[] = [];
    const bundle = deps.bundler;
    deps.bundler = (options) => {
      bundles.push(options.guestLogging);
      return bundle(options);
    };
    const result = await runWasmcloudDev([], output.io, deps);
    expect(invocations[1]).toMatchObject({
      command: '/fake/wash',
      args: ['dev', '--user-config', join(root, '.di-framework', 'wash-dev.yaml')],
    });
    // wash dev provides wasi:logging, so the guest console is linked and declared.
    expect(bundles).toEqual([true]);
    const washConfig = readFileSync(join(root, '.di-framework', 'wash-dev.yaml'), 'utf8');
    expect(washConfig).toContain('package: logging');
    expect(washConfig).toContain('0.1.0-draft');
    expect(output.stdout.join('')).toContain('(wash)');
    expect(result.data).toMatchObject({ runner: 'wash' });
  });

  it('builds and then serves the component with wasmtime', async () => {
    const root = makeProject();
    const invocations: RunnerInvocation[] = [];
    const output = captureIo();
    const deps = fakeDeps({ cwd: root, invocations });
    const bundles: (boolean | undefined)[] = [];
    const bundle = deps.bundler;
    deps.bundler = (options) => {
      bundles.push(options.guestLogging);
      return bundle(options);
    };
    const result = await runWasmcloudDev(['--port', '9123'], output.io, deps);
    // wasmtime cannot link wasi:logging; the guest keeps the noop console.
    expect(bundles).toEqual([false]);
    expect(invocations[1]).toMatchObject({
      command: '/fake/wasmtime',
      args: [
        'serve',
        '-S',
        'cli',
        '-S',
        'p3',
        '-S',
        'config',
        '--addr',
        '127.0.0.1:9123',
        join(root, 'dist', 'demo-app.wasm'),
      ],
    });
    expect(output.stdout.join('')).toContain('http://127.0.0.1:9123');
    expect(output.stdout.join('')).toContain('(wasmtime)');
    expect(result.data).toMatchObject({ host: '127.0.0.1', port: '9123', runner: 'wasmtime' });
  });

  it('maps a failing dev server to WASMCLOUD_TOOL_FAILED', async () => {
    const root = makeProject();
    await expect(
      runWasmcloudDev(
        [],
        captureIo().io,
        fakeDeps({ cwd: root, exitCodes: { 'wasmtime serve': 7 } }),
      ),
    ).rejects.toMatchObject({
      code: 'WASMCLOUD_TOOL_FAILED',
      exitCode: 3,
      details: { command: 'wasmtime serve', exitCode: 7 },
    });
  });

  it('writes a wash 2.5.2 user-config and does not pass --address', async () => {
    const root = makeProject();
    const invocations: RunnerInvocation[] = [];
    await runWasmcloudDev(
      ['--port', '8123'],
      captureIo().io,
      fakeDeps({
        cwd: root,
        invocations,
        wasmtimeBinaryPath: null,
        washBinaryPath: '/fake/wash',
      }),
    );
    expect(invocations[1]).toMatchObject({
      command: '/fake/wash',
      args: ['dev', '--user-config', join(root, '.di-framework', 'wash-dev.yaml')],
    });
    expect(invocations[1]?.args.includes('--address')).toBe(false);
  });

  it('falls back to jco when wasmtime is unavailable', async () => {
    const root = makeProject();
    const invocations: RunnerInvocation[] = [];
    await runWasmcloudDev(
      [],
      captureIo().io,
      fakeDeps({ cwd: root, invocations, wasmtimeBinaryPath: null }),
    );
    expect(invocations[1]).toMatchObject({
      command: '/fake/node',
      args: [
        '/fake/jco.js',
        'serve',
        join(root, 'dist', 'demo-app.wasm'),
        '--host',
        '127.0.0.1',
        '--port',
        '8000',
      ],
    });
  });

  it('honors DI_FRAMEWORK_WASMCLOUD_DEV_RUNNER and fails if that runner is missing', async () => {
    const root = makeProject();
    await expect(
      runWasmcloudDev(
        [],
        captureIo().io,
        fakeDeps({
          cwd: root,
          wasmtimeBinaryPath: null,
          env: { DI_FRAMEWORK_WASMCLOUD_DEV_RUNNER: 'wasmtime' },
        }),
      ),
    ).rejects.toMatchObject({
      code: 'WASMCLOUD_DEV_RUNNER_REQUIRED',
      exitCode: 3,
    });
  });
});
