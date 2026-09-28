import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWasmcloudDeploy } from '../src/deploy';
import { runWasmcloudDestroy } from '../src/destroy';
import { loadDeployManifest } from '../src/manifest';
import { captureIo, fakeDeps, type RunnerInvocation } from './helpers';

const EXAMPLE_WORKSPACE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../examples/platform/plugin-workspace',
);

describe('example workspace fixture', () => {
  it('deploys and destroys greeter from an arbitrary layout without pulumi destroy', async () => {
    if (!existsSync(join(EXAMPLE_WORKSPACE, 'di-framework.deploy.toml'))) return;
    const manifest = loadDeployManifest(EXAMPLE_WORKSPACE, {
      KUBECONFIG: join(EXAMPLE_WORKSPACE, 'kubeconfig.yaml'),
    });
    expect(manifest.defaultTarget).toBe('local');
    expect(Object.keys(manifest.targets).sort()).toEqual(['development', 'local']);
    expect('apps' in (manifest as unknown as Record<string, unknown>)).toBe(false);

    const invocations: RunnerInvocation[] = [];
    const deployed = await runWasmcloudDeploy(
      ['greeter', '--target', 'development'],
      captureIo().io,
      fakeDeps({
        cwd: EXAMPLE_WORKSPACE,
        invocations,
        env: { KUBECONFIG: join(EXAMPLE_WORKSPACE, 'kubeconfig.yaml') },
      }),
    );
    expect(deployed.data).toMatchObject({ application: 'greeter', target: 'development' });
    expect(invocations.some((invocation) => invocation.command === 'pulumi')).toBe(false);

    const destroyed = await runWasmcloudDestroy(
      ['greeter', '--target', 'development'],
      captureIo().io,
      fakeDeps({
        cwd: join(EXAMPLE_WORKSPACE, 'services', 'greeter'),
        env: { KUBECONFIG: join(EXAMPLE_WORKSPACE, 'kubeconfig.yaml') },
      }),
    );
    expect(destroyed.data).toMatchObject({ application: 'greeter' });

    const exampleReadme = readFileSync(join(EXAMPLE_WORKSPACE, 'README.md'), 'utf8');
    expect(exampleReadme).toContain('di-framework platform deploy');
    expect(exampleReadme).not.toContain('"deploy":');
  });
});
