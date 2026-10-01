import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { CommandFailure } from '@di-framework/cli-extension';
import { createWasmcloudCommand } from '../src/command';
import {
  BACKING_SERVICE_API_VERSION,
  BACKING_SERVICE_KIND,
  BACKING_SERVICE_RESOURCE,
  buildBackingServiceManifest,
  DEFAULT_SERVICE_CLASSES,
  isBackingServiceName,
  parseServiceCreateArgs,
  parseServiceListArgs,
  parseServiceNameArgs,
  runWasmcloudServiceClasses,
  runWasmcloudServiceCreate,
  runWasmcloudServiceDelete,
  runWasmcloudServiceGet,
  runWasmcloudServiceList,
  SERVICE_TYPES,
  summarizeService,
} from '../src/service';
import {
  captureIo,
  fakeDeps,
  invocationKey,
  makeWorkspace,
  type RunnerInvocation,
} from './helpers';

const READY_SERVICE_JSON = JSON.stringify({
  metadata: { name: 'stock', namespace: 'wasmcloud' },
  spec: { type: 'keyvalue', className: 'keyvalue-redis', deletionPolicy: 'Retain' },
  status: {
    conditions: [
      {
        type: 'Ready',
        status: 'True',
        reason: 'Provisioned',
        message: 'Redis ready',
        observedGeneration: 1,
        lastTransitionTime: '2026-01-01T00:00:00Z',
      },
    ],
    endpoint: { host: 'stock.runtime.svc', port: 6379, capability: 'keyvalue' },
  },
});

const LIST_JSON = JSON.stringify({
  items: [
    JSON.parse(READY_SERVICE_JSON),
    {
      metadata: { name: 'events', namespace: 'wasmcloud' },
      spec: { type: 'messaging' },
      status: {
        conditions: [
          { type: 'Ready', status: 'False', reason: 'Provisioning', message: 'pending' },
        ],
      },
    },
  ],
});

function serviceDeps(options: {
  cwd: string;
  invocations?: RunnerInvocation[];
  exitCodes?: Record<string, number>;
  capturedStdout?: Record<string, string | undefined>;
  capturedStderr?: Record<string, string | undefined>;
}) {
  const base = fakeDeps({
    cwd: options.cwd,
    invocations: options.invocations,
    exitCodes: {
      'kubectl get backingservice name': 1,
      ...options.exitCodes,
    },
    capturedStdout: {
      'kubectl get backingservice': READY_SERVICE_JSON,
      'kubectl get backingservices': LIST_JSON,
      ...options.capturedStdout,
    },
  });
  if (!options.capturedStderr) return base;
  const stderrByKey = options.capturedStderr;
  return {
    ...base,
    runCaptured: async (
      command: string,
      args: readonly string[],
      runOptions: { cwd: string; env?: Record<string, string | undefined> },
    ) => {
      const result = await base.runCaptured(command, args, runOptions);
      const key = invocationKey(command, args);
      const stderr = stderrByKey[key];
      return stderr !== undefined ? { ...result, stderr } : result;
    },
  };
}

