import { describe, expect, it } from 'bun:test';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadDeployManifest } from '../src/manifest';
import {
  loadPlatformOutputs,
  runWasmcloudPlatformDeploy,
  runWasmcloudPlatformDestroy,
} from '../src/platform';
import { resolveTarget } from '../src/target';
import {
  captureIo,
  expectFailure,
  fakeDeps,
  makeWorkspace,
  platformOutputJson,
  type RunnerInvocation,
} from './helpers';

describe('target resolution', () => {
  it('selects default-target and an explicit --target', () => {
    const { root } = makeWorkspace();
    const manifest = loadDeployManifest(root, {});
    expect(resolveTarget(manifest).name).toBe('local');
    expect(resolveTarget(manifest, 'development').kind).toBe('external');
  });

  it('fails for unknown targets', () => {
    const { root } = makeWorkspace();
    const manifest = loadDeployManifest(root, {});
    expectFailure(() => resolveTarget(manifest, 'prod'), 'WASMCLOUD_TARGET_NOT_FOUND', 2);
  });

  it('fails when neither --target nor default-target is set', () => {
    const { root } = makeWorkspace({
      manifest: `[targets.local]
platform = "deploy/platform"
stack = "dev"
`,
    });
    const manifest = loadDeployManifest(root, {});
    expectFailure(() => resolveTarget(manifest), 'WASMCLOUD_TARGET_NOT_FOUND', 2);
  });
});

