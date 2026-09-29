import { afterEach, describe, expect, it } from 'bun:test';
import {
  closeSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentConfigurationAuditFinding,
  AgentConfigurationAuditReport,
} from '@di-framework/ai-utils';
import { auditAgentConfiguration } from '@di-framework/ai-utils';
import { type CliIo, type CommandNode, executeCommand } from '@di-framework/cli/command';
import {
  type AgentAuditOperations,
  formatAgentAuditText,
  parseAgentAuditArgs,
  runAgentAudit,
} from '../src/agent/audit.ts';

function auditReport(
  valid = true,
  findings: readonly AgentConfigurationAuditFinding[] = [],
  workspace = '/workspace',
): AgentConfigurationAuditReport {
  return {
    valid,
    workspace,
    workingDirectory: join(workspace, 'packages', 'api'),
    instructions: { bytes: 0, sources: [] },
    skills: { sources: [], names: [] },
    suppressedSources: [],
    vendorAssets: [],
    migrationOpportunities: [],
    findings,
  };
}

function captureIo(): { stdout: string[]; stderr: string[]; io: CliIo } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: { write: (chunk) => stdout.push(chunk) },
      stderr: { write: (chunk) => stderr.push(chunk) },
    },
  };
}

function commandTree(api?: AgentAuditOperations, cwd = '/workspace'): CommandNode {
  return {
    description: 'root',
    children: {
      agent: {
        description: 'agent',
        children: {
          audit: {
            description: 'audit',
            run: ({ args }) => runAgentAudit(args, api, cwd),
          },
        },
      },
    },
  };
}

function repositorySnapshot(root: string): {
  readonly entries: readonly string[];
  readonly files: Readonly<Record<string, { readonly content: string; readonly mtimeMs: number }>>;
} {
  const entries = readdirSync(root, { recursive: true }).map(String).sort();
  const files: Record<string, { content: string; mtimeMs: number }> = {};
  for (const entry of entries) {
    const path = join(root, entry);
    const descriptor = openSync(path, 'r');
    try {
      const info = fstatSync(descriptor);
      if (info.isFile())
        files[entry] = {
          content: readFileSync(descriptor, 'utf8'),
          mtimeMs: info.mtimeMs,
        };
    } finally {
      closeSync(descriptor);
    }
  }
  return { entries, files };
}

