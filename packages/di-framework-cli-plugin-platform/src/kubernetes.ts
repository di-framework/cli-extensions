import type { WasmcloudDeps } from './deps';
import { toolFailed } from './support';
import type { ClusterConnection } from './target';

export function kubectlArgs(connection: ClusterConnection, args: readonly string[]): string[] {
  const flags = ['--kubeconfig', connection.kubeconfig, '--namespace', connection.namespace];
  if (connection.context !== undefined) {
    flags.push('--context', connection.context);
  }
  return [...flags, ...args];
}

export async function runKubectl(
  deps: WasmcloudDeps,
  connection: ClusterConnection,
  args: readonly string[],
  cwd: string,
): Promise<void> {
  const result = await deps.runner('kubectl', kubectlArgs(connection, args), { cwd });
  if (result.exitCode !== 0) {
    throw toolFailed(`kubectl ${args[0]}`, result.exitCode);
  }
}

export async function captureKubectl(
  deps: WasmcloudDeps,
  connection: ClusterConnection,
  args: readonly string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return deps.runCaptured('kubectl', kubectlArgs(connection, args), { cwd });
}
