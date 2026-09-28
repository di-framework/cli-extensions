import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildComponent } from '../src/build';
import { DEFAULT_DEPS } from '../src/deps';
import { loadProject } from '../src/project';
import { captureIo, makeProject } from './helpers';

const root = makeProject({
  name: 'Cron Regression',
  entry: 'src/app.ts',
  wasmcloud: { ingress: false },
});
let built: Promise<ReturnType<typeof loadProject>> | undefined;
afterAll(() => rmSync(root, { recursive: true, force: true }));

function component() {
  built ??= (async () => {
    mkdirSync(join(root, 'node_modules/@di-framework'), { recursive: true });
    symlinkSync(
      dirname(fileURLToPath(import.meta.resolve('@di-framework/core/package.json'))),
      join(root, 'node_modules/@di-framework/core'),
    );
    writeFileSync(
      join(root, 'src/app.ts'),
      `
import { Container, Cron } from '@di-framework/core';
class ScheduledService {
  @Cron('* * * * *', { name: 'regression-job' })
  async execute() {
    if (process.env.RUNTIME_TEST_SECRET !== 'runtime-only') {
      throw new Error('Application invoked without runtime environment');
    }
    return { completed: true };
  }
}
export const container = new Container();
container.setCronMode('external');
container.register(ScheduledService);
container.resolve(ScheduledService);
export default { container };
`,
    );
    const project = { ...loadProject(root), ingress: false };
    const summary = await buildComponent(project, captureIo().io, DEFAULT_DEPS);
    // Cron control plane uses the HTTP adapter so cluster CronJobs can POST /_di/cron/...
    expect(summary.profile).toBe('wasmcloud-http');
    expect(readFileSync(project.outputPath).subarray(0, 4)).toEqual(Buffer.from([0, 97, 115, 109]));
    const inspected = await DEFAULT_DEPS.runCaptured(
      DEFAULT_DEPS.nodeBinaryPath()!,
      [DEFAULT_DEPS.jcoCliPath(), 'wit', project.outputPath],
      { cwd: root },
    );
    expect(inspected.exitCode).toBe(0);
    expect(inspected.stdout).toContain('export wasi:http/handler@0.3.0');
    expect(
      readFileSync(join(project.projectRoot, '.di-framework/cron-invoker.js'), 'utf8'),
    ).toContain('regression-job');
    return project;
  })();
  return built;
}

test('componentizes cron without evaluating services against snapshot WASI stderr', async () => {
  await component();
}, 120_000);

test('rejects unknown cron jobs through the generated invoker module', async () => {
  const project = await component();
  const invokerPath = join(project.projectRoot, '.di-framework/cron-invoker.js');
  const source = readFileSync(invokerPath, 'utf8');
  expect(source).toContain('regression-job');
  expect(source).toContain('invokeJob');
}, 30_000);
