import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  auditAgentConfiguration,
  executeAgentConfigurationMigration,
  planAgentConfigurationMigration,
} from '@di-framework/ai-utils';
import {
  type CliIo,
  CommandFailure,
  type CommandNode,
  executeCommand,
} from '@di-framework/cli/command';
import {
  type AgentMigrateOperations,
  parseAgentMigrateArgs,
  runAgentMigrate,
} from '../src/agent/migrate.ts';

const operations: AgentMigrateOperations = {
  auditAgentConfiguration,
  planAgentConfigurationMigration,
  executeAgentConfigurationMigration,
};

interface Fixture {
  readonly root: string;
  readonly workspace: string;
  readonly userDirectory: string;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'agent-migrate-cli-'));
  const workspace = join(root, 'workspace');
  const userDirectory = join(root, 'home');
  mkdirSync(workspace);
  mkdirSync(userDirectory);
  return { root, workspace, userDirectory };
}

function snapshot(root: string): Record<string, string> {
  const values: Record<string, string> = {};
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop();
    if (directory == null) break;
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const path = join(directory, entry.name);
      const name = relative(root, path);
      if (entry.isDirectory()) {
        values[`${name}/`] = 'directory';
        stack.push(path);
      } else {
        values[name] = readFileSync(path, 'utf8');
      }
    }
  }
  return values;
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

function tree(api: AgentMigrateOperations, cwd: string): CommandNode {
  return {
    description: 'root',
    children: {
      agent: {
        description: 'agent',
        children: {
          migrate: {
            description: 'migrate',
            run: ({ args }) => runAgentMigrate(args, api, cwd),
          },
        },
      },
    },
  };
}

