import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  BuildSkillsIndexOptions,
  InspectSkillsIndexOptions,
  MigrateSkillsIndexOptions,
  QuerySkillsIndexOptions,
  ValidateSkillsIndexOptions,
} from '@di-framework/ai-utils';
import { SkillsIndexOperationError } from '@di-framework/ai-utils';
import { type CliIo, type CommandNode, executeCommand } from '@di-framework/cli/command';
import {
  runSkillsIndexBuild,
  runSkillsIndexCommand,
  runSkillsIndexInspect,
  runSkillsIndexMigrate,
  runSkillsIndexQuery,
  runSkillsIndexValidate,
  type SkillsIndexCommand,
  type SkillsIndexOperations,
} from '../src/skills/index.ts';

const metadata = {
  kind: '@di-framework/ai-utils/skills-index' as const,
  version: 3 as const,
  indexed: true,
  skillCount: 2,
  chunkCount: 4,
  threshold: 1,
  retrievalLimit: 10,
  chunkTokens: 256,
  chunkOverlapTokens: 32,
  scoring: 'hybrid-rrf-bm25-v1' as const,
  vectorEncoding: 'int8-per-vector-v1' as const,
  catalogHash: 'hash',
};

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

function operations(overrides: Partial<SkillsIndexOperations> = {}): SkillsIndexOperations {
  return {
    buildSkillsIndex: async () => ({
      outputFile: '/workspace/index.json',
      indexed: true,
      skillCount: 2,
      chunkCount: 4,
      dimensions: 2,
    }),
    inspectSkillsIndex: () => ({
      file: '/workspace/index.json',
      metadata,
      manifestBytes: 100,
      vectorBytes: 8,
      lexicalTerms: 3,
      loadMs: 1,
      rssBytes: 2,
    }),
    validateSkillsIndex: () => ({
      file: '/workspace/index.json',
      integrity: 'valid',
      sourceDrift: null,
      valid: true,
      ready: true,
      loadMs: 1,
    }),
    querySkillsIndex: async () => ({
      file: '/workspace/index.json',
      decision: 'selected',
      matches: [
        {
          name: 'reviewer',
          description: 'Reviews code.',
          score: 0.9,
          matchedChunk: 0,
          matchedSource: 'document',
        },
      ],
      timings: { loadMs: 1, embedMs: 2, searchMs: 3, totalMs: 6 },
      rssBytes: 4,
    }),
    migrateSkillsIndex: () => ({
      inputFile: '/workspace/old.json',
      outputFile: '/workspace/current.json',
      fromVersion: 2,
      toVersion: 3,
      loadMs: 1,
    }),
    SkillsIndexOperationError,
    ...overrides,
  };
}

function commandTree(
  command: SkillsIndexCommand,
  api?: SkillsIndexOperations,
  cwd = '/workspace',
): CommandNode {
  return {
    description: 'root',
    children: {
      skills: {
        description: 'skills',
        children: {
          index: {
            description: 'index',
            children: {
              [command]: {
                description: command,
                run: ({ args }) => runSkillsIndexCommand(command, args, api, cwd),
              },
            },
          },
        },
      },
    },
  };
}