describe('agent audit command', () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true });
  });

  it('maps defaults and every supported option directly to the typed audit API', async () => {
    expect(parseAgentAuditArgs([], '/workspace')).toEqual({
      workspace: '/workspace',
      workingDirectory: '/workspace',
      userDirectory: undefined,
      directories: undefined,
      packages: undefined,
      sourceMode: undefined,
      fallbackFilenames: undefined,
      maxBytes: undefined,
      allowedDirectories: undefined,
    });

    const calls: unknown[] = [];
    const report = auditReport();
    const result = await runAgentAudit(
      [
        '--workspace',
        'repo',
        '--working-directory',
        'packages/api',
        '--user-directory',
        'home',
        '--skills-dir',
        'one',
        '--skills-dir',
        'two',
        '--skills-package',
        '@example/skills',
        '--source-mode',
        'replace',
        '--instructions-fallback',
        'TEAM.md',
        '--instructions-fallback',
        'LOCAL.md',
        '--max-instruction-bytes',
        '0',
        '--allowed-directory',
        'packages',
        '--allowed-directory',
        '/shared',
      ],
      {
        auditAgentConfiguration: (options) => {
          calls.push(options);
          return report;
        },
      },
      '/workspace',
    );

    expect(calls).toEqual([
      {
        workspace: '/workspace/repo',
        workingDirectory: '/workspace/repo/packages/api',
        userDirectory: '/workspace/repo/home',
        directories: ['one', 'two'],
        packages: ['@example/skills'],
        sourceMode: 'replace',
        fallbackFilenames: ['TEAM.md', 'LOCAL.md'],
        maxBytes: 0,
        allowedDirectories: ['/workspace/repo/packages', '/shared'],
      },
    ]);
    expect(result.data as unknown).toBe(report as unknown);
    expect(result.exitCode).toBe(0);
  });

  it('returns the unchanged report as JSON and groups text findings by severity', async () => {
    const findings: readonly AgentConfigurationAuditFinding[] = [
      {
        code: 'migrate-vendor-skills',
        severity: 'info',
        path: '/workspace/.claude/skills',
        provenance: 'vendor',
        message: 'Vendor skills are not loaded implicitly.',
        relatedPath: '/workspace/.agents/skills',
        action: 'Review and migrate the source.',
      },
      {
        code: 'source-missing',
        severity: 'error',
        path: '/workspace/missing',
        provenance: 'explicit',
        message: 'Configured source does not exist.',
        precedence: 2,
      },
      {
        code: 'skill-shadowed',
        severity: 'warning',
        path: '/workspace/lower/review',
        provenance: 'workspace',
        message: 'A higher-precedence skill is kept.',
      },
    ];
    const report = auditReport(false, findings);
    const api = { auditAgentConfiguration: () => report };
    const text = captureIo();
    expect(await executeCommand(commandTree(api), ['agent', 'audit'], text.io)).toBe(1);
    const output = text.stdout.join('');
    expect(output).toContain(
      'Agent configuration audit is invalid: 1 error(s), 1 warning(s), 1 info finding(s)',
    );
    expect(output.indexOf('Errors (1):')).toBeLessThan(output.indexOf('Warnings (1):'));
    expect(output.indexOf('Warnings (1):')).toBeLessThan(output.indexOf('Info (1):'));
    expect(output).toContain('[source-missing] /workspace/missing');
    expect(output).toContain('provenance=explicit, precedence=2');
    expect(output).toContain('related=/workspace/.agents/skills');
    expect(output).toContain('Action: Review and migrate the source.');
    expect(text.stderr).toEqual([]);

    const json = captureIo();
    expect(await executeCommand(commandTree(api), ['agent', 'audit', '--json'], json.io)).toBe(1);
    expect(JSON.parse(json.stdout.join(''))).toEqual({
      schemaVersion: 1,
      command: 'agent audit',
      ok: false,
      data: report,
    });
    expect(json.stderr).toEqual([]);
  });

  it('renders a clean report with empty severity groups', () => {
    expect(formatAgentAuditText(auditReport())).toContain(
      'Agent configuration audit is valid: 0 error(s), 0 warning(s), 0 info finding(s)',
    );
    expect(formatAgentAuditText(auditReport()).match(/\(none\)/g)).toHaveLength(3);
  });

  it('rejects malformed configuration before package delegation with exit 2', async () => {
    let calls = 0;
    const api = {
      auditAgentConfiguration: () => {
        calls++;
        return auditReport();
      },
    };
    const cases = [
      ['--unknown'],
      ['--workspace'],
      ['--workspace', '--source-mode'],
      ['--workspace', 'one', '--workspace', 'two'],
      ['--source-mode', 'invalid'],
      ['--max-instruction-bytes', '-1'],
      ['--max-instruction-bytes', '1.5'],
      ['--max-instruction-bytes', 'many'],
      ['--skills-dir'],
    ];
    for (const args of cases) {
      const captured = captureIo();
      expect(await executeCommand(commandTree(api), ['agent', 'audit', ...args], captured.io)).toBe(
        2,
      );
      expect(captured.stderr.join('')).not.toBe('');
    }
    expect(calls).toBe(0);
  });

  it('delegates to the real read-only API without mutating the repository', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-audit-cli-'));
    temps.push(root);
    const workspace = join(root, 'workspace');
    const userDirectory = join(root, 'home');
    const skill = join(workspace, '.agents', 'skills', 'review');
    mkdirSync(skill, { recursive: true });
    mkdirSync(userDirectory);
    writeFileSync(join(workspace, 'AGENTS.md'), 'Repository instructions.');
    writeFileSync(join(workspace, '.aiignore'), 'private/**\n');
    writeFileSync(
      join(skill, 'SKILL.md'),
      '---\nname: review\ndescription: Review repository changes safely.\n---\nReview instructions.\n',
    );
    const before = repositorySnapshot(root);

    const result = await runAgentAudit(
      [
        '--workspace',
        workspace,
        '--working-directory',
        '.',
        '--user-directory',
        userDirectory,
        '--skills-dir',
        '.agents/skills',
        '--source-mode',
        'replace',
      ],
      { auditAgentConfiguration },
      workspace,
    );

    expect(result).toMatchObject({ exitCode: 0, data: { valid: true, workspace } });
    expect(repositorySnapshot(root)).toEqual(before);
  });

  it('loads ai-utils from the project and reports dependency failures', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'di-framework-cli-agent-audit-'));
    temps.push(cwd);
    const packageDirectory = join(cwd, 'node_modules', '@di-framework', 'ai-utils');
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(join(cwd, 'package.json'), '{"private":true}\n');
    writeFileSync(
      join(packageDirectory, 'package.json'),
      '{"name":"@di-framework/ai-utils","type":"module","exports":"./index.js"}\n',
    );
    writeFileSync(
      join(packageDirectory, 'index.js'),
      `export function auditAgentConfiguration(options) {
  return {
    valid: true,
    workspace: options.workspace,
    workingDirectory: options.workingDirectory,
    instructions: { bytes: 0, sources: [] },
    skills: { sources: [], names: [] },
    suppressedSources: [],
    vendorAssets: [],
    migrationOpportunities: [],
    findings: [],
  };
}
`,
    );
    await expect(runAgentAudit([], undefined, cwd)).resolves.toMatchObject({
      exitCode: 0,
      data: { valid: true, workspace: cwd, workingDirectory: cwd },
    });

    const missing = mkdtempSync(join(tmpdir(), 'di-framework-cli-agent-audit-missing-'));
    temps.push(missing);
    writeFileSync(join(missing, 'package.json'), '{"private":true}\n');
    const captured = captureIo();
    expect(
      await executeCommand(
        commandTree(undefined, missing),
        ['agent', 'audit', '--json'],
        captured.io,
      ),
    ).toBe(3);
    expect(JSON.parse(captured.stdout.join('')).error).toMatchObject({
      code: 'AGENT_AUDIT_PACKAGE_UNAVAILABLE',
      message: 'Unable to load @di-framework/ai-utils from the current project',
    });
  });
});
