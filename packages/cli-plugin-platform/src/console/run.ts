import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type CliIo, CommandFailure, type CommandResult } from '@di-framework/cli-extension';
import { DEFAULT_DEPS, type WasmcloudDeps } from '../deps';
import { type DeployManifest, type ExternalTarget, loadDeployManifest } from '../manifest';
import { invalidUsage, readOptionValue } from '../support';
import { resolveConnection, resolveTarget } from '../target';
import { tenantIdentity } from './catalog';
import { startConsoleServer } from './server';

export type ConsoleOptions = {
  host: string;
  port: number;
  target?: string;
};

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export function parseConsoleArgs(args: readonly string[]): ConsoleOptions {
  let host: string | undefined;
  let port: string | undefined;
  let target: string | undefined;
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
      case '--target':
        if (target !== undefined) invalidUsage(`Option may be provided only once: ${token}`, token);
        target = readOptionValue(args, ++position, token);
        break;
      default:
        invalidUsage(`Unknown option or argument: ${token}`, token, {
          command: 'platform console',
        });
    }
  }
  const resolvedHost = host ?? '127.0.0.1';
  if (!LOOPBACK.has(resolvedHost)) {
    invalidUsage('The console binds to loopback only.', '--host', { command: 'platform console' });
  }
  const resolvedPort = port === undefined ? 8787 : Number(port);
  if (!Number.isInteger(resolvedPort) || resolvedPort < 1 || resolvedPort > 65535) {
    invalidUsage('Console port must be an integer from 1 through 65535.', '--port', {
      command: 'platform console',
    });
  }
  return { host: resolvedHost, port: resolvedPort, ...(target !== undefined ? { target } : {}) };
}

/** The console uses one tenant kubeconfig, namespace, and host group. */
export function selectConsoleTenant(
  manifest: DeployManifest,
  requested: string | undefined,
): ExternalTarget {
  const target = resolveTarget(manifest, requested);
  if (target.kind !== 'external' || target.hostgroup === undefined) {
    throw new CommandFailure(
      'WASMCLOUD_CONSOLE_TENANT_REQUIRED',
      `Target "${target.name}" is not a tenant credential. Start the console with a target that sets tenant = "<name>" (or namespace and hostgroup) and the tenant user's kubeconfig.`,
      2,
      { target: target.name },
    );
  }
  return target;
}

export function consoleAssetsDirectory(): string {
  const compiled = fileURLToPath(new URL('../console-ui', import.meta.url));
  if (existsSync(join(compiled, 'index.html'))) return compiled;
  return fileURLToPath(new URL('../../dist/console-ui', import.meta.url));
}

export async function runWasmcloudConsole(
  args: readonly string[],
  io: CliIo,
  deps: WasmcloudDeps = DEFAULT_DEPS,
): Promise<CommandResult> {
  const options = parseConsoleArgs(args);
  const assetsDirectory = consoleAssetsDirectory();
  if (!existsSync(join(assetsDirectory, 'index.html'))) {
    throw new CommandFailure(
      'WASMCLOUD_CONSOLE_ASSETS_MISSING',
      `Console assets are missing at ${assetsDirectory}. Rebuild @di-framework/cli-plugin-platform.`,
      3,
      { directory: assetsDirectory },
    );
  }
  const manifest = loadDeployManifest(deps.cwd(), deps.env);
  const tenant = selectConsoleTenant(manifest, options.target);
  const connection = await resolveConnection(tenant, manifest.workspaceRoot, manifest.path, deps);
  const identity = tenantIdentity(connection.hostgroup, tenant.name);
  const server = await startConsoleServer({
    host: options.host,
    port: options.port,
    target: tenant.name,
    deps,
    assetsDirectory,
    io,
  });
  io.stdout.write(`Console listening on ${server.url}\n`);
  io.stdout.write(`Scoped to tenant ${identity.tenant}`);
  if (identity.hostgroup !== undefined) io.stdout.write(` on host group ${identity.hostgroup}`);
  io.stdout.write('.\n');
  io.stdout.write('The tenant credential stays in this process.\n');
  await new Promise<void>((resolve) => {
    const stop = () => {
      void server.close().finally(resolve);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return { text: `Console stopped (${server.url}).` };
}
