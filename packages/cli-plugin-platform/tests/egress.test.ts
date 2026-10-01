import { describe, expect, it } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WasmcloudDeps } from '../src/deps';
import {
  applyWorkloadEgress,
  EGRESS_WORKLOAD_LABEL,
  egressResourceName,
  removeWorkloadEgress,
  reportEgressStatus,
  usesPlatformEgress,
  warnIfTenantHostLacksTls,
} from '../src/egress';
import { loadProject, type WasmcloudProject } from '../src/project';
import type { ClusterConnection } from '../src/target';
import { applyWorkload, deleteWorkload, renderWorkloadManifest } from '../src/workload';
import { captureIo, fakeDeps, makeProject, READY_WORKLOAD_JSON } from './helpers';

const REGISTRY = {
  push: 'registry.example.com/t',
  pull: 'registry.example.com/t',
  insecure: false,
};
const TENANT: ClusterConnection = {
  target: 'alice',
  kubeconfig: '/tmp/alice',
  namespace: 'di-tenant-alice',
  registry: REGISTRY,
  hostgroup: 'tenant-alice',
};
const SHARED: ClusterConnection = {
  target: 'dev',
  kubeconfig: '/tmp/dev',
  namespace: 'wasmcloud',
  registry: REGISTRY,
};

type Result = { exitCode: number; stdout: string; stderr: string };
type Call = { args: string[]; captured: boolean };

/** Kubectl stub: `respond` sees the args after the connection flags. */
function scripted(
  root: string,
  respond: (args: string[]) => Partial<Result> | undefined,
): { deps: WasmcloudDeps; calls: Call[] } {
  const calls: Call[] = [];
  const strip = (args: readonly string[]) => {
    const rest = [...args];
    while (
      rest[0]?.startsWith('--') &&
      ['--kubeconfig', '--namespace', '--context'].includes(rest[0])
    )
      rest.splice(0, 2);
    return rest;
  };
  const answer = (args: readonly string[], captured: boolean): Result => {
    const rest = strip(args);
    calls.push({ args: [...args], captured });
    return { exitCode: 0, stdout: '', stderr: '', ...respond(rest) };
  };
  return {
    calls,
    deps: {
      ...fakeDeps({ cwd: root }),
      runCaptured: async (_command, args) => answer(args, true),
      runner: async (_command, args) => ({ exitCode: answer(args, false).exitCode }),
    },
  };
}

function egressProject(lookups?: string[], name = 'Mesh Site'): WasmcloudProject {
  const root = makeProject({
    name,
    entry: 'src/app.ts',
    ...(lookups ? { allowedIpNameLookups: lookups } : {}),
  });
  return loadProject(root);
}

const OWNED_SERVICE = JSON.stringify({
  metadata: {
    labels: {
      'app.kubernetes.io/managed-by': 'di-framework',
      [EGRESS_WORKLOAD_LABEL]: 'mesh-site',
    },
  },
});
const OWNED_BINDING = JSON.stringify({
  metadata: {
    labels: {
      'app.kubernetes.io/managed-by': 'di-framework',
      'di-framework.dev/binding-workload': 'mesh-site',
    },
  },
});

