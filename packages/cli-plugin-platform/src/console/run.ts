import { existsSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type CliIo, CommandFailure, type CommandResult } from '@di-framework/cli-extension';
import { DEFAULT_DEPS, type WasmcloudDeps } from '../deps';
import { type DeployManifest, type ExternalTarget, loadDeployManifest } from '../manifest';
import { invalidUsage, readOptionValue } from '../support';
import { resolveConnection, resolveTarget } from '../target';
import { generateConsolePassword } from './auth';
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
  if (!isBindHost(resolvedHost)) {
    invalidUsage(
      'Console host must be a loopback address or a specific hostname. Binding every interface is not supported.',
      '--host',
      { command: 'platform console' },
    );
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
      `Target "${target.name}" is not a tenant credential. Start the console with the tenant kubeconfig, namespace, and hostgroup.`,
      2,
      { target: target.name },
    );
  }
  return target;
}

export function consolePassword(
  env: Record<string, string | undefined>,
  host: string,
): { password: string; generated: boolean } {
  const configured = env.DI_CONSOLE_PASSWORD;
  if (configured === undefined || configured.length === 0) {
    if (!LOOPBACK.has(host)) {
      throw new CommandFailure(
        'WASMCLOUD_CONSOLE_PASSWORD_REQUIRED',
        'Set DI_CONSOLE_PASSWORD before binding the console to a non-loopback host.',
        2,
        { host },
      );
    }
    return { password: generateConsolePassword(), generated: true };
  }
  if (configured.length < 12 || configured.length > 200) {
    throw new CommandFailure(
      'WASMCLOUD_CONSOLE_PASSWORD_INVALID',
      'DI_CONSOLE_PASSWORD must be between 12 and 200 characters.',
      2,
    );
  }
  return { password: configured, generated: false };
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
  const { password, generated } = consolePassword(deps.env, options.host);
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
  const server = await startConsoleServer({
    host: options.host,
    port: options.port,
    password,
    target: tenant.name,
    deps,
    assetsDirectory,
    io,
  });
  io.stdout.write(`Console listening on ${server.url}\n`);
  io.stdout.write(
    `Scoped to tenant namespace ${connection.namespace} on host group ${connection.hostgroup}.\n`,
  );
  if (generated) {
    io.stdout.write(
      'Sign in with this one-time password. It is shown once and is not written to the cluster:\n' +
        `${password}\n`,
    );
  } else {
    io.stdout.write('Sign in with DI_CONSOLE_PASSWORD. The password is not sent to the cluster.\n');
  }
  io.stdout.write('Kubeconfig and control tokens stay in this process.\n');
  await new Promise<void>((resolve) => {
    const stop = () => {
      void server.close().finally(resolve);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return { text: `Console stopped (${server.url}).` };
}

function isBindHost(host: string): boolean {
  if (host === '0.0.0.0' || host === '::' || host === '[::]') return false;
  if (LOOPBACK.has(host)) return true;
  const version = isIP(host);
  if (version === 4 || version === 6) return true;
  return /^[a-z0-9]([a-z0-9.-]{0,253}[a-z0-9])?$/i.test(host) && host.includes('.');
}
