import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { CliIo, CommandResult } from '@di-framework/cli-extension';
import { CommandFailure } from '@di-framework/cli-extension';
import { parsePlatformCommandArgs } from './args';
import { DEFAULT_DEPS, type WasmcloudDeps } from './deps';
import { loadDeployManifest, type ManagedTarget } from './manifest';
import { isNamespace } from './namespace';
import { resolveInsideRoot } from './paths';
import { pulumiEnvironment, runPulumi } from './pulumi';
import { materializeRegistry, type RegistryInput, type RegistryLocation } from './registry';
import { resolveTarget } from './target';

export const PLATFORM_OUTPUT_SCHEMA_VERSION = 2;

export type PlatformEndpoints = {
  http?: string;
  kubernetes?: string;
  registry?: string;
};

export type PlatformOutputs = {
  schemaVersion: typeof PLATFORM_OUTPUT_SCHEMA_VERSION;
  kubeconfig: string;
  namespace: string;
  registry: RegistryLocation;
  context?: string;
  endpoints?: PlatformEndpoints;
};

export async function runWasmcloudPlatformDeploy(
  args: readonly string[],
  io: CliIo,
  deps: WasmcloudDeps = DEFAULT_DEPS,
): Promise<CommandResult> {
  const options = parsePlatformCommandArgs(args, 'platform cluster up');
  const { target, platformRoot, stack } = loadManagedPlatform(deps, options.target);
  io.stdout.write(`Deploying platform target ${target.name} (stack ${stack})...\n`);
  io.stdout.write('Installing generated Pulumi project dependencies...\n');
  await runPulumi(deps, ['install'], platformRoot);
  await runPulumi(deps, ['stack', 'select', stack, '--create'], platformRoot);
  await runPulumi(deps, ['up', ...(options.yes ? ['--yes'] : [])], platformRoot);
  const outputs = await loadPlatformOutputs(deps, platformRoot, stack, target.name);
  return {
    data: {
      target: target.name,
      stack,
      platformRoot,
      namespace: outputs.namespace,
      registry: outputs.registry,
      ...(outputs.endpoints === undefined ? {} : { endpoints: outputs.endpoints }),
    },
    text: `Platform target ${target.name} is up (stack ${stack}).${
      outputs.endpoints?.http === undefined
        ? ''
        : ` HTTP entrypoint: ${outputs.endpoints.http} (send the deployed project's configured name as the Host header).`
    }`,
  };
}

export async function runWasmcloudPlatformDestroy(
  args: readonly string[],
  io: CliIo,
  deps: WasmcloudDeps = DEFAULT_DEPS,
): Promise<CommandResult> {
  const options = parsePlatformCommandArgs(args, 'platform cluster destroy');
  const { target, platformRoot, stack } = loadManagedPlatform(deps, options.target);
  io.stdout.write(`Destroying platform target ${target.name} (stack ${stack})...\n`);
  await runPulumi(deps, ['install'], platformRoot);
  await runPulumi(deps, ['stack', 'select', stack], platformRoot);
  await runPulumi(deps, ['destroy', ...(options.yes ? ['--yes'] : [])], platformRoot);
  return {
    data: { target: target.name, stack, platformRoot },
    text: `Destroyed platform target ${target.name} (stack ${stack}).`,
  };
}

export async function loadPlatformOutputs(
  deps: WasmcloudDeps,
  platformRoot: string,
  stack: string,
  targetName: string,
): Promise<PlatformOutputs> {
  await runPulumi(deps, ['stack', 'select', stack], platformRoot);
  const result = await deps.runCaptured('pulumi', ['stack', 'output', '--json'], {
    cwd: platformRoot,
    env: pulumiEnvironment(deps.env, platformRoot),
  });
  if (result.exitCode !== 0) {
    throw new CommandFailure(
      'WASMCLOUD_PLATFORM_NOT_READY',
      `Managed target "${targetName}" did not produce stack outputs. Deploy the platform first with: di-framework platform cluster up ${targetName}`,
      3,
      { target: targetName, stack, platformRoot, exitCode: result.exitCode },
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(result.stdout);
  } catch (error) {
    throw invalidOutputs(
      targetName,
      `pulumi stack output --json was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return materializeOutputs(raw, targetName, platformRoot);
}

export function resolvePlatformDirectory(
  target: ManagedTarget,
  workspaceRoot: string,
  manifestPath: string,
): string {
  const resolved = resolveInsideRoot(workspaceRoot, target.platform);
  if (!resolved.ok) {
    throw new CommandFailure(
      'WASMCLOUD_DEPLOY_MANIFEST_INVALID',
      `Target "${target.name}" platform "${target.platform}" must be a directory inside the workspace`,
      2,
      { target: target.name, platform: target.platform, manifestPath },
    );
  }
  const pulumiFile = join(resolved.path, 'Pulumi.yaml');
  if (!existsSync(pulumiFile)) {
    throw new CommandFailure(
      'WASMCLOUD_PLATFORM_NOT_FOUND',
      `Managed target "${target.name}" platform ${resolved.path} has no Pulumi.yaml. Point platform at a Pulumi project that provisions only the wasmCloud platform.`,
      2,
      { target: target.name, platformRoot: resolved.path },
    );
  }
  return resolved.path;
}

function loadManagedPlatform(deps: WasmcloudDeps, targetName: string | undefined) {
  const manifest = loadDeployManifest(deps.cwd(), deps.env);
  const target = resolveTarget(manifest, targetName);
  if (target.kind !== 'managed') {
    throw new CommandFailure(
      'WASMCLOUD_TARGET_INVALID',
      `Target "${target.name}" is kubeconfig-only and has no managed platform to deploy or destroy.`,
      2,
      { target: target.name },
    );
  }
  const platformRoot = resolvePlatformDirectory(target, manifest.workspaceRoot, manifest.path);
  return { manifest, target, platformRoot, stack: target.stack };
}

function materializeOutputs(
  raw: unknown,
  targetName: string,
  platformRoot: string,
): PlatformOutputs {
  if (!isRecord(raw)) {
    throw invalidOutputs(targetName, 'stack outputs must be a JSON object');
  }

  if (
    raw.schemaVersion !== undefined &&
    raw.schemaVersion !== 1 &&
    raw.schemaVersion !== PLATFORM_OUTPUT_SCHEMA_VERSION
  ) {
    throw invalidOutputs(
      targetName,
      `unsupported schemaVersion ${JSON.stringify(raw.schemaVersion)}; expected ${PLATFORM_OUTPUT_SCHEMA_VERSION}`,
    );
  }

  const kubeconfig = requiredString(raw.kubeconfig, 'kubeconfig', targetName);
  const namespace = requiredString(raw.namespace, 'namespace', targetName);
  if (!isNamespace(namespace))
    throw invalidOutputs(
      targetName,
      'namespace must be a Kubernetes namespace (a DNS label of at most 63 characters)',
    );
  const registry = parseRegistry(raw.registry, targetName);
  const context =
    raw.context === undefined ? undefined : requiredString(raw.context, 'context', targetName);
  const endpoints = parseEndpoints(raw.endpoints, targetName);

  let kubeconfigPath = kubeconfig;
  if (kubeconfig.includes('\n') || kubeconfig.includes('apiVersion:')) {
    const generated = join(platformRoot, '.di-framework');
    mkdirSync(generated, { recursive: true });
    kubeconfigPath = join(generated, 'kubeconfig.yaml');
    writeFileSync(kubeconfigPath, kubeconfig.endsWith('\n') ? kubeconfig : `${kubeconfig}\n`, {
      mode: 0o600,
    });
    chmodSync(kubeconfigPath, 0o600);
  } else if (!isAbsolute(kubeconfigPath)) {
    kubeconfigPath = resolve(platformRoot, kubeconfigPath);
  }

  return {
    schemaVersion: PLATFORM_OUTPUT_SCHEMA_VERSION,
    kubeconfig: kubeconfigPath,
    namespace,
    registry,
    context,
    endpoints,
  };
}

function parseRegistry(value: unknown, targetName: string): RegistryLocation {
  if (typeof value === 'string') {
    return materializeRegistry(requiredString(value, 'registry', targetName));
  }
  if (!isRecord(value)) {
    throw invalidOutputs(
      targetName,
      '"registry" must be a string shorthand or an object with push, pull, and insecure',
    );
  }
  const push = requiredString(value.push, 'registry.push', targetName);
  const pull = requiredString(value.pull, 'registry.pull', targetName);
  if (typeof value.insecure !== 'boolean') {
    throw invalidOutputs(targetName, '"registry.insecure" must be a boolean');
  }
  const unknown = Object.keys(value).filter(
    (key) => key !== 'push' && key !== 'pull' && key !== 'insecure',
  );
  if (unknown.length > 0) {
    throw invalidOutputs(targetName, `"registry" has unsupported fields: ${unknown.join(', ')}`);
  }
  return materializeRegistry({ push, pull, insecure: value.insecure } satisfies RegistryInput);
}

function parseEndpoints(value: unknown, targetName: string): PlatformEndpoints | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw invalidOutputs(targetName, 'endpoints must be an object when present');
  }
  const http =
    value.http === undefined ? undefined : requiredString(value.http, 'endpoints.http', targetName);
  const kubernetes =
    value.kubernetes === undefined
      ? undefined
      : requiredString(value.kubernetes, 'endpoints.kubernetes', targetName);
  const registry =
    value.registry === undefined
      ? undefined
      : requiredString(value.registry, 'endpoints.registry', targetName);
  return { http, kubernetes, registry };
}

function requiredString(value: unknown, field: string, targetName: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalidOutputs(
      targetName,
      `missing required output "${field}". The platform Pulumi program must export kubeconfig, namespace, and registry.`,
    );
  }
  return value;
}

function invalidOutputs(targetName: string, message: string): CommandFailure {
  return new CommandFailure(
    'WASMCLOUD_PLATFORM_OUTPUT_INVALID',
    `Platform target "${targetName}" output contract is invalid: ${message}`,
    2,
    { target: targetName, schemaVersion: PLATFORM_OUTPUT_SCHEMA_VERSION },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
