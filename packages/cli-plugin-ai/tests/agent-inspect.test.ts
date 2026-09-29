import { describe, expect, it } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AiIgnorePolicyError,
  discoverAgentInstructions,
  loadAiIgnorePolicy,
  resolveSkillSources,
  validateResolvedSkillCatalog,
} from '@di-framework/ai-utils';
import { type CliIo, type CommandNode, executeCommand } from '@di-framework/cli/command';
import { type AgentInspectOperations, runAgentInspect } from '../src/agent/inspect.ts';

const operations: AgentInspectOperations = {
  resolveSkillSources,
  discoverAgentInstructions,
  loadAiIgnorePolicy,
  validateResolvedSkillCatalog,
  AiIgnorePolicyError,
};

function tempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'agent-inspect-'));
}

function writeSkill(root: string, name: string, description: string): void {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nInstructions for ${name}.\n`,
  );
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

function tree(api: AgentInspectOperations, cwd: string): CommandNode {
  return {
    description: 'root',
    children: {
      agent: {
        description: 'agent',
        children: {
          inspect: {
            description: 'inspect',
            run: ({ args }) => runAgentInspect(args, api, cwd),
          },
        },
      },
    },
  };
}

describe('agent inspect command', () => {
  it('reports a clean configuration from package APIs without changing files', async () => {
    const workspace = tempWorkspace();
    const skills = join(workspace, '.agents', 'skills');
    mkdirSync(skills, { recursive: true });
    writeSkill(skills, 'review', 'Reviews code safely.');
    writeFileSync(join(workspace, 'AGENTS.md'), 'Repository instructions.');
    writeFileSync(join(workspace, '.aiignore'), 'secrets/**\n!secrets/example.txt\n');
    const paths = readdirSync(workspace, { recursive: true }).map(String).sort();
    const watched = ['AGENTS.md', '.aiignore', '.agents/skills/review/SKILL.md'];
    const contents = watched.map((path) => readFileSync(join(workspace, path), 'utf8'));
    const mtimes = watched.map((path) => statSync(join(workspace, path)).mtimeMs);

    const calls: string[] = [];
    const api: AgentInspectOperations = {
      ...operations,
      resolveSkillSources: (options = {}) => {
        calls.push('skills');
        return resolveSkillSources(options);
      },
      validateResolvedSkillCatalog: (sources) => {
        calls.push('catalog');
        return validateResolvedSkillCatalog(sources);
      },
      discoverAgentInstructions: (options = {}) => {
        calls.push('instructions');
        return discoverAgentInstructions(options);
      },
      loadAiIgnorePolicy: (options) => {
        calls.push('aiignore');
        return loadAiIgnorePolicy(options);
      },
    };
    const result = await runAgentInspect(
      [
        '--workspace',
        workspace,
        '--working-directory',
        '.',
        '--user-directory',
        join(workspace, 'user'),
        '--skills-dir',
        '.agents/skills',
        '--source-mode',
        'replace',
        '--max-instruction-bytes',
        '1024',
      ],
      api,
      workspace,
    );

    expect(calls).toEqual(['skills', 'catalog', 'instructions', 'aiignore']);
    expect(result.data).toMatchObject({
      workspace,
      workingDirectory: workspace,
      skillRoots: [{ path: skills, origin: 'explicit', precedence: 0 }],
      instructionFiles: [{ path: join(workspace, 'AGENTS.md'), precedence: 0 }],
      aiignore: {
        source: { path: join(workspace, '.aiignore'), exists: true },
        rules: [
          { line: 1, pattern: 'secrets/**', negated: false },
          { line: 2, pattern: 'secrets/example.txt', negated: true },
        ],
      },
      suppressedSources: [],
      shadowedSkills: [],
    });
    expect(result.text).toContain('Skill roots (highest precedence first):');
    expect(result.text).toContain('Instruction files (broad to specific):');
    expect(result.text).toContain('.aiignore:');
    expect(readdirSync(workspace, { recursive: true }).map(String).sort()).toEqual(paths);
    expect(watched.map((path) => readFileSync(join(workspace, path), 'utf8'))).toEqual(contents);
    expect(watched.map((path) => statSync(join(workspace, path)).mtimeMs)).toEqual(mtimes);
  });

  it('identifies suppressed sources and lower-precedence shadowed skills in text and JSON', async () => {
    const workspace = tempWorkspace();
    const explicit = join(workspace, 'explicit');
    const neutral = join(workspace, '.agents', 'skills');
    const working = join(workspace, 'packages', 'api');
    mkdirSync(working, { recursive: true });
    writeSkill(explicit, 'review', 'Explicit review policy.');
    writeSkill(neutral, 'review', 'Neutral review policy.');
    writeFileSync(join(workspace, 'AGENTS.md'), 'Root policy.');
    writeFileSync(join(workspace, '.aiignore'), 'private/**\n');

    const args = [
      '--workspace',
      workspace,
      '--working-directory',
      'packages/api',
      '--user-directory',
      join(workspace, 'missing-user'),
      '--skills-dir',
      explicit,
      '--skills-dir',
      explicit,
      '--source-mode',
      'merge',
    ];
    const text = captureIo();
    expect(
      await executeCommand(tree(operations, workspace), ['agent', 'inspect', ...args], text.io),
    ).toBe(0);
    expect(text.stdout.join('')).toContain('[skills:source-duplicate]');
    expect(text.stdout.join('')).toContain('review ->');

    const json = captureIo();
    expect(
      await executeCommand(
        tree(operations, workspace),
        ['agent', 'inspect', ...args, '--json'],
        json.io,
      ),
    ).toBe(0);
    const envelope = JSON.parse(json.stdout.join(''));
    expect(envelope).toMatchObject({
      schemaVersion: 1,
      command: 'agent inspect',
      ok: true,
      data: {
        aiignore: { source: { exists: true }, rules: [{ pattern: 'private/**' }] },
      },
    });
    expect(envelope.data.suppressedSources).toContainEqual(
      expect.objectContaining({ scope: 'skills', code: 'source-duplicate', path: explicit }),
    );
    expect(envelope.data.shadowedSkills).toContainEqual(
      expect.objectContaining({
        code: 'skill-shadowed',
        skillName: 'review',
        path: join(neutral, 'review'),
        relatedPath: join(explicit, 'review'),
      }),
    );
    expect(envelope.data.instructionFiles).toEqual([
      expect.objectContaining({ path: join(workspace, 'AGENTS.md'), precedence: 0 }),
    ]);
    expect(envelope.data).not.toHaveProperty('content');
    expect(envelope.data.instructionFiles[0]).not.toHaveProperty('content');
  });

  it('maps every option directly to typed package calls and renders empty sections', async () => {
    const calls: Record<string, unknown> = {};
    const workspace = tempWorkspace();
    const api: AgentInspectOperations = {
      resolveSkillSources: (options = {}) => {
        calls.skills = options;
        return { directories: [], sources: [], diagnostics: [] };
      },
      validateResolvedSkillCatalog: (sources) => {
        calls.catalog = sources;
        return { valid: true, skills: [], diagnostics: [] };
      },
      discoverAgentInstructions: (options = {}) => {
        calls.instructions = options;
        return { content: '', bytes: 0, sources: [], diagnostics: [] };
      },
      loadAiIgnorePolicy: (options) => {
        calls.aiignore = options;
        const source = {
          path: join(workspace, '.aiignore'),
          workspace,
          realWorkspace: workspace,
          exists: false,
        };
        return { source, rules: [] };
      },
      AiIgnorePolicyError,
    };
    const result = await runAgentInspect(
      [
        '--workspace',
        workspace,
        '--working-directory',
        'src',
        '--user-directory',
        'user',
        '--skills-dir',
        'one',
        '--skills-dir',
        'two',
        '--skills-package',
        'pkg-a',
        '--skills-package',
        'pkg-b',
        '--source-mode',
        'replace',
        '--instructions-fallback',
        'RULES.md',
        '--instructions-fallback',
        'POLICY.md',
        '--max-instruction-bytes',
        '42',
      ],
      api,
      workspace,
    );
    expect(calls.skills).toEqual({
      workspace,
      userDirectory: join(workspace, 'user'),
      directories: ['one', 'two'],
      packages: ['pkg-a', 'pkg-b'],
      sourceMode: 'replace',
    });
    expect(calls.instructions).toEqual({
      workspace,
      workingDirectory: join(workspace, 'src'),
      fallbackFilenames: ['RULES.md', 'POLICY.md'],
      maxBytes: 42,
    });
    expect(calls.aiignore).toEqual({ workspace });
    expect(result.text).toContain('Skill roots (highest precedence first):\n  (none)');
    expect(result.text).toContain('Shadowed skills:\n  (none)');
    expect(result.text).toContain('.aiignore: not present (0 rules)');
  });

  it('rejects malformed arguments before loading package operations', async () => {
    const invalid = [
      ['positional'],
      ['--workspace'],
      ['--workspace', 'one', '--workspace', 'two'],
      ['--source-mode', 'invalid'],
      ['--max-instruction-bytes', '-1'],
      ['--max-instruction-bytes', 'nope'],
    ];
    for (const args of invalid) {
      await expect(runAgentInspect(args, operations)).rejects.toMatchObject({
        code: 'INVALID_USAGE',
        exitCode: 2,
      });
    }
  });

  it('maps typed policy and package-loading failures without translating unexpected errors', async () => {
    const missing = join(tempWorkspace(), 'missing');
    await expect(
      runAgentInspect(['--workspace', missing], operations, missing),
    ).rejects.toMatchObject({ code: 'AGENT_INSPECT_WORKSPACE_UNAVAILABLE', exitCode: 2 });

    const project = tempWorkspace();
    writeFileSync(join(project, 'package.json'), '{"name":"fixture"}\n');
    await expect(runAgentInspect([], undefined, project)).rejects.toMatchObject({
      code: 'AGENT_INSPECT_PACKAGE_UNAVAILABLE',
      exitCode: 3,
    });

    const unexpected: AgentInspectOperations = {
      ...operations,
      resolveSkillSources: () => {
        throw new Error('unexpected');
      },
    };
    await expect(runAgentInspect([], unexpected, project)).rejects.toThrow('unexpected');
  });
});