describe('egress grants for tenant workloads', () => {
  it('treats a target with a host group as a tenant and names resources after the deployment', () => {
    expect(usesPlatformEgress(TENANT)).toBe(true);
    expect(usesPlatformEgress(SHARED)).toBe(false);
    expect(egressResourceName('mesh-site')).toBe('mesh-site-egress');
  });

  it('keeps allowedIpNameLookups in the WorkloadDeployment only for non-tenant targets', () => {
    const project = egressProject(['api.example.com']);
    const shared = renderWorkloadManifest(project, SHARED, 'img:1');
    expect(shared).toContain('allowedIpNameLookups: ["api.example.com"]');
    const tenant = renderWorkloadManifest(project, TENANT, 'img:1');
    expect(tenant).not.toContain('allowedIpNameLookups');
    expect(tenant).not.toContain('allowedHosts');
    const service = renderWorkloadManifest(
      {
        ...project,
        ingress: false,
        workloadEntry: { kind: 'service', exportName: 'run', path: '/run' },
      },
      TENANT,
      'img:1',
      [],
    );
    expect(service).not.toContain('localResources');
  });

  it('does nothing without a tenant target or names', async () => {
    const { deps, calls } = scripted('/tmp', () => undefined);
    expect(await applyWorkloadEgress(egressProject(['a.example.com']), SHARED, deps)).toBe(
      undefined,
    );
    expect(await applyWorkloadEgress(egressProject(), TENANT, deps)).toBe(undefined);
    expect(await applyWorkloadEgress(egressProject([]), TENANT, deps)).toBe(undefined);
    await removeWorkloadEgress(egressProject(), SHARED, deps);
    expect(calls).toHaveLength(0);
  });

  it('applies a BackingService and ServiceBinding per the egress contract', async () => {
    const project = egressProject(['api.example.com', '*.example.org']);
    const { deps, calls } = scripted(project.projectRoot, () => undefined);
    expect(await applyWorkloadEgress(project, TENANT, deps)).toBe('mesh-site-egress');
    const apply = calls.find((call) => call.args.includes('apply'));
    const path = apply?.args[apply.args.indexOf('-f') + 1] ?? '';
    const list = JSON.parse(readFileSync(path, 'utf8')) as {
      items: {
        kind: string;
        metadata: { name: string; labels: Record<string, string> };
        spec: unknown;
      }[];
    };
    expect(list.items.map((item) => [item.kind, item.metadata.name])).toEqual([
      ['BackingService', 'mesh-site-egress'],
      ['ServiceBinding', 'mesh-site-egress'],
    ]);
    expect(list.items[0]?.spec).toEqual({
      type: 'egress',
      destinations: ['api.example.com', '*.example.org'],
    });
    expect(list.items[0]?.metadata.labels[EGRESS_WORKLOAD_LABEL]).toBe('mesh-site');
    expect(list.items[1]?.spec).toEqual({
      serviceName: 'mesh-site-egress',
      bindingName: 'egress',
      capability: 'egress',
      workloadName: 'mesh-site',
    });
    expect(list.items[1]?.metadata.labels['di-framework.dev/binding-workload']).toBe('mesh-site');
  });

  it('updates resources it already owns', async () => {
    const project = egressProject(['new.example.com']);
    const { deps, calls } = scripted(project.projectRoot, (args) =>
      args[0] === 'get'
        ? { stdout: args[1]?.startsWith('backingservices') ? OWNED_SERVICE : OWNED_BINDING }
        : undefined,
    );
    expect(await applyWorkloadEgress(project, TENANT, deps)).toBe('mesh-site-egress');
    expect(calls.some((call) => call.args.includes('apply'))).toBe(true);
  });

  it('refuses unrestricted egress, long names, foreign resources, and unreadable CRDs', async () => {
    const { deps } = scripted('/tmp', () => undefined);
    await expect(applyWorkloadEgress(egressProject(['*']), TENANT, deps)).rejects.toThrow(
      'cannot be granted on a tenant target',
    );
    await expect(
      applyWorkloadEgress(egressProject(['a.example.com'], 'x'.repeat(40)), TENANT, deps),
    ).rejects.toThrow('longer than 40 characters');

    const foreign = scripted('/tmp', (args) =>
      args[0] === 'get' ? { stdout: JSON.stringify({ metadata: { name: 'x' } }) } : undefined,
    );
    await expect(
      applyWorkloadEgress(egressProject(['a.example.com']), TENANT, foreign.deps),
    ).rejects.toThrow('Refusing to adopt BackingService mesh-site-egress');

    const bindingForeign = scripted('/tmp', (args) =>
      args[0] === 'get' && args[1]?.startsWith('servicebindings')
        ? { stdout: JSON.stringify({ metadata: { labels: {} } }) }
        : undefined,
    );
    await expect(
      applyWorkloadEgress(egressProject(['a.example.com']), TENANT, bindingForeign.deps),
    ).rejects.toThrow('Refusing to adopt ServiceBinding mesh-site-egress');

    const denied = scripted('/tmp', () => ({
      exitCode: 1,
      stderr: 'error: stat deploy/x.kubeconfig: no such file or directory\n',
    }));
    const failure = applyWorkloadEgress(egressProject(['a.example.com']), TENANT, denied.deps);
    await expect(failure).rejects.toMatchObject({ code: 'WASMCLOUD_EGRESS_FAILED' });
    await expect(failure).rejects.toThrow(
      'Cannot read BackingService mesh-site-egress: error: stat deploy/x.kubeconfig: no such file or directory',
    );
    await expect(failure).rejects.not.toThrow('install the platform');

    const silent = scripted('/tmp', () => ({ exitCode: 3 }));
    await expect(
      applyWorkloadEgress(egressProject(['a.example.com']), TENANT, silent.deps),
    ).rejects.toThrow('Cannot read BackingService mesh-site-egress: kubectl exited 3');
    const stdoutOnly = scripted('/tmp', () => ({ exitCode: 1, stdout: 'Unauthorized' }));
    await expect(
      applyWorkloadEgress(egressProject(['a.example.com']), TENANT, stdoutOnly.deps),
    ).rejects.toThrow('Cannot read BackingService mesh-site-egress: Unauthorized');

    const noCrd = scripted('/tmp', () => ({
      exitCode: 1,
      stderr: `error: the server doesn't have a resource type "backingservices"`,
    }));
    await expect(
      applyWorkloadEgress(egressProject(['a.example.com']), TENANT, noCrd.deps),
    ).rejects.toThrow(
      'Cannot read BackingService mesh-site-egress: the cluster has no BackingService resource type; install the platform backing-service CRDs',
    );
  });

  it('removes only the deploy-owned BackingService and tolerates missing CRDs', async () => {
    const project = egressProject();
    const { deps, calls } = scripted(project.projectRoot, () => undefined);
    await removeWorkloadEgress(project, TENANT, deps);
    expect(calls[0]?.args).toContain(
      `${EGRESS_WORKLOAD_LABEL}=mesh-site,app.kubernetes.io/managed-by=di-framework`,
    );
    const missing = scripted('/tmp', () => ({
      exitCode: 1,
      stderr: "error: the server doesn't have a resource type",
    }));
    await removeWorkloadEgress(project, TENANT, missing.deps);
    const denied = scripted('/tmp', () => ({ exitCode: 1, stderr: 'forbidden' }));
    await expect(removeWorkloadEgress(project, TENANT, denied.deps)).rejects.toThrow(
      'Cannot remove the egress BackingService for mesh-site',
    );
  });

  it('reports approval, NotApproved, and pending status without failing', async () => {
    const project = egressProject(['api.example.com']);
    const status = (conditions: unknown[], approved?: string[]) =>
      JSON.stringify({ status: { conditions, ...(approved ? { approved } : {}) } });

    const ready = captureIo();
    await reportEgressStatus(
      project,
      TENANT,
      ready.io,
      scripted('/tmp', () => ({
        stdout: status([{ type: 'Ready', status: 'True' }], ['api.example.com:443']),
      })).deps,
    );
    expect(ready.stdout.join('')).toBe('Egress approved for mesh-site: api.example.com:443\n');

    const blocked = captureIo();
    await reportEgressStatus(
      project,
      TENANT,
      blocked.io,
      scripted('/tmp', () => ({
        stdout: status([
          {
            type: 'Ready',
            status: 'False',
            reason: 'NotApproved',
            message: 'api.example.com is not allowed',
          },
        ]),
      })).deps,
    );
    expect(blocked.stderr.join('')).toContain(
      "is not approved (api.example.com is not allowed). A platform admin must allow the destination in the platform's egressAllowedDestinations",
    );

    const bare = captureIo();
    await reportEgressStatus(
      project,
      TENANT,
      bare.io,
      scripted('/tmp', () => ({
        stdout: status([{ type: 'Ready', status: 'False', reason: 'NotApproved' }]),
      })).deps,
    );
    expect(bare.stderr.join('')).toContain('egress for mesh-site is not approved. A platform');

    const pending = captureIo();
    const pendingDeps = scripted('/tmp', () => ({
      stdout: status([{ type: 'Ready', status: 'False', reason: 'Pending', message: 'waiting' }]),
    }));
    await reportEgressStatus(project, TENANT, pending.io, pendingDeps.deps);
    expect(pendingDeps.calls).toHaveLength(5);
    expect(pending.stderr.join('')).toBe(
      'Note: egress BackingService mesh-site-egress is not Ready yet (waiting); check it with: di-framework platform service get mesh-site-egress\n',
    );

    const unreadable = captureIo();
    let attempt = 0;
    await reportEgressStatus(
      project,
      TENANT,
      unreadable.io,
      scripted('/tmp', () => (attempt++ % 2 === 0 ? { exitCode: 1 } : { stdout: 'not-json' })).deps,
    );
    expect(unreadable.stderr.join('')).toContain('is not Ready yet; check it with');

    const noStatus = captureIo();
    await reportEgressStatus(
      project,
      TENANT,
      noStatus.io,
      scripted('/tmp', () => ({ stdout: '{}' })).deps,
    );
    expect(noStatus.stderr.join('')).toContain('is not Ready yet;');

    const emptyApproved = captureIo();
    await reportEgressStatus(
      project,
      TENANT,
      emptyApproved.io,
      scripted('/tmp', () => ({ stdout: status([{ type: 'Ready', status: 'True' }]) })).deps,
    );
    expect(emptyApproved.stdout.join('')).toBe('Egress approved for mesh-site: \n');
  });
});