describe('service argument parsing', () => {
  it('parses create type, --name=, class, sizing, wait, and connection overrides', () => {
    expect(
      parseServiceCreateArgs([
        'keyvalue',
        '--name=stock',
        '--class=keyvalue-redis',
        '--memory=256Mi',
        '--storage=2Gi',
        '--cpu=500m',
        '--deletion-policy=Delete',
        '--target=development',
        '--namespace=tenant-a',
        '--context=user',
        '--wait',
        '--timeout=30',
      ]),
    ).toEqual({
      type: 'keyvalue',
      name: 'stock',
      className: 'keyvalue-redis',
      deletionPolicy: 'Delete',
      target: 'development',
      namespace: 'tenant-a',
      context: 'user',
      wait: true,
      timeoutMs: 30_000,
      parameters: { memory: '256Mi', storage: '2Gi', cpu: '500m' },
    });
  });

  it('accepts space-separated --name and messaging type', () => {
    expect(parseServiceCreateArgs(['messaging', '--name', 'events'])).toMatchObject({
      type: 'messaging',
      name: 'events',
      wait: false,
    });
  });

  it('rejects unknown types and invalid options', () => {
    expect(() => parseServiceCreateArgs(['sql', '--name=db'])).toThrow(CommandFailure);
    expect(() => parseServiceCreateArgs(['keyvalue', '--bogus'])).toThrow(/Unknown option/);
    expect(() => parseServiceCreateArgs(['keyvalue', '--timeout=0'])).toThrow(/positive/);
    expect(() => parseServiceCreateArgs(['keyvalue', '--deletion-policy=Drop'])).toThrow(
      /Retain or Delete/,
    );
  });

  it('parses get/delete name args and list connection flags', () => {
    expect(parseServiceNameArgs(['stock', '--target=development'], 'platform service get')).toEqual(
      {
        name: 'stock',
        target: 'development',
        namespace: undefined,
        context: undefined,
      },
    );
    expect(parseServiceListArgs(['--namespace=tenant-a', '--context=user'])).toEqual({
      target: undefined,
      namespace: 'tenant-a',
      context: 'user',
    });
    expect(() => parseServiceListArgs(['extra'])).toThrow(/Unexpected argument/);
  });

  it('validates DNS label names matching the CRD', () => {
    expect(isBackingServiceName('stock')).toBe(true);
    expect(isBackingServiceName('Stock')).toBe(false);
    expect(isBackingServiceName('a'.repeat(41))).toBe(false);
    expect(SERVICE_TYPES).toEqual(['keyvalue', 'messaging', 'blobstore', 'postgres']);
    expect(DEFAULT_SERVICE_CLASSES.blobstore).toBe('blobstore-nats');
    expect(DEFAULT_SERVICE_CLASSES.keyvalue).toBe('keyvalue-redis');
  });
});

describe('backing service manifest', () => {
  it('builds a BackingService CR payload without secrets', () => {
    const manifest = buildBackingServiceManifest({
      name: 'stock',
      type: 'keyvalue',
      className: 'keyvalue-redis',
      parameters: { memory: '128Mi' },
      deletionPolicy: 'Retain',
    });
    expect(manifest).toEqual({
      apiVersion: BACKING_SERVICE_API_VERSION,
      kind: BACKING_SERVICE_KIND,
      metadata: { name: 'stock' },
      spec: {
        type: 'keyvalue',
        className: 'keyvalue-redis',
        parameters: { memory: '128Mi' },
        deletionPolicy: 'Retain',
      },
    });
    expect(JSON.stringify(manifest)).not.toMatch(/password|token|secret/i);
  });

  it('summarizes Ready condition and endpoint without credentials', () => {
    const summary = summarizeService(JSON.parse(READY_SERVICE_JSON));
    expect(summary).toMatchObject({
      name: 'stock',
      type: 'keyvalue',
      className: 'keyvalue-redis',
      ready: 'True',
      endpoint: { host: 'stock.runtime.svc', port: 6379, capability: 'keyvalue' },
    });
  });
});

