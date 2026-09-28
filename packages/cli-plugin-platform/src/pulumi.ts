import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { WasmcloudDeps } from './deps';
import { toolFailed } from './support';

/** Local file backend and passphrase defaults, without touching the caller's environment. */
export function pulumiEnvironment(
  env: Record<string, string | undefined>,
  projectRoot?: string,
): Record<string, string | undefined> {
  return {
    ...env,
    PULUMI_BACKEND_URL:
      env.PULUMI_BACKEND_URL ??
      (projectRoot === undefined
        ? 'file://~'
        : pathToFileURL(join(projectRoot, '.pulumi-state')).href),
    PULUMI_CONFIG_PASSPHRASE: env.PULUMI_CONFIG_PASSPHRASE ?? 'local-dev',
  };
}

export async function runPulumi(
  deps: WasmcloudDeps,
  args: readonly string[],
  cwd: string,
): Promise<void> {
  if (deps.env.PULUMI_BACKEND_URL === undefined) {
    mkdirSync(join(cwd, '.pulumi-state'), { recursive: true });
  }
  const result = await deps.runner('pulumi', args, {
    cwd,
    env: pulumiEnvironment(deps.env, cwd),
  });
  if (result.exitCode !== 0) {
    throw toolFailed(`pulumi ${args[0]}`, result.exitCode);
  }
}
