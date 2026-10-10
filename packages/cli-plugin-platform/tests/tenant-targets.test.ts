import { describe, expect, it } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { selectConsoleTenant } from '../src/console/run';
import { runWasmcloudDeploy } from '../src/deploy';
import { runWasmcloudDestroy } from '../src/destroy';
import { loadDeployManifest, parseDeployManifest } from '../src/manifest';
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

  async function aliceConnection(root: string, manifest: string) {
    const parsed = parseDeployManifest(join(root, 'di-framework.deploy.toml'), manifest, {});
    const target = parsed.targets.alice;
    if (!target) throw new Error('missing target');
    return resolveConnection(target, root, parsed.path, fakeDeps({ cwd: root }));
  }

  it('asks the platform for storage instead of naming a host path', async () => {
    const { root, greeter, manifest } = tenantWorkspace();
    const connection = await aliceConnection(root, manifest);
    const yaml = renderWorkloadManifest(
      { ...loadProject(greeter), persistentStorage: true },
      connection,
      'registry.example.com/alice/greeter:test',
    );
    expect(yaml).toContain(
      '  annotations:\n    di-framework.dev/persistent-storage: "true"\nspec:\n  replicas: 1\n  deployPolicy: Recreate',
    );
    expect(yaml).not.toContain('di-framework.dev/storage-mount');
    // The tenant host carries the platform mount; the storage pool is not a tenant concept.
    expect(yaml).toContain('hostgroup: alice\n');
    expect(yaml).not.toContain('alice-storage');
    expect(yaml).not.toContain('volumes:');
    expect(yaml).not.toContain('volumeMounts:');
    expect(yaml).not.toContain('hostPath');
    expect(yaml).toContain('DI_STORAGE_DIR: "/data"');
    expect(yaml).toContain('environment: "tenant-alice"');
  });

  it('names the actor mount and rejects mounts the platform does not provide', async () => {
    const { root, greeter, manifest } = tenantWorkspace();
    const connection = await aliceConnection(root, manifest);
    const project = { ...loadProject(greeter), persistentStorage: true };
    const actors = renderWorkloadManifest(project, connection, 'image:test', undefined, [], {
      hasActors: true,
    });
    expect(actors).toContain('    di-framework.dev/storage-mount: "/data/actors"');
    expect(actors).toContain('ACTOR_STORAGE_DIR: "/data/actors"');
    expect(() =>
      renderWorkloadManifest(project, connection, 'image:test', undefined, [], {
        storageVolume: { volumeName: 'app-storage', mountPath: '/srv', hostPath: '/tmp/x' },
      }),
    ).toThrow('Tenant storage mounts at /data or /data/actors, not /srv');
  });

  it('skips the host-path ownership scan for tenant storage', async () => {
    const { root, greeter } = tenantWorkspace();
    const config = JSON.parse(readFileSync(join(greeter, 'di-framework.config.json'), 'utf8'));
    writeFileSync(
      join(greeter, 'di-framework.config.json'),
      JSON.stringify({ ...config, persistentStorage: true }),
    );
    const invocations: RunnerInvocation[] = [];
    await runWasmcloudDeploy(
      ['greeter', '--target', 'alice'],
      captureIo().io,
      fakeDeps({ cwd: root, invocations }),
    );
    expect(
      invocations.some((invocation) =>
        invocation.args.includes('di-framework.dev/application!=greeter'),
      ),
    ).toBe(false);
    const manifest = readFileSync(join(greeter, '.di-framework/deploy/workload.yaml'), 'utf8');
    expect(manifest).toContain('di-framework.dev/persistent-storage: "true"');
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
      expect(invocations).toHaveLength(4);
      expect(invocations[0]?.args).toContain('delete');
      expect(invocations[1]?.args).toEqual(
        expect.arrayContaining(['delete', 'secret', 'greeter-control', '--wait=false']),
      );
      expect(invocations[3]?.args).toContain(
        'di-framework.dev/egress-workload=greeter,app.kubernetes.io/managed-by=di-framework',
      );
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

  it('resolves a relative KUBECONFIG against the invocation directory for every kubectl call', async () => {
    const { root } = makeWorkspace();
    writeFileSync(
      join(root, 'di-framework.deploy.toml'),
      `[targets.alice]
kubeconfig = "\${KUBECONFIG}"
namespace = "di-tenant-alice"
hostgroup = "tenant-alice"
registry = "registry.example.com/alice"
`,
    );
    const invocations: RunnerInvocation[] = [];
    await runWasmcloudDeploy(
      ['greeter', '--target', 'alice'],
      captureIo().io,
      fakeDeps({
        cwd: root,
        invocations,
        env: { KUBECONFIG: 'deploy/.tenant.kubeconfig' },
      }),
    );
    const kubectl = invocations.filter((i) => i.command === 'kubectl');
    expect(kubectl.length).toBeGreaterThan(0);
    for (const invocation of kubectl)
      expect(invocation.args.slice(0, 2)).toEqual([
        '--kubeconfig',
        join(root, 'deploy/.tenant.kubeconfig'),
      ]);
    expect(kubectl.some((i) => i.cwd !== root)).toBe(true);
  });
});

describe('tenant targets selected by default-target', () => {
  function defaultTenantWorkspace() {
    const workspace = makeWorkspace();
    const kubeconfig = join(workspace.root, 'dev.kubeconfig');
    writeFileSync(
      join(workspace.root, 'di-framework.deploy.toml'),
      `default-target = "dev"

[targets.dev]
kubeconfig = "${kubeconfig}"
tenant = "meshtastic"
registry = "registry.example.com/meshtastic"
`,
    );
    return { ...workspace, kubeconfig };
  }

  function expectTenantScope(invocations: RunnerInvocation[], kubeconfig: string) {
    const kubectl = invocations.filter((i) => i.command === 'kubectl');
    expect(kubectl.length).toBeGreaterThan(0);
    for (const invocation of kubectl) {
      expect(invocation.args.slice(0, 4)).toEqual([
        '--kubeconfig',
        kubeconfig,
        '--namespace',
        'di-tenant-meshtastic',
      ]);
    }
  }

  it('deploys and destroys without --target into the derived namespace and host group', async () => {
    const { root, greeter, kubeconfig } = defaultTenantWorkspace();
    const deployed: RunnerInvocation[] = [];
    const result = await runWasmcloudDeploy(
      ['greeter'],
      captureIo().io,
      fakeDeps({ cwd: root, invocations: deployed }),
    );
    expectTenantScope(deployed, kubeconfig);
    expect(result.data).toMatchObject({ target: 'dev', namespace: 'di-tenant-meshtastic' });
    const manifest = readFileSync(join(greeter, '.di-framework/deploy/workload.yaml'), 'utf8');
    expect(manifest).toContain('namespace: di-tenant-meshtastic');
    expect(manifest).toContain('hostgroup: tenant-meshtastic');

    const destroyed: RunnerInvocation[] = [];
    await runWasmcloudDestroy(
      ['greeter'],
      captureIo().io,
      fakeDeps({ cwd: root, invocations: destroyed }),
    );
    expectTenantScope(destroyed, kubeconfig);
  });

  it('opens the console on the default tenant target without --target', () => {
    const { root } = defaultTenantWorkspace();
    const tenant = selectConsoleTenant(loadDeployManifest(root, {}), undefined);
    expect(tenant).toMatchObject({
      name: 'dev',
      tenant: 'meshtastic',
      namespace: 'di-tenant-meshtastic',
      hostgroup: 'tenant-meshtastic',
    });
  });
});