describe('runWasmcloudServiceCreate', () => {
  it('creates a BackingService CR through kubectl and never runs pulumi', async () => {
    const { root, kubeconfig } = makeWorkspace();
    const invocations: RunnerInvocation[] = [];
    const result = await runWasmcloudServiceCreate(
      ['keyvalue', '--name=stock', '--target=development', '--memory=128Mi'],
      captureIo().io,
      serviceDeps({ cwd: root, invocations }),
    );

    expect(invocations.every((i) => i.command !== 'pulumi')).toBe(true);
    const create = invocations.find((i) => i.command === 'kubectl' && i.args.includes('create'));
    expect(create?.args).toEqual(
      expect.arrayContaining([
        '--kubeconfig',
        kubeconfig,
        '--namespace',
        'wasmcloud',
        '--context',
        'team-development',
        'create',
        '-f',
      ]),
    );
    const manifestPath = create?.args[create.args.indexOf('-f') + 1];
    expect(manifestPath).toBeDefined();
    // create cleans up the temp file; reconstruct expected payload instead
    expect(result.data).toMatchObject({
      name: 'stock',
      type: 'keyvalue',
      className: 'keyvalue-redis',
      namespace: 'wasmcloud',
      target: 'development',
      parameters: { memory: '128Mi' },
      resource: { apiVersion: BACKING_SERVICE_API_VERSION, kind: BACKING_SERVICE_KIND },
    });
    expect(result.text).toContain('Created BackingService stock');
    expect(
      buildBackingServiceManifest({
        name: 'stock',
        type: 'keyvalue',
        parameters: { memory: '128Mi' },
      }),
    ).toMatchObject({
      kind: 'BackingService',
      metadata: { name: 'stock' },
      spec: { type: 'keyvalue', parameters: { memory: '128Mi' } },
    });
  });

  it('writes the create payload to the kubectl -f path before cleanup', async () => {
    const { root } = makeWorkspace();
    const invocations: RunnerInvocation[] = [];
    let capturedManifest = '';
    const deps = serviceDeps({ cwd: root, invocations });
    const original = deps.runCaptured;
    deps.runCaptured = async (command, args, options) => {
      if (command === 'kubectl' && args.includes('create')) {
        const path = args[args.indexOf('-f') + 1];
        if (path) capturedManifest = readFileSync(path, 'utf8');
      }
      return original(command, args, options);
    };
    await runWasmcloudServiceCreate(
      ['messaging', '--name=events', '--target=development', '--class=messaging-nats'],
      captureIo().io,
      deps,
    );
    expect(JSON.parse(capturedManifest)).toEqual({
      apiVersion: BACKING_SERVICE_API_VERSION,
      kind: BACKING_SERVICE_KIND,
      metadata: { name: 'events' },
      spec: { type: 'messaging', className: 'messaging-nats' },
    });
  });

  it('creates a blobstore with the blobstore-nats default class', async () => {
    const { root } = makeWorkspace();
    const invocations: RunnerInvocation[] = [];
    let capturedManifest = '';
    const deps = serviceDeps({ cwd: root, invocations });
    const original = deps.runCaptured;
    deps.runCaptured = async (command, args, options) => {
      if (command === 'kubectl' && args.includes('create')) {
        const path = args[args.indexOf('-f') + 1];
        if (path) capturedManifest = readFileSync(path, 'utf8');
      }
      return original(command, args, options);
    };
    const result = await runWasmcloudServiceCreate(
      ['blobstore', '--name=catalog', '--target=development'],
      captureIo().io,
      deps,
    );
    expect(result.data).toMatchObject({ type: 'blobstore', className: 'blobstore-nats' });
    expect(JSON.parse(capturedManifest)).toEqual({
      apiVersion: BACKING_SERVICE_API_VERSION,
      kind: BACKING_SERVICE_KIND,
      metadata: { name: 'catalog' },
      spec: { type: 'blobstore' },
    });
  });

  it('rejects duplicate names before creating', async () => {
    const { root } = makeWorkspace();
    await expect(
      runWasmcloudServiceCreate(
        ['keyvalue', '--name=stock', '--target=development'],
        captureIo().io,
        serviceDeps({
          cwd: root,
          exitCodes: { 'kubectl get backingservice name': 0 },
        }),
      ),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_SERVICE_ALREADY_EXISTS', exitCode: 2 });
  });

  it('rejects missing type with discovery text and invalid names', async () => {
    const { root } = makeWorkspace();
    await expect(
      runWasmcloudServiceCreate([], captureIo().io, serviceDeps({ cwd: root })),
    ).rejects.toMatchObject({ code: 'INVALID_USAGE' });
    try {
      await runWasmcloudServiceCreate([], captureIo().io, serviceDeps({ cwd: root }));
    } catch (error) {
      expect(String(error)).toContain('keyvalue');
      expect(String(error)).toContain('messaging-nats');
    }
    await expect(
      runWasmcloudServiceCreate(
        ['keyvalue', '--name=Bad_Name', '--target=development'],
        captureIo().io,
        serviceDeps({ cwd: root }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_USAGE' });
    await expect(
      runWasmcloudServiceCreate(
        ['keyvalue', '--name=stock', '--cpu=nope', '--target=development'],
        captureIo().io,
        serviceDeps({ cwd: root }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_USAGE' });
  });

  it('honors --namespace and --context overrides on kubectl', async () => {
    const { root, kubeconfig } = makeWorkspace();
    const invocations: RunnerInvocation[] = [];
    await runWasmcloudServiceCreate(
      [
        'keyvalue',
        '--name=stock',
        '--target=development',
        '--namespace=tenant-a',
        '--context=override',
      ],
      captureIo().io,
      serviceDeps({ cwd: root, invocations }),
    );
    const create = invocations.find((i) => i.args.includes('create'));
    expect(create?.args).toEqual(
      expect.arrayContaining([
        '--kubeconfig',
        kubeconfig,
        '--namespace',
        'tenant-a',
        '--context',
        'override',
      ]),
    );
  });

  it('waits for Ready and surfaces provisioning failures and timeouts', async () => {
    const { root } = makeWorkspace();
    const ready = await runWasmcloudServiceCreate(
      ['keyvalue', '--name=stock', '--target=development', '--wait', '--timeout=1'],
      captureIo().io,
      serviceDeps({
        cwd: root,
        capturedStdout: { 'kubectl get backingservice': READY_SERVICE_JSON },
      }),
    );
    expect(ready.data).toMatchObject({ ready: 'True', wait: true });
    expect(ready.text).toContain('Ready=True');

    await expect(
      runWasmcloudServiceCreate(
        ['keyvalue', '--name=stock', '--target=development', '--wait', '--timeout=1'],
        captureIo().io,
        serviceDeps({
          cwd: root,
          capturedStdout: {
            'kubectl get backingservice': JSON.stringify({
              metadata: { name: 'stock', namespace: 'wasmcloud' },
              spec: { type: 'keyvalue' },
              status: {
                conditions: [
                  {
                    type: 'Ready',
                    status: 'False',
                    reason: 'Failed',
                    message: 'quota exceeded',
                  },
                ],
              },
            }),
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_SERVICE_PROVISIONING_FAILED' });

    await expect(
      runWasmcloudServiceCreate(
        ['keyvalue', '--name=stock', '--target=development', '--wait', '--timeout=0.001'],
        captureIo().io,
        serviceDeps({
          cwd: root,
          capturedStdout: {
            'kubectl get backingservice': JSON.stringify({
              metadata: { name: 'stock' },
              spec: { type: 'keyvalue' },
              status: {
                conditions: [{ type: 'Ready', status: 'False', reason: 'Provisioning' }],
              },
            }),
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_SERVICE_NOT_READY' });
  });

  it('maps authorization and AlreadyExists kubectl errors', async () => {
    const { root } = makeWorkspace();
    await expect(
      runWasmcloudServiceCreate(
        ['keyvalue', '--name=stock', '--target=development'],
        captureIo().io,
        serviceDeps({
          cwd: root,
          exitCodes: { 'kubectl create': 1 },
          capturedStderr: {
            'kubectl create': 'Error from server (Forbidden): backingservices is forbidden',
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_SERVICE_UNAUTHORIZED' });

    await expect(
      runWasmcloudServiceCreate(
        ['keyvalue', '--name=stock', '--target=development'],
        captureIo().io,
        serviceDeps({
          cwd: root,
          exitCodes: { 'kubectl create': 1 },
          capturedStderr: {
            'kubectl create': 'Error from server (AlreadyExists): already exists',
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_SERVICE_ALREADY_EXISTS' });
  });
});

describe('service commands without --target', () => {
  it('use the default tenant target for create, list, get, delete, and classes', async () => {
    const { root } = makeWorkspace({
      manifest: `default-target = "dev"
[targets.dev]
kubeconfig = "/tmp/dev.kubeconfig"
tenant = "meshtastic"
registry = "registry.example.com/meshtastic"
`,
    });
    const invocations: RunnerInvocation[] = [];
    const deps = serviceDeps({ cwd: root, invocations });
    const created = await runWasmcloudServiceCreate(
      ['keyvalue', '--name=stock'],
      captureIo().io,
      deps,
    );
    expect(created.data).toMatchObject({ target: 'dev', namespace: 'di-tenant-meshtastic' });
    await runWasmcloudServiceList([], captureIo().io, deps);
    await runWasmcloudServiceGet(['stock'], captureIo().io, deps);
    await runWasmcloudServiceDelete(['stock'], captureIo().io, deps);
    await runWasmcloudServiceClasses([], captureIo().io, deps);
    const kubectl = invocations.filter((i) => i.command === 'kubectl');
    expect(kubectl.length).toBeGreaterThanOrEqual(5);
    for (const invocation of kubectl) {
      expect(invocation.args).toContain('di-tenant-meshtastic');
    }
  });
});

describe('runWasmcloudServiceList/get/delete/classes', () => {
  it('lists services with readable Ready/type/class/endpoint summary', async () => {
    const { root } = makeWorkspace();
    const result = await runWasmcloudServiceList(
      ['--target=development'],
      captureIo().io,
      serviceDeps({ cwd: root }),
    );
    expect(result.data).toMatchObject({ namespace: 'wasmcloud', target: 'development' });
    expect(result.text).toContain('NAME');
    expect(result.text).toContain('stock');
    expect(result.text).toContain('events');
    expect(result.text).toContain('stock.runtime.svc:6379');
    expect(result.text).not.toMatch(/password|token/i);
  });

  it('gets a named service and surfaces not found', async () => {
    const { root } = makeWorkspace();
    const result = await runWasmcloudServiceGet(
      ['stock', '--target=development'],
      captureIo().io,
      serviceDeps({ cwd: root }),
    );
    expect(result.data).toMatchObject({ name: 'stock', ready: 'True', type: 'keyvalue' });
    expect(result.text).toContain('Endpoint:');

    await expect(
      runWasmcloudServiceGet(
        ['missing', '--target=development'],
        captureIo().io,
        serviceDeps({
          cwd: root,
          exitCodes: { 'kubectl get backingservice': 1 },
          capturedStderr: {
            'kubectl get backingservice':
              'Error from server (NotFound): backingservices "missing" not found',
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_SERVICE_NOT_FOUND' });
  });

  it('deletes the CR and reports retention feedback; surfaces in-use errors', async () => {
    const { root } = makeWorkspace();
    const invocations: RunnerInvocation[] = [];
    const result = await runWasmcloudServiceDelete(
      ['stock', '--target=development'],
      captureIo().io,
      serviceDeps({ cwd: root, invocations }),
    );
    expect(
      invocations.some(
        (i) => i.args.includes('delete') && i.args.includes(BACKING_SERVICE_RESOURCE),
      ),
    ).toBe(true);
    expect(result.data).toMatchObject({ deleted: true, deletionPolicy: 'Retain' });
    expect(result.text).toContain('DeletionPolicy=Retain');

    await expect(
      runWasmcloudServiceDelete(
        ['stock', '--target=development'],
        captureIo().io,
        serviceDeps({
          cwd: root,
          exitCodes: { 'kubectl delete backingservice': 1 },
          capturedStderr: {
            'kubectl delete backingservice':
              'Error from server: cannot delete: resource is in use by ServiceBinding',
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_SERVICE_IN_USE' });
  });

  it('discovers classes from the cluster or falls back to defaults', async () => {
    const { root } = makeWorkspace();
    const fromCluster = await runWasmcloudServiceClasses(
      ['--target=development'],
      captureIo().io,
      serviceDeps({
        cwd: root,
        capturedStdout: {
          'kubectl get backingserviceclasses': JSON.stringify({
            items: [
              {
                metadata: { name: 'keyvalue-redis' },
                spec: { type: 'keyvalue', provider: 'redis', default: true },
              },
            ],
          }),
        },
      }),
    );
    expect(fromCluster.data).toMatchObject({ fromCluster: true });
    expect(fromCluster.text).toContain('keyvalue-redis');

    const fallback = await runWasmcloudServiceClasses(
      ['--target=development'],
      captureIo().io,
      serviceDeps({
        cwd: root,
        exitCodes: { 'kubectl get backingserviceclasses': 1 },
      }),
    );
    expect(fallback.data).toMatchObject({ fromCluster: false });
    expect(fallback.text).toContain('messaging-nats');
    expect(fallback.text).toMatch(/blobstore-nats\s+blobstore\s+nats/);
    expect(fallback.text).toContain('platform defaults');
  });
});

describe('platform service command tree', () => {
  it('registers create/list/get/delete/classes under service', () => {
    const command = createWasmcloudCommand();
    const service = command.children?.service;
    expect(service?.children?.create?.run).toBeTypeOf('function');
    expect(service?.children?.list?.run).toBeTypeOf('function');
    expect(service?.children?.get?.run).toBeTypeOf('function');
    expect(service?.children?.delete?.run).toBeTypeOf('function');
    expect(service?.children?.classes?.run).toBeTypeOf('function');
    expect(service?.children?.create?.usage).toContain('service create');
  });
});

describe('service edge cases for coverage', () => {
  it('rejects duplicate flags, empty equals values, and extra positionals', () => {
    expect(() => parseServiceCreateArgs(['keyvalue', '--name=a', '--name=b'])).toThrow(/only once/);
    expect(() => parseServiceCreateArgs(['keyvalue', '--name=a', '--wait', '--wait'])).toThrow(
      /only once/,
    );
    expect(() => parseServiceCreateArgs(['keyvalue', '--name='])).toThrow(/Missing value/);
    expect(() => parseServiceCreateArgs(['keyvalue', '--name', 'a', 'extra'])).toThrow(
      /Unexpected argument/,
    );
    expect(() => parseServiceCreateArgs(['keyvalue', '--class=a', '--class=b'])).toThrow(
      /only once/,
    );
    expect(() => parseServiceCreateArgs(['keyvalue', '--memory=1Mi', '--memory=2Mi'])).toThrow(
      /only once/,
    );
    expect(() => parseServiceCreateArgs(['keyvalue', '--storage=1Gi', '--storage=2Gi'])).toThrow(
      /only once/,
    );
    expect(() => parseServiceCreateArgs(['keyvalue', '--cpu=1', '--cpu=2'])).toThrow(/only once/);
    expect(() => parseServiceCreateArgs(['keyvalue', '--target=a', '--target=b'])).toThrow(
      /only once/,
    );
    expect(() =>
      parseServiceCreateArgs(['keyvalue', '--deletion-policy=Retain', '--deletion-policy=Delete']),
    ).toThrow(/only once/);
    expect(() => parseServiceCreateArgs(['keyvalue', '--timeout=30', '--timeout=60'])).toThrow(
      /only once/,
    );
    expect(() => parseServiceNameArgs(['a', 'b'], 'platform service get')).toThrow(
      /Unexpected argument/,
    );
    expect(() => parseServiceNameArgs(['--bogus'], 'platform service get')).toThrow(
      /Unknown option/,
    );
    expect(() => parseServiceNameArgs(['--namespace=a', '--namespace=b'], 'get')).toThrow(
      /only once/,
    );
    expect(() => parseServiceNameArgs(['--context=a', '--context=b'], 'get')).toThrow(/only once/);
    expect(() => parseServiceNameArgs(['--target=a', '--target=b'], 'get')).toThrow(/only once/);
    expect(() => parseServiceListArgs(['--bogus'])).toThrow(/Unknown option/);
    expect(() => parseServiceListArgs(['--namespace=a', '--namespace=b'])).toThrow(/only once/);
    expect(() => parseServiceListArgs(['--context=a', '--context=b'])).toThrow(/only once/);
    expect(() => parseServiceListArgs(['--target=a', '--target=b'])).toThrow(/only once/);
  });

  it('requires --name and valid class/namespace on create', async () => {
    const { root } = makeWorkspace();
    await expect(
      runWasmcloudServiceCreate(
        ['keyvalue', '--target=development'],
        captureIo().io,
        serviceDeps({ cwd: root }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_USAGE' });
    await expect(
      runWasmcloudServiceCreate(
        ['keyvalue', '--name=stock', '--class=Bad_Class', '--target=development'],
        captureIo().io,
        serviceDeps({ cwd: root }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_USAGE' });
    await expect(
      runWasmcloudServiceCreate(
        ['keyvalue', '--name=stock', '--namespace=INVALID_NS', '--target=development'],
        captureIo().io,
        serviceDeps({ cwd: root }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_USAGE' });
  });

  it('covers get/delete validation, empty list, Delete retention, and tool failures', async () => {
    const { root } = makeWorkspace();
    await expect(
      runWasmcloudServiceGet([], captureIo().io, serviceDeps({ cwd: root })),
    ).rejects.toMatchObject({ code: 'INVALID_USAGE' });
    await expect(
      runWasmcloudServiceGet(
        ['Bad_Name', '--target=development'],
        captureIo().io,
        serviceDeps({ cwd: root }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_USAGE' });
    await expect(
      runWasmcloudServiceDelete([], captureIo().io, serviceDeps({ cwd: root })),
    ).rejects.toMatchObject({ code: 'INVALID_USAGE' });
    await expect(
      runWasmcloudServiceDelete(
        ['Bad_Name', '--target=development'],
        captureIo().io,
        serviceDeps({ cwd: root }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_USAGE' });

    const emptyList = await runWasmcloudServiceList(
      ['--target=development'],
      captureIo().io,
      serviceDeps({
        cwd: root,
        capturedStdout: { 'kubectl get backingservices': '{"items":[]}' },
      }),
    );
    expect(emptyList.text).toContain('No BackingService');

    await expect(
      runWasmcloudServiceList(
        ['--target=development'],
        captureIo().io,
        serviceDeps({
          cwd: root,
          exitCodes: { 'kubectl get backingservices': 1 },
          capturedStderr: { 'kubectl get backingservices': 'connection refused' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_TOOL_FAILED' });

    await expect(
      runWasmcloudServiceList(
        ['--target=development'],
        captureIo().io,
        serviceDeps({
          cwd: root,
          capturedStdout: { 'kubectl get backingservices': 'not-json' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_TOOL_FAILED' });

    await expect(
      runWasmcloudServiceGet(
        ['stock', '--target=development'],
        captureIo().io,
        serviceDeps({
          cwd: root,
          capturedStdout: { 'kubectl get backingservice': 'not-json' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_TOOL_FAILED' });

    await expect(
      runWasmcloudServiceDelete(
        ['missing', '--target=development'],
        captureIo().io,
        serviceDeps({
          cwd: root,
          exitCodes: { 'kubectl get backingservice': 1 },
          capturedStderr: {
            'kubectl get backingservice': 'Error from server (NotFound): not found',
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_SERVICE_NOT_FOUND' });

    const deleted = await runWasmcloudServiceDelete(
      ['stock', '--target=development'],
      captureIo().io,
      serviceDeps({
        cwd: root,
        capturedStdout: {
          'kubectl get backingservice': JSON.stringify({
            metadata: { name: 'stock', namespace: 'wasmcloud' },
            spec: { type: 'keyvalue', deletionPolicy: 'Delete' },
          }),
        },
      }),
    );
    expect(deleted.text).toContain('DeletionPolicy=Delete');

    const classesBadJson = await runWasmcloudServiceClasses(
      ['--target=development'],
      captureIo().io,
      serviceDeps({
        cwd: root,
        capturedStdout: { 'kubectl get backingserviceclasses': 'not-json' },
      }),
    );
    expect(classesBadJson.data).toMatchObject({ fromCluster: true });
    expect(classesBadJson.text).toContain('keyvalue-redis');

    expect(
      summarizeService({
        metadata: { name: 'x' },
        spec: { type: 'messaging' },
        status: { endpoint: { host: 'h', port: 4222 } },
      }).className,
    ).toBe('messaging-nats');
  });
});
