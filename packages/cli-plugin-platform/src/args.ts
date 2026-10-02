import { invalidUsage, readOptionValue } from './support';

export type AppCommandOptions = {
  name?: string;
  target?: string;
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
  let yes = false;

  for (let position = 0; position < args.length; position++) {
    const token = args[position] ?? '';
    switch (token) {
      case '--target':
        if (target !== undefined) invalidUsage(`Option may be provided only once: ${token}`, token);
        target = readOptionValue(args, ++position, token);
        break;
      case '--yes':
        if (yes) invalidUsage(`Option may be provided only once: ${token}`, token);
        yes = true;
        break;
      default:
        if (token.startsWith('--')) {
          invalidUsage(`Unknown option: ${token}`, token, { command });
        }
        if (name !== undefined) {
          invalidUsage(`Unexpected argument: ${token}`, token, { command });
        }
        name = token;
    }
  }

  return { name, target, yes };
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
