import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runWasmcloudDeploy } from '../src/deploy';
import { contentDigest, ociReference, projectRelativePath } from '../src/publish';
import {
  captureIo,
  fakeDeps,
  makeWorkspace,
  platformOutputJson,
  type RunnerInvocation,
} from './helpers';

describe('runWasmcloudDeploy', () => {
  it('deploys the nearest project to a kubeconfig-only target', async () => {
    const { root, greeter, kubeconfig } = makeWorkspace();
    const invocations: RunnerInvocation[] = [];
    const result = await runWasmcloudDeploy(
      ['--target', 'development'],
      captureIo().io,
      fakeDeps({ cwd: greeter, invocations }),
    );

    expect(invocations.some((invocation) => invocation.command === 'pulumi')).toBe(false);
    expect(invocations.some((invocation) => invocation.command === 'oras')).toBe(true);
    expect(invocations.some((invocation) => invocation.args.includes('apply'))).toBe(true);
    const wasm = join(greeter, 'dist', 'greeter.wasm');
    const artifactDigest = contentDigest(wasm);
    const deploymentDigest = String(result.data.deploymentDigest);
    expect(result.data).toMatchObject({
      application: 'greeter',
      target: 'development',
      namespace: 'wasmcloud',
      image: `registry.example.com/team/greeter:sha256-${deploymentDigest}`,
      publishedImage: `registry.example.com/team/greeter:sha256-${deploymentDigest}`,
      digest: artifactDigest,
      service: 'greeter',
    });
    expect(existsSync(join(greeter, '.di-framework', 'deploy', 'workload.yaml'))).toBe(true);
    const yaml = readFileSync(join(greeter, '.di-framework', 'deploy', 'workload.yaml'), 'utf8');
    expect(yaml).toContain('kind: WorkloadDeployment');
    expect(yaml).toContain('kind: Service');
    expect(yaml).toContain('"host": "greeter"');
    expect(yaml).not.toContain('apps');
    const oras = invocations.find(
      (invocation) => invocation.command === 'oras' && invocation.args[0] === 'push',
    );
    expect(oras?.args).toContain(`registry.example.com/team/greeter:sha256-${deploymentDigest}`);
    expect(oras?.args).not.toContain('--plain-http');
    expect(oras?.args).toContain(
      '.di-framework/oci-config.json:application/vnd.wasm.config.v0+json',
    );
    expect(oras?.args).toContain('dist/greeter.wasm:application/wasm');
    expect(oras?.args.some((arg) => arg.startsWith(`${greeter}/`))).toBe(false);
    expect(kubeconfig.length).toBeGreaterThan(0);
    expect(root).toBeTruthy();
  });

  it('resolves greeter from the workspace root and another directory', async () => {
    const { root, echo, kubeconfig } = makeWorkspace();
    const fromRoot = await runWasmcloudDeploy(
      ['greeter', '--target', 'development'],
      captureIo().io,
      fakeDeps({ cwd: root }),
    );
    expect(fromRoot.data).toMatchObject({ application: 'greeter', target: 'development' });

    const fromEcho = await runWasmcloudDeploy(
      ['greeter', '--target', 'development'],
      captureIo().io,
      fakeDeps({ cwd: echo }),
    );
    expect(fromEcho.data).toMatchObject({ application: 'greeter' });
    expect(kubeconfig).toBeTruthy();
  });

  it('uses managed Pulumi outputs instead of deploying the platform', async () => {
    const { root, greeter, kubeconfig } = makeWorkspace();
    const invocations: RunnerInvocation[] = [];
    const result = await runWasmcloudDeploy(
      [],
      captureIo().io,
      fakeDeps({
        cwd: greeter,
        invocations,
        capturedStdout: { 'pulumi stack output': platformOutputJson(kubeconfig) },
      }),
    );
    expect(
      invocations.filter((invocation) => invocation.command === 'pulumi').map((i) => i.args),
    ).toEqual([
      ['stack', 'select', 'dev'],
      ['stack', 'output', '--json'],
    ]);
    expect(invocations.some((invocation) => invocation.args[0] === 'up')).toBe(false);
    expect(invocations.some((invocation) => invocation.args[0] === 'destroy')).toBe(false);
    expect(result.data).toMatchObject({
      application: 'greeter',
      target: 'local',
      registry: {
        push: 'http://127.0.0.1:25000',
        pull: 'di-framework-registry.wasmcloud.svc.cluster.local:5000',
        insecure: true,
      },
      http: { url: 'http://127.0.0.1:28180', host: 'greeter' },
    });
    expect(root).toBeTruthy();
  });

  it('publishes to the push registry but deploys the equivalent pull reference over plain HTTP', async () => {
    const { root, greeter, kubeconfig } = makeWorkspace();
    writeFileSync(
      join(root, 'di-framework.deploy.toml'),
      `default-target = "split"

[targets.split]
kubeconfig = "${kubeconfig}"
namespace = "wasmcloud"

[targets.split.registry]
push = "http://127.0.0.1:25000"
pull = "di-framework-registry.wasmcloud.svc.cluster.local:5000"
insecure = true
`,
    );
    const invocations: RunnerInvocation[] = [];
    const result = await runWasmcloudDeploy(
      ['greeter'],
      captureIo().io,
      fakeDeps({ cwd: root, invocations }),
    );

    const oras = invocations.find(
      (invocation) => invocation.command === 'oras' && invocation.args[0] === 'push',
    );
    expect(oras?.args).toContain('--plain-http');
    expect(oras?.args).toContain(result.data.publishedImage as string);
    expect(result.data.publishedImage).toStartWith('127.0.0.1:25000/greeter:sha256-');
    expect(result.data.image).toStartWith(
      'di-framework-registry.wasmcloud.svc.cluster.local:5000/greeter:sha256-',
    );
    expect(String(result.data.publishedImage).split('/greeter:')[1]).toBe(
      String(result.data.image).split('/greeter:')[1],
    );
    const yaml = readFileSync(join(greeter, '.di-framework/deploy/workload.yaml'), 'utf8');
    expect(yaml).toContain(result.data.image as string);
    expect(yaml).not.toContain(result.data.publishedImage as string);
  });

  it('honors an explicit insecure registry without globally weakening secure targets', async () => {
    const { root, kubeconfig } = makeWorkspace();
    writeFileSync(
      join(root, 'di-framework.deploy.toml'),
      `[targets.insecure]
kubeconfig = "${kubeconfig}"
namespace = "wasmcloud"
[targets.insecure.registry]
push = "localhost:25000"
pull = "registry.wasmcloud.svc.cluster.local:5000"
insecure = true
`,
    );
    const invocations: RunnerInvocation[] = [];
    await runWasmcloudDeploy(
      ['greeter', '--target', 'insecure'],
      captureIo().io,
      fakeDeps({ cwd: root, invocations }),
    );
    expect(
      invocations.find(
        (invocation) => invocation.command === 'oras' && invocation.args[0] === 'push',
      )?.args,
    ).toContain('--plain-http');
  });

  it('keeps the workload reference stable across unchanged nondeterministic builds', async () => {
    const { greeter } = makeWorkspace();
    const invocations: RunnerInvocation[] = [];
    const deps = fakeDeps({
      cwd: greeter,
      invocations,
      componentOutput: (build) => `component-build-${build}-${Math.random()}`,
    });

    const first = await runWasmcloudDeploy(['--target', 'development'], captureIo().io, deps);
    const second = await runWasmcloudDeploy(['--target', 'development'], captureIo().io, deps);

    expect(first.data.digest).not.toBe(second.data.digest);
    expect(first.data.deploymentDigest).toBe(second.data.deploymentDigest);
    expect(first.data.image).toBe(second.data.image);
    const pushes = invocations.filter(
      (invocation) => invocation.command === 'oras' && invocation.args[0] === 'push',
    );
    expect(pushes[0]?.args.find((arg) => arg.includes('/greeter:sha256-'))).toBe(
      pushes[1]?.args.find((arg) => arg.includes('/greeter:sha256-')),
    );
  });

  it('does not replace an existing canonical-input tag', async () => {
    const { greeter } = makeWorkspace();
    const invocations: RunnerInvocation[] = [];
    await runWasmcloudDeploy(
      ['--target', 'development'],
      captureIo().io,
      fakeDeps({
        cwd: greeter,
        invocations,
        exitCodes: { 'oras manifest fetch': 0 },
      }),
    );

    expect(
      invocations.some(
        (invocation) => invocation.command === 'oras' && invocation.args[0] === 'push',
      ),
    ).toBe(false);
    expect(
      invocations.some(
        (invocation) => invocation.command === 'oras' && invocation.args[0] === 'manifest',
      ),
    ).toBe(true);
  });

  it('maps oras and kubectl failures to WASMCLOUD_TOOL_FAILED', async () => {
    const { greeter } = makeWorkspace();
    await expect(
      runWasmcloudDeploy(
        ['--target', 'development'],
        captureIo().io,
        fakeDeps({ cwd: greeter, exitCodes: { 'oras push': 1 } }),
      ),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_TOOL_FAILED', exitCode: 3 });

    await expect(
      runWasmcloudDeploy(
        ['--target', 'development'],
        captureIo().io,
        fakeDeps({ cwd: greeter, exitCodes: { 'kubectl apply': 1 } }),
      ),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_TOOL_FAILED', exitCode: 3 });
  });

  it('derives an immutable digest from component bytes', () => {
    const { greeter } = makeWorkspace();
    const wasm = join(greeter, 'component.wasm');
    writeFileSync(wasm, 'abc');
    expect(contentDigest(wasm)).toBe(createHash('sha256').update('abc').digest('hex'));
  });

  it('normalizes registry hosts without a trailing-slash regular expression', () => {
    expect(ociReference('registry.example.com///', 'greeter', 'abc')).toBe(
      'registry.example.com/greeter:sha256-abc',
    );
    expect(ociReference('https://registry.example.com/', 'greeter', 'abc')).toBe(
      'registry.example.com/greeter:sha256-abc',
    );
    expect(ociReference('http://localhost:5000', 'greeter', 'abc')).toBe(
      'localhost:5000/greeter:sha256-abc',
    );
  });

  it('rejects OCI artifact paths outside the project root', () => {
    expect(() => projectRelativePath('/workspace/project', '/workspace/project')).toThrow(
      'OCI artifact path must be inside the project',
    );
    expect(() => projectRelativePath('/workspace/project', '/workspace/outside.wasm')).toThrow(
      'OCI artifact path must be inside the project',
    );
  });
});

it('builds and reports scheduled-only deployments without an HTTP service', async () => {
  const { greeter, kubeconfig } = makeWorkspace();
  const configPath = join(greeter, 'di-framework.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  writeFileSync(configPath, JSON.stringify({ ...config, ingress: false }));
  writeFileSync(
    join(greeter, 'src', 'jobs.ts'),
    "class Worker { @Cron(60000, { name: 'heartbeat' }) run() {} }",
  );
  const result = await runWasmcloudDeploy(
    [],
    captureIo().io,
    fakeDeps({
      cwd: greeter,
      capturedStdout: { 'pulumi stack output': platformOutputJson(kubeconfig) },
    }),
  );
  expect(result.data.http).toBeUndefined();
  expect(result.data.cronJobs).toEqual([
    { jobId: 'heartbeat', schedule: 60000, cronExpression: '* * * * *' },
  ]);
  expect(result.text).toContain('Scheduled jobs (1): heartbeat');
  const generated = join(greeter, '.di-framework');
  // Cron control uses the HTTP adapter (cluster CronJob POSTs /_di/cron/...), not wasi:cli/run.
  expect(readFileSync(join(generated, 'cron-invoker.js'), 'utf8')).toContain('heartbeat');
  expect(JSON.parse(readFileSync(join(generated, 'cron.json'), 'utf8'))).toHaveLength(1);
  const yaml = readFileSync(join(generated, 'deploy', 'workload.yaml'), 'utf8');
  expect(yaml).toContain('kind: CronJob');
  expect(yaml).toContain('kind: Service');
});
