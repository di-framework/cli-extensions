import { describe, expect, it } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runWasmcloudDeploy } from '../src/deploy';
import { runWasmcloudDestroy } from '../src/destroy';
import { parseDeployManifest } from '../src/manifest';
import { loadProject } from '../src/project';
import { resolveConnection } from '../src/target';
import { renderWorkloadManifest } from '../src/workload';
import { captureIo, fakeDeps, makeWorkspace, type RunnerInvocation } from './helpers';

function tenantWorkspace() {
  const workspace = makeWorkspace();
  const manifest = ['alice', 'bob']
    .map(
      (user) => `
[targets.${user}]
kubeconfig = "${join(workspace.root, `${user}.kubeconfig`)}"
context = "${user}"
namespace = "tenant-${user}"
hostgroup = "${user}"
storage-hostgroup = "${user}-storage"
registry = "registry.example.com/${user}"
`,
    )
    .join('\n');
  writeFileSync(join(workspace.root, 'di-framework.deploy.toml'), manifest);
  return { ...workspace, manifest };
}

function expectScope(invocations: RunnerInvocation[], root: string, user: string) {
  const kubectl = invocations.filter((i) => i.command === 'kubectl');
  expect(kubectl.length).toBeGreaterThan(0);
  for (const invocation of kubectl) {
    expect(invocation.args.slice(0, 6)).toEqual([
      '--kubeconfig',
      join(root, `${user}.kubeconfig`),
      '--namespace',
      `tenant-${user}`,
      '--context',
      user,
    ]);
    expect(invocation.args).not.toContain('--all-namespaces');
  }
}

describe('tenant deployment targets', () => {
  it('rejects invalid tenant hostgroup selectors', () => {
    const { root, manifest } = tenantWorkspace();
    for (const field of ['hostgroup', 'storage-hostgroup']) {
      const invalid = manifest.replace(
        field === 'hostgroup' ? 'hostgroup = "alice"' : 'storage-hostgroup = "alice-storage"',
        `${field} = "../other"`,
      );
      expect(() =>
        parseDeployManifest(join(root, 'di-framework.deploy.toml'), invalid, {}),
      ).toThrow('DNS label');
    }
  });

  it('deploys the same application separately with each target’s credentials, namespace, environment and registry', async () => {
    const { root, greeter } = tenantWorkspace();
    for (const user of ['alice', 'bob']) {
      const invocations: RunnerInvocation[] = [];
      const result = await runWasmcloudDeploy(
        ['greeter', '--target', user],
        captureIo().io,
        fakeDeps({ cwd: root, invocations }),
      );
      expectScope(invocations, root, user);
      expect(result.data.namespace).toBe(`tenant-${user}`);
      expect(result.data.image).toStartWith(`registry.example.com/${user}/greeter:`);
      const manifest = readFileSync(join(greeter, '.di-framework/deploy/workload.yaml'), 'utf8');
      expect(manifest).toContain(`namespace: tenant-${user}`);
      expect(manifest).toContain(`      environment: "tenant-${user}"`);
      expect(manifest).toContain('name: greeter');
      expect(manifest).toContain(`hostgroup: ${user}`);
    }
  });

  it('selects the tenant storage pool while keeping the namespace environment', async () => {
    const { root, greeter, manifest } = tenantWorkspace();
    const parsed = parseDeployManifest(join(root, 'di-framework.deploy.toml'), manifest, {});
    const target = parsed.targets.alice;
    if (!target) throw new Error('missing target');
    const connection = await resolveConnection(target, root, parsed.path, fakeDeps({ cwd: root }));
    const yaml = renderWorkloadManifest(
      { ...loadProject(greeter), persistentStorage: true },
      connection,
      'registry.example.com/alice/greeter:test',
    );
    expect(yaml).toContain('hostgroup: alice-storage');
    expect(yaml).toContain('environment: "tenant-alice"');
  });

  it('destroys only within the selected tenant and never changes the platform', async () => {
    const { root } = tenantWorkspace();
    for (const user of ['alice', 'bob']) {
      const invocations: RunnerInvocation[] = [];
      await runWasmcloudDestroy(
        ['greeter', '--target', user],
        captureIo().io,
        fakeDeps({ cwd: root, invocations }),
      );
      expectScope(invocations, root, user);
      expect(invocations).toHaveLength(2);
      expect(invocations[0]?.args).toContain('delete');
    }
  });

  it('does not fall back to another identity or namespace after a denied deployment', async () => {
    const { root } = tenantWorkspace();
    const invocations: RunnerInvocation[] = [];
    await expect(
      runWasmcloudDeploy(
        ['greeter', '--target', 'alice'],
        captureIo().io,
        fakeDeps({ cwd: root, invocations, exitCodes: { 'kubectl apply': 1 } }),
      ),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_TOOL_FAILED' });
    expectScope(invocations, root, 'alice');
    expect(invocations.some((i) => i.command === 'pulumi')).toBe(false);
  });

  it('rejects invalid namespaces instead of emitting them into deployment YAML', () => {
    const { root, manifest } = tenantWorkspace();
    for (const namespace of ['Tenant-A', '../alice', 'a/b', 'a'.repeat(64)]) {
      expect(() =>
        parseDeployManifest(
          join(root, 'di-framework.deploy.toml'),
          manifest.replace('tenant-alice', namespace),
          {},
        ),
      ).toThrow('Kubernetes namespace');
    }
  });
});
