/**
 * Environment names the CLI renders into a workload's `localResources.environment.config`
 * without a `DI_` prefix (every `DI_*` name is the framework's as well). The console hides them,
 * and `controlSecretKeys` may not declare them, so a Secret key never shadows one.
 */
export const RENDERED_ENVIRONMENT_KEYS: readonly string[] = [
  'ACTOR_STORAGE_DIR',
  'QUEUE_DB_PATH',
  'MIGRATION_DB_PATH',
];
