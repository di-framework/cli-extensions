import { defineExtension } from '@di-framework/cli-extension';
import { createAiCommand } from './command.ts';

export { parseAgentAuditArgs, runAgentAudit } from './agent/audit.ts';
export { runAgentInit } from './agent/init.ts';
export { runAgentInspect } from './agent/inspect.ts';
export { parseAgentMigrateArgs, runAgentMigrate } from './agent/migrate.ts';
export { createAiCommand } from './command.ts';
export {
  runSkillsIndexBuild,
  runSkillsIndexInspect,
  runSkillsIndexMigrate,
  runSkillsIndexQuery,
  runSkillsIndexValidate,
} from './skills/index.ts';
export { parseSkillsValidateArgs, runSkillsValidate } from './skills/validate.ts';

export default defineExtension({
  schemaVersion: 1,
  name: 'ai',
  description: 'Inspect and manage agent configuration and Agent Skills',
  command: createAiCommand(),
});
