import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ResolveSkillSourcesOptions,
  SkillCatalogDiagnostic,
  SkillValidationResult,
} from '@di-framework/ai-utils';
import { type CliIo, type CommandNode, executeCommand } from '@di-framework/cli/command';
import {
  formatSkillsValidation,
  parseSkillsValidateArgs,
  runSkillsValidate,
  type SkillsValidateOperations,
} from '../src/skills/validate.ts';

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

function validationResult(
  valid: boolean,
  diagnostics: readonly SkillCatalogDiagnostic[] = [],
): SkillValidationResult {
  return {
    valid,
    skills: [
      {
        name: 'reviewer',
        description: 'Reviews code.',
        basePath: '/workspace/.agents/skills/reviewer',
        frontMatter: { name: 'reviewer', description: 'Reviews code.' },
        yaml: { name: 'reviewer', description: 'Reviews code.' },
        source: 'PRIVATE SKILL BODY',
        content: 'PRIVATE SKILL BODY',
      },
    ],
    diagnostics,
  };
}

function operations(
  validateSkillCatalog: SkillsValidateOperations['validateSkillCatalog'],
): SkillsValidateOperations {
  return { validateSkillCatalog };
}

function commandTree(api?: SkillsValidateOperations, cwd = '/workspace'): CommandNode {
  return {
    description: 'root',
    children: {
      skills: {
        description: 'skills',
        children: {
          validate: {
            description: 'validate',
            run: ({ args }) => runSkillsValidate(args, api, cwd),
          },
        },
      },
    },
  };
}

describe('skills validate command', () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true });
  });

  it('uses the current workspace and neutral merge defaults without explicit sources', () => {
    expect(parseSkillsValidateArgs([], '/workspace')).toEqual({
      workspace: '/workspace',
      userDirectory: undefined,
      directories: undefined,
      packages: undefined,
      sourceMode: undefined,
    });
  });

  it('delegates explicit source configuration directly to validateSkillCatalog', async () => {
    const calls: ResolveSkillSourcesOptions[] = [];
    const api = operations((options = {}) => {
      calls.push(options);
      return validationResult(true);
    });

    const result = await runSkillsValidate(
      [
        '--workspace',
        '/repo',
        '--user-directory',
        '/users/test',
        '--skills-dir',
        'first',
        '--skills-dir',
        'second',
        '--skills-package',
        '@example/skills',
        '--skills-package',
        './local-package',
        '--source-mode',
        'replace',
      ],
      api,
      '/workspace',
    );

    expect(calls).toEqual([
      {
        workspace: '/repo',
        userDirectory: '/users/test',
        directories: ['first', 'second'],
        packages: ['@example/skills', './local-package'],
        sourceMode: 'replace',
      },
    ]);
    expect(result).toMatchObject({ exitCode: 0, data: { valid: true, skillCount: 1 } });
  });

  it('renders typed diagnostics in human and stable JSON forms without skill bodies', async () => {
    const diagnostic: SkillCatalogDiagnostic = {
      code: 'skill-name-invalid',
      severity: 'error',
      message: 'name must use lowercase kebab-case',
      path: '/workspace/.agents/skills/Bad/SKILL.md',
      skillName: 'Bad',
      source: {
        path: '/workspace/.agents/skills',
        origin: 'workspace',
        precedence: 0,
      },
      relatedPath: '/workspace/.agents/skills/Bad',
    };
    const api = operations(() => validationResult(false, [diagnostic]));

    const text = captureIo();
    expect(await executeCommand(commandTree(api), ['skills', 'validate'], text.io)).toBe(1);
    expect(text.stdout.join('')).toContain('Skill catalog is invalid: 1 skill(s), 1 diagnostic(s)');
    expect(text.stdout.join('')).toContain(
      '[ERROR skill-name-invalid] /workspace/.agents/skills/Bad/SKILL.md',
    );
    expect(text.stdout.join('')).toContain('(related: /workspace/.agents/skills/Bad)');
    expect(text.stdout.join('')).not.toContain('PRIVATE SKILL BODY');
    expect(text.stderr).toEqual([]);

    const json = captureIo();
    expect(await executeCommand(commandTree(api), ['skills', 'validate', '--json'], json.io)).toBe(
      1,
    );
    expect(JSON.parse(json.stdout.join(''))).toEqual({
      schemaVersion: 1,
      command: 'skills validate',
      ok: false,
      data: { valid: false, skillCount: 1, diagnostics: [diagnostic] },
    });
    expect(json.stdout.join('')).not.toContain('PRIVATE SKILL BODY');
    expect(json.stderr).toEqual([]);
  });

  it('formats valid results and diagnostics without related paths', () => {
    expect(formatSkillsValidation({ valid: true, skillCount: 2, diagnostics: [] })).toBe(
      'Skill catalog is valid: 2 skill(s), 0 diagnostic(s)',
    );
    expect(
      formatSkillsValidation({
        valid: true,
        skillCount: 1,
        diagnostics: [
          {
            code: 'skill-shadowed',
            severity: 'warning',
            message: 'lower source is shadowed',
            path: '/workspace/lower/SKILL.md',
            source: { path: '/workspace/lower' },
          },
        ],
      }),
    ).toContain('[WARNING skill-shadowed] /workspace/lower/SKILL.md: lower source is shadowed');
  });

  it('rejects malformed configuration before package delegation with exit 2', async () => {
    let calls = 0;
    const api = operations(() => {
      calls++;
      return validationResult(true);
    });
    const cases = [
      ['--workspace'],
      ['--workspace', '/one', '--workspace', '/two'],
      ['--user-directory', '/one', '--user-directory', '/two'],
      ['--source-mode', 'merge', '--source-mode', 'replace'],
      ['--source-mode', 'invalid'],
      ['--unknown'],
    ];
    for (const args of cases) {
      const captured = captureIo();
      expect(
        await executeCommand(commandTree(api), ['skills', 'validate', ...args], captured.io),
      ).toBe(2);
      expect(JSON.stringify(captured.stderr)).not.toBe('[]');
    }
    expect(calls).toBe(0);

    const captured = captureIo();
    expect(
      await executeCommand(
        commandTree(api),
        ['skills', 'validate', '--source-mode', 'invalid', '--json'],
        captured.io,
      ),
    ).toBe(2);
    expect(JSON.parse(captured.stdout.join('')).error).toEqual({
      code: 'INVALID_USAGE',
      message: 'Invalid value for --source-mode: invalid',
      details: { token: '--source-mode', value: 'invalid' },
    });
  });

  it('loads ai-utils from the current project and reports dependency failures', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'di-framework-cli-skills-validate-'));
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
      `export function validateSkillCatalog(options) {
  return { valid: true, skills: [], diagnostics: options.workspace ? [] : ['missing workspace'] };
}
`,
    );
    await expect(runSkillsValidate([], undefined, cwd)).resolves.toMatchObject({
      exitCode: 0,
      data: { valid: true, skillCount: 0, diagnostics: [] },
    });

    const missing = mkdtempSync(join(tmpdir(), 'di-framework-cli-no-ai-utils-'));
    temps.push(missing);
    writeFileSync(join(missing, 'package.json'), '{"private":true}\n');
    const captured = captureIo();
    expect(
      await executeCommand(
        commandTree(undefined, missing),
        ['skills', 'validate', '--json'],
        captured.io,
      ),
    ).toBe(3);
    expect(JSON.parse(captured.stdout.join('')).error).toMatchObject({
      code: 'SKILLS_PACKAGE_UNAVAILABLE',
      message: 'Unable to load @di-framework/ai-utils from the current project',
    });
  });
});
