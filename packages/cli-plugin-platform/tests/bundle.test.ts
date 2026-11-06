import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWasmcloudBuild } from '../src/build';
import {
  buildDeployBundle,
  type DeployBundle,
  normalizeSha256Digest,
  PASSTHROUGH_LABEL_PREFIX,
  parseBuildArgs,
  parseWorkloadDeploymentYaml,
  pinImageToDigest,
  sanitizeWorkloadForBundle,
} from '../src/bundle';
import { loadProject } from '../src/project';
import {
  captureIo,
  expectFailure,
  fakeDeps,
  makeAssets,
  makeProject,
  makeWorkspace,
  type RunnerInvocation,
} from './helpers';

const DNS_LABEL = /^[a-z]([a-z0-9-]*[a-z0-9])?$/;
const SECRET_NAME = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/;
const CAPABILITIES = ['keyvalue', 'messaging', 'blobstore', 'postgres', 'egress'];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Exact validation rules enforced by `/v1/deploy` in `tenant-auth/src/v1/deploy.ts`.
 * Returns `undefined` when the bundle is valid or the rejection reason string.
 */
function controllerInvalidReason(bundle: DeployBundle): string | undefined {
  const { service, env, component, workload, bindings, secrets } = bundle;
  if (!DNS_LABEL.test(service) || service.length > 40)
    return 'service must be a DNS label of at most 40 characters';
  if (!component.reference) return 'component.reference must not be empty';
  if (!/^sha256:[0-9a-f]+$/.test(component.digest))
    return 'component.digest must be a sha256 digest';
  if (workload.kind !== undefined && workload.kind !== 'WorkloadDeployment')
    return 'workload.kind must be WorkloadDeployment';
  if (workload.apiVersion !== undefined && workload.apiVersion !== 'runtime.wasmcloud.dev/v1alpha1')
    return 'workload.apiVersion must be runtime.wasmcloud.dev/v1alpha1';
  const metadata = workload.metadata;
  if (metadata !== undefined && !isObject(metadata)) return 'workload.metadata must be an object';
  if (metadata) {
    for (const key of Object.keys(metadata))
      if (!['name', 'namespace', 'labels', 'annotations'].includes(key))
        return `workload.metadata.${key} is not allowed; only labels and annotations pass through`;
    for (const key of ['labels', 'annotations']) {
      const map = metadata[key];
      if (map === undefined) continue;
      if (!isObject(map) || !Object.values(map).every((value) => typeof value === 'string'))
        return `workload.metadata.${key} must map strings to strings`;
      for (const name of Object.keys(map))
        if (!name.startsWith(PASSTHROUGH_LABEL_PREFIX))
          return `workload.metadata.${key}.${name} must start with ${PASSTHROUGH_LABEL_PREFIX}`;
    }
  }
  if (metadata?.namespace !== undefined)
    return 'workload.metadata.namespace is set by the controller';
  if (metadata?.name !== undefined && metadata.name !== `${service}-${env}`)
    return `workload.metadata.name must be ${service}-${env} or absent`;
  const spec = workload.spec;
  const template = isObject(spec) && isObject(spec.template) ? spec.template.spec : undefined;
  if (!isObject(template)) return 'workload.spec.template.spec must be an object';
  for (const field of ['hostSelector', 'environment', 'hostId'])
    if (template[field] !== undefined)
      return `workload.spec.template.spec.${field} is set by the controller`;
  const components = template.components;
  if (!Array.isArray(components) || components.length === 0 || !components.every(isObject))
    return 'workload.spec.template.spec.components must be a non-empty array of objects';
  if (Array.isArray(template.hostInterfaces)) {
    for (const [index, entry] of template.hostInterfaces.entries()) {
      if (!isObject(entry) || entry.namespace !== 'wasi' || entry.package !== 'http') continue;
      const at = `workload.spec.template.spec.hostInterfaces[${index}]`;
      if (
        entry.version !== '0.3.0' ||
        !Array.isArray(entry.interfaces) ||
        entry.interfaces.length !== 1 ||
        entry.interfaces[0] !== 'handler'
      )
        return `${at} must be wasi:http@0.3.0 with interfaces [handler]`;
      const config = entry.config;
      if (config !== undefined && !isObject(config)) return `${at}.config must be an object`;
      if (config?.host !== undefined && config.host !== `${service}-${env}`)
        return `${at}.config.host must be ${service}-${env}, the service and env, or absent`;
    }
  }
  const guests: [string, unknown][] = components.map((guest, index) => [
    `components[${index}]`,
    guest,
  ]);
  if (template.service !== undefined) guests.push(['service', template.service]);
  for (const [at, guest] of guests) {
    if (!isObject(guest)) return `workload.spec.template.spec.${at} must be an object`;
    const local = guest.localResources;
    const environment = isObject(local) ? local.environment : undefined;
    for (const field of ['configFrom', 'secretFrom'])
      if (isObject(environment) && environment[field] !== undefined)
        return `workload.spec.template.spec.${at}.localResources.environment.${field} is set by the controller`;
  }
  if (
    !components.some(
      (guest) => typeof guest.image === 'string' && guest.image.endsWith(`@${component.digest}`),
    )
  )
    return 'workload does not run component.digest: no component image is pinned to it';
  const seen = new Set<string>();
  for (const [index, binding] of bindings.entries()) {
    const at = `bindings[${index}]`;
    if (!DNS_LABEL.test(binding.name) || binding.name.length > 63)
      return `${at}.name must be a DNS label`;
    if (seen.has(binding.name)) return `${at}.name repeats ${binding.name}`;
    seen.add(binding.name);
    if (!CAPABILITIES.includes(binding.capability))
      return `${at}.capability must be one of ${CAPABILITIES.join(', ')}`;
    if (!binding.serviceName || !DNS_LABEL.test(binding.serviceName))
      return `${at}.serviceName must name a backing service in the tenant`;
  }
  for (const [index, name] of secrets.entries()) {
    if (!SECRET_NAME.test(name) || name.startsWith('di-binding-') || name.startsWith('di-bs-'))
      return `secrets[${index}] must be a tenant secret name`;
    if (secrets.indexOf(name) !== index) return `secrets[${index}] repeats ${name}`;
  }
  return undefined;
}