describe('skills index CLI commands', () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true });
  });

  it('maps every build argument directly to BuildSkillsIndexOptions', async () => {
    const calls: BuildSkillsIndexOptions[] = [];
    const api = operations({
      buildSkillsIndex: async (options: BuildSkillsIndexOptions = {}) => {
        calls.push(options);
        return {
          outputFile: '/workspace/index.json',
          indexed: true,
          skillCount: 2,
          chunkCount: 4,
          unchanged: true,
        };
      },
    });
    const result = await runSkillsIndexCommand(
      'build',
      [
        '--skills-dir',
        'skills-a',
        '--skills-dir',
        'skills-b',
        '--skill-file',
        'one/SKILL.md',
        '--output',
        'index.json',
        '--threshold',
        '5',
        '--limit',
        '7',
        '--batch-size',
        '8',
        '--chunk-tokens',
        '128',
        '--chunk-overlap',
        '16',
        '--force',
      ],
      api,
    );
    expect(calls).toEqual([
      {
        directories: ['skills-a', 'skills-b'],
        files: ['one/SKILL.md'],
        outputFile: 'index.json',
        threshold: 5,
        retrievalLimit: 7,
        batchSize: 8,
        chunkTokens: 128,
        chunkOverlapTokens: 16,
        force: true,
      },
    ]);
    expect(result.text).toContain('(unchanged)');
  });

  it('maps inspect, validate, query, and migrate arguments to their typed options', async () => {
    const inspectCalls: InspectSkillsIndexOptions[] = [];
    const validateCalls: ValidateSkillsIndexOptions[] = [];
    const queryCalls: QuerySkillsIndexOptions[] = [];
    const migrateCalls: MigrateSkillsIndexOptions[] = [];
    const api = operations({
      inspectSkillsIndex: (options: InspectSkillsIndexOptions = {}) => {
        inspectCalls.push(options);
        return operations().inspectSkillsIndex(options);
      },
      validateSkillsIndex: (options: ValidateSkillsIndexOptions = {}) => {
        validateCalls.push(options);
        return operations().validateSkillsIndex(options);
      },
      querySkillsIndex: async (options: QuerySkillsIndexOptions) => {
        queryCalls.push(options);
        return operations().querySkillsIndex(options);
      },
      migrateSkillsIndex: (options: MigrateSkillsIndexOptions = {}) => {
        migrateCalls.push(options);
        return operations().migrateSkillsIndex(options);
      },
    });

    await runSkillsIndexCommand('inspect', ['--input', 'index.json'], api, '/workspace');
    await runSkillsIndexCommand(
      'validate',
      [
        '--input',
        'index.json',
        '--skills-dir',
        'skills',
        '--skill-file',
        'one/SKILL.md',
        '--allow-extra-skills',
      ],
      api,
      '/workspace',
    );
    await runSkillsIndexCommand(
      'query',
      [
        '--input',
        'index.json',
        '--query',
        'review code',
        '--limit',
        '3',
        '--min-score',
        '0.2',
        '--abstention-threshold',
        '0.4',
      ],
      api,
      '/workspace',
    );
    await runSkillsIndexCommand(
      'migrate',
      ['--input', 'old.json', '--output', 'new.json'],
      api,
      '/workspace',
    );

    expect(inspectCalls).toEqual([{ inputFile: 'index.json', cwd: '/workspace' }]);
    expect(validateCalls).toEqual([
      {
        inputFile: 'index.json',
        directories: ['skills'],
        files: ['one/SKILL.md'],
        allowExtraSkills: true,
        cwd: '/workspace',
      },
    ]);
    expect(queryCalls).toEqual([
      {
        inputFile: 'index.json',
        query: 'review code',
        limit: 3,
        minScore: 0.2,
        abstentionThreshold: 0.4,
        cwd: '/workspace',
      },
    ]);
    expect(migrateCalls).toEqual([
      { inputFile: 'old.json', outputFile: 'new.json', cwd: '/workspace' },
    ]);
  });

  it('renders typed package results through unified text and JSON envelopes', async () => {
    const api = operations();
    const text = captureIo();
    expect(
      await executeCommand(
        commandTree('query', api),
        ['skills', 'index', 'query', '--query', 'review'],
        text.io,
      ),
    ).toBe(0);
    expect(text.stdout.join('')).toBe('Selected 1 skill match(es) from /workspace/index.json\n');
    expect(text.stderr).toEqual([]);

    const json = captureIo();
    expect(
      await executeCommand(
        commandTree('inspect', api),
        ['skills', 'index', 'inspect', '--json'],
        json.io,
      ),
    ).toBe(0);
    expect(JSON.parse(json.stdout.join(''))).toMatchObject({
      schemaVersion: 1,
      command: 'skills index inspect',
      ok: true,
      data: { file: '/workspace/index.json', metadata: { version: 3, skillCount: 2 } },
    });
    expect(json.stderr).toEqual([]);
  });

  it('derives negative domain exits from validation drift and query abstention', async () => {
    const drift = operations({
      validateSkillsIndex: () => ({
        file: '/workspace/index.json',
        integrity: 'valid',
        sourceDrift: 'catalog is stale',
        valid: false,
        ready: true,
        loadMs: 1,
      }),
      querySkillsIndex: async () => ({
        file: '/workspace/index.json',
        decision: 'abstained',
        matches: [],
        timings: { loadMs: 1, embedMs: 1, searchMs: 1, totalMs: 3 },
        rssBytes: 0,
      }),
    });
    const validation = await runSkillsIndexCommand('validate', [], drift);
    expect(validation).toMatchObject({ exitCode: 1 });
    expect(validation.text).toContain('catalog is stale');
    const query = await runSkillsIndexCommand('query', ['--query', 'nothing'], drift);
    expect(query).toMatchObject({ exitCode: 1 });
    expect(query.text).toContain('No skill matches selected');

    const unknownDrift = operations({
      validateSkillsIndex: () => ({
        file: '/workspace/index.json',
        integrity: 'valid',
        sourceDrift: null,
        valid: false,
        ready: true,
        loadMs: 1,
      }),
    });
    expect((await runSkillsIndexCommand('validate', [], unknownDrift)).text).toContain(
      'unknown drift',
    );
  });

  it('rejects unknown, missing, and duplicate options before delegation', async () => {
    const api = operations();
    await expect(runSkillsIndexCommand('inspect', ['extra'], api)).rejects.toMatchObject({
      code: 'INVALID_USAGE',
      exitCode: 2,
    });
    await expect(runSkillsIndexCommand('inspect', ['--input'], api)).rejects.toThrow(
      'Missing value',
    );
    await expect(
      runSkillsIndexCommand('inspect', ['--input', 'one', '--input', 'two'], api),
    ).rejects.toThrow('only once');
    await expect(runSkillsIndexCommand('build', ['--force', '--force'], api)).rejects.toThrow(
      'only once',
    );
  });

  it('maps every typed operation error family to stable CLI codes and exits', async () => {
    const cases = [
      ['SOURCE_DRIFT', 1],
      ['INVALID_OPTIONS', 2],
      ['SOURCE_NOT_FOUND', 2],
      ['INDEX_NOT_FOUND', 2],
      ['INVALID_INDEX', 2],
      ['EMBEDDING_FAILED', 3],
      ['WRITE_FAILED', 3],
      ['OPERATION_FAILED', 3],
    ] as const;
    for (const [code, exitCode] of cases) {
      const api = operations({
        inspectSkillsIndex: () => {
          throw new SkillsIndexOperationError('inspect', code, `failed: ${code}`);
        },
      });
      const captured = captureIo();
      expect(
        await executeCommand(
          commandTree('inspect', api),
          ['skills', 'index', 'inspect', '--json'],
          captured.io,
        ),
      ).toBe(exitCode);
      expect(JSON.parse(captured.stdout.join('')).error).toEqual({
        code: `SKILLS_INDEX_${code}`,
        message: `failed: ${code}`,
        details: { operation: 'inspect', operationCode: code },
      });
    }
  });

  it('uses all five focused default leaf adapters', async () => {
    const api = operations();
    await expect(runSkillsIndexBuild([], api)).resolves.toBeDefined();
    await expect(runSkillsIndexInspect([], api)).resolves.toBeDefined();
    await expect(runSkillsIndexValidate([], api)).resolves.toBeDefined();
    await expect(runSkillsIndexQuery(['--query', 'review'], api)).resolves.toBeDefined();
    await expect(runSkillsIndexMigrate([], api)).resolves.toBeDefined();
  });

  it('loads ai-utils from the current project and reports an unavailable package', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'di-framework-cli-skills-project-'));
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
      `export class SkillsIndexOperationError extends Error {}
export function inspectSkillsIndex() {
  return {
    file: 'fixture.json',
    metadata: { version: 3, skillCount: 0, chunkCount: 0 },
    manifestBytes: 1, vectorBytes: 0, lexicalTerms: 0, loadMs: 0, rssBytes: 0,
  };
}
export async function buildSkillsIndex() {}
export function validateSkillsIndex() {}
export async function querySkillsIndex() {}
export function migrateSkillsIndex() {}
`,
    );
    await expect(runSkillsIndexCommand('inspect', [], undefined, cwd)).resolves.toMatchObject({
      data: { file: 'fixture.json' },
    });

    const missing = mkdtempSync(join(tmpdir(), 'di-framework-cli-no-skills-'));
    temps.push(missing);
    writeFileSync(join(missing, 'package.json'), '{"private":true}\n');
    const captured = captureIo();
    expect(
      await executeCommand(
        commandTree('inspect', undefined, missing),
        ['skills', 'index', 'inspect', '--json'],
        captured.io,
      ),
    ).toBe(3);
    expect(JSON.parse(captured.stdout.join('')).error.code).toBe(
      'SKILLS_INDEX_PACKAGE_UNAVAILABLE',
    );
  });

  it('does not translate unexpected non-package failures', async () => {
    const failure = new Error('unexpected');
    await expect(
      runSkillsIndexCommand(
        'inspect',
        [],
        operations({
          inspectSkillsIndex: () => {
            throw failure;
          },
        }),
      ),
    ).rejects.toBe(failure);
  });
});
