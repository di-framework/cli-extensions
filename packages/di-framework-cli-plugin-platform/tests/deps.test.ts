import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  componentizeQjsPlatformPackageName,
  componentizeQjsPlatformPackageVersion,
  DEFAULT_DEPS,
  findInstalledComponentizeQjsCli,
  findJcoEntry,
  nativeComponentizeQjsOnPath,
  nodeCompatibilityPlugin,
  resolveComponentizeQjsPath,
} from '../src/deps';

describe('nodeCompatibilityPlugin', () => {
  it('routes the virtual application module and Node built-ins through unenv', () => {
    const plugin = nodeCompatibilityPlugin('/project/src/app.ts');
    expect(plugin.resolveId('virtual:di-framework-application')).toBe('/project/src/app.ts');
    expect(plugin.resolveId('node:fs')).toMatch(/node-compat\/fs\.(ts|js)$/);
    expect(plugin.resolveId('node:net')).toMatch(/node-compat\/net\.(ts|js)$/);
    expect(plugin.resolveId('node:crypto')).toMatch(/node-compat\/crypto\.(ts|js)$/);
    expect(plugin.resolveId('node:http')).toMatch(/node-compat\/http\.(ts|js)$/);
    expect(plugin.resolveId('node:path')).toContain('unenv');
    expect(plugin.resolveId('rolldown')).toBeNull();
    expect(plugin.load('/project/src/app.ts')).toBeNull();
    expect(plugin.resolveId('virtual:di-framework-wasmcloud-guests')).toBe(
      '\0virtual:di-framework-wasmcloud-guests-empty',
    );
    expect(plugin.load('\0virtual:di-framework-wasmcloud-guests-empty')).toContain(
      'Symbol.for("di-framework.wasmcloud.guests")',
    );
    expect(
      nodeCompatibilityPlugin('/app.ts', '/generated/guests.js').resolveId(
        'virtual:di-framework-wasmcloud-guests',
      ),
    ).toBe('/generated/guests.js');
    const seeded = nodeCompatibilityPlugin(
      '/app.ts',
      {
        guestsPath: '/generated/guests.js',
        actorsPath: '/generated/actors.js',
        cronPath: '/generated/cron.js',
        queuesPath: '/generated/queues.js',
      },
      { files: {}, environ: {}, cwd: '/app' },
      { files: { '/ignored': 'x' }, environ: {}, cwd: '/seed' },
    );
    expect(seeded.resolveId('virtual:di-framework-wasmcloud-queues')).toBe('/generated/queues.js');
    expect(seeded.load('\0virtual:di-framework-node-fs-seed')).toContain('"/app"');
    const seededFromMaybe = nodeCompatibilityPlugin(
      '/app.ts',
      { queuesPath: '/generated/queues.js' },
      undefined,
      { files: { '/from-maybe': '1' }, environ: {}, cwd: '/maybe' },
    );
    expect(seededFromMaybe.load('\0virtual:di-framework-node-fs-seed')).toContain('"/from-maybe"');
  });
});

