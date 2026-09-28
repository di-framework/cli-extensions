import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { discoverActors, renderActorsModule, renderWorkloadManifest } from '../src/index';
import type { WasmcloudProject } from '../src/project';
import type { ClusterConnection } from '../src/target';

describe('wasmCloud Actor Build & Manifest Generation', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wasmcloud-actor-build-'));

  const makeProject = (
    srcFiles: Record<string, string>,
    configExtra: Record<string, unknown> = {},
  ): WasmcloudProject => {
    const projDir = path.join(tmp, `proj-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const srcDir = path.join(projDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    for (const [filename, code] of Object.entries(srcFiles)) {
      fs.writeFileSync(path.join(srcDir, filename), code);
    }

    const configPath = path.join(projDir, 'di-framework.config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        name: 'actor-app',
        entry: 'src/index.ts',
        ...configExtra,
      }),
    );

    return {
      applicationName: 'actor-app',
      configPath,
      entryPath: path.join(srcDir, 'index.ts'),
      outputPath: path.join(projDir, 'dist', 'actor-app.wasm'),
      bindingsPath: undefined,
      bindingsConfigured: false,
      bindingsRelative: 'src/bindings.ts',
      projectRoot: projDir,
      version: '1.0.0',
      witName: 'actor-app',
    };
  };

  it('scans decorated actor metadata (@Actor, @ActorMethod)', () => {
    const project = makeProject({
      'counter-actor.ts': `
        import { Actor, ActorMethod } from '@di-framework/actors';

        @Actor({ name: 'Counter', namespace: 'system' })
        export class CounterActor {
          @ActorMethod()
          async increment(step: number = 1): Promise<number> { return step; }

          @ActorMethod({ name: 'fetchCount', timeout: 5000 })
          async getCount(): Promise<number> { return 0; }
        }
      `,
      'index.ts': `
        export { CounterActor } from './counter-actor';
      `,
    });

    const actors = discoverActors(project);
    expect(actors.length).toBe(1);
    expect(actors[0]?.className).toBe('CounterActor');
    expect(actors[0]?.actorName).toBe('Counter');
    expect(actors[0]?.namespace).toBe('system');
    expect(actors[0]?.methods).toEqual([
      { name: 'increment', methodName: 'increment', timeout: undefined },
      { name: 'fetchCount', methodName: 'getCount', timeout: 5000 },
    ]);
  });

  it('generates explicit registration and dispatch exports module', () => {
    const project = makeProject({
      'user-actor.ts': `
        import { Actor, ActorMethod } from '@di-framework/actors';

        @Actor('User')
        export class UserActor {
          @ActorMethod()
          async getName(): Promise<string> { return 'alice'; }
        }
      `,
      'index.ts': `export { UserActor } from './user-actor';`,
    });

    const actors = discoverActors(project);
    const moduleSource = renderActorsModule(actors);

    expect(moduleSource).toContain(
      "import { ActorRuntime, SqliteActorStorage } from '@di-framework/actors';",
    );
    expect(moduleSource).toContain('import { UserActor } from');
    expect(moduleSource).toContain('ensureActorRuntime()');
    expect(moduleSource).toContain('runtime.register(UserActor, {');
    expect(moduleSource).toContain('export async function dispatchActorInvocation(');
    expect(moduleSource).toContain('export { getActorRuntime as actorRuntime, storage };');
    expect(moduleSource).toContain('export { UserActor };');
    expect(moduleSource).toContain('globalThis[Symbol.for("di-framework.wasmcloud.actors")]');
  });

  it('enforces replicas: 1 for actor deployments with SQLite persistence', () => {
    const project = makeProject({
      'counter.ts': `
        import { Actor, ActorMethod } from '@di-framework/actors';
        @Actor()
        export class CounterActor {}
      `,
      'index.ts': `export { CounterActor } from './counter.ts';`,
    });

    const connection: ClusterConnection = {
      target: 'dev',
      kubeconfig: '/tmp/kubeconfig',
      context: 'dev',
      namespace: 'wasmcloud',
      registry: {
        push: 'registry.example.com',
        pull: 'registry.example.com',
        insecure: false,
      },
    };

    // Valid with replicas: 1
    const validManifest = renderWorkloadManifest(
      project,
      connection,
      'registry.example.com/actor-app:v1',
      [],
      [],
      { hasActors: true, replicas: 1 },
    );

    expect(validManifest).not.toContain('kind: PersistentVolumeClaim');
    expect(validManifest).toContain('replicas: 1');
    expect(validManifest).toContain('deployPolicy: Recreate');
    expect(validManifest).toContain('hostgroup: storage');
    expect(validManifest).toContain('mountPath: /data/actors');
    expect(validManifest).toContain('hostPath:');
    expect(validManifest).toContain('/var/lib/di-framework/storage/actor-app');
    expect(validManifest).toContain('ACTOR_STORAGE_DIR');
    expect(validManifest).toContain('localResources:');
    expect(validManifest).toContain('environment:');
    expect(validManifest).not.toContain('queueConsumers:');
    expect(validManifest).not.toContain('strategy:');

    // Rejects replicas > 1
    expect(() =>
      renderWorkloadManifest(project, connection, 'registry.example.com/actor-app:v1', [], [], {
        hasActors: true,
        replicas: 2,
      }),
    ).toThrow('SQLite-backed workloads require replicas: 1');
  });
});

it('discovers nested actors, alternate decorators and entrypoints outside src', async () => {
  const { spyOn } = await import('bun:test');
  const { makeProject } = await import('./helpers');
  const { loadProject } = await import('../src/project');
  const { nodeCompatibilityPlugin } = await import('../src/deps');
  const root = makeProject();
  try {
    fs.mkdirSync(path.join(root, 'src', 'nested'));
    fs.mkdirSync(path.join(root, 'src', 'node_modules'));
    fs.writeFileSync(path.join(root, 'src', 'types.d.ts'), 'declare class Actor {}');
    fs.writeFileSync(path.join(root, 'src', 'skip.test.ts'), '@Actor class Ignored {}');
    fs.writeFileSync(path.join(root, 'src', 'plain.ts'), 'export const value = 1;');
    const file = path.join(root, 'src', 'nested', 'actors.ts');
    fs.writeFileSync(
      file,
      `
      @other() export class NotActor {}
      @Actor export class Bare { @ActorMethod read() {} }
      @lib.Actor({ name: 'Configured', namespace: 'app', migrations: [migration], enabled: true, disabled: false, ...extra })
      export class Configured {
        @lib.ActorMethod('fetch') read() {}
        @ActorMethod(dynamic) dynamic() {}
        @ActorMethod({ name: 'alias', timeout: 2, enabled: true, disabled: false, ...extra }) timed() {}
        @Other() skipped() {}
      }
      @Actor(dynamic) export class Dynamic {}
    `,
    );
    const project = loadProject(root);
    const records = discoverActors(project);
    expect(records.map((record) => record.actorName)).toEqual(['Bare', 'Configured', 'Dynamic']);
    expect(records[1]?.hasMigrations).toBe(true);
    expect(records[1]?.methods.map((method) => method.name)).toEqual(['fetch', 'dynamic', 'alias']);
    const read = fs.readFileSync;
    const missing = spyOn(fs, 'readFileSync').mockImplementation(((
      filePath: any,
      ...args: any[]
    ) => {
      if (filePath === file) throw new Error('disappeared');
      return (read as any)(filePath, ...args);
    }) as typeof fs.readFileSync);
    try {
      expect(discoverActors(project)).toEqual([]);
    } finally {
      missing.mockRestore();
    }
    const extra = path.join(root, 'extra.js');
    fs.writeFileSync(extra, '@Actor("Outside") export class Outside {}');
    expect(
      discoverActors({ ...project, entryPath: extra }).some(
        (record) => record.actorName === 'Outside',
      ),
    ).toBe(true);
    fs.rmSync(path.join(root, 'src'), { recursive: true });
    expect(discoverActors({ ...project, entryPath: extra })).toHaveLength(1);
    expect(
      discoverActors({
        ...project,
        projectRoot: path.join(root, 'missing'),
        entryPath: path.join(root, 'missing.js'),
      }),
    ).toEqual([]);
    const plugin = nodeCompatibilityPlugin('/app.ts', undefined, '/actors.js');
    expect(plugin.resolveId('virtual:di-framework-wasmcloud-actors')).toBe('/actors.js');
    const empty = nodeCompatibilityPlugin('/app.ts');
    expect(empty.resolveId('virtual:di-framework-wasmcloud-actors')).toContain('actors-empty');
    expect(
      empty.load(empty.resolveId('virtual:di-framework-wasmcloud-actors') as string),
    ).toContain('actorRuntime = undefined');
    expect(nodeCompatibilityPlugin('/app.ts', undefined, undefined, {} as any)).toBeDefined();
    expect(nodeCompatibilityPlugin('/app.ts', undefined, {} as any)).toBeDefined();
    fs.mkdirSync(path.join(root, '.di-framework'));
    const generatedEntry = path.join(root, '.di-framework', 'generated.js');
    fs.writeFileSync(generatedEntry, '@Actor() export class Generated {}');
    expect(
      discoverActors({ ...project, entryPath: generatedEntry }).find(
        (actor) => actor.className === 'Generated',
      )?.importPath,
    ).toBe('./generated.js');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
