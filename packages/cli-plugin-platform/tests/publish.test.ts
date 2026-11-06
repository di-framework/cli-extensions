import { describe, expect, it } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadProject } from '../src/project';
import {
  contentDigest,
  countCoreWasmModules,
  ociReference,
  plainHttpRegistryFailure,
  projectRelativePath,
  publishComponent,
  reportCoreInstanceCost,
} from '../src/publish';
import type { ClusterConnection } from '../src/target';
import { captureIo, fakeDeps, makeProject } from './helpers';

const COMPONENT_HEADER = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00]);
const CORE_MODULE_HEADER = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

function makeFakeComponentWithCoreModules(coreModuleCount: number): Buffer {
  const chunks: Buffer[] = [COMPONENT_HEADER];
  for (let i = 0; i < coreModuleCount; i += 1) {
    chunks.push(Buffer.from([0x01, 0x08]), CORE_MODULE_HEADER);
  }
  return Buffer.concat(chunks);
}

describe('publish helpers and publishComponent (#46)', () => {
  it('counts embedded core WebAssembly modules inside a component binary', () => {
    expect(countCoreWasmModules(new Uint8Array([1, 2, 3]))).toBe(1);
    expect(countCoreWasmModules(CORE_MODULE_HEADER)).toBe(1);
    expect(countCoreWasmModules(makeFakeComponentWithCoreModules(4))).toBe(4);
    expect(countCoreWasmModules(makeFakeComponentWithCoreModules(14))).toBe(14);
  });

  it('reports core-instance cost and warns when concurrent capacity against WASH_CORE_INSTANCES is low', () => {
    const singleIo = captureIo();
    expect(reportCoreInstanceCost(CORE_MODULE_HEADER, singleIo.io)).toEqual({
      coreModules: 1,
      maxConcurrentInvocations: 100,
    });
    expect(singleIo.stdout).toEqual([]);
    expect(singleIo.stderr).toEqual([]);

    const mediumIo = captureIo();
    expect(reportCoreInstanceCost(makeFakeComponentWithCoreModules(4), mediumIo.io)).toEqual({
      coreModules: 4,
      maxConcurrentInvocations: 25,
    });
    expect(mediumIo.stdout.join('')).toContain(
      'Component instantiates 4 core WebAssembly modules per invocation (~25 concurrent invocations at default WASH_CORE_INSTANCES=100).',
    );
    expect(mediumIo.stderr).toEqual([]);

    const heavyIo = captureIo();
    expect(reportCoreInstanceCost(makeFakeComponentWithCoreModules(14), heavyIo.io)).toEqual({
      coreModules: 14,
      maxConcurrentInvocations: 7,
    });
    expect(heavyIo.stdout.join('')).toContain(
      'Component instantiates 14 core WebAssembly modules per invocation (~7 concurrent invocations at default WASH_CORE_INSTANCES=100).',
    );
    expect(heavyIo.stderr.join('')).toContain(
      "Warning: component requires 14 core instances per invocation, leaving at most 7 concurrent invocations against the host's default WASH_CORE_INSTANCES=100; increase WASH_CORE_INSTANCES on the host if higher concurrency is needed.",
    );
  });

  it('suggests http:// or registry.insecure = true when oras hits a plain-HTTP registry over HTTPS', async () => {
    const root = makeProject({ name: 'identity-guest', entry: 'src/app.ts' });
    const project = loadProject(root);
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(project.outputPath, makeFakeComponentWithCoreModules(14));

    const connection: ClusterConnection = {
      target: 'development',
      kubeconfig: '/tmp/kubeconfig',
      namespace: 'wasmcloud',
      registry: {
        push: '127.0.0.1:25000/team',
        pull: 'registry.wasmcloud.svc.cluster.local:5000/team',
        insecure: false,
      },
    };
    const deps = fakeDeps({ cwd: root });
    deps.runCaptured = async () => ({
      exitCode: 1,
      stdout: '',
      stderr:
        'Error: Get "https://127.0.0.1:25000/v2/team/identity-guest/manifests/sha256-abc": http: server gave HTTP response to HTTPS client\n',
    });
    const captured = captureIo();

    await expect(
      publishComponent(project, connection, captured.io, deps, 'abc'),
    ).rejects.toMatchObject({
      code: 'WASMCLOUD_TOOL_FAILED',
      exitCode: 3,
      message:
        'oras push failed with exit code 1: 127.0.0.1:25000/team/identity-guest:sha256-abc answered with plain HTTP to an HTTPS client; prefix the registry push URL with "http://" or set "insecure = true" under [targets.development.registry] in di-framework.deploy.toml',
    });
    expect(captured.stdout.join('')).toContain(
      'Component instantiates 14 core WebAssembly modules per invocation',
    );
    expect(captured.stderr.join('')).toContain('leaving at most 7 concurrent invocations');
    expect(plainHttpRegistryFailure('127.0.0.1:25000/app:sha256-abc', 'dev').exitCode).toBe(3);
  });

  it('covers digest, reference, and relative path helpers', () => {
    const root = makeProject({ name: 'greeter', entry: 'src/app.ts' });
    const file = join(root, 'artifact.wasm');
    writeFileSync(file, 'wasm-bytes');
    expect(contentDigest(file)).toHaveLength(64);
    expect(ociReference('https://registry.example.com/', 'greeter', 'deadbeef')).toBe(
      'registry.example.com/greeter:sha256-deadbeef',
    );
    expect(projectRelativePath(root, file)).toBe('artifact.wasm');
    expect(() => projectRelativePath(root, root)).toThrow(
      'OCI artifact path must be inside the project',
    );
  });
});