describe('DEFAULT_DEPS', () => {
  it('runs processes and reports their exit codes', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'wasmcloud-deps-'));
    const ok = await DEFAULT_DEPS.runner(process.execPath, ['--version'], { cwd });
    expect(ok.exitCode).toBe(0);
    const failed = await DEFAULT_DEPS.runner(process.execPath, ['-e', 'process.exit(3)'], {
      cwd,
      env: process.env,
    });
    expect(failed.exitCode).toBe(3);
  });

  it('captures probe output and reports unavailable commands', () => {
    expect(DEFAULT_DEPS.capture(process.execPath, ['--version'])).toMatch(/\d+\.\d+/);
    expect(DEFAULT_DEPS.capture('definitely-not-a-command-xyz', [])).toBeUndefined();
    expect(DEFAULT_DEPS.capture(process.execPath, ['-e', 'process.exit(1)'])).toBeUndefined();
  });

  it('captures stdout, stderr, and the exit code of a child process', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'wasmcloud-deps-capture-'));
    const captured = await DEFAULT_DEPS.runCaptured(
      process.execPath,
      ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(4)'],
      { cwd },
    );
    expect(captured.exitCode).toBe(4);
    expect(captured.stdout).toBe('out');
    expect(captured.stderr).toBe('err');

    const withEnv = await DEFAULT_DEPS.runCaptured(
      process.execPath,
      ['-e', 'process.stdout.write(process.env.WASM_CLOUD_DEPS_TEST ?? "")'],
      { cwd, env: { ...process.env, WASM_CLOUD_DEPS_TEST: 'from-env' } },
    );
    expect(withEnv.stdout).toBe('from-env');
    await DEFAULT_DEPS.wait(1);
  });

  it('bundles an entry behind an adapter with the compatibility plugin', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wasmcloud-bundle-'));
    const adapterPath = join(root, 'adapter.ts');
    const entryPath = join(root, 'entry.ts');
    const outFile = join(root, 'out', 'component.js');
    writeFileSync(
      adapterPath,
      "import application from 'virtual:di-framework-application';\nexport const handler = application;\n",
    );
    writeFileSync(
      entryPath,
      "import { writeFileSync } from 'node:fs';\nimport { isAbsolute, resolve } from 'node:path';\nexport default `${isAbsolute(resolve('x'))}:${typeof writeFileSync}`;\n",
    );
    await DEFAULT_DEPS.bundler({ adapterPath, entryPath, outFile });
    expect(existsSync(outFile)).toBe(true);
    expect(readFileSync(outFile, 'utf8')).toContain('handler');
  });

  it('leaves wasi and wasmcloud WIT specifiers as component imports', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wasmcloud-bundle-ext-'));
    const adapterPath = join(root, 'adapter.ts');
    const entryPath = join(root, 'entry.ts');
    const outFile = join(root, 'out', 'component.js');
    writeFileSync(
      adapterPath,
      "import { handle } from 'wasi:http/handler@0.3.0';\nimport { query } from 'wasmcloud:postgres/query@0.2.0';\nexport const handler = { handle, query };\n",
    );
    writeFileSync(entryPath, 'export default 1;\n');
    await DEFAULT_DEPS.bundler({ adapterPath, entryPath, outFile });
    const bundled = readFileSync(outFile, 'utf8');
    expect(bundled).toContain('wasi:http/handler@0.3.0');
    expect(bundled).toContain('wasmcloud:postgres/query@0.2.0');
  });

  it('locates the jco CLI, shipped assets, and project resolutions', () => {
    // A node_modules path (not bun's install cache) so Node can run jco directly.
    expect(DEFAULT_DEPS.jcoCliPath()).toEndWith(
      join('node_modules', '@bytecodealliance', 'jco', 'dist', 'jco.js'),
    );
    expect(findJcoEntry(mkdtempSync(join(tmpdir(), 'wasmcloud-nojco-')))).toBeUndefined();
    expect(['string', 'undefined']).toContain(typeof DEFAULT_DEPS.nodeBinaryPath());
    expect(['string', 'undefined']).toContain(typeof DEFAULT_DEPS.componentizeQjsPath());
    expect(DEFAULT_DEPS.assetsDirectory()).toEndWith(join('dist', 'assets'));
    expect(DEFAULT_DEPS.env).toBe(process.env);
    expect(DEFAULT_DEPS.cwd()).toBe(process.cwd());

    const packageRoot = join(import.meta.dir, '..');
    expect(DEFAULT_DEPS.resolveFromProject(packageRoot, 'rolldown')).toBeDefined();
    expect(
      DEFAULT_DEPS.resolveFromProject(packageRoot, '@definitely/not-installed-xyz'),
    ).toBeUndefined();
  });

  it('prefers DI_FRAMEWORK_COMPONENTIZE_QJS over an installed CLI', () => {
    expect(resolveComponentizeQjsPath({}, undefined)).toBeUndefined();
    expect(resolveComponentizeQjsPath({}, undefined, '/usr/bin/componentize-qjs')).toBe(
      '/usr/bin/componentize-qjs',
    );
    expect(
      resolveComponentizeQjsPath({ DI_FRAMEWORK_COMPONENTIZE_QJS: '  ' }, '/opt/installed'),
    ).toBe('/opt/installed');
    expect(
      resolveComponentizeQjsPath(
        { DI_FRAMEWORK_COMPONENTIZE_QJS: '/opt/componentize-qjs' },
        '/opt/installed',
        '/usr/bin/componentize-qjs',
      ),
    ).toBe('/opt/componentize-qjs');
    expect(nativeComponentizeQjsOnPath(undefined)).toBeUndefined();
    expect(nativeComponentizeQjsOnPath('/usr/local/bin/componentize-qjs')).toBe(
      '/usr/local/bin/componentize-qjs',
    );
    expect(
      nativeComponentizeQjsOnPath('/home/runner/work/repo/node_modules/.bin/componentize-qjs'),
    ).toBeUndefined();
  });
});

