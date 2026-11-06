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

export function readStringFlag<K extends string>(
  args: readonly string[],
  position: number,
  token: string,
  flags: Readonly<Record<string, K>>,
  values: Partial<Record<K, string>>,
): number | undefined {
  for (const [flag, key] of Object.entries(flags)) {
    const matched = matchOption(args, position, token, flag);
    if (matched) {
      if (values[key] !== undefined) {
        invalidUsage(`Option may be provided only once: ${flag}`, flag);
      }
      values[key] = matched.value;
      return matched.consumedThrough + 1;
    }
  }
  return undefined;
}

export function readEnvFlag(
  args: readonly string[],
  position: number,
  token: string,
  current: DeployEnvironment | undefined,
  command: string,
): { value: DeployEnvironment; nextPosition: number } | undefined {
  const matched = matchOption(args, position, token, '--env');
  if (!matched) return undefined;
  if (current !== undefined) {
    invalidUsage('Option may be provided only once: --env', '--env');
  }
  if (matched.value !== 'prod' && matched.value !== 'staging') {
    invalidUsage('--env must be prod or staging', matched.value, { command });
  }
  return { value: matched.value, nextPosition: matched.consumedThrough + 1 };
}

const APP_STRING_FLAGS = { '--target': 'target' } as const;

export function parseAppCommandArgs(args: readonly string[], command: string): AppCommandOptions {
  let name: string | undefined;
  const values: { target?: string } = {};
  let env: DeployEnvironment | undefined;
  const flags = { preview: false, yes: false };

  let position = 0;
  while (position < args.length) {
    const token = args[position] as string;
    const nextPos = readStringFlag(args, position, token, APP_STRING_FLAGS, values);
    if (nextPos !== undefined) {
      position = nextPos;
      continue;
    }
    const envOpt = readEnvFlag(args, position, token, env, command);
    if (envOpt) {
      env = envOpt.value;
      position = envOpt.nextPosition;
      continue;
    }
    if (token === '--preview' || token === '--yes') {
      const key = token === '--preview' ? 'preview' : 'yes';
      if (flags[key]) invalidUsage(`Option may be provided only once: ${token}`, token);
      flags[key] = true;
      position += 1;
      continue;
    }
    if (token.startsWith('--')) {
      invalidUsage(`Unknown option: ${token}`, token, { command });
    }
    if (name !== undefined) {
      invalidUsage(`Unexpected argument: ${token}`, token, { command });
    }
    name = token;
    position += 1;
  }

  return {
    name,
    target: values.target,
    ...(env ? { env } : {}),
    ...(flags.preview ? { preview: true } : {}),
    yes: flags.yes,
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

  let position = 0;
  while (position < args.length) {
    const token = args[position] as string;
    if (token === '--yes') {
      if (yes) invalidUsage(`Option may be provided only once: ${token}`, token);
      yes = true;
      position += 1;
      continue;
    }
    if (token === '--target') {
      if (target !== undefined) invalidUsage(`Option may be provided only once: ${token}`, token);
      target = readOptionValue(args, position + 1, token);
      position += 2;
      continue;
    }
    if (token.startsWith('--')) {
      invalidUsage(`Unknown option: ${token}`, token, { command });
    }
    if (target !== undefined) {
      invalidUsage(`Unexpected argument: ${token}`, token, { command });
    }
    target = token;
    position += 1;
  }

  return { ...(target === undefined ? {} : { target }), yes };
}
