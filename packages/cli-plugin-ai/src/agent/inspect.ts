import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  AiIgnorePolicyError,
  discoverAgentInstructions,
  loadAiIgnorePolicy,
  resolveSkillSources,
  validateResolvedSkillCatalog,
} from '@di-framework/ai-utils';
import { CommandFailure, type CommandResult, type JsonValue } from '@di-framework/cli-extension';

export type AgentInspectOperations = {
  readonly resolveSkillSources: typeof resolveSkillSources;
  readonly discoverAgentInstructions: typeof discoverAgentInstructions;
  readonly loadAiIgnorePolicy: typeof loadAiIgnorePolicy;
  readonly validateResolvedSkillCatalog: typeof validateResolvedSkillCatalog;
  readonly AiIgnorePolicyError: typeof AiIgnorePolicyError;
};

interface ParsedAgentInspectOptions {
  readonly workspace: string;
  readonly workingDirectory: string;
  readonly userDirectory?: string;
  readonly directories?: readonly string[];
  readonly packages?: readonly string[];
  readonly sourceMode?: 'merge' | 'replace';
  readonly fallbackFilenames?: readonly string[];
  readonly maxBytes?: number;
}

const REPEATABLE_OPTIONS = new Set(['--skills-dir', '--skills-package', '--instructions-fallback']);
const VALUE_OPTIONS = new Set([
  '--workspace',
  '--working-directory',
  '--user-directory',
  '--source-mode',
  '--max-instruction-bytes',
]);

export async function runAgentInspect(
  args: readonly string[],
  operations?: AgentInspectOperations,
  cwd = process.cwd(),
): Promise<CommandResult> {
  const options = parseAgentInspectArgs(args, cwd);
  const api = operations ?? (await loadAgentInspectOperations(cwd));
  try {
    const skills = api.resolveSkillSources({
      workspace: options.workspace,
      userDirectory: options.userDirectory,
      directories: options.directories,
      packages: options.packages,
      sourceMode: options.sourceMode,
    });
    const catalog = api.validateResolvedSkillCatalog(skills);
    const instructions = api.discoverAgentInstructions({
      workspace: options.workspace,
      workingDirectory: options.workingDirectory,
      fallbackFilenames: options.fallbackFilenames,
      maxBytes: options.maxBytes,
    });
    const aiignore = api.loadAiIgnorePolicy({ workspace: options.workspace });
    const result = {
      workspace: options.workspace,
      workingDirectory: options.workingDirectory,
      skillRoots: skills.sources.map(({ path, realPath, origin, precedence }) => ({
        path,
        realPath,
        origin,
        precedence,
      })),
      instructionFiles: instructions.sources.map(
        ({ path, realPath, directory, filename, origin, precedence, bytes }) => ({
          path,
          realPath,
          directory,
          filename,
          origin,
          precedence,
          bytes,
        }),
      ),
      aiignore: {
        source: aiignore.source,
        rules: aiignore.rules.map(
          ({ line, original, pattern, negated, directoryOnly, rootRelative }) => ({
            line,
            original,
            pattern,
            negated,
            directoryOnly,
            rootRelative,
          }),
        ),
      },
      suppressedSources: [
        ...skills.diagnostics.map((diagnostic) => ({ scope: 'skills' as const, ...diagnostic })),
        ...instructions.diagnostics.map((diagnostic) => ({
          scope: 'instructions' as const,
          ...diagnostic,
        })),
      ],
      shadowedSkills: catalog.diagnostics.filter(
        (diagnostic) => diagnostic.code === 'skill-shadowed',
      ),
    };
    return {
      data: result as unknown as JsonValue,
      text: formatAgentInspectText(result),
    };
  } catch (error) {
    if (!(error instanceof api.AiIgnorePolicyError)) throw error;
    throw new CommandFailure(`AGENT_INSPECT_${error.code}`, error.message, 2, {
      policyCode: error.code,
    });
  }
}

