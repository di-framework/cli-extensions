import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { type CliIo, CommandFailure } from '@di-framework/cli-extension';
import type { WasmcloudDeps } from './deps';
import type { WasmcloudProject } from './project';
import { registryReferenceHost, registryUsesPlainHttp } from './registry';
import { toolFailed } from './support';
import type { ClusterConnection } from './target';

export type PublishedImage = {
  artifactDigest: string;
  digest: string;
  pullReference: string;
  pushReference: string;
  reference: string;
};

const CORE_WASM_MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const PLAIN_HTTP_RESPONSE_RE = /server gave HTTP response to HTTPS client/i;

export function contentDigest(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

export function ociReference(registry: string, repository: string, digest: string): string {
  return `${registryReferenceHost(registry)}/${repository}:sha256-${digest}`;
}

export function countCoreWasmModules(wasmBytes: Uint8Array): number {
  const buf = Buffer.from(wasmBytes.buffer, wasmBytes.byteOffset, wasmBytes.byteLength);
  let count = 0;
  let offset = buf.indexOf(CORE_WASM_MAGIC, 0);
  while (offset !== -1) {
    count += 1;
    offset = buf.indexOf(CORE_WASM_MAGIC, offset + CORE_WASM_MAGIC.length);
  }
  return Math.max(1, count);
}

export function reportCoreInstanceCost(
  wasmBytes: Uint8Array,
  io: CliIo,
  hostPoolSize = 100,
): { coreModules: number; maxConcurrentInvocations: number } {
  const coreModules = countCoreWasmModules(wasmBytes);
  const maxConcurrentInvocations = Math.floor(hostPoolSize / coreModules);
  if (coreModules > 1) {
    io.stdout.write(
      `Component instantiates ${coreModules} core WebAssembly modules per invocation (~${maxConcurrentInvocations} concurrent invocations at default WASH_CORE_INSTANCES=${hostPoolSize}).\n`,
    );
  }
  if (maxConcurrentInvocations <= 10) {
    io.stderr.write(
      `Warning: component requires ${coreModules} core instances per invocation, leaving at most ${maxConcurrentInvocations} concurrent invocations against the host's default WASH_CORE_INSTANCES=${hostPoolSize}; increase WASH_CORE_INSTANCES on the host if higher concurrency is needed.\n`,
    );
  }
  return { coreModules, maxConcurrentInvocations };
}

export function plainHttpRegistryFailure(
  pushReference: string,
  target: string,
  exitCode = 1,
): CommandFailure {
  return new CommandFailure(
    'WASMCLOUD_TOOL_FAILED',
    `oras push failed with exit code ${exitCode}: ${pushReference} answered with plain HTTP to an HTTPS client; prefix the registry push URL with "http://" or set "insecure = true" under [targets.${target}.registry] in di-framework.deploy.toml`,
    3,
    { command: 'oras push', exitCode, target, reference: pushReference },
  );
}

export async function publishComponent(
  project: WasmcloudProject,
  connection: ClusterConnection,
  io: CliIo,
  deps: WasmcloudDeps,
  deploymentDigest: string,
): Promise<PublishedImage> {
  const wasmBytes = readFileSync(project.outputPath);
  const artifactDigest = createHash('sha256').update(wasmBytes).digest('hex');
  const pushReference = ociReference(connection.registry.push, project.witName, deploymentDigest);
  const pullReference = ociReference(connection.registry.pull, project.witName, deploymentDigest);
  const configPath = join(project.projectRoot, '.di-framework', 'oci-config.json');
  const componentPath = projectRelativePath(project.projectRoot, project.outputPath);
  const projectConfigPath = projectRelativePath(project.projectRoot, configPath);
  io.stdout.write(`Publishing ${componentPath} as ${pushReference}...\n`);
  reportCoreInstanceCost(wasmBytes, io);
  const transportArgs = registryUsesPlainHttp(connection.registry) ? ['--plain-http'] : [];
  const existing = await deps.runCaptured(
    'oras',
    ['manifest', 'fetch', ...transportArgs, '--descriptor', pushReference],
    { cwd: project.projectRoot },
  );
  if (existing.exitCode === 0) {
    io.stdout.write(`OCI tag ${pushReference} already exists; keeping it immutable.\n`);
    return {
      artifactDigest,
      digest: deploymentDigest,
      pullReference,
      pushReference,
      reference: pushReference,
    };
  }
  if (PLAIN_HTTP_RESPONSE_RE.test(existing.stderr)) {
    throw plainHttpRegistryFailure(pushReference, connection.target, existing.exitCode);
  }
  const pushed = await deps.runner(
    'oras',
    [
      'push',
      ...transportArgs,
      '--config',
      `${projectConfigPath}:application/vnd.wasm.config.v0+json`,
      pushReference,
      `${componentPath}:application/wasm`,
    ],
    { cwd: project.projectRoot },
  );
  if (pushed.exitCode !== 0) {
    throw toolFailed('oras push', pushed.exitCode);
  }
  return {
    artifactDigest,
    digest: deploymentDigest,
    pullReference,
    pushReference,
    reference: pushReference,
  };
}

export function projectRelativePath(projectRoot: string, path: string): string {
  const value = relative(projectRoot, path);
  if (value === '' || value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value)) {
    throw new Error(`OCI artifact path must be inside the project: ${path}`);
  }
  return value.split(sep).join('/');
}