describe('agent migrate command', () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true });
  });

  test('plans by default and with --plan without changing any repository file', async () => {
    const value = fixture();
    temps.push(value.root);
    const source = join(value.workspace, 'CLAUDE.md');
    writeFileSync(source, '# Vendor instructions\n');
    const before = snapshot(value.root);
    const sourceMtime = statSync(source).mtimeMs;
    const args = [
      '--workspace',
      value.workspace,
      '--working-directory',
      '.',
      '--user-directory',
      value.userDirectory,
    ];

    const implicit = await runAgentMigrate(args, operations, value.workspace);
    const explicit = await runAgentMigrate(['--plan', ...args], operations, value.workspace);

    expect(implicit).toEqual(explicit);
    expect(implicit.exitCode).toBe(0);
    expect(implicit.data).toMatchObject({
      mode: 'plan',
      audit: { valid: true },
      plan: {
        valid: true,
        actions: [
          {
            status: 'ready',
            operation: 'write-file',
            relativeTargetPath: 'AGENTS.md',
            source: { kind: 'file', path: source },
          },
        ],
      },
    });
    expect(implicit.data).not.toHaveProperty('execution');
    expect(implicit.text).toContain('No files changed (plan mode).');
    expect(snapshot(value.root)).toEqual(before);
    expect(statSync(source).mtimeMs).toBe(sourceMtime);
    expect(existsSync(join(value.workspace, 'AGENTS.md'))).toBe(false);
  });

  test('passes the exact generated plan object to the executor only for --apply', async () => {
    const value = fixture();
    temps.push(value.root);
    const report = auditAgentConfiguration({
      workspace: value.workspace,
      workingDirectory: value.workspace,
      userDirectory: value.userDirectory,
    });
    const plan = planAgentConfigurationMigration(report, {
      includeAuditOpportunities: false,
      requests: [{ target: '.aiignore', content: 'private/' }],
    });
    const execution = executeAgentConfigurationMigration(plan);
    const calls: string[] = [];
    const api: AgentMigrateOperations = {
      auditAgentConfiguration: (options = {}) => {
        calls.push(`audit:${options.workspace}`);
        return report;
      },
      planAgentConfigurationMigration: (received, options = {}) => {
        calls.push(`plan:${options.replaceExisting}:${String(options.opportunityPaths)}`);
        expect(received).toBe(report);
        return plan;
      },
      executeAgentConfigurationMigration: (received, options = {}) => {
        calls.push(`execute:${options.dryRun}`);
        expect(received).toBe(plan);
        expect(options).toEqual({ dryRun: false });
        return execution;
      },
    };

    const result = await runAgentMigrate(
      ['--apply', '--workspace', value.workspace, '--source', 'one', '--replace-existing'],
      api,
      value.workspace,
    );

    expect(calls).toEqual([`audit:${value.workspace}`, 'plan:true:one', 'execute:false']);
    expect(result).toMatchObject({
      exitCode: 0,
      data: { mode: 'apply', plan, execution },
    });
    expect(result.text).toContain('Execution: 0 applied, 1 skipped, 0 failed');
    expect(result.text).toContain('Skipped actions:');
  });

  test('surfaces collisions and partial apply outcomes in stable text and JSON', async () => {
    const value = fixture();
    temps.push(value.root);
    writeFileSync(join(value.workspace, 'CLAUDE.md'), 'vendor instructions');
    writeFileSync(join(value.workspace, 'AGENTS.md'), 'neutral instructions');
    const vendorSkill = join(value.workspace, '.claude', 'skills', 'review');
    mkdirSync(vendorSkill, { recursive: true });
    writeFileSync(join(vendorSkill, 'SKILL.md'), 'skill content');
    const cli = tree(operations, value.workspace);
    const argv = [
      'agent',
      'migrate',
      '--apply',
      '--workspace',
      value.workspace,
      '--user-directory',
      value.userDirectory,
    ];

    const json = captureIo();
    expect(await executeCommand(cli, [...argv, '--json'], json.io)).toBe(1);
    const envelope = JSON.parse(json.stdout.join(''));
    expect(envelope).toMatchObject({
      schemaVersion: 1,
      command: 'agent migrate',
      ok: false,
      data: {
        mode: 'apply',
        plan: { valid: false },
        execution: { success: false, changed: true },
      },
    });
    expect(envelope.data.plan.actions).toContainEqual(
      expect.objectContaining({
        relativeTargetPath: 'AGENTS.md',
        status: 'failed',
        code: 'target-exists',
      }),
    );
    expect(envelope.data.execution.failed).toContainEqual(
      expect.objectContaining({ code: 'target-exists' }),
    );
    expect(envelope.data.execution.applied.length).toBeGreaterThan(0);
    expect(
      readFileSync(join(value.workspace, '.agents', 'skills', 'review', 'SKILL.md'), 'utf8'),
    ).toBe('skill content');
    expect(readFileSync(join(value.workspace, 'AGENTS.md'), 'utf8')).toBe('neutral instructions');

    const text = captureIo();
    expect(await executeCommand(cli, argv, text.io)).toBe(1);
    expect(text.stdout.join('')).toContain('[failed:target-exists]');
    expect(text.stdout.join('')).toContain('applied,');
    expect(text.stdout.join('')).toContain('failed');
  });

  test('maps every option to audit and plan APIs and makes replacement recoverable', async () => {
    const value = fixture();
    temps.push(value.root);
    const target = join(value.workspace, 'AGENTS.md');
    const source = join(value.workspace, 'CLAUDE.md');
    writeFileSync(target, 'old');
    writeFileSync(source, 'new');
    const args = [
      '--apply',
      '--workspace',
      value.workspace,
      '--working-directory',
      'packages/api',
      '--user-directory',
      value.userDirectory,
      '--skills-dir',
      'skills-one',
      '--skills-dir',
      'skills-two',
      '--skills-package',
      'package-one',
      '--source-mode',
      'replace',
      '--instructions-fallback',
      'TEAM.md',
      '--max-instruction-bytes',
      '2048',
      '--source',
      source,
      '--replace-existing',
    ];
    const parsed = parseAgentMigrateArgs(args, value.workspace);
    expect(parsed).toEqual({
      mode: 'apply',
      audit: {
        workspace: value.workspace,
        workingDirectory: join(value.workspace, 'packages', 'api'),
        userDirectory: value.userDirectory,
        directories: ['skills-one', 'skills-two'],
        packages: ['package-one'],
        sourceMode: 'replace',
        fallbackFilenames: ['TEAM.md'],
        maxBytes: 2048,
      },
      opportunityPaths: [source],
      replaceExisting: true,
    });

    const result = await runAgentMigrate(
      [
        '--apply',
        '--workspace',
        value.workspace,
        '--user-directory',
        value.userDirectory,
        '--source',
        source,
        '--replace-existing',
      ],
      operations,
      value.workspace,
    );
    expect(result.exitCode).toBe(0);
    expect(result.data).toMatchObject({
      mode: 'apply',
      plan: {
        actions: [
          expect.objectContaining({
            relativeTargetPath: 'AGENTS.md',
            operation: 'replace-file',
          }),
        ],
      },
    });
    expect(readFileSync(target, 'utf8')).toBe('new');
    expect(readFileSync(`${target}.di-framework-backup`, 'utf8')).toBe('old');
    expect(existsSync(join(value.workspace, '.cursor'))).toBe(false);
    expect(existsSync(join(value.workspace, '.codex'))).toBe(false);
  });

  test('rejects malformed modes and option values before loading package operations', async () => {
    const value = fixture();
    temps.push(value.root);
    const invalid = [
      ['--plan', '--apply'],
      ['--apply', '--apply'],
      ['--replace-existing', '--replace-existing'],
      ['--workspace'],
      ['--workspace', '--apply'],
      ['--workspace', 'one', '--workspace', 'two'],
      ['--source-mode', 'invalid'],
      ['--max-instruction-bytes', '-1'],
      ['--max-instruction-bytes', '1.5'],
      ['--unknown'],
      ['positional'],
    ];
    for (const args of invalid) {
      expect(() => parseAgentMigrateArgs(args, value.workspace)).toThrow(CommandFailure);
    }
  });

  test('reports package loading failures and leaves unexpected package errors to the shared layer', async () => {
    const value = fixture();
    temps.push(value.root);
    await expect(runAgentMigrate([], undefined, value.workspace)).rejects.toMatchObject({
      code: 'AGENT_MIGRATE_PACKAGE_UNAVAILABLE',
      exitCode: 3,
    });

    const api: AgentMigrateOperations = {
      ...operations,
      auditAgentConfiguration: () => {
        throw new Error('unexpected audit failure');
      },
    };
    await expect(runAgentMigrate([], api, value.workspace)).rejects.toThrow(
      'unexpected audit failure',
    );
  });
});