function parseAgentInspectArgs(args: readonly string[], cwd: string): ParsedAgentInspectOptions {
  const values = new Map<string, string>();
  const repeated = new Map<string, string[]>();
  for (let position = 0; position < args.length; position++) {
    const option = args[position] ?? '';
    if (!VALUE_OPTIONS.has(option) && !REPEATABLE_OPTIONS.has(option)) {
      invalidUsage(`Unknown option or argument: ${option}`, option);
    }
    const value = args[++position];
    if (value == null || value.startsWith('--')) {
      invalidUsage(`Missing value for ${option}`, option);
    }
    if (REPEATABLE_OPTIONS.has(option)) {
      repeated.set(option, [...(repeated.get(option) ?? []), value]);
    } else {
      if (values.has(option)) invalidUsage(`Option may be provided only once: ${option}`, option);
      values.set(option, value);
    }
  }

  const workspace = resolve(cwd, values.get('--workspace') ?? '.');
  const sourceMode = values.get('--source-mode');
  if (sourceMode != null && sourceMode !== 'merge' && sourceMode !== 'replace') {
    invalidUsage('--source-mode must be merge or replace', '--source-mode');
  }
  const maxBytesValue = values.get('--max-instruction-bytes');
  const maxBytes = maxBytesValue == null ? undefined : Number(maxBytesValue);
  if (maxBytes != null && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
    invalidUsage(
      '--max-instruction-bytes must be a non-negative safe integer',
      '--max-instruction-bytes',
    );
  }

  return {
    workspace,
    workingDirectory: resolve(workspace, values.get('--working-directory') ?? cwd),
    userDirectory: optionalResolved(workspace, values.get('--user-directory')),
    directories: repeatedValues(repeated, '--skills-dir'),
    packages: repeatedValues(repeated, '--skills-package'),
    sourceMode,
    fallbackFilenames: repeatedValues(repeated, '--instructions-fallback'),
    maxBytes,
  };
}

function optionalResolved(base: string, value: string | undefined): string | undefined {
  return value == null ? undefined : resolve(base, value);
}

function repeatedValues(
  values: ReadonlyMap<string, readonly string[]>,
  option: string,
): readonly string[] | undefined {
  const entries = values.get(option);
  return entries?.length ? entries : undefined;
}

function formatAgentInspectText(result: {
  readonly workspace: string;
  readonly workingDirectory: string;
  readonly skillRoots: readonly {
    readonly precedence: number;
    readonly origin: string;
    readonly path: string;
  }[];
  readonly instructionFiles: readonly { readonly precedence: number; readonly path: string }[];
  readonly aiignore: {
    readonly source: { readonly exists: boolean; readonly path: string };
    readonly rules: readonly unknown[];
  };
  readonly suppressedSources: readonly {
    readonly scope: string;
    readonly code: string;
    readonly path: string;
  }[];
  readonly shadowedSkills: readonly {
    readonly skillName?: string;
    readonly path: string;
    readonly relatedPath?: string;
  }[];
}): string {
  const lines = [
    `Agent configuration for ${result.workingDirectory}`,
    `Workspace: ${result.workspace}`,
    'Skill roots (highest precedence first):',
    ...listOrNone(
      result.skillRoots.map(
        (source) => `  ${source.precedence}. [${source.origin}] ${source.path}`,
      ),
    ),
    'Instruction files (broad to specific):',
    ...listOrNone(
      result.instructionFiles.map((source) => `  ${source.precedence}. ${source.path}`),
    ),
    `.aiignore: ${result.aiignore.source.exists ? result.aiignore.source.path : 'not present'} (${result.aiignore.rules.length} rules)`,
    'Suppressed sources:',
    ...listOrNone(
      result.suppressedSources.map((source) => `  [${source.scope}:${source.code}] ${source.path}`),
    ),
    'Shadowed skills:',
    ...listOrNone(
      result.shadowedSkills.map(
        (diagnostic) =>
          `  ${diagnostic.skillName ?? diagnostic.path} -> ${diagnostic.relatedPath ?? 'higher-precedence definition'}`,
      ),
    ),
  ];
  return lines.join('\n');
}

function listOrNone(lines: readonly string[]): readonly string[] {
  return lines.length === 0 ? ['  (none)'] : lines;
}

async function loadAgentInspectOperations(cwd: string): Promise<AgentInspectOperations> {
  try {
    const projectRequire = createRequire(resolve(cwd, 'package.json'));
    const modulePath = projectRequire.resolve('@di-framework/ai-utils');
    return import(pathToFileURL(modulePath).href);
  } catch (cause) {
    throw new CommandFailure(
      'AGENT_INSPECT_PACKAGE_UNAVAILABLE',
      'Unable to load @di-framework/ai-utils from the current project',
      3,
      { cause: cause instanceof Error ? cause.message : String(cause) },
    );
  }
}

function invalidUsage(message: string, token: string): never {
  throw new CommandFailure('INVALID_USAGE', message, 2, { token });
}
