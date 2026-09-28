import { describe, expect, it } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runWasmcloudDoctor } from '../src/doctor';
import { captureIo, fakeDeps, makeProject } from './helpers';

const HEALTHY = {
  resolutions: {
    '@di-framework/core': '/project/node_modules/@di-framework/core/index.js',
    '@di-framework/http': '/project/node_modules/@di-framework/http/index.js',
  },
  captures: {
    node: 'v22.23.2',
    pulumi: 'v3.261.0',
    docker: '27.0.3',
    kubectl: 'clientVersion:',
    oras: 'oras version 1.2.0',
  },
};

describe('runWasmcloudDoctor', () => {
  it('reports success when the project and toolchain are complete', async () => {
    const root = makeProject();
    const result = await runWasmcloudDoctor(
      [],
      captureIo().io,
      fakeDeps({ cwd: root, ...HEALTHY }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.data).toMatchObject({ application: 'Demo App' });
    const checks = (result.data as { checks: Array<{ name: string; ok: boolean }> }).checks;
    expect(checks.map((check) => check.name)).toEqual([
      'Bun',
      'Node.js',
      '@di-framework/core',
      '@di-framework/http',
      'Pulumi',
      'Docker',
      'kubectl',
      'oras',
      'dev runner',
    ]);
    expect(checks.every((check) => check.ok)).toBe(true);
    expect(result.text).toContain('✓ Pulumi: v3.261.0');
    expect(result.text).toContain('Contract: incoming HTTP → default export in src/app.ts');
  });

  it('fails with exit 1 when tools or framework packages are missing', async () => {
    const root = makeProject();
    const result = await runWasmcloudDoctor(
      [],
      captureIo().io,
      fakeDeps({ cwd: root, captures: { pulumi: 'v3.261.0' } }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.text).toContain('✗ Docker is unavailable');
    expect(result.text).toContain('✗ @di-framework/core is unavailable');
  });

  it('lists discovered bindings and missing catalog as a failed check', async () => {
    const root = makeProject();
    writeFileSync(
      join(root, 'src', 'bindings.ts'),
      `import { Postgres, WasmCloudBinding } from '@di-framework/bindings';
@WasmCloudBinding('users')
export class Users extends Postgres {}
`,
    );
    const missing = await runWasmcloudDoctor(
      [],
      captureIo().io,
      fakeDeps({ cwd: root, ...HEALTHY }),
    );
    expect(missing.exitCode).toBe(1);
    expect(missing.text).toContain('✗ @di-framework/bindings is unavailable');

    const catalogPath = join(root, 'catalog.json');
    writeFileSync(
      catalogPath,
      `${JSON.stringify({
        Postgres: {
          kind: 'Postgres',
          package: 'wasmcloud:postgres',
          version: '0.2.0',
          interfaces: ['query', 'prepared', 'types'],
          primaryInterface: 'query',
          namedInstance: true,
          sharedResources: [],
          witDep: 'wasmcloud-postgres',
          usesSecret: true,
          configKeys: [],
        },
      })}\n`,
    );
    const ok = await runWasmcloudDoctor(
      [],
      captureIo().io,
      fakeDeps({
        cwd: root,
        ...HEALTHY,
        washBinaryPath: '/fake/wash',
        resolutions: {
          ...HEALTHY.resolutions,
          '@di-framework/bindings': catalogPath,
          '@di-framework/bindings/catalog.json': catalogPath,
        },
      }),
    );
    expect(ok.exitCode).toBe(0);
    expect(ok.text).toContain('binding users');
    expect(ok.text).toContain('Users');
    expect(ok.text).toContain('✓ dev runner: wash');
  });

  it('rejects arguments', async () => {
    await expect(
      runWasmcloudDoctor(['--fix'], captureIo().io, fakeDeps({ cwd: '/nowhere' })),
    ).rejects.toMatchObject({ code: 'INVALID_USAGE', exitCode: 2 });
  });

  it('reports a missing dev runner without failing the rest of the probe', async () => {
    const root = makeProject();
    const result = await runWasmcloudDoctor(
      [],
      captureIo().io,
      fakeDeps({
        cwd: root,
        ...HEALTHY,
        wasmtimeBinaryPath: null,
        washBinaryPath: null,
        nodeBinaryPath: null,
      }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.text).toContain('✗ dev runner is unavailable');
    expect(result.text).toContain('✓ Pulumi: v3.261.0');
  });
});
