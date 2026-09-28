import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  AgentConfigurationAuditFinding,
  AgentConfigurationAuditReport,
  AgentConfigurationAuditSeverity,
  AuditAgentConfigurationOptions,
  auditAgentConfiguration,
} from '@di-framework/ai-utils';
import { CommandFailure, type CommandResult, type JsonValue } from '@di-framework/cli-extension';

export type AgentAuditOperations = {
  readonly auditAgentConfiguration: typeof auditAgentConfiguration;
};

const REPEATABLE_OPTIONS = new Set([
  '--skills-dir',
  '--skills-package',
  '--instructions-fallback',
  '--allowed-directory',
]);
const VALUE_OPTIONS = new Set([
  '--workspace',
  '--working-directory',
  '--user-directory',
  '--source-mode',
  '--max-instruction-bytes',
]);
const SEVERITIES: readonly AgentConfigurationAuditSeverity[] = ['error', 'warning', 'info'];
const SEVERITY_LABELS: Readonly<Record<AgentConfigurationAuditSeverity, string>> = {
  error: 'Errors',
  warning: 'Warnings',
  info: 'Info',
};

export function parseAgentAuditArgs(
  args: readonly string[],
  cwd = process.cwd(),
): AuditAgentConfigurationOptions {
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
    allowedDirectories: repeatedValues(repeated, '--allowed-directory')?.map((path) =>
      resolve(workspace, path),
    ),
  };
}

export async function runAgentAudit(
  args: readonly string[],
  operations?: AgentAuditOperations,
  cwd = process.cwd(),
): Promise<CommandResult> {
  const options = parseAgentAuditArgs(args, cwd);
  const api = operations ?? (await loadAgentAuditOperations(cwd));
  const report = api.auditAgentConfiguration(options);
  return {
    data: report as unknown as JsonValue,
    text: formatAgentAuditText(report),
    exitCode: report.valid ? 0 : 1,
  };
}

export function formatAgentAuditText(report: AgentConfigurationAuditReport): string {
  const counts = new Map(
    SEVERITIES.map((severity) => [
      severity,
      report.findings.filter((finding) => finding.severity === severity).length,
    ]),
  );
  const lines = [
    `Agent configuration audit is ${report.valid ? 'valid' : 'invalid'}: ${counts.get('error')} error(s), ${counts.get('warning')} warning(s), ${counts.get('info')} info finding(s)`,
    `Workspace: ${report.workspace}`,
    `Working directory: ${report.workingDirectory}`,
  ];
  for (const severity of SEVERITIES) {
    const findings = report.findings.filter((finding) => finding.severity === severity);
    lines.push(`${severityLabel(severity)} (${findings.length}):`);
    if (findings.length === 0) lines.push('  (none)');
    else for (const finding of findings) lines.push(...formatFinding(finding));
  }
  return lines.join('\n');
}

function formatFinding(finding: AgentConfigurationAuditFinding): string[] {
  const metadata = [`provenance=${finding.provenance}`];
  if (finding.precedence != null) metadata.push(`precedence=${finding.precedence}`);
  if (finding.relatedPath != null) metadata.push(`related=${finding.relatedPath}`);
  return [
    `  [${finding.code}] ${finding.path}: ${finding.message}`,
    `    ${metadata.join(', ')}`,
    ...(finding.action == null ? [] : [`    Action: ${finding.action}`]),
  ];
}

function severityLabel(severity: AgentConfigurationAuditSeverity): string {
  return SEVERITY_LABELS[severity];
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

async function loadAgentAuditOperations(cwd: string): Promise<AgentAuditOperations> {
  try {
    const projectRequire = createRequire(resolve(cwd, 'package.json'));
    const modulePath = projectRequire.resolve('@di-framework/ai-utils');
    return import(pathToFileURL(modulePath).href);
  } catch (cause) {
    throw new CommandFailure(
      'AGENT_AUDIT_PACKAGE_UNAVAILABLE',
      'Unable to load @di-framework/ai-utils from the current project',
      3,
      { cause: cause instanceof Error ? cause.message : String(cause) },
    );
  }
}

function invalidUsage(message: string, token: string): never {
  throw new CommandFailure('INVALID_USAGE', message, 2, { token });
}
