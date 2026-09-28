import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  AgentConfigurationAuditFinding,
  AgentConfigurationMigrationAction,
  AgentConfigurationMigrationActionResult,
  AgentConfigurationMigrationExecutionResult,
  AgentConfigurationMigrationPlan,
  AuditAgentConfigurationOptions,
  auditAgentConfiguration,
  executeAgentConfigurationMigration,
  planAgentConfigurationMigration,
} from '@di-framework/ai-utils';
import { CommandFailure, type CommandResult, type JsonValue } from '@di-framework/cli-extension';

export type AgentMigrateOperations = {
  readonly auditAgentConfiguration: typeof auditAgentConfiguration;
  readonly planAgentConfigurationMigration: typeof planAgentConfigurationMigration;
  readonly executeAgentConfigurationMigration: typeof executeAgentConfigurationMigration;
};

export interface AgentMigrateCliOptions {
  readonly mode: 'plan' | 'apply';
  readonly audit: AuditAgentConfigurationOptions;
  readonly opportunityPaths?: readonly string[];
  readonly replaceExisting: boolean;
}

export interface AgentMigrateCommandData {
  readonly mode: 'plan' | 'apply';
  readonly audit: {
    readonly valid: boolean;
    readonly findings: readonly AgentConfigurationAuditFinding[];
  };
  readonly plan: AgentConfigurationMigrationPlan;
  readonly execution?: AgentConfigurationMigrationExecutionResult;
}

const REPEATABLE_OPTIONS = new Set([
  '--skills-dir',
  '--skills-package',
  '--instructions-fallback',
  '--source',
]);
const VALUE_OPTIONS = new Set([
  '--workspace',
  '--working-directory',
  '--user-directory',
  '--source-mode',
  '--max-instruction-bytes',
]);
const FLAG_OPTIONS = new Set(['--plan', '--apply', '--replace-existing']);

export async function runAgentMigrate(
  args: readonly string[],
  operations?: AgentMigrateOperations,
  cwd = process.cwd(),
): Promise<CommandResult> {
  const options = parseAgentMigrateArgs(args, cwd);
  const api = operations ?? (await loadAgentMigrateOperations(cwd));
  const report = api.auditAgentConfiguration(options.audit);
  const plan = api.planAgentConfigurationMigration(report, {
    opportunityPaths: options.opportunityPaths,
    replaceExisting: options.replaceExisting,
  });
  const execution =
    options.mode === 'apply'
      ? api.executeAgentConfigurationMigration(plan, { dryRun: false })
      : undefined;
  const sharedData = {
    mode: options.mode,
    audit: { valid: report.valid, findings: report.findings },
    plan,
  };
  const data: AgentMigrateCommandData =
    execution == null ? sharedData : { ...sharedData, execution };
  const successful = report.valid && plan.valid && (execution?.success ?? true);
  return {
    data: data as unknown as JsonValue,
    text: formatAgentMigration(data),
    exitCode: successful ? 0 : 1,
  };
}

export function parseAgentMigrateArgs(
  args: readonly string[],
  cwd = process.cwd(),
): AgentMigrateCliOptions {
  const values = new Map<string, string>();
  const repeated = new Map<string, string[]>();
  const flags = new Set<string>();
  for (let position = 0; position < args.length; position++) {
    const option = args[position] ?? '';
    if (FLAG_OPTIONS.has(option)) {
      if (flags.has(option)) invalidUsage(`Option may be provided only once: ${option}`, option);
      flags.add(option);
      continue;
    }
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
  if (flags.has('--plan') && flags.has('--apply')) {
    invalidUsage('--plan and --apply are mutually exclusive', '--apply');
  }
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

  const workspace = resolve(cwd, values.get('--workspace') ?? '.');
  return {
    mode: flags.has('--apply') ? 'apply' : 'plan',
    audit: {
      workspace,
      workingDirectory: resolve(workspace, values.get('--working-directory') ?? '.'),
      userDirectory: optionalResolved(workspace, values.get('--user-directory')),
      directories: repeatedValues(repeated, '--skills-dir'),
      packages: repeatedValues(repeated, '--skills-package'),
      sourceMode: sourceMode as 'merge' | 'replace' | undefined,
      fallbackFilenames: repeatedValues(repeated, '--instructions-fallback'),
      maxBytes,
    },
    opportunityPaths: repeatedValues(repeated, '--source'),
    replaceExisting: flags.has('--replace-existing'),
  };
}

export function formatAgentMigration(result: AgentMigrateCommandData): string {
  const lines = [
    `Agent migration ${result.mode} for ${result.plan.workspace}`,
    `Audit: ${result.audit.valid ? 'valid' : 'invalid'} (${result.audit.findings.length} findings)`,
    `Plan: ${result.plan.valid ? 'valid' : 'invalid'} (${result.plan.actions.length} actions)`,
    'Planned actions:',
    ...listOrNone(result.plan.actions.map(formatPlanAction)),
  ];
  if (result.execution == null) {
    lines.push('No files changed (plan mode).');
  } else {
    lines.push(
      `Execution: ${result.execution.applied.length} applied, ${result.execution.skipped.length} skipped, ${result.execution.failed.length} failed`,
      'Applied actions:',
      ...listOrNone(result.execution.applied.map(formatActionResult)),
      'Skipped actions:',
      ...listOrNone(result.execution.skipped.map(formatActionResult)),
      'Failed actions:',
      ...listOrNone(result.execution.failed.map(formatActionResult)),
    );
  }
  return lines.join('\n');
}

function formatPlanAction(action: AgentConfigurationMigrationAction): string {
  const source = action.source?.kind === 'file' ? ` <- ${action.source.path}` : '';
  return `  ${action.id} [${action.status}:${action.code}] ${action.operation} ${action.relativeTargetPath}${source}`;
}

function formatActionResult(result: AgentConfigurationMigrationActionResult): string {
  const backup = result.backupPath == null ? '' : ` (backup: ${result.backupPath})`;
  return `  ${result.actionId} [${result.status}:${result.code}] ${result.targetPath}${backup}`;
}

function listOrNone(lines: readonly string[]): readonly string[] {
  return lines.length === 0 ? ['  (none)'] : lines;
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

async function loadAgentMigrateOperations(cwd: string): Promise<AgentMigrateOperations> {
  try {
    const projectRequire = createRequire(resolve(cwd, 'package.json'));
    const modulePath = projectRequire.resolve('@di-framework/ai-utils');
    return import(pathToFileURL(modulePath).href);
  } catch (cause) {
    throw new CommandFailure(
      'AGENT_MIGRATE_PACKAGE_UNAVAILABLE',
      'Unable to load @di-framework/ai-utils from the current project',
      3,
      { cause: cause instanceof Error ? cause.message : String(cause) },
    );
  }
}

function invalidUsage(message: string, token: string): never {
  throw new CommandFailure('INVALID_USAGE', message, 2, { token });
}
