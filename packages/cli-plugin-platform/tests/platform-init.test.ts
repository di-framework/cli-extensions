import { describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { runWasmcloudPlatformDeploy } from '../src/platform';
import {
  createPlatformProjectName,
  PLATFORM_START_COMMAND,
  runWasmcloudPlatformInit,
  serializeDeployToml,
} from '../src/platform-init';
import { captureIo, fakeDeps, platformOutputJson, type RunnerInvocation } from './helpers';

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');

describe('runWasmcloudPlatformInit', () => {
  it('generates deploy/platform and registers the default local target', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wasmcloud-init-'));
    const output = captureIo();
    const result = await runWasmcloudPlatformInit(
      [],
      output.io,
      fakeDeps({ cwd: root, assets: ASSETS }),
    );

    const platform = join(root, 'deploy', 'platform');
    const pulumi = readFileSync(join(platform, 'Pulumi.yaml'), 'utf8');
    const program = readFileSync(join(platform, 'index.ts'), 'utf8');
    expect(pulumi).toContain(`name: ${createPlatformProjectName(root)}`);
    expect(pulumi).not.toContain('{{DI_FRAMEWORK_PLATFORM_PROJECT}}');
    expect(program).toContain("from '@di-framework/platform/local'");
    const dependencies = JSON.parse(
      readFileSync(join(platform, 'package.json'), 'utf8'),
    ).dependencies;
    expect(dependencies['@di-framework/platform']).toBe(
      JSON.parse(
        readFileSync(
          fileURLToPath(import.meta.resolve('@di-framework/platform/package.json')),
          'utf8',
        ),
      ).version,
    );
    expect(readFileSync(join(platform, '.gitignore'), 'utf8')).toContain('.kubeconfig-*');
    expect(readFileSync(join(root, 'di-framework.deploy.toml'), 'utf8')).toContain(
      'default-target = "local"',
    );
    expect(readFileSync(join(root, 'di-framework.deploy.toml'), 'utf8')).toContain(
      'platform = "deploy/platform"',
    );
    expect(result.data).toMatchObject({
      startCommand: PLATFORM_START_COMMAND,
      defaultTarget: 'local',
    });
    expect(result.text).toContain(PLATFORM_START_COMMAND);
    expect(output.stdout.join('')).toContain(PLATFORM_START_COMMAND);
  });

  it('can immediately run the printed deploy command with Pulumi installing dependencies', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wasmcloud-init-deploy-'));
    const initialized = await runWasmcloudPlatformInit(
      [],
      captureIo().io,
      fakeDeps({ cwd: root, assets: ASSETS }),
    );
    const invocations: RunnerInvocation[] = [];
    await runWasmcloudPlatformDeploy(
      ['local', '--yes'],
      captureIo().io,
      fakeDeps({
        cwd: root,
        invocations,
        capturedStdout: {
          'pulumi stack output': platformOutputJson(join(root, 'deploy/platform/.kubeconfig-dev')),
        },
      }),
    );

    expect(initialized.data).toMatchObject({ startCommand: PLATFORM_START_COMMAND });
    expect(invocations[0]).toMatchObject({
      command: 'pulumi',
      args: ['install'],
      cwd: join(root, 'deploy', 'platform'),
    });
  });

  it('preserves existing platform files and a conflicting local target without --force', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wasmcloud-init-skip-'));
    mkdirSync(join(root, 'deploy', 'platform'), { recursive: true });
    writeFileSync(join(root, 'deploy', 'platform', 'Pulumi.yaml'), 'name: keep-me\n');
    writeFileSync(
      join(root, 'di-framework.deploy.toml'),
      `[targets.local]
platform = "other/platform"
stack = "prod"

[targets.development]
kubeconfig = "\${KUBECONFIG}"
namespace = "wasmcloud"
registry = "registry.example.com/team"
`,
    );

    const output = captureIo();
    await runWasmcloudPlatformInit([], output.io, fakeDeps({ cwd: root, assets: ASSETS }));

    expect(readFileSync(join(root, 'deploy', 'platform', 'Pulumi.yaml'), 'utf8')).toBe(
      'name: keep-me\n',
    );
    expect(readFileSync(join(root, 'di-framework.deploy.toml'), 'utf8')).toContain(
      'platform = "other/platform"',
    );
    expect(readFileSync(join(root, 'di-framework.deploy.toml'), 'utf8')).toContain(
      `kubeconfig = "\${KUBECONFIG}"`,
    );
    expect(output.stdout.join('')).toContain('use --force to overwrite');
  });

  it('overwrites with --force and keeps other targets', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wasmcloud-init-force-'));
    mkdirSync(join(root, 'deploy', 'platform'), { recursive: true });
    writeFileSync(join(root, 'deploy', 'platform', 'Pulumi.yaml'), 'name: keep-me\n');
    writeFileSync(
      join(root, 'di-framework.deploy.toml'),
      `default-target = "development"

[targets.local]
platform = "other/platform"
stack = "prod"

[targets.development]
kubeconfig = "\${KUBECONFIG}"
namespace = "wasmcloud"
registry = "registry.example.com/team"
`,
    );

    await runWasmcloudPlatformInit(
      ['--force'],
      captureIo().io,
      fakeDeps({ cwd: root, assets: ASSETS }),
    );

    expect(readFileSync(join(root, 'deploy', 'platform', 'Pulumi.yaml'), 'utf8')).toContain(
      'di-framework-wasmcloud-',
    );
    const manifest = readFileSync(join(root, 'di-framework.deploy.toml'), 'utf8');
    expect(manifest).toContain('default-target = "local"');
    expect(manifest).toContain('platform = "deploy/platform"');
    expect(manifest).toContain('stack = "dev"');
    expect(manifest).toContain('[targets.development]');
    expect(manifest).toContain(`kubeconfig = "\${KUBECONFIG}"`);
  });

  it('adds a missing local target to an existing manifest without clobbering default-target', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wasmcloud-init-merge-'));
    writeFileSync(
      join(root, 'di-framework.deploy.toml'),
      `default-target = "development"

[targets.development]
kubeconfig = "/tmp/kube"
namespace = "wasmcloud"
registry = "registry.example.com/team"
`,
    );

    await runWasmcloudPlatformInit([], captureIo().io, fakeDeps({ cwd: root, assets: ASSETS }));
    const manifest = readFileSync(join(root, 'di-framework.deploy.toml'), 'utf8');
    expect(manifest).toContain('default-target = "development"');
    expect(manifest).toContain('[targets.local]');
    expect(manifest).toContain('platform = "deploy/platform"');
    expect(manifest).toContain('[targets.development]');
  });

  it('uses an ancestor workspace when a deploy manifest already exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wasmcloud-init-nested-'));
    writeFileSync(
      join(root, 'di-framework.deploy.toml'),
      `default-target = "local"\n[targets.local]\nplatform = "deploy/platform"\nstack = "dev"\n`,
    );
    const nested = join(root, 'services', 'greeter');
    mkdirSync(nested, { recursive: true });
    await runWasmcloudPlatformInit([], captureIo().io, fakeDeps({ cwd: nested, assets: ASSETS }));
    expect(readFileSync(join(root, 'deploy', 'platform', 'Pulumi.yaml'), 'utf8')).toContain(
      'di-framework-wasmcloud-',
    );
  });

  it('fails when platform templates are missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wasmcloud-init-notemplates-'));
    const assets = mkdtempSync(join(tmpdir(), 'wasmcloud-empty-assets-'));
    mkdirSync(join(assets, 'platform'), { recursive: true });
    await expect(
      runWasmcloudPlatformInit([], captureIo().io, fakeDeps({ cwd: root, assets })),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_PLATFORM_TEMPLATE_NOT_FOUND', exitCode: 3 });
  });

  it('copies nested template files and preserves discovery plus escaped strings', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wasmcloud-init-nested-tmpl-'));
    const assets = mkdtempSync(join(tmpdir(), 'wasmcloud-nested-assets-'));
    const platformTemplates = join(assets, 'platform');
    mkdirSync(join(platformTemplates, 'charts'), { recursive: true });
    writeFileSync(join(platformTemplates, 'Pulumi.yaml'), 'name: wasmcloud-platform\n');
    writeFileSync(join(platformTemplates, 'charts', 'notes.txt'), 'nested\n');
    writeFileSync(
      join(root, 'di-framework.deploy.toml'),
      `default-target = "development"

[discovery]
include = ["services/**"]
exclude = ["vendor/**"]

[targets.development]
kubeconfig = "C:\\\\kube"
namespace = "wasmcloud"
registry = "registry.example.com/team"
`,
    );

    await runWasmcloudPlatformInit([], captureIo().io, fakeDeps({ cwd: root, assets }));
    expect(readFileSync(join(root, 'deploy', 'platform', 'charts', 'notes.txt'), 'utf8')).toBe(
      'nested\n',
    );
    const manifest = readFileSync(join(root, 'di-framework.deploy.toml'), 'utf8');
    expect(manifest).toContain('[discovery]');
    expect(manifest).toContain('include = ["services/**"]');
    expect(manifest).toContain('[targets.local]');
  });

  it('rejects an existing manifest that cannot be parsed or declares apps', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wasmcloud-init-badmanifest-'));
    writeFileSync(join(root, 'di-framework.deploy.toml'), 'default-target = [\n');
    await expect(
      runWasmcloudPlatformInit([], captureIo().io, fakeDeps({ cwd: root, assets: ASSETS })),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_DEPLOY_MANIFEST_INVALID', exitCode: 2 });

    writeFileSync(
      join(root, 'di-framework.deploy.toml'),
      `apps = "nope"\n[targets.local]\nplatform = "deploy/platform"\n`,
    );
    await expect(
      runWasmcloudPlatformInit([], captureIo().io, fakeDeps({ cwd: root, assets: ASSETS })),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_DEPLOY_MANIFEST_INVALID', exitCode: 2 });
  });

  it('propagates unexpected errors when the deploy manifest cannot be read', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wasmcloud-init-eisdir-'));
    mkdirSync(join(root, 'di-framework.deploy.toml'));
    await expect(
      runWasmcloudPlatformInit([], captureIo().io, fakeDeps({ cwd: root, assets: ASSETS })),
    ).rejects.toThrow();
  });

  it('propagates unexpected write errors when a template cannot be created', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wasmcloud-init-eacces-'));
    const platformRoot = join(root, 'deploy', 'platform');
    mkdirSync(platformRoot, { recursive: true });
    chmodSync(platformRoot, 0o555);
    try {
      await expect(
        runWasmcloudPlatformInit([], captureIo().io, fakeDeps({ cwd: root, assets: ASSETS })),
      ).rejects.toThrow();
    } finally {
      chmodSync(platformRoot, 0o755);
    }
  });

  it('serializes local first, skips non-tables, and escapes quotes', () => {
    const rendered = serializeDeployToml({
      'default-target': 'local',
      discovery: { include: ['a/**'], exclude: ['b/**'] },
      targets: {
        zed: {
          kubeconfig: 'say "hi"',
          namespace: 'ns',
          registry: { push: 'http://127.0.0.1:25000', pull: 'registry:5000', insecure: true },
        },
        local: { platform: 'deploy/platform', stack: 'dev' },
        skip: 1,
      },
    });
    expect(rendered.indexOf('[targets.local]')).toBeLessThan(rendered.indexOf('[targets.zed]'));
    expect(rendered).toContain('kubeconfig = "say \\"hi\\""');
    expect(rendered).not.toContain('[targets.skip]');
    expect(rendered).toContain('include = ["a/**"]');
    expect(rendered).toContain('[targets.zed.registry]');
    expect(rendered).toContain('push = "http://127.0.0.1:25000"');
    expect(rendered).toContain('insecure = true');
  });

  it('derives different Pulumi project identities for different consumer workspaces', () => {
    expect(createPlatformProjectName('/tmp/consumer-one')).not.toBe(
      createPlatformProjectName('/tmp/consumer-two'),
    );
    expect(createPlatformProjectName(`/tmp/${'-'.repeat(10_000)}consumer`)).toMatch(
      /^di-framework-wasmcloud-consumer-[a-f0-9]{10}$/,
    );
  });

  it('scaffolds a nodenext tsconfig and kubeconfigs re-export that type-check cleanly', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wasmcloud-init-typecheck-'));
    await runWasmcloudPlatformInit([], captureIo().io, fakeDeps({ cwd: root, assets: ASSETS }));

    const platform = join(root, 'deploy', 'platform');
    const tsconfig = JSON.parse(readFileSync(join(platform, 'tsconfig.json'), 'utf8')) as {
      compilerOptions: { module: string; moduleResolution: string };
    };
    expect(tsconfig.compilerOptions.module).toBe('nodenext');
    expect(tsconfig.compilerOptions.moduleResolution).toBe('nodenext');

    const indexTs = readFileSync(join(platform, 'index.ts'), 'utf8');
    expect(indexTs).toContain(
      "export { schemaVersion, kubeconfig, namespace, registry, endpoints, tenants, users, kubeconfigs } from '@di-framework/platform/local';",
    );

    const readme = readFileSync(join(platform, 'README.md'), 'utf8');
    expect(readme).toContain(
      'ghcr.io/di-framework/wash:2.8.0-wasi-tls@sha256:d88158b0b09edd9fc3e79d787762697c60f65baf134d895529e85d6c47cd80ad',
    );
    expect(readme).toContain(
      'ghcr.io/di-framework/wash:2.8.0-wasi-tls-exclusive@sha256:0ee414e9db4b0d4fc923eb477f1b1afd20f707b8ab3e552957575ff4f8e6a528',
    );
    expect(readme).not.toContain(
      'ee89fd4bce4f9f35f4cd09c63d3cbdd07bea3071b5d372f82c9f49b9741c3669',
    );
    expect(readme).toContain('insecureRegistries');

    const stubPkgDir = join(platform, 'node_modules', '@di-framework', 'platform');
    mkdirSync(stubPkgDir, { recursive: true });
    writeFileSync(
      join(stubPkgDir, 'package.json'),
      JSON.stringify({
        name: '@di-framework/platform',
        version: '0.0.0',
        exports: {
          './local': {
            types: './local.d.ts',
            default: './local.js',
          },
        },
      }),
    );
    writeFileSync(
      join(stubPkgDir, 'local.d.ts'),
      [
        'export declare const schemaVersion: 2;',
        'export declare const kubeconfig: unknown;',
        'export declare const namespace: unknown;',
        'export declare const registry: unknown;',
        'export declare const endpoints: unknown;',
        'export declare const tenants: unknown;',
        'export declare const users: unknown;',
        'export declare const kubeconfigs: unknown;',
      ].join('\n'),
    );

    const parsed = ts.parseJsonConfigFileContent(tsconfig, ts.sys, platform);
    expect(parsed.errors).toEqual([]);
    expect(parsed.options.module).toBe(ts.ModuleKind.NodeNext);
    expect(parsed.options.moduleResolution).toBe(ts.ModuleResolutionKind.NodeNext);

    const program = ts.createProgram({
      rootNames: parsed.fileNames,
      options: { ...parsed.options, noEmit: true },
    });
    expect(ts.getPreEmitDiagnostics(program)).toEqual([]);
  });
});
