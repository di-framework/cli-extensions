import { describe, expect, it } from 'bun:test';
import { DEV_RUNNER_ENV, requiresWasmCloudHost, resolveDevRunner } from '../src/dev-runner';
import { fakeDeps, makeProject } from './helpers';

describe('resolveDevRunner', () => {
  it('detects wasmCloud host-interface imports', () => {
    expect(requiresWasmCloudHost([{ package: 'wasi:http' }])).toBe(false);
    expect(requiresWasmCloudHost([{ package: 'wasmcloud:keyvalue' }])).toBe(true);
  });

  it('selects wash when the guest needs a wasmCloud host, even if wasmtime is present', () => {
    const cwd = makeProject();
    expect(
      resolveDevRunner(fakeDeps({ cwd, washBinaryPath: '/fake/wash' }), { wasmCloudHost: true })
        .kind,
    ).toBe('wash');
    expect(
      resolveDevRunner(
        fakeDeps({ cwd, washBinaryPath: '/fake/wash', env: { [DEV_RUNNER_ENV]: 'wasmtime' } }),
        { wasmCloudHost: true },
      ).kind,
    ).toBe('wasmtime');
  });

  it('requires wash when the guest needs a wasmCloud host and wash is missing', () => {
    const cwd = makeProject();
    try {
      resolveDevRunner(fakeDeps({ cwd, washBinaryPath: null }), { wasmCloudHost: true });
      throw new Error('expected CommandFailure');
    } catch (error) {
      expect(error).toMatchObject({ code: 'WASMCLOUD_DEV_RUNNER_REQUIRED', exitCode: 3 });
    }
  });

  it('prefers wasmtime, then wash, then jco', () => {
    const cwd = makeProject();
    expect(resolveDevRunner(fakeDeps({ cwd })).kind).toBe('wasmtime');
    expect(
      resolveDevRunner(fakeDeps({ cwd, wasmtimeBinaryPath: null, washBinaryPath: '/fake/wash' }))
        .kind,
    ).toBe('wash');
    expect(resolveDevRunner(fakeDeps({ cwd, wasmtimeBinaryPath: null })).kind).toBe('jco');
  });

  it('selects an explicit runner from the environment', () => {
    const cwd = makeProject();
    const runner = resolveDevRunner(
      fakeDeps({
        cwd,
        washBinaryPath: '/fake/wash',
        env: { [DEV_RUNNER_ENV]: 'wash' },
      }),
    );
    expect(runner.kind).toBe('wash');
    expect(runner.command).toBe('/fake/wash');
    expect(
      runner.args({
        componentPath: 'app.wasm',
        host: '127.0.0.1',
        port: '8000',
        washConfigPath: '/tmp/wash-dev.yaml',
      }),
    ).toEqual(['dev', '--user-config', '/tmp/wash-dev.yaml']);
  });

  it('uses wasmtime and jco argument conventions when those runners are selected', () => {
    const cwd = makeProject();
    const wasmtime = resolveDevRunner(fakeDeps({ cwd, env: { [DEV_RUNNER_ENV]: 'wasmtime' } }));
    expect(wasmtime.args({ componentPath: 'app.wasm', host: '0.0.0.0', port: '9000' })).toEqual([
      'serve',
      '-S',
      'cli',
      '-S',
      'p3',
      '-S',
      'config',
      '--addr',
      '0.0.0.0:9000',
      'app.wasm',
    ]);
    const jco = resolveDevRunner(
      fakeDeps({ cwd, wasmtimeBinaryPath: null, env: { [DEV_RUNNER_ENV]: 'jco' } }),
    );
    expect(jco.command).toBe('/fake/node');
    expect(jco.args({ componentPath: 'app.wasm', host: '127.0.0.1', port: '8000' })).toEqual([
      '/fake/jco.js',
      'serve',
      'app.wasm',
      '--host',
      '127.0.0.1',
      '--port',
      '8000',
    ]);
  });

  it('treats a blank runner override as unset', () => {
    const cwd = makeProject();
    expect(resolveDevRunner(fakeDeps({ cwd, env: { [DEV_RUNNER_ENV]: '  ' } })).kind).toBe(
      'wasmtime',
    );
  });

  it('rejects an unknown runner override', () => {
    const cwd = makeProject();
    try {
      resolveDevRunner(fakeDeps({ cwd, env: { [DEV_RUNNER_ENV]: 'deno' } }));
      throw new Error('expected CommandFailure');
    } catch (error) {
      expect(error).toMatchObject({ code: 'WASMCLOUD_DEV_RUNNER_UNKNOWN', exitCode: 2 });
    }
  });

  it('rejects a requested runner that is not installed', () => {
    const cwd = makeProject();
    try {
      resolveDevRunner(
        fakeDeps({
          cwd,
          washBinaryPath: null,
          env: { [DEV_RUNNER_ENV]: 'wash' },
        }),
      );
      throw new Error('expected CommandFailure');
    } catch (error) {
      expect(error).toMatchObject({ code: 'WASMCLOUD_DEV_RUNNER_REQUIRED', exitCode: 3 });
    }
    try {
      resolveDevRunner(
        fakeDeps({
          cwd,
          nodeBinaryPath: null,
          env: { [DEV_RUNNER_ENV]: 'jco' },
        }),
      );
      throw new Error('expected CommandFailure');
    } catch (error) {
      expect(error).toMatchObject({ code: 'WASMCLOUD_DEV_RUNNER_REQUIRED', exitCode: 3 });
    }
  });

  it('fails when no local runner is available', () => {
    const cwd = makeProject();
    try {
      resolveDevRunner(
        fakeDeps({
          cwd,
          wasmtimeBinaryPath: null,
          washBinaryPath: null,
          nodeBinaryPath: null,
        }),
      );
      throw new Error('expected CommandFailure');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'WASMCLOUD_DEV_RUNNER_REQUIRED',
        exitCode: 3,
      });
    }
  });
});
