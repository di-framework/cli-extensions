import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  ResolveSkillSourcesOptions,
  SkillCatalogDiagnostic,
  validateSkillCatalog,
} from '@di-framework/ai-utils';
import { CommandFailure, type CommandResult, type JsonValue } from '@di-framework/cli-extension';

export type SkillsValidateOperations = {
  readonly validateSkillCatalog: typeof validateSkillCatalog;
};

export interface SkillsValidateCliOptions {
  readonly workspace: string;
  readonly userDirectory?: string;
  readonly directories?: readonly string[];
  readonly packages?: readonly string[];
  readonly sourceMode?: 'merge' | 'replace';
}

export interface SkillsValidateCommandResult {
  readonly valid: boolean;
  readonly skillCount: number;
  readonly diagnostics: readonly SkillCatalogDiagnostic[];
}

export function parseSkillsValidateArgs(
  args: readonly string[],
  cwd = process.cwd(),
): SkillsValidateCliOptions {
  let workspace = cwd;
  let workspaceConfigured = false;
  let userDirectory: string | undefined;
  let sourceMode: 'merge' | 'replace' | undefined;
  const directories: string[] = [];
  const packages: string[] = [];

  for (let position = 0; position < args.length; position++) {
    const token = args[position] ?? '';
    switch (token) {
      case '--workspace':
        if (workspaceConfigured) duplicateOption(token);
        workspace = readOptionValue(args, ++position, token);
        workspaceConfigured = true;
        break;
      case '--user-directory':
        if (userDirectory != null) duplicateOption(token);
        userDirectory = readOptionValue(args, ++position, token);
        break;
      case '--skills-dir':
        directories.push(readOptionValue(args, ++position, token));
        break;
      case '--skills-package':
        packages.push(readOptionValue(args, ++position, token));
        break;
      case '--source-mode': {
        if (sourceMode != null) duplicateOption(token);
        const value = readOptionValue(args, ++position, token);
        if (value !== 'merge' && value !== 'replace') {
          invalidUsage(`Invalid value for --source-mode: ${value}`, token, { value });
        }
        sourceMode = value;
        break;
      }
      default:
        invalidUsage(`Unknown option or argument: ${token}`, token);
    }
  }

  return {
    workspace,
    userDirectory,
    directories: directories.length ? directories : undefined,
    packages: packages.length ? packages : undefined,
    sourceMode,
  };
}

export async function runSkillsValidate(
  args: readonly string[],
  operations?: SkillsValidateOperations,
  cwd = process.cwd(),
): Promise<CommandResult> {
  const options = parseSkillsValidateArgs(args, cwd);
  const api = operations ?? (await loadSkillsValidateOperations(cwd));
  const packageOptions: ResolveSkillSourcesOptions = options;
  const result = api.validateSkillCatalog(packageOptions);
  const presentation: SkillsValidateCommandResult = {
    valid: result.valid,
    skillCount: result.skills.length,
    diagnostics: result.diagnostics,
  };
  return {
    data: presentation as unknown as JsonValue,
    text: formatSkillsValidation(presentation),
    exitCode: result.valid ? 0 : 1,
  };
}

export function formatSkillsValidation(result: SkillsValidateCommandResult): string {
  const state = result.valid ? 'valid' : 'invalid';
  const summary = `Skill catalog is ${state}: ${result.skillCount} skill(s), ${result.diagnostics.length} diagnostic(s)`;
  const diagnostics = result.diagnostics.map((diagnostic) => {
    const related = diagnostic.relatedPath ? ` (related: ${diagnostic.relatedPath})` : '';
    return `[${diagnostic.severity.toUpperCase()} ${diagnostic.code}] ${diagnostic.path}: ${diagnostic.message}${related}`;
  });
  return [summary, ...diagnostics].join('\n');
}

async function loadSkillsValidateOperations(cwd: string): Promise<SkillsValidateOperations> {
  try {
    const projectRequire = createRequire(resolve(cwd, 'package.json'));
    const modulePath = projectRequire.resolve('@di-framework/ai-utils');
    return import(pathToFileURL(modulePath).href);
  } catch (cause) {
    throw new CommandFailure(
      'SKILLS_PACKAGE_UNAVAILABLE',
      'Unable to load @di-framework/ai-utils from the current project',
      3,
      { cause: cause instanceof Error ? cause.message : String(cause) },
    );
  }
}

function readOptionValue(args: readonly string[], position: number, option: string): string {
  const value = args[position];
  if (value == null || value.startsWith('--')) {
    invalidUsage(`Missing value for ${option}`, option);
  }
  return value;
}

function duplicateOption(option: string): never {
  invalidUsage(`Option may be provided only once: ${option}`, option);
}

function invalidUsage(
  message: string,
  token: string,
  details: Record<string, JsonValue> = {},
): never {
  throw new CommandFailure('INVALID_USAGE', message, 2, { token, ...details });
}
