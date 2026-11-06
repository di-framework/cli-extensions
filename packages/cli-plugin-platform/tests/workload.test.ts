import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProject } from '../src/project';
import { SECRET_UPDATE_KEYS_MESSAGE } from '../src/secret-admission';
import {
  applyWorkload,
  CONTROL_TOKEN_ROTATED_NOTICE,
  DEFAULT_DEPLOY_TIMEOUT_SECONDS,
  deleteWorkload,
  projectHasStorageOrPglite,
  renderWorkloadManifest,
  resolveDeployTimeoutSeconds,
  STORAGE_DEPLOY_TIMEOUT_SECONDS,
  STORAGE_WAIT_ATTEMPTS,
  storageDirectoryName,
  storageOwnershipConflict,
  WAIT_ATTEMPTS,
  WORKLOAD_DEPLOYMENT_RESOURCE,
  WORKLOAD_REPLICA_SET_RESOURCE,
  waitForReady,
  writeControlSecret,
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
  it('runs a long-lived workload service as the WorkloadService', () => {
    const { greeter } = makeWorkspace();
    const project = {
      ...loadProject(greeter),
      ingress: false,
      allowedIpNameLookups: ['nats.example.com'],
      workloadEntry: { kind: 'service' as const, exportName: 'collect', path: '/collect' },
    };
    const yaml = renderWorkloadManifest(
      project,
      {
        target: 'development',
        kubeconfig: '/tmp/kube',
        namespace: 'wasmcloud',
        registry: REGISTRY,
      },
      'registry.example.com/collector:1',
      [],
    );
    // wash 2.8 runs wasi:cli/run only from spec.template.spec.service; a host interface
    // named wasi:cli/run is never provided and stops the workload from starting.
    expect(yaml).toContain(
      '      service:\n        image: "registry.example.com/collector:1"\n        localResources:\n          allowedIpNameLookups: ["nats.example.com"]\n      hostInterfaces:\n',
    );
    expect(yaml).not.toContain('components:');
    expect(yaml).not.toContain('package: cli');
    expect(yaml).not.toContain('kubernetes:');
    // Every deployed guest links the wasi:logging console; the host binds it only when declared.
    expect(yaml).toMatch(
      /- namespace: wasi\n\s+package: logging\n\s+version: "?0\.1\.0-draft"?\n\s+interfaces:\n\s+- logging/,
    );
    expect(yaml).not.toContain('volumeMounts:');
  });

  it('keeps a messaging-subscription workload service as a component', () => {
    const { greeter } = makeWorkspace();
    const project = {
      ...loadProject(greeter),
      ingress: false,
      workloadEntry: {
        kind: 'service' as const,
        exportName: 'collect',
        path: '/collect',
        subscriptions: ['mesh.events'],
      },
    };
    const yaml = renderWorkloadManifest(
      project,
      {
        target: 'development',
        kubeconfig: '/tmp/kube',
        namespace: 'wasmcloud',
        registry: REGISTRY,
      },
      'registry.example.com/collector:1',
      [
        {
          package: 'wasmcloud:messaging',
          version: '0.2.0',
          interfaces: ['handler'],
          direction: 'export',
          source: 'workload-service',
        },
      ],
    );
    expect(yaml).toContain('      components:\n        - name: greeter\n');
    expect(yaml).not.toContain('      service:');
    expect(yaml).not.toContain('package: cli');
    expect(yaml).toContain('"subscriptions": "mesh.events"');
  });

  it('opts a deployment out of guest logs with an annotation and no wasi:logging', () => {
    const { greeter } = makeWorkspace();
    const project = loadProject(greeter);
    const connection = {
      target: 'development',
      kubeconfig: '/tmp/kube',
      namespace: 'wasmcloud',
      registry: REGISTRY,
    };
    const on = renderWorkloadManifest(project, connection, 'registry.example.com/greeter:1');
    expect(on).toContain('package: logging');
    expect(on).not.toContain('annotations:');
    const off = renderWorkloadManifest(
      { ...project, logs: false },
      connection,
      'registry.example.com/greeter:1',
    );
    expect(off).not.toContain('package: logging');
    expect(off).toContain('  annotations:\n    di-framework.dev/logs: "false"\nspec:');
    // Tenant storage annotations share the one annotations block.
    const tenant = renderWorkloadManifest(
      { ...project, logs: false, persistentStorage: true },
      { ...connection, namespace: 'di-tenant-acme', hostgroup: 'tenant-acme' },
      'registry.example.com/greeter:1',
    );
    expect(tenant.match(/annotations:/g)).toHaveLength(1);
    expect(tenant).toContain(
      '  annotations:\n    di-framework.dev/persistent-storage: "true"\n    di-framework.dev/logs: "false"\n',
    );
  });

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

  it('shares one storage directory across a persistent workload', () => {
    const { greeter } = makeWorkspace();
    const project = {
      ...loadProject(greeter),
      workload: 'mesh',
      persistentStorage: true,
    };
    expect(storageDirectoryName(project)).toBe('mesh');
    expect(storageDirectoryName({ ...project, persistentStorage: false })).toBe('greeter');
    expect(storageDirectoryName({ applicationName: 'Queue App' })).toBe('Queue App');
    const yaml = renderWorkloadManifest(
      project,
      {
        target: 'development',
        kubeconfig: '/tmp/kube',
        namespace: 'wasmcloud',
        registry: REGISTRY,
      },
      'registry.example.com/team/greeter:shared',
      undefined,
      [],
      { hasPersistentStorage: true },
    );
    expect(yaml).toContain('path: "/var/lib/di-framework/storage/mesh"');
    const claim = {
      metadata: { name: 'mesh-collector', labels: { 'di-framework.dev/workload': 'mesh' } },
      spec: {
        template: {
          spec: { volumes: [{ hostPath: { path: '/var/lib/di-framework/storage/mesh' } }] },
        },
      },
    };
    expect(storageOwnershipConflict(project, '/var/lib/di-framework/storage/mesh', [claim])).toBe(
      undefined,
    );
    expect(
      storageOwnershipConflict(project, '/var/lib/di-framework/storage/mesh', [
        { metadata: { name: 'other' }, spec: claim.spec },
      ]),
    ).toEqual({ owner: 'other' });
    expect(
      storageOwnershipConflict(project, '/var/lib/di-framework/storage/mesh', [
        { metadata: { name: 'empty' } },
      ]),
    ).toBe(undefined);
    expect(
      storageOwnershipConflict(project, '/var/lib/di-framework/storage/mesh', [
        { spec: claim.spec },
      ]),
    ).toEqual({ owner: 'unknown' });
    expect(
      storageOwnershipConflict({ applicationName: 'lone' }, '/var/lib/di-framework/storage/mesh', [
        claim,
      ]),
    ).toEqual({ owner: 'mesh-collector' });
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
    const created = invocations.find(
      (invocation) => invocation.command === 'kubectl' && invocation.args.includes('create'),
    );
    expect(created?.args).toEqual(
      expect.arrayContaining(['create', '--raw', '/api/v1/namespaces/wasmcloud/secrets', '-f']),
    );
    expect(
      invocations.some(
        (invocation) =>
          invocation.command === 'kubectl' &&
          (invocation.args.includes('label') || invocation.args.includes('patch')),
      ),
    ).toBe(false);
    expect(readFileSync(path, 'utf8')).toMatch(/DI_CONTROL_TOKEN_REVISION: "[0-9a-f]{16}"/);
  });

  it('replaces an existing control secret with a full update instead of reading it', async () => {
    const { greeter } = makeWorkspace();
    const project = loadProject(greeter);
    const invocations: RunnerInvocation[] = [];
    const deps = fakeDeps({ cwd: greeter, invocations });
    const runCaptured = deps.runCaptured;
    deps.runCaptured = async (command, args, options) => {
      if (command === 'kubectl' && args.includes('create') && args.includes('--raw')) {
        await runCaptured(command, args, options);
        return {
          exitCode: 1,
          stdout: '',
          stderr: 'Error from server (AlreadyExists): secrets "greeter-control" already exists',
        };
      }
      return runCaptured(command, args, options);
    };
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
      deps,
    );
    const replaced = invocations.find(
      (invocation) => invocation.command === 'kubectl' && invocation.args.includes('replace'),
    );
    expect(replaced?.args).toEqual(
      expect.arrayContaining([
        'replace',
        '--raw',
        '/api/v1/namespaces/wasmcloud/secrets/greeter-control',
      ]),
    );
    expect(
      invocations.some(
        (invocation) =>
          invocation.command === 'kubectl' &&
          invocation.args.includes('get') &&
          invocation.args.includes('secret'),
      ),
    ).toBe(false);
  });

  it('matches control secret errors on raw stderr before 400-char truncation (#59 S7)', async () => {
    const { greeter } = makeWorkspace();
    const project = loadProject(greeter);
    const connection = {
      target: 'development',
      kubeconfig: '/tmp/kube',
      namespace: 'wasmcloud',
      registry: REGISTRY,
    };
    const longWarning = `Warning: ${'x'.repeat(450)}\n`;

    const keysDeniedDeps = fakeDeps({ cwd: greeter });
    keysDeniedDeps.runCaptured = async (_command, args) => {
      if (args.includes('create')) {
        return { exitCode: 1, stdout: '', stderr: 'Error from server (AlreadyExists): exists' };
      }
      if (args.includes('can-i')) {
        return { exitCode: 1, stdout: 'no\n', stderr: '' };
      }
      return {
        exitCode: 1,
        stdout: '',
        stderr: `${longWarning}Error from server (Forbidden): ${SECRET_UPDATE_KEYS_MESSAGE}`,
      };
    };
    await expect(writeControlSecret(project, connection, keysDeniedDeps)).rejects.toMatchObject({
      code: 'WASMCLOUD_CONTROL_SECRET_FOREIGN_KEYS',
      exitCode: 2,
    });

    const conflictDeps = fakeDeps({ cwd: greeter });
    conflictDeps.runCaptured = async (_command, args) => {
      if (args.includes('create')) {
        return { exitCode: 1, stdout: '', stderr: 'Error from server (AlreadyExists): exists' };
      }
      if (args.includes('can-i')) {
        return { exitCode: 1, stdout: 'no\n', stderr: '' };
      }
      return {
        exitCode: 1,
        stdout: '',
        stderr: `${longWarning}Error from server (Conflict): Operation cannot be fulfilled on secrets "greeter-control"`,
      };
    };
    await expect(writeControlSecret(project, connection, conflictDeps)).rejects.toMatchObject({
      code: 'WASMCLOUD_CONTROL_SECRET_CHANGED',
      exitCode: 3,
    });
  });

  it('appends the rotated-token notice to non-CommandFailure Errors after Secret PUT (#59 S8)', async () => {
    const { greeter } = makeWorkspace();
    const project = loadProject(greeter);
    const connection = {
      target: 'development',
      kubeconfig: '/tmp/kube',
      namespace: 'wasmcloud',
      registry: REGISTRY,
    };
    const deps = fakeDeps({ cwd: greeter });
    const spawnError = new Error('spawn kubectl EACCES');
    deps.runner = async (command, args) => {
      if (command === 'kubectl' && args.includes('apply')) throw spawnError;
      return { exitCode: 0 };
    };
    await expect(
      applyWorkload(
        project,
        connection,
        'registry.example.com/team/greeter:1',
        captureIo().io,
        deps,
      ),
    ).rejects.toThrow(`spawn kubectl EACCES; ${CONTROL_TOKEN_ROTATED_NOTICE}`);
    expect(spawnError.message).toContain(CONTROL_TOKEN_ROTATED_NOTICE);

    deps.runner = async (command, args) => {
      if (command === 'kubectl' && args.includes('apply')) throw 'non-error-string';
      return { exitCode: 0 };
    };
    await expect(
      applyWorkload(
        project,
        connection,
        'registry.example.com/team/greeter:1',
        captureIo().io,
        deps,
      ),
    ).rejects.toBe('non-error-string');
  });

  it('supports configurable readiness timeouts and longer storage/pglite defaults (#73, #68)', async () => {
    const { greeter } = makeWorkspace();
    const baseProject = loadProject(greeter);
    const connection = {
      target: 'development',
      kubeconfig: '/tmp/kube',
      namespace: 'wasmcloud',
      registry: REGISTRY,
    };

    expect(projectHasStorageOrPglite(baseProject)).toBe(false);
    expect(projectHasStorageOrPglite({ ...baseProject, persistentStorage: true })).toBe(true);
    expect(projectHasStorageOrPglite({ ...baseProject, storage: { mount: '/data' } })).toBe(true);
    expect(
      projectHasStorageOrPglite({
        ...baseProject,
        pglite: {
          image: `ghcr.io/di-framework/pglite@sha256:${'a'.repeat(64)}`,
          dataDir: '/data/pglite',
          storageMount: '/data',
        },
      }),
    ).toBe(true);
    expect(projectHasStorageOrPglite({ ...baseProject, actors: true })).toBe(true);

    expect(resolveDeployTimeoutSeconds(baseProject, { env: {} })).toBe(
      DEFAULT_DEPLOY_TIMEOUT_SECONDS,
    );
    expect(
      resolveDeployTimeoutSeconds({ ...baseProject, persistentStorage: true }, { env: {} }),
    ).toBe(STORAGE_DEPLOY_TIMEOUT_SECONDS);
    expect(
      resolveDeployTimeoutSeconds(baseProject, {
        env: { DI_FRAMEWORK_DEPLOY_TIMEOUT_SECONDS: '120' },
      }),
    ).toBe(120);
    expect(
      resolveDeployTimeoutSeconds(
        baseProject,
        { env: { DI_FRAMEWORK_DEPLOY_TIMEOUT_SECONDS: '120' } },
        { timeoutSeconds: 10 },
      ),
    ).toBe(10);
    expect(
      resolveDeployTimeoutSeconds(baseProject, {
        env: { DI_FRAMEWORK_DEPLOY_TIMEOUT_SECONDS: 'invalid' },
      }),
    ).toBe(DEFAULT_DEPLOY_TIMEOUT_SECONDS);

    let statelessWaits = 0;
    const statelessDeps = fakeDeps({
      cwd: greeter,
      capturedStdout: { 'kubectl get': '{}' },
    });
    statelessDeps.wait = async () => {
      statelessWaits += 1;
    };
    await expect(waitForReady(baseProject, connection, statelessDeps)).rejects.toMatchObject({
      code: 'WASMCLOUD_DEPLOYMENT_NOT_READY',
      exitCode: 3,
      details: { timeoutSeconds: 60 },
      message: expect.stringContaining(
        'The workload may still become Ready while the host finishes rolling; check status with "kubectl get workloaddeployment greeter -n wasmcloud" or re-run "di-framework platform deploy greeter --target development".',
      ),
    });
    expect(statelessWaits).toBe(WAIT_ATTEMPTS);

    let storageWaits = 0;
    const storageDeps = fakeDeps({
      cwd: greeter,
      capturedStdout: { 'kubectl get': '{}' },
    });
    storageDeps.wait = async () => {
      storageWaits += 1;
    };
    const output = captureIo();
    await expect(
      waitForReady({ ...baseProject, persistentStorage: true }, connection, storageDeps, output.io),
    ).rejects.toMatchObject({
      code: 'WASMCLOUD_DEPLOYMENT_NOT_READY',
      exitCode: 3,
      details: { timeoutSeconds: 180 },
    });
    expect(storageWaits).toBe(STORAGE_WAIT_ATTEMPTS);
    expect(output.stderr.join('')).toContain(
      'check status with "kubectl get workloaddeployment greeter -n wasmcloud"',
    );

    let customWaits = 0;
    const customDeps = fakeDeps({
      cwd: greeter,
      capturedStdout: { 'kubectl get': '{}' },
    });
    customDeps.wait = async () => {
      customWaits += 1;
    };
    await expect(
      waitForReady(baseProject, connection, customDeps, undefined, { timeoutSeconds: 6 }),
    ).rejects.toMatchObject({
      code: 'WASMCLOUD_DEPLOYMENT_NOT_READY',
      details: { timeoutSeconds: 6 },
    });
    expect(customWaits).toBe(3);

    const statelessFailDeps = fakeDeps({
      cwd: greeter,
      capturedStdout: { 'kubectl get': '{}' },
    });
    statelessFailDeps.wait = async () => undefined;
    await expect(
      applyWorkload(
        baseProject,
        connection,
        'registry.example.com/team/greeter:1',
        captureIo().io,
        statelessFailDeps,
      ),
    ).rejects.toMatchObject({
      code: 'WASMCLOUD_DEPLOYMENT_NOT_READY',
      message: `WorkloadDeployment greeter in wasmcloud did not become ready; ${CONTROL_TOKEN_ROTATED_NOTICE}`,
    });

    const persistentFailDeps = fakeDeps({
      cwd: greeter,
      capturedStdout: { 'kubectl get': '{}' },
    });
    persistentFailDeps.wait = async () => undefined;
    await expect(
      applyWorkload(
        { ...baseProject, persistentStorage: true },
        connection,
        'registry.example.com/team/greeter:1',
        captureIo().io,
        persistentFailDeps,
      ),
    ).rejects.toMatchObject({
      code: 'WASMCLOUD_DEPLOYMENT_NOT_READY',
      message: expect.stringContaining(
        `check status with "kubectl get workloaddeployment greeter -n wasmcloud" or re-run "di-framework platform deploy greeter --target development".; ${CONTROL_TOKEN_ROTATED_NOTICE}`,
      ),
    });
  });

  it('covers remaining manifest, control secret, and lifecycle branches', async () => {
    const { greeter } = makeWorkspace();
    const project = loadProject(greeter);
    const connection = {
      target: 'development',
      kubeconfig: '/tmp/kube',
      namespace: 'wasmcloud',
      registry: REGISTRY,
    };

    expect(() =>
      renderWorkloadManifest(project, connection, 'img:1', undefined, [], {
        hasPersistentStorage: true,
        replicas: 2,
      }),
    ).toThrow('SQLite-backed workloads require replicas: 1');

    expect(() =>
      renderWorkloadManifest(
        {
          ...project,
          pglite: {
            image: `ghcr.io/di-framework/pglite@sha256:${'a'.repeat(64)}`,
            dataDir: '/data/pglite',
            storageMount: '/data',
          },
        },
        connection,
        'img:1',
        undefined,
        [],
        { replicas: 2 },
      ),
    ).toThrow('PGlite workloads require replicas: 1');

    expect(() =>
      renderWorkloadManifest(
        {
          ...project,
          pglite: {
            image: `ghcr.io/di-framework/pglite@sha256:${'a'.repeat(64)}`,
            dataDir: '/outside/pglite',
            storageMount: '/data',
          },
        },
        connection,
        'img:1',
      ),
    ).toThrow('outside the storage mount');

    expect(() =>
      renderWorkloadManifest(
        { ...project, persistentStorage: true },
        { ...connection, hostgroup: 'tenant-acme' },
        'img:1',
        undefined,
        [],
        { storageVolume: { mountPath: '/custom' } },
      ),
    ).toThrow('Tenant storage mounts at');

    const actorTenantYaml = renderWorkloadManifest(
      {
        ...project,
        pglite: {
          image: `ghcr.io/di-framework/pglite@sha256:${'a'.repeat(64)}`,
          dataDir: '/data/actors/pglite',
          storageMount: '/data/actors',
        },
      },
      { ...connection, hostgroup: 'tenant-acme' },
      'img:1',
      undefined,
      [],
      true,
      [
        {
          jobId: 'sync',
          name: '',
          kebabId: '',
          schedule: '*/5 * * * *',
          cronExpression: '*/5 * * * *',
          className: 'SyncJob',
          methodName: 'run',
          filePath: 'src/cron.ts',
          allowConcurrent: true,
          timeoutMs: 10_000,
        },
      ],
      [
        {
          className: 'Worker',
          methodName: 'run',
          queueName: 'mail',
          filePath: 'src/worker.ts',
          options: { concurrency: 2, maxRetries: 3, backoffMs: 1000, timeoutMs: 5000 },
        },
      ],
    );
    expect(actorTenantYaml).toContain('di-framework.dev/storage-mount: "/data/actors"');
    expect(actorTenantYaml).toContain('di-framework.dev/exclusive-instance: "true"');
    expect(actorTenantYaml).toContain('DI_QUEUE_MAIL_CONCURRENCY: "2"');
    expect(actorTenantYaml).toContain('DI_QUEUE_MAIL_MAX_RETRIES: "3"');
    expect(actorTenantYaml).toContain('DI_QUEUE_MAIL_BACKOFF_MS: "1000"');
    expect(actorTenantYaml).toContain('DI_QUEUE_MAIL_TIMEOUT_MS: "5000"');
    expect(actorTenantYaml).toContain('concurrencyPolicy: Allow');

    const encode = (v: string) => Buffer.from(v, 'utf8').toString('base64');
    const adminDeps = fakeDeps({ cwd: greeter });
    adminDeps.runCaptured = async (_cmd, args) => {
      if (args.includes('create'))
        return { exitCode: 1, stdout: '', stderr: 'Error from server (AlreadyExists): exists' };
      if (args.includes('can-i')) return { exitCode: 0, stdout: 'yes\n', stderr: '' };
      if (args.includes('get')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            metadata: { resourceVersion: '1' },
            data: {
              DI_CONTROL_TOKEN: encode('tok'),
              DI_CONTROL_IDENTITY: encode('greeter'),
              APP_KEY: encode('short'),
              TINY: encode('ab'),
            },
          }),
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const rotated = await writeControlSecret(
      { ...project, controlSecretKeys: ['APP_KEY', 'TINY'] },
      connection,
      adminDeps,
    );
    expect(rotated.revision).toBeDefined();

    await expect(writeControlSecret(project, connection, adminDeps)).rejects.toMatchObject({
      code: 'WASMCLOUD_CONTROL_SECRET_FOREIGN_KEYS',
    });

    const adminReplaceFailDeps = fakeDeps({ cwd: greeter });
    adminReplaceFailDeps.runCaptured = async (_cmd, args) => {
      if (args.includes('create'))
        return { exitCode: 1, stdout: '', stderr: 'Error from server (AlreadyExists): exists' };
      if (args.includes('can-i')) return { exitCode: 0, stdout: 'yes\n', stderr: '' };
      if (args.includes('get')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            metadata: {},
            data: { TINY: encode('ab') },
          }),
          stderr: '',
        };
      }
      return { exitCode: 1, stdout: '', stderr: 'Error from server (BadRequest): token ab failed' };
    };
    await expect(
      writeControlSecret(
        { ...project, controlSecretKeys: ['TINY'] },
        connection,
        adminReplaceFailDeps,
      ),
    ).rejects.toMatchObject({
      code: 'WASMCLOUD_TOOL_FAILED',
      message: expect.stringContaining('[redacted]'),
    });

    const adminGetFailDeps = fakeDeps({ cwd: greeter });
    adminGetFailDeps.runCaptured = async (_cmd, args) => {
      if (args.includes('create'))
        return { exitCode: 1, stdout: '', stderr: 'Error from server (AlreadyExists): exists' };
      if (args.includes('can-i')) return { exitCode: 0, stdout: 'yes\n', stderr: '' };
      return { exitCode: 1, stdout: '', stderr: '' };
    };
    await expect(writeControlSecret(project, connection, adminGetFailDeps)).rejects.toMatchObject({
      code: 'WASMCLOUD_TOOL_FAILED',
    });

    const adminBadJsonDeps = fakeDeps({ cwd: greeter });
    adminBadJsonDeps.runCaptured = async (_cmd, args) => {
      if (args.includes('create'))
        return { exitCode: 1, stdout: '', stderr: 'Error from server (AlreadyExists): exists' };
      if (args.includes('can-i')) return { exitCode: 0, stdout: 'yes\n', stderr: '' };
      return { exitCode: 0, stdout: '{', stderr: '' };
    };
    await expect(writeControlSecret(project, connection, adminBadJsonDeps)).rejects.toMatchObject({
      code: 'WASMCLOUD_TOOL_FAILED',
    });

    const adminNonStringDeps = fakeDeps({ cwd: greeter });
    adminNonStringDeps.runCaptured = async (_cmd, args) => {
      if (args.includes('create'))
        return { exitCode: 1, stdout: '', stderr: 'Error from server (AlreadyExists): exists' };
      if (args.includes('can-i')) return { exitCode: 0, stdout: 'yes\n', stderr: '' };
      return { exitCode: 0, stdout: JSON.stringify({ data: { BAD: 123 } }), stderr: '' };
    };
    await expect(writeControlSecret(project, connection, adminNonStringDeps)).rejects.toMatchObject(
      { code: 'WASMCLOUD_TOOL_FAILED' },
    );

    const createFailDeps = fakeDeps({ cwd: greeter });
    createFailDeps.runCaptured = async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'Error from server (Forbidden): forbidden',
    });
    await expect(writeControlSecret(project, connection, createFailDeps)).rejects.toMatchObject({
      code: 'WASMCLOUD_TOOL_FAILED',
    });

    const unguardedDeps = fakeDeps({ cwd: greeter });
    unguardedDeps.runCaptured = async (_cmd, args) => {
      if (args.includes('create'))
        return { exitCode: 1, stdout: '', stderr: 'Error from server (AlreadyExists): exists' };
      if (args.includes('can-i')) return { exitCode: 1, stdout: 'no\n', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    await expect(
      writeControlSecret({ ...project, controlSecretKeys: ['APP_KEY'] }, connection, unguardedDeps),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_CONTROL_SECRET_UNGUARDED' });

    let dryRunStep = 0;
    const keptSecretDeps = fakeDeps({ cwd: greeter });
    keptSecretDeps.runCaptured = async (_cmd, args) => {
      if (args.includes('create'))
        return { exitCode: 1, stdout: '', stderr: 'Error from server (AlreadyExists): exists' };
      if (args.includes('can-i')) return { exitCode: 1, stdout: 'no\n', stderr: '' };
      if (args.some((a) => a.includes('dryRun=All'))) {
        dryRunStep += 1;
        if (dryRunStep === 2) return { exitCode: 0, stdout: '', stderr: '' };
        return { exitCode: 1, stdout: '', stderr: SECRET_UPDATE_KEYS_MESSAGE };
      }
      if (args.includes('replace')) {
        return { exitCode: 1, stdout: '', stderr: SECRET_UPDATE_KEYS_MESSAGE };
      }
      if (args.includes('--ignore-not-found')) {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return { exitCode: 0, stdout: READY_WORKLOAD_JSON, stderr: '' };
    };
    keptSecretDeps.wait = async () => undefined;
    const keptIo = captureIo();
    await applyWorkload(
      {
        ...project,
        controlSecretKeys: ['APP_KEY'],
        allowedIpNameLookups: ['api.example.com'],
        workloadEntry: {
          kind: 'service',
          exportName: 'collect',
          path: '/collect',
          subscriptions: ['events'],
        },
      },
      { ...connection, hostgroup: 'tenant-acme' },
      'img:1',
      keptIo.io,
      keptSecretDeps,
    );
    expect(keptIo.stdout.join('')).toContain('Kept control Secret');

    let incompleteStep = 0;
    const incompleteDeps = fakeDeps({ cwd: greeter });
    incompleteDeps.runCaptured = async (_cmd, args) => {
      if (args.includes('create'))
        return { exitCode: 1, stdout: '', stderr: 'Error from server (AlreadyExists): exists' };
      if (args.includes('can-i')) return { exitCode: 1, stdout: 'no\n', stderr: '' };
      if (args.some((a) => a.includes('dryRun=All'))) {
        incompleteStep += 1;
        if (incompleteStep >= 2) return { exitCode: 0, stdout: '', stderr: '' };
        return { exitCode: 1, stdout: '', stderr: SECRET_UPDATE_KEYS_MESSAGE };
      }
      return { exitCode: 1, stdout: '', stderr: SECRET_UPDATE_KEYS_MESSAGE };
    };
    await expect(
      writeControlSecret(
        { ...project, controlSecretKeys: ['APP_KEY'] },
        connection,
        incompleteDeps,
      ),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_CONTROL_SECRET_INCOMPLETE' });

    const foreignDryRunDeps = fakeDeps({ cwd: greeter });
    foreignDryRunDeps.runCaptured = async (_cmd, args) => {
      if (args.includes('create'))
        return { exitCode: 1, stdout: '', stderr: 'Error from server (AlreadyExists): exists' };
      if (args.includes('can-i')) return { exitCode: 1, stdout: 'no\n', stderr: '' };
      return { exitCode: 1, stdout: '', stderr: SECRET_UPDATE_KEYS_MESSAGE };
    };
    await expect(
      writeControlSecret(
        { ...project, controlSecretKeys: ['APP_KEY'] },
        connection,
        foreignDryRunDeps,
      ),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_CONTROL_SECRET_FOREIGN_KEYS' });

    const dryRunErrorDeps = fakeDeps({ cwd: greeter });
    dryRunErrorDeps.runCaptured = async (_cmd, args) => {
      if (args.includes('create'))
        return { exitCode: 1, stdout: '', stderr: 'Error from server (AlreadyExists): exists' };
      if (args.includes('can-i')) return { exitCode: 1, stdout: 'no\n', stderr: '' };
      return { exitCode: 1, stdout: '', stderr: 'Error from server (InternalError): boom' };
    };
    await expect(
      writeControlSecret(
        { ...project, controlSecretKeys: ['APP_KEY'] },
        connection,
        dryRunErrorDeps,
      ),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_TOOL_FAILED' });

    await applyWorkload(
      { ...project, ingress: false },
      connection,
      'img:1',
      captureIo().io,
      fakeDeps({ cwd: greeter, capturedStdout: { 'kubectl get': READY_WORKLOAD_JSON } }),
    );
    await expect(
      applyWorkload(
        { ...project, ingress: false },
        connection,
        'img:1',
        captureIo().io,
        fakeDeps({ cwd: greeter, exitCodes: { 'kubectl apply': 1 } }),
      ),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_TOOL_FAILED' });

    await deleteWorkload(project, connection, captureIo().io, fakeDeps({ cwd: greeter }));
  });
});