describe('DeployBundle helpers', () => {
  it('normalizes sha256 digests and pins OCI references by digest', () => {
    const hex = 'a'.repeat(64);
    expect(normalizeSha256Digest(hex)).toBe(`sha256:${hex}`);
    expect(normalizeSha256Digest(`sha256:${hex}`)).toBe(`sha256:${hex}`);
    expect(pinImageToDigest('registry.example.com/acme/orders:sha256-1234', hex)).toBe(
      `registry.example.com/acme/orders@sha256:${hex}`,
    );
    expect(pinImageToDigest('localhost:5000/orders@sha256:old', `sha256:${hex}`)).toBe(
      `localhost:5000/orders@sha256:${hex}`,
    );
    expect(pinImageToDigest('localhost:5000/orders', hex)).toBe(
      `localhost:5000/orders@sha256:${hex}`,
    );
  });

  it('parses CLI build args and rejects invalid usage', () => {
    expect(parseBuildArgs([])).toEqual({});
    expect(
      parseBuildArgs([
        '--bundle',
        'dist/bundle.json',
        '--env',
        'staging',
        '--target',
        'dev',
        '--registry',
        'registry.example.com/acme',
        '--tag',
        'v1.0.0',
        'greeter',
      ]),
    ).toEqual({
      bundle: 'dist/bundle.json',
      env: 'staging',
      target: 'dev',
      registry: 'registry.example.com/acme',
      tag: 'v1.0.0',
      name: 'greeter',
    });
    expect(
      parseBuildArgs([
        '--bundle=out.json',
        '--env=prod',
        '--target=prod',
        '--registry=reg.io/acme',
        '--tag=latest',
      ]),
    ).toEqual({
      bundle: 'out.json',
      env: 'prod',
      target: 'prod',
      registry: 'reg.io/acme',
      tag: 'latest',
    });

    for (const badArgs of [
      ['--bundle'],
      ['--bundle', '--env'],
      ['--bundle', 'out.json', '--env', 'dev'],
      ['--bundle', 'out.json', '--target'],
      ['--bundle', 'out.json', '--registry'],
      ['--bundle', 'out.json', '--tag'],
      ['--bundle', 'out.json', '--unknown'],
      ['--bundle', 'out.json', 'app-one', 'app-two'],
      ['--env', 'prod'],
      ['greeter'],
    ]) {
      expectFailure(() => parseBuildArgs(badArgs), 'INVALID_USAGE', 2);
    }
  });

  it('sanitizes controller-owned fields, service specs, and hostInterfaces', () => {
    const digest = `sha256:${'b'.repeat(64)}`;
    const component = { reference: 'registry.example.com/acme/svc:v1', digest };

    // Service-only workload (runsAsService) with empty localResources after stripping
    const serviceWorkload = {
      apiVersion: 'runtime.wasmcloud.dev/v1alpha1',
      kind: 'WorkloadDeployment',
      metadata: {
        name: 'svc',
        namespace: 'di-tenant-acme',
        labels: {
          'app.kubernetes.io/name': 'svc',
          'app.di-framework.dev/team': 'core',
        },
        annotations: {
          'di-framework.dev/logs': 'false',
          'app.di-framework.dev/release': '2026.11',
        },
      },
      spec: {
        replicas: 1,
        template: {
          spec: {
            environment: 'di-tenant-acme',
            hostId: 'host-1',
            hostSelector: { hostgroup: 'tenant-acme' },
            volumes: [{ name: 'data' }],
            service: {
              image: 'registry.example.com/acme/svc:v1',
              localResources: {
                volumeMounts: [{ name: 'data', mountPath: '/data' }],
                allowedIpNameLookups: ['api.example.com'],
                environment: {
                  configFrom: [{ name: 'vars' }],
                  secretFrom: [{ name: 'svc-control' }],
                },
              },
            },
            hostInterfaces: [
              {
                namespace: 'wasi',
                package: 'http',
                version: '0.3.0',
                interfaces: ['handler'],
                config: { host: 'svc.di-tenant-acme.svc.cluster.local', path: '/api' },
                configFrom: [{ name: 'http-cfg' }],
                secretFrom: [{ name: 'http-sec' }],
              },
            ],
          },
        },
      },
    };

    const sanitized = sanitizeWorkloadForBundle(serviceWorkload, {
      service: 'svc',
      env: 'staging',
      component,
      publicIngress: false,
      labels: {
        'app.di-framework.dev/tier': 'backend',
        'ignored.example.com/key': 'ignored',
      },
      annotations: {
        'app.di-framework.dev/commit': 'abc1234',
        'ignored.example.com/ann': 'ignored',
      },
    });

    expect(sanitized.metadata).toEqual({
      name: 'svc-staging',
      labels: {
        'app.di-framework.dev/team': 'core',
        'app.di-framework.dev/tier': 'backend',
      },
      annotations: {
        'app.di-framework.dev/release': '2026.11',
        'app.di-framework.dev/commit': 'abc1234',
      },
    });
    const templateSpec = (
      (sanitized.spec as Record<string, unknown>).template as Record<string, unknown>
    ).spec as Record<string, unknown>;
    expect(templateSpec.service).toBeUndefined();
    expect(templateSpec.components).toEqual([
      {
        name: 'svc',
        image: `registry.example.com/acme/svc@${digest}`,
      },
    ]);
    expect(templateSpec.hostInterfaces).toEqual([
      {
        namespace: 'wasi',
        package: 'http',
        version: '0.3.0',
        interfaces: ['handler'],
        config: { path: '/api' },
      },
    ]);

    // Also test when both components and service are present and defaults are used
    const withBoth = sanitizeWorkloadForBundle(
      {
        spec: {
          template: {
            spec: {
              components: [{ name: 'svc', image: 'old' }],
              service: { image: 'old-service' },
              hostInterfaces: [
                {
                  namespace: 'wasi',
                  package: 'http',
                  version: '0.3.0',
                  interfaces: ['handler'],
                },
              ],
            },
          },
        },
      },
      {
        service: 'svc',
        env: 'prod',
        component,
      },
    );
    const bothSpec = (
      (withBoth.spec as Record<string, unknown>).template as Record<string, unknown>
    ).spec as Record<string, unknown>;
    expect(bothSpec.service).toEqual({ image: `registry.example.com/acme/svc@${digest}` });
    expect(bothSpec.hostInterfaces).toEqual([
      {
        namespace: 'wasi',
        package: 'http',
        version: '0.3.0',
        interfaces: ['handler'],
        config: { host: 'svc-prod' },
      },
    ]);
  });

  it('parses sequence items with nested blocks in parseWorkloadDeploymentYaml', () => {
    const parsed = parseWorkloadDeploymentYaml(`apiVersion: runtime.wasmcloud.dev/v1alpha1
kind: WorkloadDeployment
spec:
  items:
    - nested:
        key: "value"
      other: 2
`);
    expect(parsed).toEqual({
      apiVersion: 'runtime.wasmcloud.dev/v1alpha1',
      kind: 'WorkloadDeployment',
      spec: {
        items: [
          {
            nested: { key: 'value' },
            other: 2,
          },
        ],
      },
    });
  });
});

