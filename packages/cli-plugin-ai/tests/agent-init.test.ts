import { describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  auditAgentConfiguration,
  executeAgentConfigurationMigration,
  planAgentConfigurationMigration,
} from '@di-framework/ai-utils';
import { type CliIo, type CommandNode, executeCommand } from '@di-framework/cli/command';
import { type AgentInitOperations, runAgentInit } from '../src/agent/init.ts';

const operations: AgentInitOperations = {
  auditAgentConfiguration,
  planAgentConfigurationMigration,
  executeAgentConfigurationMigration,
};

function tempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'agent-init-'));
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

function tree(api: AgentInitOperations | undefined, cwd: string): CommandNode {
  return {
    description: 'root',
    children: {
      agent: {
        description: 'agent',
        children: {
          init: {
            description: 'init',
            run: ({ args }) => runAgentInit(args, api, cwd),
          },
        },
      },
    },
  };
}

describe('agent init command', () => {
  it('delegates audit, planning, and dry-run execution to typed package APIs', async () => {
    const workspace = tempWorkspace();
    const calls: Array<[string, unknown]> = [];
    const api: AgentInitOperations = {
      auditAgentConfiguration: (options = {}) => {
        calls.push(['audit', options]);
        return auditAgentConfiguration(options);
      },
      planAgentConfigurationMigration: (report, options = {}) => {
        calls.push(['plan', options]);
        return planAgentConfigurationMigration(report, options);
      },
      executeAgentConfigurationMigration: (plan, options = {}) => {
        calls.push(['execute', options]);
        return executeAgentConfigurationMigration(plan, options);
      },
    };

    const result = await runAgentInit(['--workspace', '.'], api, workspace);

    expect(calls).toEqual([
      ['audit', { workspace, workingDirectory: workspace, sourceMode: 'replace' }],
      [
        'plan',
        {
          includeAuditOpportunities: false,
          requests: [
            { target: 'AGENTS.md', content: '# Repository instructions\n' },
            {
              target: '.agents/AGENTS.md',
              content: '# Agent configuration instructions\n',
            },
            { target: '.agents/skills' },
            { target: '.aiignore', content: '# Add paths that AI tools must ignore.\n' },
          ],
        },
      ],
      ['execute', { dryRun: true }],
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.data).toMatchObject({
      plan: { valid: true, actions: expect.any(Array) },
      execution: { dryRun: true, success: true, changed: false },
    });
    expect(result.text?.indexOf('Plan:')).toBeLessThan(result.text?.indexOf('Execution:') ?? 0);
    expect(readdirSync(workspace)).toEqual([]);
  });

  it('supports selected assets and applies the exact plan without vendor paths', async () => {
    const workspace = tempWorkspace();
    mkdirSync(join(workspace, '.claude', 'skills', 'vendor'), { recursive: true });
    writeFileSync(join(workspace, 'CLAUDE.md'), 'Vendor instructions.');
    writeFileSync(join(workspace, '.claude', 'skills', 'vendor', 'SKILL.md'), 'vendor');

    const result = await runAgentInit(
      ['--asset', 'AGENTS.md', '--asset', '.agents/skills', '--apply'],
      operations,
      workspace,
    );

    expect(result.exitCode).toBe(0);
    const data = result.data as {
      plan: { valid: boolean; actions: Array<{ asset: string; operation: string }> };
      execution: { dryRun: boolean; success: boolean; changed: boolean };
    };
    expect(data.plan.valid).toBe(true);
    expect(data.plan.actions).toHaveLength(2);
    expect(data.plan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ asset: 'AGENTS.md', operation: 'write-file' }),
        expect.objectContaining({ asset: '.agents/skills', operation: 'create-directory' }),
      ]),
    );
    expect(data).toMatchObject({
      execution: { dryRun: false, success: true, changed: true },
    });
    expect(readFileSync(join(workspace, 'AGENTS.md'), 'utf8')).toBe('# Repository instructions\n');
    expect(existsSync(join(workspace, '.agents', 'skills'))).toBe(true);
    expect(existsSync(join(workspace, '.agents', 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(workspace, '.aiignore'))).toBe(false);
    expect(existsSync(join(workspace, '.codex'))).toBe(false);
    expect(existsSync(join(workspace, '.cursor'))).toBe(false);
    expect(readFileSync(join(workspace, 'CLAUDE.md'), 'utf8')).toBe('Vendor instructions.');
  });

  it('reports collisions in text and JSON and never overwrites existing files', async () => {
    const workspace = tempWorkspace();
    const existing = 'Keep these instructions.\n';
    writeFileSync(join(workspace, 'AGENTS.md'), existing);
    const command = tree(operations, workspace);

    const text = captureIo();
    expect(
      await executeCommand(command, ['agent', 'init', '--asset', 'AGENTS.md', '--apply'], text.io),
    ).toBe(1);
    expect(text.stdout.join('')).toContain('[failed:target-exists]');
    expect(text.stdout.join('').indexOf('Plan:')).toBeLessThan(
      text.stdout.join('').indexOf('Execution:'),
    );
    expect(readFileSync(join(workspace, 'AGENTS.md'), 'utf8')).toBe(existing);

    const json = captureIo();
    expect(
      await executeCommand(
        command,
        ['agent', 'init', '--asset', 'AGENTS.md', '--apply', '--json'],
        json.io,
      ),
    ).toBe(1);
    expect(JSON.parse(json.stdout.join(''))).toMatchObject({
      schemaVersion: 1,
      command: 'agent init',
      ok: false,
      data: {
        plan: { valid: false, actions: [{ code: 'target-exists', status: 'failed' }] },
        execution: { success: false, failed: [{ code: 'target-exists' }] },
      },
    });
    expect(json.stderr).toEqual([]);
    expect(readFileSync(join(workspace, 'AGENTS.md'), 'utf8')).toBe(existing);
  });

  it('rejects non-neutral paths and contradictory modes before calling package APIs', async () => {
    const workspace = tempWorkspace();
    let calls = 0;
    const api = new Proxy(operations, {
      get(target, key, receiver) {
        calls++;
        return Reflect.get(target, key, receiver);
      },
    });
    for (const args of [
      ['--asset', '.claude/skills'],
      ['--asset'],
      ['--apply', '--dry-run'],
      ['--workspace', '.', '--workspace', '.'],
      ['--unknown'],
    ]) {
      const captured = captureIo();
      expect(
        await executeCommand(tree(api, workspace), ['agent', 'init', ...args], captured.io),
      ).toBe(2);
      expect(captured.stderr.join('')).not.toBe('');
    }
    expect(calls).toBe(0);
    expect(readdirSync(workspace)).toEqual([]);
  });

  it('returns a stable dependency failure when the project package is unavailable', async () => {
    const workspace = tempWorkspace();
    const json = captureIo();
    expect(
      await executeCommand(tree(undefined, workspace), ['agent', 'init', '--json'], json.io),
    ).toBe(3);
    expect(JSON.parse(json.stdout.join(''))).toMatchObject({
      schemaVersion: 1,
      command: 'agent init',
      ok: false,
      error: { code: 'AGENT_INIT_PACKAGE_UNAVAILABLE' },
    });
  });
});
