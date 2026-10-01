import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type CliIo, CommandFailure, type CommandResult } from '@di-framework/cli-extension';
import { discoverBindings } from './bindings';
import { buildComponent, requirementsForProject } from './build';
import { DEFAULT_DEPS, type WasmcloudDeps } from './deps';
import { requiresWasmCloudHost, resolveDevRunner } from './dev-runner';
import { loadProject } from './project';
import { invalidUsage, readOptionValue, toolFailed } from './support';
import { writeWashDevConfig } from './wash-dev';
import { guestLoggingRequirement, type WitLock } from './wit';

export type DevOptions = { host: string; port: string };

export function parseDevArgs(args: readonly string[]): DevOptions {
  let host: string | undefined;
  let port: string | undefined;
  for (let position = 0; position < args.length; position++) {
    const token = args[position] ?? '';
    switch (token) {
      case '--host':
        if (host !== undefined) invalidUsage(`Option may be provided only once: ${token}`, token);
        host = readOptionValue(args, ++position, token);
        break;
      case '--port':
        if (port !== undefined) invalidUsage(`Option may be provided only once: ${token}`, token);
        port = readOptionValue(args, ++position, token);
        break;
      default:
        invalidUsage(`Unknown option or argument: ${token}`, token);
    }
  }
  return { host: host ?? '127.0.0.1', port: port ?? '8000' };
}

export async function runWasmcloudDev(
  args: readonly string[],
  io: CliIo,
  deps: WasmcloudDeps = DEFAULT_DEPS,
): Promise<CommandResult> {
  const options = parseDevArgs(args);
  const project = loadProject(deps.cwd());
  const projectRequirements = requirementsForProject(project, deps);
  const runner = resolveDevRunner(deps, {
    wasmCloudHost: requiresWasmCloudHost(projectRequirements),
  });
  // Only wash provides wasi:logging locally; other runners keep the noop console.
  await buildComponent(project, io, deps, { guestLogging: runner.kind === 'wash' });
  const lockPath = join(project.projectRoot, '.di-framework', 'wit.lock.json');
  let tls: boolean;
  try {
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as WitLock;
    tls = lock.requirements.some((requirement) => requirement.package === 'wasi:tls');
  } catch (error) {
    throw new CommandFailure(
      'WASMCLOUD_WIT_LOCK_INVALID',
      `Cannot read generated WIT requirements from ${lockPath}. Rerun platform build before starting the dev server.`,
      3,
      { path: lockPath, cause: String(error) },
    );
  }
  const washConfigPath =
    runner.kind === 'wash'
      ? writeWashDevConfig(
          project,
          [...projectRequirements, guestLoggingRequirement()],
          discoverBindings(project, deps),
          {
            host: options.host,
            port: options.port,
            postgresUrl: deps.env.WASMCLOUD_POSTGRES_URL,
          },
        )
      : undefined;
  io.stdout.write(`Serving on http://${options.host}:${options.port} (${runner.kind})\n`);
  const served = await deps.runner(
    runner.command,
    runner.args({
      componentPath: project.outputPath,
      host: options.host,
      port: options.port,
      washConfigPath,
      tls,
    }),
    { cwd: project.projectRoot },
  );
  if (served.exitCode !== 0) {
    throw toolFailed(`${runner.kind} serve`, served.exitCode);
  }
  return {
    data: {
      application: project.applicationName,
      host: options.host,
      port: options.port,
      runner: runner.kind,
    },
    text: 'Dev server stopped.',
  };
}
