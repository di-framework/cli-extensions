import { CommandFailure } from '@di-framework/cli-extension';
import type { WasmcloudDeps } from './deps';

export const DEV_RUNNER_ENV = 'DI_FRAMEWORK_WASMCLOUD_DEV_RUNNER';
export type DevRunnerKind = 'wasmtime' | 'wash' | 'jco';

export type DevServeTarget = {
  componentPath: string;
  host: string;
  port: string;
  washConfigPath?: string;
  tls?: boolean;
};

export type ResolvedDevRunner = {
  kind: DevRunnerKind;
  command: string;
  args(target: DevServeTarget): string[];
};

export type DevRunnerOptions = {
  /** Prefer wash: wasmtime and jco cannot host `wasmcloud:*` imports. */
  wasmCloudHost?: boolean;
};

/** True when the guest imports a wasmCloud host interface, not only WASI. */
export function requiresWasmCloudHost(requirements: readonly { package: string }[]): boolean {
  return requirements.some((requirement) => requirement.package.startsWith('wasmcloud:'));
}

const KINDS: readonly DevRunnerKind[] = ['wasmtime', 'wash', 'jco'];

function binaryFor(kind: DevRunnerKind, deps: WasmcloudDeps): string | undefined {
  switch (kind) {
    case 'wasmtime':
      return deps.wasmtimeBinaryPath();
    case 'wash':
      return deps.washBinaryPath();
    case 'jco':
      return deps.nodeBinaryPath();
  }
}

function argsFor(kind: DevRunnerKind, deps: WasmcloudDeps, target: DevServeTarget): string[] {
  switch (kind) {
    case 'wasmtime':
      // qjs guests import wasi:cli@0.2.x; WASI 0.3 HTTP is off unless -S p3 is set.
      // `-S config` hosts unlabeled wasi:config@0.2.0-rc.1 (sync) locally.
      return [
        'serve',
        '-S',
        'cli',
        '-S',
        'p3',
        '-S',
        'config',
        ...(target.tls ? ['-S', 'tls=y,inherit-network=y,allow-ip-name-lookup=y'] : []),
        '--addr',
        `${target.host}:${target.port}`,
        target.componentPath,
      ];
    case 'wash': {
      // wash 2.5.x has no --address flag; address and hostInterfaces live in config.
      const args = ['dev'];
      if (target.washConfigPath !== undefined) {
        args.push('--user-config', target.washConfigPath);
      }
      return args;
    }
    case 'jco':
      return [
        deps.jcoCliPath(),
        'serve',
        target.componentPath,
        '--host',
        target.host,
        '--port',
        target.port,
      ];
  }
}

export function resolveDevRunner(
  deps: WasmcloudDeps,
  options: DevRunnerOptions = {},
): ResolvedDevRunner {
  const requested = deps.env[DEV_RUNNER_ENV]?.trim();
  if (requested !== undefined && requested !== '') {
    if (!KINDS.includes(requested as DevRunnerKind)) {
      throw new CommandFailure(
        'WASMCLOUD_DEV_RUNNER_UNKNOWN',
        `Unknown ${DEV_RUNNER_ENV} value "${requested}". Expected wasmtime, wash, or jco.`,
        2,
        { runner: requested },
      );
    }
    const kind = requested as DevRunnerKind;
    const command = binaryFor(kind, deps);
    if (command === undefined) {
      throw new CommandFailure(
        'WASMCLOUD_DEV_RUNNER_REQUIRED',
        `${kind} is required to serve the component locally; install it and make sure it is on PATH`,
        3,
        { tool: kind },
      );
    }
    return { kind, command, args: (target) => argsFor(kind, deps, target) };
  }

  if (options.wasmCloudHost === true) {
    const command = binaryFor('wash', deps);
    if (command === undefined) {
      throw new CommandFailure(
        'WASMCLOUD_DEV_RUNNER_REQUIRED',
        'wash is required to serve a component that imports wasmCloud host interfaces; install wash or set DI_FRAMEWORK_WASMCLOUD_DEV_RUNNER',
        3,
        { tool: 'wash' },
      );
    }
    return { kind: 'wash', command, args: (target) => argsFor('wash', deps, target) };
  }

  for (const kind of KINDS) {
    const command = binaryFor(kind, deps);
    if (command === undefined) continue;
    return { kind, command, args: (target) => argsFor(kind, deps, target) };
  }

  throw new CommandFailure(
    'WASMCLOUD_DEV_RUNNER_REQUIRED',
    'A local component runner is required (wasmtime 46+, wash, or jco); install one and make sure it is on PATH',
    3,
    { tool: 'dev-runner' },
  );
}