describe('runWasmcloudPlatformDeploy', () => {
  it('rejects an invalid namespace returned by Pulumi', async () => {
    const { root, kubeconfig } = makeWorkspace();
    const outputs = JSON.parse(platformOutputJson(kubeconfig));
    outputs.namespace = '../tenant';
    await expect(
      runWasmcloudPlatformDeploy(
        ['local', '--yes'],
        captureIo().io,
        fakeDeps({
          cwd: root,
          capturedStdout: { 'pulumi stack output': JSON.stringify(outputs) },
        }),
      ),
    ).rejects.toThrow('Kubernetes namespace');
  });

  it('runs pulumi up for a managed target and reads the output contract', async () => {
    const { root, kubeconfig } = makeWorkspace();
    const invocations: RunnerInvocation[] = [];
    const result = await runWasmcloudPlatformDeploy(
      ['local', '--yes'],
      captureIo().io,
      fakeDeps({
        cwd: root,
        invocations,
        capturedStdout: { 'pulumi stack output': platformOutputJson(kubeconfig) },
      }),
    );
    const pulumi = invocations.filter((invocation) => invocation.command === 'pulumi');
    expect(pulumi.map((invocation) => invocation.args)).toEqual([
      ['install'],
      ['stack', 'select', 'dev', '--create'],
      ['up', '--yes'],
      ['stack', 'select', 'dev'],
      ['stack', 'output', '--json'],
    ]);
    expect(pulumi[0]?.cwd).toBe(join(root, 'deploy', 'platform'));
    expect(pulumi[0]?.env?.PULUMI_BACKEND_URL).toContain('/deploy/platform/.pulumi-state');
    expect(result.data).toMatchObject({
      target: 'local',
      stack: 'dev',
      namespace: 'wasmcloud',
      registry: {
        push: 'http://127.0.0.1:25000',
        pull: 'di-framework-registry.wasmcloud.svc.cluster.local:5000',
        insecure: true,
      },
    });
  });

  it('refuses to deploy a kubeconfig-only target as a platform', async () => {
    const { root } = makeWorkspace();
    await expect(
      runWasmcloudPlatformDeploy(['development'], captureIo().io, fakeDeps({ cwd: root })),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_TARGET_INVALID', exitCode: 2 });
  });

  it('maps missing Pulumi.yaml and bad outputs to typed failures', async () => {
    const { root } = makeWorkspace();
    mkdirSync(join(root, 'deploy', 'empty'), { recursive: true });
    writeFileSync(
      join(root, 'di-framework.deploy.toml'),
      `[targets.broken]\nplatform = "deploy/empty"\n`,
    );
    await expect(
      runWasmcloudPlatformDeploy(['broken'], captureIo().io, fakeDeps({ cwd: root })),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_PLATFORM_NOT_FOUND', exitCode: 2 });

    const healthy = makeWorkspace();
    await expect(
      loadPlatformOutputs(
        fakeDeps({
          cwd: healthy.root,
          capturedStdout: { 'pulumi stack output': '{"namespace":"wasmcloud"}' },
        }),
        join(healthy.root, 'deploy', 'platform'),
        'dev',
        'local',
      ),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_PLATFORM_OUTPUT_INVALID', exitCode: 2 });

    await expect(
      loadPlatformOutputs(
        fakeDeps({
          cwd: healthy.root,
          exitCodes: { 'pulumi stack output': 1 },
        }),
        join(healthy.root, 'deploy', 'platform'),
        'dev',
        'local',
      ),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_PLATFORM_NOT_READY', exitCode: 3 });

    await expect(
      loadPlatformOutputs(
        fakeDeps({
          cwd: healthy.root,
          capturedStdout: { 'pulumi stack output': 'not-json' },
        }),
        join(healthy.root, 'deploy', 'platform'),
        'dev',
        'local',
      ),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_PLATFORM_OUTPUT_INVALID', exitCode: 2 });

    await expect(
      loadPlatformOutputs(
        fakeDeps({
          cwd: healthy.root,
          capturedStdout: { 'pulumi stack output': '[]' },
        }),
        join(healthy.root, 'deploy', 'platform'),
        'dev',
        'local',
      ),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_PLATFORM_OUTPUT_INVALID', exitCode: 2 });

    await expect(
      loadPlatformOutputs(
        fakeDeps({
          cwd: healthy.root,
          capturedStdout: {
            'pulumi stack output': JSON.stringify({
              kubeconfig: '/tmp/kube',
              namespace: 'wasmcloud',
              registry: 'localhost:5000',
              endpoints: ['http://127.0.0.1'],
            }),
          },
        }),
        join(healthy.root, 'deploy', 'platform'),
        'dev',
        'local',
      ),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_PLATFORM_OUTPUT_INVALID', exitCode: 2 });

    for (const output of [
      {
        schemaVersion: 99,
        kubeconfig: '/tmp/kube',
        namespace: 'wasmcloud',
        registry: 'localhost:5000',
      },
      { kubeconfig: '/tmp/kube', namespace: 'wasmcloud', registry: null },
    ]) {
      await expect(
        loadPlatformOutputs(
          fakeDeps({
            cwd: healthy.root,
            capturedStdout: { 'pulumi stack output': JSON.stringify(output) },
          }),
          join(healthy.root, 'deploy', 'platform'),
          'dev',
          'local',
        ),
      ).rejects.toMatchObject({ code: 'WASMCLOUD_PLATFORM_OUTPUT_INVALID', exitCode: 2 });
    }
  });

  it('writes inline kubeconfig YAML and keeps optional output fields', async () => {
    const { root } = makeWorkspace();
    const platformRoot = join(root, 'deploy', 'platform');
    const outputs = await loadPlatformOutputs(
      fakeDeps({
        cwd: root,
        capturedStdout: {
          'pulumi stack output': JSON.stringify({
            kubeconfig: 'apiVersion: v1\nkind: Config',
            namespace: 'wasmcloud',
            registry: 'localhost:5000',
            context: 'k0s',
            endpoints: {
              http: 'http://127.0.0.1',
              kubernetes: 'https://127.0.0.1:6443',
              registry: 'localhost:5000',
            },
          }),
        },
      }),
      platformRoot,
      'dev',
      'local',
    );
    expect(outputs.kubeconfig).toBe(join(platformRoot, '.di-framework', 'kubeconfig.yaml'));
    expect(readFileSync(outputs.kubeconfig, 'utf8')).toBe('apiVersion: v1\nkind: Config\n');
    expect(statSync(outputs.kubeconfig).mode & 0o777).toBe(0o600);
    expect(outputs.registry).toEqual({
      push: 'localhost:5000',
      pull: 'localhost:5000',
      insecure: false,
    });
    expect(outputs.context).toBe('k0s');
    expect(outputs.endpoints).toEqual({
      http: 'http://127.0.0.1',
      kubernetes: 'https://127.0.0.1:6443',
      registry: 'localhost:5000',
    });
  });

  it('validates and preserves separate registry transport endpoints', async () => {
    const { root } = makeWorkspace();
    const platformRoot = join(root, 'deploy', 'platform');
    const outputs = await loadPlatformOutputs(
      fakeDeps({
        cwd: root,
        capturedStdout: {
          'pulumi stack output': JSON.stringify({
            schemaVersion: 2,
            kubeconfig: '.kubeconfig-dev',
            namespace: 'wasmcloud',
            registry: {
              push: 'http://127.0.0.1:25000',
              pull: 'di-framework-registry.wasmcloud.svc.cluster.local:5000',
              insecure: true,
            },
          }),
        },
      }),
      platformRoot,
      'dev',
      'local',
    );
    expect(outputs.kubeconfig).toBe(join(platformRoot, '.kubeconfig-dev'));
    expect(outputs.registry).toEqual({
      push: 'http://127.0.0.1:25000',
      pull: 'di-framework-registry.wasmcloud.svc.cluster.local:5000',
      insecure: true,
    });

    for (const registry of [
      { push: 'localhost:5000', pull: 'registry:5000' },
      { push: 'localhost:5000', pull: 'registry:5000', insecure: 'yes' },
      { push: 'localhost:5000', pull: 'registry:5000', insecure: false, extra: 'no' },
    ]) {
      await expect(
        loadPlatformOutputs(
          fakeDeps({
            cwd: root,
            capturedStdout: {
              'pulumi stack output': JSON.stringify({
                kubeconfig: '/tmp/kube',
                namespace: 'wasmcloud',
                registry,
              }),
            },
          }),
          platformRoot,
          'dev',
          'local',
        ),
      ).rejects.toMatchObject({ code: 'WASMCLOUD_PLATFORM_OUTPUT_INVALID', exitCode: 2 });
    }
  });

  it('rejects a platform path that escapes the workspace', async () => {
    const { root } = makeWorkspace();
    writeFileSync(
      join(root, 'di-framework.deploy.toml'),
      `[targets.escaped]\nplatform = "../outside"\n`,
    );
    await expect(
      runWasmcloudPlatformDeploy(['escaped'], captureIo().io, fakeDeps({ cwd: root })),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_DEPLOY_MANIFEST_INVALID', exitCode: 2 });
  });

  it('rejects unknown platform targets', async () => {
    const { root } = makeWorkspace();
    await expect(
      runWasmcloudPlatformDeploy(['missing'], captureIo().io, fakeDeps({ cwd: root })),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_TARGET_NOT_FOUND', exitCode: 2 });
  });
});

describe('runWasmcloudPlatformDestroy', () => {
  it('destroys only the platform stack', async () => {
    const { root } = makeWorkspace();
    const invocations: RunnerInvocation[] = [];
    const result = await runWasmcloudPlatformDestroy(
      ['local', '--yes'],
      captureIo().io,
      fakeDeps({ cwd: root, invocations }),
    );
    expect(invocations.map((invocation) => invocation.args)).toEqual([
      ['install'],
      ['stack', 'select', 'dev'],
      ['destroy', '--yes'],
    ]);
    expect(result.data).toMatchObject({ target: 'local', stack: 'dev' });
  });
});
