import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProject } from '../src/project';
import {
  applyWorkload,
  renderWorkloadManifest,
  WORKLOAD_DEPLOYMENT_RESOURCE,
  WORKLOAD_REPLICA_SET_RESOURCE,
  waitForReady,
} from '../src/workload';
import {
  captureIo,
  fakeDeps,
  makeWorkspace,
  READY_WORKLOAD_JSON,
  type RunnerInvocation,
} from './helpers';

const REGISTRY = {
  push: 'registry.example.com/team',
  pull: 'registry.example.com/team',
  insecure: false,
};

describe('workload manifests', () => {
  it('renders Service and WorkloadDeployment from the project name and image', () => {
    const { greeter } = makeWorkspace();
    const project = loadProject(greeter);
    const yaml = renderWorkloadManifest(
      project,
      {
        target: 'development',
        kubeconfig: '/tmp/kube',
        namespace: 'wasmcloud',
        registry: REGISTRY,
      },
      'registry.example.com/team/greeter:sha256-abc',
    );
    expect(yaml).not.toContain('allowedIpNameLookups');
    const permitted = renderWorkloadManifest(
      { ...project, allowedIpNameLookups: ['echo.example.com'] },
      {
        target: 'development',
        kubeconfig: '/tmp/kube',
        namespace: 'wasmcloud',
        registry: REGISTRY,
      },
      'registry.example.com/probe:local',
    );
    expect(permitted).toContain('allowedIpNameLookups: ["echo.example.com"]');
    expect(permitted).toContain('localResources:');
    expect(yaml).toContain('kind: Service');
    expect(yaml).toContain('kind: WorkloadDeployment');
    expect(yaml).toContain('name: greeter');
    expect(yaml).toContain('registry.example.com/team/greeter:sha256-abc');
    expect(yaml).toContain('hostInterfaces:');
    expect(yaml).toContain('package: http');
    expect(yaml).toContain('version: "0.3.0"');
    expect(yaml).toContain('- handler');
    expect(yaml).toContain('"host": "greeter"');
    expect(yaml).toContain('secretFrom:');
    expect(yaml).toContain('name: greeter-control');
    expect(yaml).not.toContain('incoming-handler');
    expect(yaml).not.toContain('Pulumi');
  });

  it('renders an unlabeled PostgreSQL host interface with its binding secretFrom', () => {
    const { greeter } = makeWorkspace();
    const project = loadProject(greeter);
    const yaml = renderWorkloadManifest(
      project,
      {
        target: 'development',
        kubeconfig: '/tmp/kube',
        namespace: 'wasmcloud',
        registry: REGISTRY,
      },
      'registry.example.com/team/greeter:sha256-abc',
      [
        {
          package: 'wasi:http',
          version: '0.3.0',
          interfaces: ['handler'],
          direction: 'export',
          source: 'http-adapter',
        },
        {
          package: 'wasmcloud:postgres',
          version: '0.2.0',
          interfaces: ['query', 'prepared', 'types'],
          direction: 'import',
          instanceName: 'user-database',
          source: 'UserDatabase',
        },
      ],
      [
        {
          className: 'UserDatabase',
          name: 'user-database',
          kind: 'Postgres',
          requirement: {
            package: 'wasmcloud:postgres',
            version: '0.2.0',
            interfaces: ['query', 'prepared', 'types'],
            direction: 'import',
            instanceName: 'user-database',
            source: 'UserDatabase',
          },
          secretFrom: 'orders-user-database',
        },
      ],
    );
    expect(yaml).not.toContain('name: "user-database"');
    expect(yaml).toContain('package: postgres');
    expect(yaml).toContain('version: "0.2.0"');
    expect(yaml).toContain('secretFrom:');
    expect(yaml).toContain('name: "orders-user-database"');
  });

  it('treats unparseable kubectl output as not ready and times out', async () => {
    const { greeter } = makeWorkspace();
    const project = loadProject(greeter);
    await expect(
      waitForReady(
        project,
        {
          target: 'development',
          kubeconfig: '/tmp/kube',
          namespace: 'wasmcloud',
          registry: REGISTRY,
        },
        fakeDeps({
          cwd: greeter,
          capturedStdout: { 'kubectl get': 'not-json' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_DEPLOYMENT_NOT_READY', exitCode: 3 });
  });

  it('accepts the Available condition when readyReplicas is absent', async () => {
    const { greeter } = makeWorkspace();
    const project = loadProject(greeter);
    await waitForReady(
      project,
      {
        target: 'development',
        kubeconfig: '/tmp/kube',
        namespace: 'wasmcloud',
        registry: REGISTRY,
      },
      fakeDeps({
        cwd: greeter,
        capturedStdout: {
          'kubectl get': JSON.stringify({
            status: { conditions: [{ type: 'Available', status: 'True' }] },
          }),
        },
      }),
    );
  });

  it('accepts the runtime operator Ready condition', async () => {
    const { greeter } = makeWorkspace();
    await waitForReady(
      loadProject(greeter),
      {
        target: 'development',
        kubeconfig: '/tmp/kube',
        namespace: 'wasmcloud',
        registry: REGISTRY,
      },
      fakeDeps({
        cwd: greeter,
        capturedStdout: {
          'kubectl get': JSON.stringify({
            status: { conditions: [{ type: 'Ready', status: 'True' }] },
          }),
        },
      }),
    );
  });

  it('accepts legacy readyReplicas without readiness conditions', async () => {
    const { greeter } = makeWorkspace();
    await waitForReady(
      loadProject(greeter),
      {
        target: 'development',
        kubeconfig: '/tmp/kube',
        namespace: 'wasmcloud',
        registry: REGISTRY,
      },
      fakeDeps({
        cwd: greeter,
        capturedStdout: {
          'kubectl get': JSON.stringify({ spec: { replicas: 2 }, status: { readyReplicas: 2 } }),
        },
      }),
    );
  });

  it('times out with WASMCLOUD_DEPLOYMENT_NOT_READY when the workload never becomes ready', async () => {
    const { greeter } = makeWorkspace();
    const output = captureIo();
    const invocations: RunnerInvocation[] = [];
    const project = loadProject(greeter);
    await expect(
      waitForReady(
        project,
        {
          target: 'development',
          kubeconfig: '/tmp/kube',
          namespace: 'wasmcloud',
          registry: REGISTRY,
        },
        fakeDeps({
          cwd: greeter,
          invocations,
          capturedStdout: { 'kubectl get': '{}' },
        }),
        output.io,
      ),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_DEPLOYMENT_NOT_READY', exitCode: 3 });
    expect(output.stderr.join('')).toContain('WorkloadDeployment');
    expect(output.stderr.join('')).toContain('WorkloadReplicaSets');
    expect(
      invocations.some((invocation) => invocation.args.includes(WORKLOAD_REPLICA_SET_RESOURCE)),
    ).toBe(true);
    expect(invocations.some((invocation) => invocation.args.includes('logs'))).toBe(true);
  });

  it('renders control secrets, storage mounts, and injected control HTTP exports', () => {
    const { greeter } = makeWorkspace();
    const project = { ...loadProject(greeter), ingress: false, applicationType: 'worker' as const };
    const yaml = renderWorkloadManifest(
      project,
      {
        target: 'development',
        kubeconfig: '/tmp/kube',
        namespace: 'wasmcloud',
        registry: REGISTRY,
      },
      'registry.example.com/team/greeter:local',
      [],
      [],
      {
        controlSecretName: 'greeter-control',
        hasPersistentStorage: true,
        environment: { EXTRA: '1' },
      },
      [],
      [
        {
          className: 'Worker',
          methodName: 'run',
          queueName: 'jobs',
          filePath: 'src/worker.ts',
          options: {},
        },
      ],
    );
    expect(yaml).toContain('secretFrom:');
    expect(yaml).toContain('name: greeter-control');
    expect(yaml).toContain('EXTRA: "1"');
    expect(yaml).toContain('volumeMounts:');
    expect(yaml).toContain('hostgroup: storage');
    expect(yaml).toContain('package: http');
    expect(yaml).toContain('"host": "greeter.wasmcloud.svc.cluster.local"');
    expect(yaml).toContain('DI_CONTROL_REJECT_FORWARDED: "1"');
    expect(yaml).toContain('DI_CONTROL_HTTP_HOST: "greeter,greeter.wasmcloud.svc.cluster.local"');
  });

  it('applyWorkload discovers queue handlers and persistent storage flags', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wasmcloud-apply-queue-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'src', 'worker.ts'),
      `
import { QueueHandler } from '@di-framework/queues';
export class Worker {
  @QueueHandler('jobs')
  async run() {}
}
`,
    );
    writeFileSync(join(root, 'src', 'index.ts'), 'export * from "./worker";');
    writeFileSync(
      join(root, 'di-framework.config.json'),
      `${JSON.stringify({ name: 'Queue App', entry: 'src/index.ts', applicationType: 'worker' })}\n`,
    );
    writeFileSync(join(root, 'package.json'), '{ "name": "queue-app", "version": "1.0.0" }\n');
    const project = loadProject(root);
    const invocations: RunnerInvocation[] = [];
    const path = await applyWorkload(
      project,
      {
        target: 'development',
        kubeconfig: '/tmp/kube',
        namespace: 'wasmcloud',
        registry: REGISTRY,
      },
      'registry.example.com/team/queue-app:local',
      captureIo().io,
      fakeDeps({
        cwd: root,
        invocations,
        capturedStdout: { 'kubectl get': READY_WORKLOAD_JSON },
      }),
    );
    expect(path).toContain('workload.yaml');
    expect(invocations.some((entry) => entry.args.includes('apply'))).toBe(true);
  });

  it('rejects apply when another deployment already owns the storage host path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wasmcloud-apply-conflict-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'src', 'worker.ts'),
      `
import { QueueHandler } from '@di-framework/queues';
export class Worker {
  @QueueHandler('jobs')
  async run() {}
}
`,
    );
    writeFileSync(join(root, 'src', 'index.ts'), 'export * from "./worker";');
    writeFileSync(
      join(root, 'di-framework.config.json'),
      `${JSON.stringify({ name: 'Queue App', entry: 'src/index.ts', applicationType: 'worker' })}\n`,
    );
    writeFileSync(join(root, 'package.json'), '{ "name": "queue-app", "version": "1.0.0" }\n');
    const project = loadProject(root);
    await expect(
      applyWorkload(
        project,
        {
          target: 'development',
          kubeconfig: '/tmp/kube',
          namespace: 'wasmcloud',
          registry: REGISTRY,
        },
        'registry.example.com/team/queue-app:local',
        captureIo().io,
        fakeDeps({
          cwd: root,
          capturedStdout: {
            'kubectl get': JSON.stringify({
              items: [
                {
                  metadata: { name: 'other-app' },
                  spec: {
                    template: {
                      spec: {
                        volumes: [
                          { hostPath: { path: '/var/lib/di-framework/storage/queue-app' } },
                        ],
                      },
                    },
                  },
                },
              ],
            }),
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_STORAGE_OWNERSHIP_CONFLICT', exitCode: 2 });
  });

  it('creates localResources for control secrets and allowed IP lookups when no env is configured', () => {
    const { greeter } = makeWorkspace();
    const project = loadProject(greeter);
    const yaml = renderWorkloadManifest(
      { ...project, allowedIpNameLookups: ['lookup.example.com'] },
      {
        target: 'development',
        kubeconfig: '/tmp/kube',
        namespace: 'wasmcloud',
        registry: REGISTRY,
      },
      'registry.example.com/team/greeter:lookup',
    );
    expect(yaml).toContain('allowedIpNameLookups: ["lookup.example.com"]');
    expect(yaml).toContain('localResources:');
    expect(yaml).toContain('secretFrom:');
    expect(yaml).toContain('name: greeter-control');
  });

  it('uses queue requirements for worker-only apply paths and allowed IP lookups', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wasmcloud-apply-worker-only-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'index.ts'), 'export default () => new Response("ok");');
    writeFileSync(
      join(root, 'di-framework.config.json'),
      `${JSON.stringify({ name: 'Worker Only', entry: 'src/index.ts', applicationType: 'worker', ingress: false })}\n`,
    );
    writeFileSync(join(root, 'package.json'), '{ "name": "worker-only", "version": "1.0.0" }\n');
    const project = loadProject(root);
    await applyWorkload(
      project,
      {
        target: 'development',
        kubeconfig: '/tmp/kube',
        namespace: 'wasmcloud',
        registry: REGISTRY,
      },
      'registry.example.com/team/worker-only:local',
      captureIo().io,
      fakeDeps({ cwd: root, capturedStdout: { 'kubectl get': READY_WORKLOAD_JSON } }),
    );

    const yaml = renderWorkloadManifest(
      { ...project, allowedIpNameLookups: ['echo.example.com'] },
      {
        target: 'development',
        kubeconfig: '/tmp/kube',
        namespace: 'wasmcloud',
        registry: REGISTRY,
      },
      'registry.example.com/team/worker-only:local',
      [],
      [],
      undefined,
      [],
      [],
    );
    expect(yaml).toContain('allowedIpNameLookups: ["echo.example.com"]');
  });

  it('ignores malformed ownership diagnostics when kubectl returns non-JSON', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wasmcloud-apply-bad-json-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'src', 'worker.ts'),
      `
import { QueueHandler } from '@di-framework/queues';
export class Worker {
  @QueueHandler('jobs')
  async run() {}
}
`,
    );
    writeFileSync(join(root, 'src', 'index.ts'), 'export * from "./worker";');
    writeFileSync(
      join(root, 'di-framework.config.json'),
      `${JSON.stringify({ name: 'Queue App', entry: 'src/index.ts', applicationType: 'worker' })}\n`,
    );
    writeFileSync(join(root, 'package.json'), '{ "name": "queue-app", "version": "1.0.0" }\n');
    const project = loadProject(root);
    await applyWorkload(
      project,
      {
        target: 'development',
        kubeconfig: '/tmp/kube',
        namespace: 'wasmcloud',
        registry: REGISTRY,
      },
      'registry.example.com/team/queue-app:local',
      captureIo().io,
      fakeDeps({
        cwd: root,
        capturedStdout: {
          'kubectl ownership': 'not-json',
        },
      }),
    );
  });

  it('applies the generated manifest through kubectl', async () => {
    const { greeter } = makeWorkspace();
    const project = loadProject(greeter);
    const invocations: RunnerInvocation[] = [];
    const path = await applyWorkload(
      project,
      {
        target: 'development',
        kubeconfig: '/tmp/kube',
        namespace: 'wasmcloud',
        registry: REGISTRY,
      },
      'registry.example.com/team/greeter:sha256-abc',
      captureIo().io,
      fakeDeps({ cwd: greeter, invocations }),
    );
    expect(path).toContain('.di-framework');
    expect(
      invocations.some(
        (invocation) =>
          invocation.command === 'kubectl' &&
          invocation.args.includes('get') &&
          invocation.args.includes(WORKLOAD_DEPLOYMENT_RESOURCE),
      ),
    ).toBe(true);
    expect(
      invocations.some(
        (invocation) =>
          invocation.command === 'kubectl' &&
          invocation.args.includes('create') &&
          invocation.args.includes('secret') &&
          invocation.args.includes('greeter-control'),
      ),
    ).toBe(true);
    expect(
      invocations.some(
        (invocation) =>
          invocation.command === 'kubectl' &&
          invocation.args.includes('label') &&
          invocation.args.includes('secret') &&
          invocation.args.includes('greeter-control'),
      ),
    ).toBe(true);
  });

  it('reuses an existing control secret instead of recreating it', async () => {
    const { greeter } = makeWorkspace();
    const project = loadProject(greeter);
    const invocations: RunnerInvocation[] = [];
    await applyWorkload(
      project,
      {
        target: 'development',
        kubeconfig: '/tmp/kube',
        namespace: 'wasmcloud',
        registry: REGISTRY,
      },
      'registry.example.com/team/greeter:sha256-abc',
      captureIo().io,
      fakeDeps({ cwd: greeter, invocations, exitCodes: { 'kubectl get secret': 0 } }),
    );
    expect(
      invocations.some(
        (invocation) => invocation.command === 'kubectl' && invocation.args.includes('create'),
      ),
    ).toBe(false);
    expect(
      invocations.some(
        (invocation) =>
          invocation.command === 'kubectl' &&
          invocation.args.includes('label') &&
          invocation.args.includes('greeter-control'),
      ),
    ).toBe(true);
  });
});
