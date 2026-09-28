import type { CliIo, CommandResult } from '@di-framework/cli-extension';
import { parseAppCommandArgs } from './args';
import { DEFAULT_DEPS, type WasmcloudDeps } from './deps';
import { resolveApplication } from './discovery';
import { loadDeployManifest } from './manifest';
import { resolveConnection, resolveTarget } from './target';
import { deleteWorkload, deploymentResourceName } from './workload';

export async function runWasmcloudDestroy(
  args: readonly string[],
  io: CliIo,
  deps: WasmcloudDeps = DEFAULT_DEPS,
): Promise<CommandResult> {
  const options = parseAppCommandArgs(args, 'platform destroy');
  const manifest = loadDeployManifest(deps.cwd(), deps.env);
  const target = resolveTarget(manifest, options.target);
  const project = resolveApplication(
    deps.cwd(),
    options.name,
    manifest.workspaceRoot,
    manifest.discovery,
  );
  const connection = await resolveConnection(target, manifest.workspaceRoot, manifest.path, deps);
  await deleteWorkload(project, connection, io, deps);
  const service = deploymentResourceName(project);

  return {
    data: {
      application: project.applicationName,
      target: connection.target,
      namespace: connection.namespace,
      service,
    },
    text: `Removed ${project.applicationName} from ${connection.target} (namespace ${connection.namespace}).`,
  };
}
