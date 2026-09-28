import { describe, expect, it } from 'bun:test';
import { runWasmcloudDestroy } from '../src/destroy';
import { WORKLOAD_DEPLOYMENT_RESOURCE } from '../src/workload';
import { captureIo, fakeDeps, makeWorkspace, type RunnerInvocation } from './helpers';

describe('runWasmcloudDestroy', () => {
  it('deletes generated application resources and never invokes pulumi destroy', async () => {
    const { greeter } = makeWorkspace();
    const invocations: RunnerInvocation[] = [];
    const result = await runWasmcloudDestroy(
      ['--target', 'development'],
      captureIo().io,
      fakeDeps({ cwd: greeter, invocations }),
    );

    expect(invocations.every((invocation) => invocation.command !== 'pulumi')).toBe(true);
    expect(invocations.some((invocation) => invocation.args[0] === 'destroy')).toBe(false);
    const kubectl = invocations.filter((invocation) => invocation.command === 'kubectl');
    expect(kubectl).toHaveLength(2);
    expect(kubectl[0]?.args).toEqual(
      expect.arrayContaining([
        'delete',
        `${WORKLOAD_DEPLOYMENT_RESOURCE},service,cronjob,secret`,
        '-l',
        'app.kubernetes.io/name=greeter',
        '--ignore-not-found',
      ]),
    );
    expect(kubectl[0]?.args).not.toContain('service/greeter');
    expect(result.data).toMatchObject({
      application: 'greeter',
      target: 'development',
      namespace: 'wasmcloud',
      service: 'greeter',
    });
    expect(result.text).toContain('Removed greeter');
  });

  it('destroys a named project from the workspace root', async () => {
    const { root } = makeWorkspace();
    const invocations: RunnerInvocation[] = [];
    await runWasmcloudDestroy(
      ['echo', '--target', 'development'],
      captureIo().io,
      fakeDeps({ cwd: root, invocations }),
    );
    expect(invocations[0]?.args).toEqual(
      expect.arrayContaining([
        `${WORKLOAD_DEPLOYMENT_RESOURCE},service,cronjob,secret`,
        '-l',
        'app.kubernetes.io/name=echo',
      ]),
    );
  });

  it('surfaces kubectl failures', async () => {
    const { greeter } = makeWorkspace();
    await expect(
      runWasmcloudDestroy(
        ['--target', 'development'],
        captureIo().io,
        fakeDeps({ cwd: greeter, exitCodes: { 'kubectl delete': 1 } }),
      ),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_TOOL_FAILED', exitCode: 3 });
  });
});
