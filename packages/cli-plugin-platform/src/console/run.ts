import { existsSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type CliIo, CommandFailure, type CommandResult } from '@di-framework/cli-extension';
import { DEFAULT_DEPS, type WasmcloudDeps } from '../deps';
import { invalidUsage, readOptionValue } from '../support';
import { generateConsolePassword } from './auth';
import { startConsoleServer } from './server';

export type ConsoleOptions = {
  host: string;
  port: number;
};

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export function parseConsoleArgs(args: readonly string[]): ConsoleOptions {
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
  return { host: resolvedHost, port: resolvedPort };
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
  const server = await startConsoleServer({
    host: options.host,
    port: options.port,
    password,
    deps,
    assetsDirectory,
    io,
  });
  io.stdout.write(`Console listening on ${server.url}\n`);
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