describe('wasi:tls host warning', () => {
  function tlsProject(packages: string[] | 'broken'): WasmcloudProject {
    const project = egressProject();
    mkdirSync(join(project.projectRoot, '.di-framework'), { recursive: true });
    writeFileSync(
      join(project.projectRoot, '.di-framework', 'wit.lock.json'),
      packages === 'broken'
        ? '{'
        : JSON.stringify({
            requirements: packages.map((pkg) => ({ package: pkg, direction: 'import' })),
          }),
    );
    return project;
  }
  const pods = (...images: (string | undefined)[]) =>
    JSON.stringify({
      items: [{ spec: { containers: images.map((image) => (image ? { image } : {})) } }, {}],
    });

  it('warns when the tenant host image has no wasi-tls tag', async () => {
    const { deps, calls } = scripted('/tmp', () => ({
      stdout: pods('ghcr.io/wasmcloud/wash:2.8.0'),
    }));
    const out = captureIo();
    await warnIfTenantHostLacksTls(tlsProject(['wasi:tls']), TENANT, out.io, deps);
    expect(calls[0]?.args.slice(2, 4)).toEqual(['--namespace', 'di-runtime-alice']);
    expect(calls[0]?.args).toContain('wasmcloud.com/hostgroup=tenant-alice');
    expect(out.stderr.join('')).toContain(
      'imports wasi:tls, but host group tenant-alice runs ghcr.io/wasmcloud/wash:2.8.0, which has no wasi:tls provider',
    );
  });

  it('stays silent for TLS hosts, non-TLS components, and anything it cannot read', async () => {
    const cases: Array<[WasmcloudProject, ClusterConnection, Partial<Result>]> = [
      [tlsProject(['wasi:tls']), TENANT, { stdout: pods('registry:5000/wash:2.8.0-wasi-tls') }],
      [
        tlsProject(['wasi:tls']),
        TENANT,
        { stdout: pods(undefined, 'ghcr.io/x/wash:2.8.0-wasi-tls@sha256:abc') },
      ],
      [tlsProject(['wasi:tls']), TENANT, { exitCode: 1 }],
      [tlsProject(['wasi:tls']), TENANT, { stdout: 'nope' }],
      [tlsProject(['wasi:tls']), TENANT, { stdout: '{}' }],
      [tlsProject(['wasi:http']), TENANT, { stdout: pods('ghcr.io/wasmcloud/wash:2.8.0') }],
      [tlsProject('broken'), TENANT, { stdout: pods('ghcr.io/wasmcloud/wash:2.8.0') }],
      [tlsProject(['wasi:tls']), SHARED, { stdout: pods('ghcr.io/wasmcloud/wash:2.8.0') }],
      [
        tlsProject(['wasi:tls']),
        { ...TENANT, hostgroup: 'alice' },
        { stdout: pods('ghcr.io/wasmcloud/wash:2.8.0') },
      ],
    ];
    for (const [project, connection, result] of cases) {
      const out = captureIo();
      await warnIfTenantHostLacksTls(
        project,
        connection,
        out.io,
        scripted('/tmp', () => result).deps,
      );
      expect(out.stderr).toEqual([]);
    }
  });
});

