import { describe, expect, it } from 'bun:test';
import { validateExtensionManifest } from '@di-framework/cli-extension';
import { createWasmcloudCommand } from '../src/command';
import manifest from '../src/index';
import { captureIo, fakeDeps } from './helpers';

describe('extension manifest', () => {
  it('default-exports a valid manifest named platform', () => {
    expect(validateExtensionManifest(manifest)).toEqual([]);
    expect(manifest.name).toBe('platform');
    expect(Object.keys(manifest.command.children ?? {})).toEqual([
      'build',
      'dev',
      'deploy',
      'destroy',
      'cluster',
      'doctor',
      'console',
      'service',
    ]);
    expect(Object.keys(manifest.command.children?.cluster?.children ?? {})).toEqual([
      'init',
      'up',
      'destroy',
    ]);
    expect(Object.keys(manifest.command.children?.service?.children ?? {})).toEqual([
      'create',
      'list',
      'get',
      'delete',
      'classes',
    ]);
  });

  it('threads injected dependencies through every leaf', async () => {
    const command = createWasmcloudCommand(fakeDeps({ cwd: '/nowhere' }));
    const leaves: Array<{ path: string; run: NonNullable<(typeof command)['run']> }> = [];
    const walk = (node: typeof command, prefix: string[]) => {
      for (const [name, child] of Object.entries(node.children ?? {})) {
        const path = [...prefix, name];
        if (child.run) leaves.push({ path: path.join(' '), run: child.run });
        walk(child, path);
      }
    };
    walk(command, []);
    expect(leaves.map((leaf) => leaf.path)).toEqual([
      'build',
      'dev',
      'deploy',
      'destroy',
      'cluster init',
      'cluster up',
      'cluster destroy',
      'doctor',
      'console',
      'service create',
      'service list',
      'service get',
      'service delete',
      'service classes',
    ]);
    for (const leaf of leaves) {
      await expect(
        Promise.resolve(
          leaf.run({
            args: ['--bogus'],
            command: ['platform', ...leaf.path.split(' ')],
            io: captureIo().io,
          }),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_USAGE', exitCode: 2 });
    }
  });
});
