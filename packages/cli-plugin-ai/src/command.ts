import type { CommandNode } from '@di-framework/cli-extension';
import { runAgentAudit } from './agent/audit.ts';
import { runAgentInit } from './agent/init.ts';
import { runAgentInspect } from './agent/inspect.ts';
import { runAgentMigrate } from './agent/migrate.ts';
import {
  runSkillsIndexBuild,
  runSkillsIndexInspect,
  runSkillsIndexMigrate,
  runSkillsIndexQuery,
  runSkillsIndexValidate,
} from './skills/index.ts';
import { runSkillsValidate } from './skills/validate.ts';

/** `di-framework ai` command tree. Agent and skills commands moved here from the CLI host. */
export function createAiCommand(): CommandNode {
  return {
    description: 'Inspect and manage agent configuration and Agent Skills',
    children: {
      agent: {
        description: 'Inspect and manage agent configuration',
        children: {
          audit: {
            description: 'Audit agent configuration without changing files',
            usage: 'di-framework ai agent audit [options]',
            options: [
              '--workspace <path>  Workspace boundary (default: current directory)',
              '--working-directory <path>  Instruction discovery location',
              '--user-directory <path>  User-level neutral source root',
              '--skills-dir <path>  Explicit skill root (repeatable)',
              '--skills-package <name>  Package-provided skill root (repeatable)',
              '--source-mode merge|replace  Merge with or replace neutral skill roots',
              '--instructions-fallback <name>  Instruction fallback filename (repeatable)',
              '--max-instruction-bytes <count>  Combined instruction byte limit',
              '--allowed-directory <path>  Allowed-directory intersection (repeatable)',
            ],
            run: ({ args }) => runAgentAudit(args),
          },
          init: {
            description: 'Plan or create neutral agent configuration assets',
            usage: 'di-framework ai agent init [options]',
            options: [
              '--workspace <path>  Workspace boundary (default: current directory)',
              '--asset <path>  Neutral asset to initialize (repeatable; defaults to all)',
              '--dry-run  Plan without writing (default)',
              '--apply  Apply the exact generated plan',
            ],
            run: ({ args }) => runAgentInit(args),
          },
          inspect: {
            description: 'Inspect resolved agent configuration without changing files',
            usage: 'di-framework ai agent inspect [options]',
            options: [
              '--workspace <path>  Workspace boundary (default: current directory)',
              '--working-directory <path>  Instruction discovery location',
              '--user-directory <path>  User-level neutral source root',
              '--skills-dir <path>  Explicit skill root (repeatable)',
              '--skills-package <name>  Package-provided skill root (repeatable)',
              '--source-mode merge|replace  Merge with or replace neutral skill roots',
              '--instructions-fallback <name>  Instruction fallback filename (repeatable)',
              '--max-instruction-bytes <count>  Combined instruction byte limit',
            ],
            run: ({ args }) => runAgentInspect(args),
          },
          migrate: {
            description: 'Plan or apply neutral agent-configuration migrations',
            usage: 'di-framework ai agent migrate [--plan | --apply] [options]',
            options: [
              '--plan  Display a migration plan without changing files (default)',
              '--apply  Apply exactly the generated migration plan',
              '--workspace <path>  Workspace boundary (default: current directory)',
              '--working-directory <path>  Instruction audit location',
              '--user-directory <path>  User-level neutral source root',
              '--skills-dir <path>  Explicit skill root to audit (repeatable)',
              '--skills-package <name>  Package-provided skill root (repeatable)',
              '--source-mode merge|replace  Merge with or replace neutral skill roots',
              '--instructions-fallback <name>  Instruction fallback filename (repeatable)',
              '--max-instruction-bytes <count>  Combined instruction byte limit',
              '--source <path>  Select an audited migration source (repeatable)',
              '--replace-existing  Plan explicit recoverable file replacement',
            ],
            run: ({ args }) => runAgentMigrate(args),
          },
        },
      },
      skills: {
        description: 'Agent Skills operations',
        children: {
          index: {
            description: 'Semantic skills-index operations',
            children: {
              build: {
                description: 'Build a skills index from explicit skill sources',
                usage: 'di-framework ai skills index build [options]',
                options: [
                  '--skills-dir <path>  SKILL.md tree (repeatable)',
                  '--skill-file <path>  Individual SKILL.md (repeatable)',
                  '--output <path>  Index output file',
                  '--threshold <count>  Minimum catalog size for embeddings',
                  '--limit <count>  Retrieval candidate limit',
                  '--batch-size <count>  Embedding batch size',
                  '--chunk-tokens <count>  Tokens per source chunk',
                  '--chunk-overlap <count>  Overlap between chunks',
                  '--force  Rebuild an unchanged index',
                ],
                run: ({ args }) => runSkillsIndexBuild(args),
              },
              inspect: {
                description: 'Inspect safe skills-index metadata',
                usage: 'di-framework ai skills index inspect [--input <path>]',
                options: ['--input <path>  Index file to inspect'],
                run: ({ args }) => runSkillsIndexInspect(args),
              },
              validate: {
                description: 'Validate index integrity and optional source drift',
                usage: 'di-framework ai skills index validate [options]',
                options: [
                  '--input <path>  Index file to validate',
                  '--skills-dir <path>  SKILL.md tree to compare (repeatable)',
                  '--skill-file <path>  SKILL.md file to compare (repeatable)',
                  '--allow-extra-skills  Allow indexed skills absent from sources',
                ],
                run: ({ args }) => runSkillsIndexValidate(args),
              },
              query: {
                description: 'Query an existing skills index',
                usage: 'di-framework ai skills index query --query <text> [options]',
                options: [
                  '--input <path>  Index file to query',
                  '--query <text>  Search query (required)',
                  '--limit <count>  Maximum matches',
                  '--min-score <number>  Minimum match score',
                  '--abstention-threshold <number>  Minimum selection confidence',
                ],
                run: ({ args }) => runSkillsIndexQuery(args),
              },
              migrate: {
                description: 'Rewrite a skills index in the current format',
                usage: 'di-framework ai skills index migrate [options]',
                options: [
                  '--input <path>  Source index file',
                  '--output <path>  Migrated index output file',
                ],
                run: ({ args }) => runSkillsIndexMigrate(args),
              },
            },
          },
          validate: {
            description: 'Validate discovered Agent Skills catalogs',
            usage: 'di-framework ai skills validate [options]',
            options: [
              '--workspace <path>  Workspace root (default: current directory)',
              '--user-directory <path>  User root for neutral default discovery',
              '--skills-dir <path>  Explicit SKILL.md tree (repeatable)',
              '--skills-package <name-or-path>  Package skill source (repeatable)',
              '--source-mode <merge|replace>  Merge with or replace neutral defaults',
            ],
            run: ({ args }) => runSkillsValidate(args),
          },
        },
      },
    },
  };
}
