import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  buildSkillsIndex,
  inspectSkillsIndex,
  migrateSkillsIndex,
  querySkillsIndex,
  SkillsIndexOperationError,
  validateSkillsIndex,
} from '@di-framework/ai-utils';
import { CommandFailure, type CommandResult, type JsonValue } from '@di-framework/cli-extension';

export type SkillsIndexCommand = 'build' | 'inspect' | 'validate' | 'query' | 'migrate';

export type SkillsIndexOperations = {
  readonly buildSkillsIndex: typeof buildSkillsIndex;
  readonly inspectSkillsIndex: typeof inspectSkillsIndex;
  readonly validateSkillsIndex: typeof validateSkillsIndex;
  readonly querySkillsIndex: typeof querySkillsIndex;
  readonly migrateSkillsIndex: typeof migrateSkillsIndex;
  readonly SkillsIndexOperationError: typeof SkillsIndexOperationError;
};

type OptionKind = 'value' | 'repeatable' | 'boolean';

const OPTION_SPECS: Record<SkillsIndexCommand, Readonly<Record<string, OptionKind>>> = {
  build: {
    '--skills-dir': 'repeatable',
    '--skill-file': 'repeatable',
    '--output': 'value',
    '--threshold': 'value',
    '--limit': 'value',
    '--batch-size': 'value',
    '--chunk-tokens': 'value',
    '--chunk-overlap': 'value',
    '--force': 'boolean',
  },
  inspect: { '--input': 'value' },
  validate: {
    '--input': 'value',
    '--skills-dir': 'repeatable',
    '--skill-file': 'repeatable',
    '--allow-extra-skills': 'boolean',
  },
  query: {
    '--input': 'value',
    '--query': 'value',
    '--limit': 'value',
    '--min-score': 'value',
    '--abstention-threshold': 'value',
  },
  migrate: { '--input': 'value', '--output': 'value' },
};

interface ParsedOptions {
  readonly values: ReadonlyMap<string, string>;
  readonly repeated: ReadonlyMap<string, readonly string[]>;
  readonly booleans: ReadonlySet<string>;
}

export async function runSkillsIndexCommand(
  command: SkillsIndexCommand,
  args: readonly string[],
  operations?: SkillsIndexOperations,
  cwd = process.cwd(),
): Promise<CommandResult> {
  const options = parseOptions(command, args);
  const api = operations ?? (await loadSkillsIndexOperations(cwd));
  try {
    switch (command) {
      case 'build': {
        const result = await api.buildSkillsIndex({
          directories: repeated(options, '--skills-dir'),
          files: repeated(options, '--skill-file'),
          outputFile: value(options, '--output'),
          threshold: numeric(options, '--threshold'),
          retrievalLimit: numeric(options, '--limit'),
          batchSize: numeric(options, '--batch-size'),
          chunkTokens: numeric(options, '--chunk-tokens'),
          chunkOverlapTokens: numeric(options, '--chunk-overlap'),
          force: options.booleans.has('--force'),
        });
        return resultPresentation(
          result,
          `Built skills index at ${result.outputFile}: ${result.skillCount} skills, ${result.chunkCount} chunks${result.unchanged ? ' (unchanged)' : ''}`,
        );
      }
      case 'inspect': {
        const result = api.inspectSkillsIndex({
          inputFile: value(options, '--input'),
          cwd,
        });
        return resultPresentation(
          result,
          `Skills index ${result.file}: version ${result.metadata.version}, ${result.metadata.skillCount} skills, ${result.metadata.chunkCount} chunks`,
        );
      }
      case 'validate': {
        const result = api.validateSkillsIndex({
          inputFile: value(options, '--input'),
          directories: repeated(options, '--skills-dir'),
          files: repeated(options, '--skill-file'),
          allowExtraSkills: options.booleans.has('--allow-extra-skills'),
          cwd,
        });
        if (result.valid) {
          return resultPresentation(result, `Skills index ${result.file} is valid`);
        }
        const drift = result.sourceDrift ?? 'unknown drift';
        return resultPresentation(
          result,
          `Skills index ${result.file} has source drift: ${drift}`,
          1,
        );
      }
      case 'query': {
        const result = await api.querySkillsIndex({
          inputFile: value(options, '--input'),
          query: value(options, '--query') ?? '',
          limit: numeric(options, '--limit'),
          minScore: numeric(options, '--min-score'),
          abstentionThreshold: numeric(options, '--abstention-threshold'),
          cwd,
        });
        if (result.decision === 'selected') {
          return resultPresentation(
            result,
            `Selected ${result.matches.length} skill match(es) from ${result.file}`,
          );
        }
        return resultPresentation(result, `No skill matches selected from ${result.file}`, 1);
      }
      case 'migrate': {
        const result = api.migrateSkillsIndex({
          inputFile: value(options, '--input'),
          outputFile: value(options, '--output'),
          cwd,
        });
        return resultPresentation(
          result,
          `Migrated skills index ${result.inputFile} from version ${result.fromVersion} to version ${result.toVersion} at ${result.outputFile}`,
        );
      }
    }
  } catch (error) {
    if (!(error instanceof api.SkillsIndexOperationError)) throw error;
    throw operationFailure(error);
  }
}