describe('findInstalledComponentizeQjsCli', () => {
  it('names the native CLI as a version of the single npm package', () => {
    expect(componentizeQjsPlatformPackageName()).toBe('@di-framework/componentize-qjs');
    expect(componentizeQjsPlatformPackageVersion('darwin', 'arm64', '0.4.4-di.2')).toBe(
      '0.4.4-di.2-darwin-arm64',
    );
    expect(componentizeQjsPlatformPackageVersion('linux', 'x64', '0.4.4-di.2')).toBe(
      '0.4.4-di.2-linux-x64',
    );
  });

  it('walks node_modules for a same-package native CLI version', () => {
    const root = mkdtempSync(join(tmpdir(), 'wasmcloud-qjs-walk-'));
    writeFileSync(join(root, 'package.json'), '{}\n');
    const pkgDir = join(root, 'node_modules', '@di-framework', 'componentize-qjs');
    const binDir = join(pkgDir, 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({
        name: '@di-framework/componentize-qjs',
        version: '0.4.4-di.2-linux-x64',
        os: ['linux'],
        cpu: ['x64'],
      }),
    );
    const bin = join(binDir, 'componentize-qjs');
    writeFileSync(bin, '#!/bin/sh\n');
    expect(findInstalledComponentizeQjsCli(root, 'linux', 'x64')).toBe(bin);
    expect(findInstalledComponentizeQjsCli(root, 'linux', 'arm64')).toBeUndefined();
    expect(findInstalledComponentizeQjsCli(root, 'darwin', 'arm64')).toBeUndefined();
  });

  it('ignores a native version whose suffix is a different platform', () => {
    const root = mkdtempSync(join(tmpdir(), 'wasmcloud-qjs-ver-'));
    writeFileSync(join(root, 'package.json'), '{}\n');
    const pkgDir = join(root, 'node_modules', '@di-framework', 'componentize-qjs');
    mkdirSync(join(pkgDir, 'bin'), { recursive: true });
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({
        name: '@di-framework/componentize-qjs',
        version: '0.4.4-di.2-linux-x64',
      }),
    );
    writeFileSync(join(pkgDir, 'bin', 'componentize-qjs'), '#!/bin/sh\n');
    expect(findInstalledComponentizeQjsCli(root, 'linux', 'arm64')).toBeUndefined();
  });

  it('treats an unreadable platform package.json as matching', () => {
    const root = mkdtempSync(join(tmpdir(), 'wasmcloud-qjs-badjson-'));
    writeFileSync(join(root, 'package.json'), '{}\n');
    const pkgDir = join(root, 'node_modules', '@di-framework', 'componentize-qjs');
    mkdirSync(join(pkgDir, 'bin'), { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), '{not json');
    const bin = join(pkgDir, 'bin', 'componentize-qjs');
    writeFileSync(bin, '#!/bin/sh\n');
    expect(findInstalledComponentizeQjsCli(root, 'linux', 'x64')).toBe(bin);
  });

  it('walks node_modules for the wrapper alias folder', () => {
    const root = mkdtempSync(join(tmpdir(), 'wasmcloud-qjs-alias-'));
    writeFileSync(join(root, 'package.json'), '{}\n');
    const binDir = join(root, 'node_modules', 'componentize-qjs-linux-x64', 'bin');
    mkdirSync(binDir, { recursive: true });
    const bin = join(binDir, 'componentize-qjs');
    writeFileSync(bin, '#!/bin/sh\n');
    expect(findInstalledComponentizeQjsCli(root, 'linux', 'x64')).toBe(bin);
  });

  it('walks node_modules for the Windows CLI binary', () => {
    const root = mkdtempSync(join(tmpdir(), 'wasmcloud-qjs-win-'));
    writeFileSync(join(root, 'package.json'), '{}\n');
    const binDir = join(root, 'node_modules', 'componentize-qjs-win32-x64', 'bin');
    mkdirSync(binDir, { recursive: true });
    const bin = join(binDir, 'componentize-qjs.exe');
    writeFileSync(bin, 'MZ');
    expect(findInstalledComponentizeQjsCli(root, 'win32', 'x64')).toBe(bin);
  });

  it('uses nativeCliPath from the wrapper package when the platform package is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'wasmcloud-qjs-wrapper-'));
    const cli = join(root, 'fake-cli');
    writeFileSync(cli, '#!/bin/sh\n');
    writeFileSync(join(root, 'package.json'), '{}\n');
    const wrapper = join(root, 'node_modules', '@di-framework', 'componentize-qjs');
    mkdirSync(wrapper, { recursive: true });
    writeFileSync(
      join(wrapper, 'package.json'),
      JSON.stringify({ name: '@di-framework/componentize-qjs', main: './index.cjs' }),
    );
    writeFileSync(
      join(wrapper, 'index.cjs'),
      [
        'const { join } = require("node:path");',
        'module.exports = {',
        '  nativeCliPath: () => join(__dirname, "..", "..", "..", "fake-cli"),',
        '};',
        '',
      ].join('\n'),
    );
    expect(findInstalledComponentizeQjsCli(root, 'linux', 'x64')).toBe(cli);
  });

  it('ignores a wrapper nativeCliPath that does not exist on disk', () => {
    const root = mkdtempSync(join(tmpdir(), 'wasmcloud-qjs-missing-'));
    writeFileSync(join(root, 'package.json'), '{}\n');
    const wrapper = join(root, 'node_modules', '@di-framework', 'componentize-qjs');
    mkdirSync(wrapper, { recursive: true });
    writeFileSync(
      join(wrapper, 'package.json'),
      JSON.stringify({ name: '@di-framework/componentize-qjs', main: './index.cjs' }),
    );
    writeFileSync(
      join(wrapper, 'index.cjs'),
      'module.exports = { nativeCliPath: () => "/no/such/componentize-qjs" };\n',
    );
    expect(findInstalledComponentizeQjsCli(root, 'linux', 'x64')).toBeUndefined();
  });

  it('returns undefined when the wrapper has no nativeCliPath export', () => {
    const root = mkdtempSync(join(tmpdir(), 'wasmcloud-qjs-empty-'));
    writeFileSync(join(root, 'package.json'), '{}\n');
    const wrapper = join(root, 'node_modules', '@di-framework', 'componentize-qjs');
    mkdirSync(wrapper, { recursive: true });
    writeFileSync(
      join(wrapper, 'package.json'),
      JSON.stringify({ name: '@di-framework/componentize-qjs', main: './index.cjs' }),
    );
    writeFileSync(join(wrapper, 'index.cjs'), 'module.exports = {};\n');
    expect(findInstalledComponentizeQjsCli(root, 'linux', 'x64')).toBeUndefined();
  });
});

it('retains registration side effects and emits one bundle for dynamic imports', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wasmcloud-registration-'));
  const adapterPath = join(root, 'adapter.ts');
  const entryPath = join(root, 'entry.ts');
  const outFile = join(root, 'component.js');
  writeFileSync(
    join(root, 'registration.ts'),
    'globalThis.__diRegistration = "registered-service";',
  );
  writeFileSync(join(root, 'lazy.ts'), 'export default "dynamic-service";');
  writeFileSync(
    entryPath,
    'import "./registration.ts"; export default async () => (await import("./lazy.ts")).default;',
  );
  writeFileSync(
    adapterPath,
    'import application from "virtual:di-framework-application"; export const run = application;',
  );
  await DEFAULT_DEPS.bundler({ adapterPath, entryPath, outFile });
  const code = readFileSync(outFile, 'utf8');
  expect(code).toContain('registered-service');
  expect(code).toContain('dynamic-service');
  expect(code).not.toMatch(/import\(["']\.\//);
});
