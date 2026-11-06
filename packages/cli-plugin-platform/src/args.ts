import type { DeployEnvironment } from './manifest';
import { invalidUsage, matchOption, readOptionValue } from './support';

export type AppCommandOptions = {
  name?: string;
  target?: string;
  env?: DeployEnvironment;
  preview?: boolean;
  yes: boolean;
};

export type PlatformCommandOptions = {
  /** Omitted when the command should use default-target. */
  target?: string;
  yes: boolean;
};

export function parseAppCommandArgs(args: readonly string[], command: string): AppCommandOptions {
  let name: string | undefined;
  let target: string | undefined;
  let env: DeployEnvironment | undefined;
  let preview = false;
  let yes = false;

  for (let position = 0; position < args.length; position++) {
    const token = args[position] ?? '';
    const targetOpt = matchOption(args, position, token, '--target');
    if (targetOpt) {
      if (target !== undefined)
        invalidUsage('Option may be provided only once: --target', '--target');
      target = targetOpt.value;
      position = targetOpt.consumedThrough;
      continue;
    }
    const envOpt = matchOption(args, position, token, '--env');
    if (envOpt) {
      if (env !== undefined) invalidUsage('Option may be provided only once: --env', '--env');
      if (envOpt.value !== 'prod' && envOpt.value !== 'staging') {
        invalidUsage('--env must be prod or staging', envOpt.value, { command });
      }
      env = envOpt.value;
      position = envOpt.consumedThrough;
      continue;
    }
    if (token === '--preview') {
      if (preview) invalidUsage(`Option may be provided only once: ${token}`, token);
      preview = true;
      continue;
    }
    if (token === '--yes') {
      if (yes) invalidUsage(`Option may be provided only once: ${token}`, token);
      yes = true;
      continue;
    }
    if (token.startsWith('--')) {
      invalidUsage(`Unknown option: ${token}`, token, { command });
    }
    if (name !== undefined) {
      invalidUsage(`Unexpected argument: ${token}`, token, { command });
    }
    name = token;
  }

  return {
    name,
    target,
    ...(env ? { env } : {}),
    ...(preview ? { preview: true } : {}),
    yes,
  };
}

export type PlatformInitOptions = {
  force: boolean;
};

export function parsePlatformInitArgs(args: readonly string[]): PlatformInitOptions {
  let force = false;
  for (const token of args) {
    if (token === '--force' || token === '-f') {
      if (force) invalidUsage(`Option may be provided only once: ${token}`, token);
      force = true;
      continue;
    }
    invalidUsage(
      token.startsWith('--') ? `Unknown option: ${token}` : `Unexpected argument: ${token}`,
      token,
      { command: 'platform cluster init' },
    );
  }
  return { force };
}

export function parsePlatformCommandArgs(
  args: readonly string[],
  command: string,
): PlatformCommandOptions {
  let target: string | undefined;
  let yes = false;

  for (let position = 0; position < args.length; position++) {
    const token = args[position] ?? '';
    if (token === '--yes') {
      if (yes) invalidUsage(`Option may be provided only once: ${token}`, token);
      yes = true;
      continue;
    }
    if (token === '--target') {
      if (target !== undefined) invalidUsage(`Option may be provided only once: ${token}`, token);
      target = readOptionValue(args, ++position, token);
      continue;
    }
    if (token.startsWith('--')) {
      invalidUsage(`Unknown option: ${token}`, token, { command });
    }
    if (target !== undefined) {
      invalidUsage(`Unexpected argument: ${token}`, token, { command });
    }
    target = token;
  }

  return { ...(target === undefined ? {} : { target }), yes };
}