export function runSkillsIndexBuild(
  args: readonly string[],
  operations?: SkillsIndexOperations,
  cwd?: string,
) {
  return runSkillsIndexCommand('build', args, operations, cwd);
}

export function runSkillsIndexInspect(
  args: readonly string[],
  operations?: SkillsIndexOperations,
  cwd?: string,
) {
  return runSkillsIndexCommand('inspect', args, operations, cwd);
}

export function runSkillsIndexValidate(
  args: readonly string[],
  operations?: SkillsIndexOperations,
  cwd?: string,
) {
  return runSkillsIndexCommand('validate', args, operations, cwd);
}

export function runSkillsIndexQuery(
  args: readonly string[],
  operations?: SkillsIndexOperations,
  cwd?: string,
) {
  return runSkillsIndexCommand('query', args, operations, cwd);
}

export function runSkillsIndexMigrate(
  args: readonly string[],
  operations?: SkillsIndexOperations,
  cwd?: string,
) {
  return runSkillsIndexCommand('migrate', args, operations, cwd);
}

function parseOptions(command: SkillsIndexCommand, args: readonly string[]): ParsedOptions {
  const specs = OPTION_SPECS[command];
  const values = new Map<string, string>();
  const repeated = new Map<string, string[]>();
  const booleans = new Set<string>();
  for (let position = 0; position < args.length; position++) {
    const token = args[position] ?? '';
    const kind = specs[token];
    if (kind == null) invalidUsage(`Unknown option or argument: ${token}`, token);
    if (kind === 'boolean') {
      if (booleans.has(token)) invalidUsage(`Option may be provided only once: ${token}`, token);
      booleans.add(token);
      continue;
    }
    const optionValue = args[++position];
    if (optionValue == null || optionValue.startsWith('--')) {
      invalidUsage(`Missing value for ${token}`, token);
    }
    if (kind === 'repeatable') {
      repeated.set(token, [...(repeated.get(token) ?? []), optionValue]);
    } else {
      if (values.has(token)) invalidUsage(`Option may be provided only once: ${token}`, token);
      values.set(token, optionValue);
    }
  }
  return { values, repeated, booleans };
}

function value(options: ParsedOptions, option: string): string | undefined {
  return options.values.get(option);
}

function repeated(options: ParsedOptions, option: string): readonly string[] | undefined {
  const entries = options.repeated.get(option);
  return entries?.length ? entries : undefined;
}

function numeric(options: ParsedOptions, option: string): number | undefined {
  const raw = value(options, option);
  return raw == null ? undefined : Number(raw);
}

function resultPresentation(result: object, text: string, exitCode: 0 | 1 = 0): CommandResult {
  return { data: result as unknown as JsonValue, text, exitCode };
}

async function loadSkillsIndexOperations(cwd: string): Promise<SkillsIndexOperations> {
  try {
    const projectRequire = createRequire(resolve(cwd, 'package.json'));
    const modulePath = projectRequire.resolve('@di-framework/ai-utils');
    return import(pathToFileURL(modulePath).href);
  } catch (cause) {
    throw new CommandFailure(
      'SKILLS_INDEX_PACKAGE_UNAVAILABLE',
      'Unable to load @di-framework/ai-utils from the current project',
      3,
      { cause: cause instanceof Error ? cause.message : String(cause) },
    );
  }
}

function invalidUsage(message: string, token: string): never {
  throw new CommandFailure('INVALID_USAGE', message, 2, { token });
}

function operationFailure(error: SkillsIndexOperationError): CommandFailure {
  const exitCode =
    error.code === 'SOURCE_DRIFT'
      ? 1
      : error.code === 'INVALID_OPTIONS' ||
          error.code === 'SOURCE_NOT_FOUND' ||
          error.code === 'INDEX_NOT_FOUND' ||
          error.code === 'INVALID_INDEX'
        ? 2
        : 3;
  return new CommandFailure(`SKILLS_INDEX_${error.code}`, error.message, exitCode, {
    operation: error.operation,
    operationCode: error.code,
  });
}