describe('tenant deploy with egress', () => {
  function respond(
    root: string,
    extra: (args: string[]) => Partial<Result> | undefined = () => undefined,
  ) {
    return scripted(root, (args) => {
      const custom = extra(args);
      if (custom) return custom;
      if (args[0] === 'get' && args[1]?.startsWith('workloaddeployment'))
        return { stdout: READY_WORKLOAD_JSON };
      if (args[0] === 'get' && args[1] === 'secret') return { exitCode: 1 };
      if (args[0] === 'get' && args.includes('-l')) return { stdout: '{"items":[]}' };
      if (args[0] === 'get' && args[1]?.startsWith('backingservices'))
        return args.includes('--ignore-not-found')
          ? { stdout: '' }
          : {
              stdout: JSON.stringify({
                status: { conditions: [{ type: 'Ready', status: 'False', reason: 'NotApproved' }] },
              }),
            };
      return undefined;
    });
  }

  it('creates the grant, keeps the binding, and notes the missing approval', async () => {
    const project = egressProject(['api.example.com']);
    const { deps, calls } = respond(project.projectRoot);
    const out = captureIo();
    await applyWorkload(project, TENANT, 'img:1', out.io, deps);
    const yaml = readFileSync(
      join(project.projectRoot, '.di-framework/deploy/workload.yaml'),
      'utf8',
    );
    expect(yaml).not.toContain('allowedIpNameLookups');
    expect(calls.some((call) => call.args.some((arg) => arg.endsWith('egress.json')))).toBe(true);
    expect(calls.some((call) => call.args.includes('delete'))).toBe(false);
    expect(out.stderr.join('')).toContain('egress for mesh-site is not approved');
  });

  it('removes the grant when the setting is gone and on destroy', async () => {
    const project = egressProject();
    const binding = {
      metadata: {
        name: 'mesh-site-egress',
        labels: {
          'app.kubernetes.io/managed-by': 'di-framework',
          'di-framework.dev/binding-workload': 'mesh-site',
        },
      },
      spec: { serviceName: 'mesh-site-egress', bindingName: 'egress', capability: 'egress' },
    };
    const { deps, calls } = respond(project.projectRoot, (args) =>
      args[0] === 'get' && args[1]?.startsWith('servicebindings') && args.includes('-l')
        ? { stdout: JSON.stringify({ items: [binding] }) }
        : undefined,
    );
    await applyWorkload(project, TENANT, 'img:1', captureIo().io, deps);
    const deletes = calls.filter((call) => call.args.includes('delete')).map((call) => call.args);
    expect(deletes[0]).toContain('mesh-site-egress');
    expect(deletes[1]).toContain(
      `${EGRESS_WORKLOAD_LABEL}=mesh-site,app.kubernetes.io/managed-by=di-framework`,
    );

    calls.length = 0;
    await deleteWorkload(project, TENANT, captureIo().io, deps);
    expect(calls.at(-1)?.args).toContain(
      `${EGRESS_WORKLOAD_LABEL}=mesh-site,app.kubernetes.io/managed-by=di-framework`,
    );
  });
});
