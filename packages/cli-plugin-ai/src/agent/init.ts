import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  AgentConfigurationMigrationExecutionResult,
  AgentConfigurationMigrationPlan,
  AgentConfigurationMigrationRequest,
  auditAgentConfiguration,
  executeAgentConfigurationMigration,
  NeutralAgentAssetPath,
  planAgentConfigurationMigration,
} from '@di-framework/ai-utils';
import { CommandFailure, type CommandResult, type JsonValue } from '@di-framework/cli-extension';

export type AgentInitOperations = {
  readonly auditAgentConfiguration: typeof auditAgentConfiguration;
  readonly planAgentConfigurationMigration: typeof planAgentConfigurationMigration;
  readonly executeAgentConfigurationMigration: typeof executeAgentConfigurationMigration;
};

interface ParsedAgentInitOptions {
  readonly workspace: string;
  readonly assets: readonly NeutralAgentAssetPath[];
  readonly dryRun: boolean;
}

const NEUTRAL_ASSETS = [
  'AGENTS.md',
  '.agents/AGENTS.md',
  '.agents/skills',
  '.aiignore',
] as const satisfies readonly NeutralAgentAssetPath[];

const ASSET_CONTENT: Readonly<Record<Exclude<NeutralAgentAssetPath, '.agents/skills'>, string>> = {
  'AGENTS.md': '# Repository instructions\n',
  '.agents/AGENTS.md': '# Agent configuration instructions\n',
  '.aiignore': '# Add paths that AI tools must ignore.\n',
};

export async function runAgentInit(
  args: readonly string[],
  operations?: AgentInitOperations,
  cwd = process.cwd(),
): Promise<CommandResult> {
  const options = parseAgentInitArgs(args, cwd);
  const api = operations ?? (await loadAgentInitOperations(cwd));
  const report = api.auditAgentConfiguration({
    workspace: options.workspace,
    workingDirectory: options.workspace,
    sourceMode: 'replace',
  });
  const plan = api.planAgentConfigurationMigration(report, {
    includeAuditOpportunities: false,
    requests: options.assets.map(requestForAsset),
  });
  const execution = api.executeAgentConfigurationMigration(plan, { dryRun: options.dryRun });

  return {
    data: { plan, execution } as unknown as JsonValue,
    text: formatAgentInitText(plan, execution),
    exitCode: plan.valid && execution.success ? 0 : 1,
  };
}

function parseAgentInitArgs(args: readonly string[], cwd: string): ParsedAgentInitOptions {
  let workspace = cwd;
  let hasWorkspace = false;
  let apply = false;
  let explicitDryRun = false;
  const assets: NeutralAgentAssetPath[] = [];

  for (let position = 0; position < args.length; position++) {
    const option = args[position] ?? '';
    if (option === '--apply' || option === '--dry-run') {
      if (option === '--apply') {
        if (apply) invalidUsage('Option may be provided only once: --apply', option);
        apply = true;
      } else {
        if (explicitDryRun) invalidUsage('Option may be provided only once: --dry-run', option);
        explicitDryRun = true;
      }
      continue;
    }
    if (option !== '--workspace' && option !== '--asset') {
      invalidUsage(`Unknown option or argument: ${option}`, option);
    }
    const value = args[++position];
    if (value == null || value.startsWith('--')) {
      invalidUsage(`Missing value for ${option}`, option);
    }
    if (option === '--workspace') {
      if (hasWorkspace) invalidUsage('Option may be provided only once: --workspace', option);
      workspace = resolve(cwd, value);
      hasWorkspace = true;
      continue;
    }
    if (!isNeutralAsset(value)) {
      invalidUsage(`--asset must be one of: ${NEUTRAL_ASSETS.join(', ')}`, option);
    }
    assets.push(value);
  }

  if (apply && explicitDryRun) {
    invalidUsage('--apply and --dry-run cannot be used together', '--apply');
  }
  return {
    workspace,
    assets: assets.length === 0 ? NEUTRAL_ASSETS : assets,
    dryRun: !apply,
  };
}

function isNeutralAsset(value: string): value is NeutralAgentAssetPath {
  return (NEUTRAL_ASSETS as readonly string[]).includes(value);
}

function requestForAsset(asset: NeutralAgentAssetPath): AgentConfigurationMigrationRequest {
  return asset === '.agents/skills'
    ? { target: asset }
    : { target: asset, content: ASSET_CONTENT[asset] };
}

function formatAgentInitText(
  plan: AgentConfigurationMigrationPlan,
  execution: AgentConfigurationMigrationExecutionResult,
): string {
  const actionPaths = new Map(plan.actions.map((action) => [action.id, action.relativeTargetPath]));
  const lines = [
    `Agent initialization plan for ${plan.workspace}`,
    `Plan: ${plan.valid ? 'valid' : 'invalid'} (${plan.actions.length} actions)`,
    ...listOrNone(
      plan.actions.map(
        (action) =>
          `  [${action.status}:${action.code}] ${action.operation} ${action.relativeTargetPath} — ${action.message}`,
      ),
    ),
    `Execution: ${execution.dryRun ? 'dry-run' : 'apply'} (${execution.success ? 'succeeded' : 'failed'})`,
    `  Applied: ${execution.applied.length}; skipped: ${execution.skipped.length}; failed: ${execution.failed.length}`,
    ...[...execution.applied, ...execution.skipped, ...execution.failed].map(
      (result) =>
        `  [${result.status}:${result.code}] ${result.operation} ${actionPaths.get(result.actionId) ?? result.targetPath} — ${result.message}`,
    ),
  ];
  return lines.join('\n');
}

function listOrNone(lines: readonly string[]): readonly string[] {
  return lines.length === 0 ? ['  (none)'] : lines;
}

async function loadAgentInitOperations(cwd: string): Promise<AgentInitOperations> {
  try {
    const projectRequire = createRequire(resolve(cwd, 'package.json'));
    const modulePath = projectRequire.resolve('@di-framework/ai-utils');
    return import(pathToFileURL(modulePath).href);
  } catch (cause) {
    throw new CommandFailure(
      'AGENT_INIT_PACKAGE_UNAVAILABLE',
      'Unable to load @di-framework/ai-utils from the current project',
      3,
      { cause: cause instanceof Error ? cause.message : String(cause) },
    );
  }
}

function invalidUsage(message: string, token: string): never {
  throw new CommandFailure('INVALID_USAGE', message, 2, { token });
}