describe('buildDeployBundle and platform build --bundle', () => {
  it('builds a controller-valid DeployBundle from di-framework.deploy.toml and writes --bundle JSON', async () => {
    const { root, greeter } = makeWorkspace();
    writeFileSync(
      join(root, 'di-framework.deploy.toml'),
      `default-target = "tenant"
secrets = ["stripe-key", "webhook-secret", "stripe-key"]

[bindings.cache]
capability = "keyvalue"
service = "redis-shared"

[bindings.events]
capability = "messaging"
serviceName = "nats-events"

[bindings.events.config]
subject = "orders.created"

[targets.tenant]
kubeconfig = "/tmp/tenant.kubeconfig"
tenant = "acme"
registry = "registry.example.com/acme"
env = "staging"
secrets = ["webhook-secret", "jwt-signing-key"]

[targets.tenant.bindings.cache]
capability = "keyvalue"
service-name = "redis-staging"
`,
    );

    const invocations: RunnerInvocation[] = [];
    const output = captureIo();
    const outPath = join(root, 'out', 'greeter.bundle.json');
    const deps = fakeDeps({
      cwd: root,
      assets: makeAssets(),
      invocations,
      exitCodes: { 'manifest fetch': 1 },
    });

    const result = await runWasmcloudBuild(['greeter', '--bundle', outPath], output.io, deps);

    expect(existsSync(outPath)).toBe(true);
    const written = JSON.parse(readFileSync(outPath, 'utf8')) as DeployBundle;
    expect(result.data as unknown as DeployBundle).toEqual(written);
    expect(result.text).toContain('Wrote DeployBundle for greeter (staging)');

    expect(written.service).toBe('greeter');
    expect(written.env).toBe('staging');
    expect(written.component.reference).toMatch(
      /^registry\.example\.com\/acme\/greeter:sha256-[0-9a-f]{64}$/,
    );
    expect(written.component.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(written.bindings).toEqual([
      {
        name: 'cache',
        capability: 'keyvalue',
        serviceName: 'redis-staging',
      },
      {
        name: 'events',
        capability: 'messaging',
        serviceName: 'nats-events',
        config: { subject: 'orders.created' },
      },
    ]);
    expect(written.secrets).toEqual(['stripe-key', 'webhook-secret', 'jwt-signing-key']);

    // Verify controller validation contract
    expect(controllerInvalidReason(written)).toBeUndefined();

    // Check workload details
    const metadata = written.workload.metadata as Record<string, unknown>;
    expect(metadata).toEqual({ name: 'greeter-staging' });
    const templateSpec = (
      (written.workload.spec as Record<string, unknown>).template as Record<string, unknown>
    ).spec as Record<string, unknown>;
    expect(templateSpec.hostSelector).toBeUndefined();
    expect(templateSpec.environment).toBeUndefined();
    expect(templateSpec.hostId).toBeUndefined();
    expect(templateSpec.kubernetes).toBeUndefined();

    const components = templateSpec.components as Record<string, unknown>[];
    expect(components).toHaveLength(1);
    expect(components[0]?.image).toBe(
      `registry.example.com/acme/greeter@${written.component.digest}`,
    );
    const localEnv = (components[0]?.localResources as Record<string, unknown>)
      ?.environment as Record<string, unknown>;
    expect(localEnv.configFrom).toBeUndefined();
    expect(localEnv.secretFrom).toBeUndefined();

    const hostInterfaces = templateSpec.hostInterfaces as Record<string, unknown>[];
    const httpIface = hostInterfaces.find(
      (entry) => entry.namespace === 'wasi' && entry.package === 'http',
    );
    expect(httpIface?.config).toEqual({ host: 'greeter-staging' });

    // Also verify when OCI tag already exists in registry
    const cachedDeps = fakeDeps({
      cwd: greeter,
      assets: makeAssets(),
      exitCodes: { 'manifest fetch': 0 },
    });
    const secondBundle = await buildDeployBundle({ env: 'prod' }, captureIo().io, cachedDeps);
    expect(secondBundle.env).toBe('prod');
    expect(controllerInvalidReason(secondBundle)).toBeUndefined();
  });

  it('omits wasi:http config.host for ingress: false and queue worker workloads', async () => {
    // 1. ingress: false project
    const ingressFalseRoot = makeProject({
      name: 'Internal Api',
      entry: 'src/app.ts',
      ingress: false,
      persistentStorage: true,
    });
    const deps1 = fakeDeps({ cwd: ingressFalseRoot, assets: makeAssets() });
    const bundle1 = await buildDeployBundle(
      {
        registry: 'registry.example.com/acme',
        publish: async ({ build }) => ({
          reference: `registry.example.com/acme/internal-api:sha256-${build.deploymentDigest}`,
          digest: build.artifactDigest,
        }),
      },
      captureIo().io,
      deps1,
    );

    expect(controllerInvalidReason(bundle1)).toBeUndefined();
    const spec1 = (
      (bundle1.workload.spec as Record<string, unknown>).template as Record<string, unknown>
    ).spec as Record<string, unknown>;
    const http1 = (spec1.hostInterfaces as Record<string, unknown>[]).find(
      (entry) => entry.namespace === 'wasi' && entry.package === 'http',
    );
    expect(http1).toBeDefined();
    expect(http1?.config).toBeUndefined();

    // 2. queue worker project
    const workerRoot = mkdtempSync(join(tmpdir(), 'wasmcloud-bundle-worker-'));
    const srcDir = join(workerRoot, 'src');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(
      join(srcDir, 'worker.ts'),
      `import { Container } from '@di-framework/core';
import { QueueHandler } from '@di-framework/queues';
@Container()
export class Worker {
  @QueueHandler('emails')
  async handle() {}
}
`,
    );
    writeFileSync(join(srcDir, 'index.ts'), 'export * from "./worker";');
    writeFileSync(
      join(workerRoot, 'di-framework.config.json'),
      `${JSON.stringify({ name: 'Email Worker', entry: 'src/index.ts', applicationType: 'worker' })}\n`,
    );
    writeFileSync(
      join(workerRoot, 'package.json'),
      '{ "name": "email-worker", "version": "1.0.0" }\n',
    );
    const assets = makeAssets();
    mkdirSync(join(assets, 'sqlite'), { recursive: true });
    writeFileSync(join(assets, 'sqlite', 'di-framework-sqlite.wasm'), 'sqlite-provider');

    const bundle2 = await buildDeployBundle(
      {
        project: loadProject(workerRoot),
        env: 'staging',
        publish: async ({ build }) => ({
          reference: `registry.example.com/acme/email-worker:sha256-${build.deploymentDigest}`,
          digest: `sha256:${build.artifactDigest}`,
        }),
      },
      captureIo().io,
      fakeDeps({
        cwd: workerRoot,
        assets,
        componentOutput: () => `\0asm sqlite-import`,
        capturedStdout: {
          wit: `world application {
  export wasi:http/handler@0.3.0;
  import di-framework:sqlite/database@0.1.0;
}
`,
        },
        captures: { wac: undefined },
      }),
    );

    expect(controllerInvalidReason(bundle2)).toBeUndefined();
    const spec2 = (
      (bundle2.workload.spec as Record<string, unknown>).template as Record<string, unknown>
    ).spec as Record<string, unknown>;
    const http2 = (spec2.hostInterfaces as Record<string, unknown>[]).find(
      (entry) => entry.namespace === 'wasi' && entry.package === 'http',
    );
    expect(http2).toBeDefined();
    expect(http2?.config).toBeUndefined();
  });

  it('discovers managed project bindings, supports credentials/tag pushing, and manifest without targets', async () => {
    const root = makeProject({ name: 'Orders Service', entry: 'src/app.ts', logs: false });
    writeFileSync(
      join(root, 'di-framework.deploy.toml'),
      `env = "prod"
secrets = ["orders-api-key"]

[bindings.cache]
capability = "keyvalue"
`,
    );
    writeFileSync(
      join(root, 'src', 'bindings.ts'),
      `import { Config, Postgres, PlatformBinding } from '@di-framework/bindings';
@PlatformBinding('orders-db', { serviceName: 'pg-main' })
export class OrdersDb extends Postgres {}
@PlatformBinding('app-cfg')
export class AppCfg extends Config {}
`,
    );
    writeFileSync(
      join(root, 'catalog.json'),
      `${JSON.stringify({
        Postgres: {
          kind: 'Postgres',
          package: 'wasmcloud:postgres',
          version: '0.2.0',
          interfaces: ['query', 'prepared', 'types'],
          primaryInterface: 'query',
          namedInstance: true,
          sharedResources: [],
          witDep: 'wasmcloud-postgres',
          usesSecret: true,
          configKeys: [],
        },
        Config: {
          kind: 'Config',
          package: 'wasi:config',
          version: '0.2.0-rc.1',
          interfaces: ['store'],
          primaryInterface: 'store',
          namedInstance: false,
          sharedResources: [],
          witDep: 'wasi-config',
          usesSecret: false,
          configKeys: [],
        },
      })}\n`,
    );

    const invocations: RunnerInvocation[] = [];
    const deps = fakeDeps({
      cwd: root,
      assets: makeAssets(),
      invocations,
      resolutions: { '@di-framework/bindings/catalog.json': join(root, 'catalog.json') },
    });

    const bundle = await buildDeployBundle(
      {
        tag: 'v2.1.0',
        credentials: async () => ({
          registry: 'http://127.0.0.1:25000/tenant-acme',
          repository: 'orders-service',
          username: 'robot',
          password: 'secret-password',
        }),
        bindings: [
          {
            name: 'blob',
            capability: 'blobstore',
            serviceName: 's3-assets',
          },
        ],
        secrets: ['extra-secret'],
      },
      captureIo().io,
      deps,
    );

    expect(controllerInvalidReason(bundle)).toBeUndefined();
    expect(bundle.component.reference).toBe('127.0.0.1:25000/tenant-acme/orders-service:v2.1.0');
    expect(bundle.bindings).toEqual([
      {
        name: 'orders-db',
        capability: 'postgres',
        serviceName: 'pg-main',
      },
      {
        name: 'cache',
        capability: 'keyvalue',
        serviceName: 'cache',
      },
      {
        name: 'blob',
        capability: 'blobstore',
        serviceName: 's3-assets',
      },
    ]);
    expect(bundle.secrets).toEqual(['orders-api-key', 'extra-secret']);
    const pushCall = invocations.find((call) => call.command === 'oras' && call.args[0] === 'push');
    expect(pushCall?.args).toContain('--plain-http');
    expect(pushCall?.args).toContain('-u');
    expect(pushCall?.args).toContain('robot');
    expect(pushCall?.args).toContain('-p');

    // Token-based credentials and username without password
    await buildDeployBundle(
      {
        credentials: {
          registry: 'registry.example.com/acme',
          token: '/tmp/registry-config.json',
        },
      },
      captureIo().io,
      deps,
    );
    await buildDeployBundle(
      {
        credentials: {
          registry: 'registry.example.com/acme',
          username: 'token-user',
        },
      },
      captureIo().io,
      deps,
    );

    // Registry override on an existing target connection
    writeFileSync(
      join(root, 'di-framework.deploy.toml'),
      `default-target = "dev"
[targets.dev]
kubeconfig = "/tmp/kube"
tenant = "acme"
registry = "registry.example.com/old"
`,
    );
    const overridden = await buildDeployBundle(
      {
        registry: 'registry.example.com/new',
        tag: 'v3',
      },
      captureIo().io,
      deps,
    );
    expect(overridden.component.reference).toBe('registry.example.com/new/orders-service:v3');

    // Oras push failure with custom tag/credentials
    await expect(
      buildDeployBundle(
        {
          registry: 'registry.example.com/new',
          tag: 'v4',
        },
        captureIo().io,
        fakeDeps({
          cwd: root,
          assets: makeAssets(),
          resolutions: { '@di-framework/bindings/catalog.json': join(root, 'catalog.json') },
          exitCodes: { 'oras push': 1 },
        }),
      ),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_TOOL_FAILED', exitCode: 3 });

    // Invalid env option passed directly to buildDeployBundle
    await expect(
      buildDeployBundle(
        {
          env: 'invalid' as 'prod',
          registry: 'registry.example.com/new',
        },
        captureIo().io,
        deps,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_USAGE', exitCode: 2 });
  });
});
