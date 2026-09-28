import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LIVE = process.env.DI_FRAMEWORK_WASMCLOUD_LIVE === '1';
const liveDescribe = LIVE ? describe : describe.skip;
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPOSITORY_ROOT = join(PACKAGE_ROOT, '..', '..');
const LIVE_ENV = {
  ...process.env,
  PULUMI_CONFIG_PASSPHRASE: '',
};

type CommandRun = {
  status: number | null;
  stdout: string;
  stderr: string;
};

liveDescribe('packed blank-workspace live deployment', () => {
  it('runs the complete local wasmCloud lifecycle without handwritten resources', async () => {
    for (const command of ['bun', 'curl', 'docker', 'kubectl', 'npm', 'oras', 'pulumi']) {
      expect(Bun.which(command), `${command} is required for the opt-in live test`).toBeString();
    }
    expect(runCommand('docker', ['info'], REPOSITORY_ROOT).status).toBe(0);

    const packedRoot = mkdtempSync(join(tmpdir(), 'di-wasmcloud-live-packs-'));
    const workspace = mkdtempSync(join(tmpdir(), 'di-wasmcloud-live-consumer-'));
    const platform = join(workspace, 'deploy', 'platform');
    const project = join(workspace, 'services', 'greeter');
    let platformUp = false;
    let applicationUp = false;

    try {
      const packageDirectories = [
        'di-framework-core',
        'di-framework-codegen',
        'di-framework-cli-extension',
        'cli-plugin-platform',
        'di-framework-cli',
      ];
      for (const directory of packageDirectories) {
        runChecked('bun', ['run', 'build'], join(REPOSITORY_ROOT, 'packages', directory), 180_000);
      }

      const tarballs = packageDirectories.map((directory) =>
        packPackage(join(REPOSITORY_ROOT, 'packages', directory), packedRoot),
      );
      const dependencies = Object.fromEntries(
        tarballs.map(({ name, path }) => [name, `file:${path}`]),
      );
      writeFileSync(
        join(workspace, 'package.json'),
        `${JSON.stringify({ name: 'blank-wasmcloud-consumer', private: true, dependencies }, null, 2)}\n`,
      );
      runChecked('npm', ['install', '--ignore-scripts'], workspace, 300_000);

      const cli = join(workspace, 'node_modules', '.bin', 'di-framework');
      const initialized = runChecked(cli, ['platform', 'cluster', 'init'], workspace);
      expect(initialized).toContain('di-framework platform cluster up local --yes');
      expect(existsSync(join(platform, 'node_modules'))).toBe(false);
      expect(existsSync(join(platform, '.gitignore'))).toBe(true);

      const [apiPort, registryPort, httpPort] = await freePorts(3);
      const platformEnvironment = {
        ...LIVE_ENV,
        PULUMI_BACKEND_URL: pathToFileURL(join(platform, '.pulumi-state')).href,
      };
      mkdirSync(join(platform, '.pulumi-state'), { recursive: true });
      runChecked('pulumi', ['stack', 'init', 'dev'], platform, 120_000, platformEnvironment);
      for (const [name, value] of [
        ['apiPort', apiPort],
        ['registryPort', registryPort],
        ['httpPort', httpPort],
      ] as const) {
        runChecked(
          'pulumi',
          ['config', 'set', name, String(value)],
          platform,
          120_000,
          platformEnvironment,
        );
      }

      const platformDeploy = runChecked(
        cli,
        ['platform', 'cluster', 'up', 'local', '--yes'],
        workspace,
        900_000,
      );
      platformUp = true;
      expect(platformDeploy).toContain(`HTTP entrypoint: http://127.0.0.1:${httpPort}`);
      expect(platformDeploy).not.toContain('client-key-data:');
      expect(existsSync(join(platform, 'node_modules'))).toBe(true);

      const outputs = JSON.parse(
        runChecked('pulumi', ['stack', 'output', '--json'], platform, 120_000, platformEnvironment),
      ) as {
        kubeconfig: string;
        registry: { push: string; pull: string; insecure: boolean };
      };
      expect(outputs.registry).toEqual({
        push: `http://127.0.0.1:${registryPort}`,
        pull: 'di-framework-registry.wasmcloud.svc.cluster.local:5000',
        insecure: true,
      });
      expect(statSync(outputs.kubeconfig).mode & 0o777).toBe(0o600);

      mkdirSync(project, { recursive: true });
      writeFileSync(
        join(project, 'di-framework.config.json'),
        `${JSON.stringify({ name: 'greeter', entry: 'index.ts', output: 'dist/greeter.wasm' }, null, 2)}\n`,
      );
      writeFileSync(
        join(project, 'index.ts'),
        "export default (request: Request) => new Response(new URL(request.url).pathname === '/health' ? 'ok' : 'hello');\n",
      );

      const firstDeploy = runChecked(cli, ['platform', 'deploy', 'greeter'], workspace, 600_000);
      applicationUp = true;
      expect(firstDeploy).toContain(`HTTP: http://127.0.0.1:${httpPort} with Host: greeter`);
      expect(
        runChecked(
          'curl',
          [
            '--fail',
            '--silent',
            '--show-error',
            '-H',
            'Host: greeter',
            `http://127.0.0.1:${httpPort}/health`,
          ],
          workspace,
        ),
      ).toBe('ok');

      const firstBuild = JSON.parse(
        readFileSync(join(project, '.di-framework', 'build.json'), 'utf8'),
      ) as { deploymentDigest: string };
      const firstWorkload = workloadState(outputs.kubeconfig, project);
      expect(firstWorkload.image).toStartWith(`${outputs.registry.pull}/greeter:sha256-`);
      expect(firstWorkload.ready).toBe(true);

      const secondDeploy = runChecked(cli, ['platform', 'deploy', 'greeter'], workspace, 600_000);
      const secondBuild = JSON.parse(
        readFileSync(join(project, '.di-framework', 'build.json'), 'utf8'),
      ) as { deploymentDigest: string };
      const secondWorkload = workloadState(outputs.kubeconfig, project);
      expect(secondDeploy).toContain('already exists; keeping it immutable');
      expect(secondBuild.deploymentDigest).toBe(firstBuild.deploymentDigest);
      expect(secondWorkload.image).toBe(firstWorkload.image);
      expect(secondWorkload.generation).toBe(firstWorkload.generation);

      runChecked(cli, ['platform', 'destroy', 'greeter'], workspace, 300_000);
      applicationUp = false;
      runChecked(cli, ['platform', 'cluster', 'destroy', 'local', '--yes'], workspace, 600_000);
      platformUp = false;

      expect(existsSync(outputs.kubeconfig)).toBe(false);
      const pulumiProject = readFileSync(join(platform, 'Pulumi.yaml'), 'utf8')
        .split('\n')
        .find((line) => line.startsWith('name: '))
        ?.slice('name: '.length);
      expect(pulumiProject).toBeString();
      const scope = `di-framework-dev-${createHash('sha256')
        .update(pulumiProject as string)
        .digest('hex')
        .slice(0, 10)}`;
      expect(
        runCommand('docker', ['container', 'inspect', `${scope}-k0s`], workspace).status,
      ).not.toBe(0);
      expect(
        runCommand('docker', ['network', 'inspect', `${scope}-network`], workspace).status,
      ).not.toBe(0);
      expect(
        runCommand('docker', ['volume', 'inspect', `${scope}-k0s-data`], workspace).status,
      ).not.toBe(0);
    } finally {
      if (applicationUp)
        runCommand(cliPath(workspace), ['platform', 'destroy', 'greeter'], workspace);
      if (platformUp) {
        runCommand(
          cliPath(workspace),
          ['platform', 'cluster', 'destroy', 'local', '--yes'],
          workspace,
          600_000,
        );
      }
      rmSync(packedRoot, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 1_800_000);
});

function cliPath(workspace: string): string {
  return join(workspace, 'node_modules', '.bin', 'di-framework');
}

function packPackage(packageRoot: string, destination: string): { name: string; path: string } {
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
    name: string;
  };
  const output = runChecked(
    'npm',
    ['pack', '--json', '--pack-destination', destination],
    packageRoot,
    120_000,
  );
  const packed = JSON.parse(output) as Array<{ filename: string }>;
  const filename = packed[0]?.filename;
  if (filename === undefined) throw new Error(`npm pack returned no artifact for ${manifest.name}`);
  return { name: manifest.name, path: join(destination, filename) };
}

function runChecked(
  command: string,
  args: readonly string[],
  cwd: string,
  timeout = 120_000,
  env = LIVE_ENV,
): string {
  const result = runCommand(command, args, cwd, timeout, env);
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed with ${result.status}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  timeout = 120_000,
  env = LIVE_ENV,
): CommandRun {
  const result = spawnSync(command, [...args], {
    cwd,
    encoding: 'utf8',
    env,
    maxBuffer: 32 * 1024 * 1024,
    timeout,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

async function freePorts(count: number): Promise<number[]> {
  const ports = new Set<number>();
  while (ports.size < count) ports.add(await freePort());
  return [...ports];
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('could not allocate a loopback port'));
        return;
      }
      server.close((error) => (error === undefined ? resolve(address.port) : reject(error)));
    });
  });
}

function workloadState(
  kubeconfig: string,
  project: string,
): { generation: number; image: string; ready: boolean } {
  const document = JSON.parse(
    runChecked(
      'kubectl',
      [
        '--kubeconfig',
        kubeconfig,
        '--namespace',
        'wasmcloud',
        'get',
        'workloaddeployment.runtime.wasmcloud.dev/greeter',
        '-o',
        'json',
      ],
      project,
    ),
  ) as {
    metadata: { generation: number };
    spec: { template: { spec: { components: Array<{ image: string }> } } };
    status?: { conditions?: Array<{ type?: string; status?: string }> };
  };
  return {
    generation: document.metadata.generation,
    image: document.spec.template.spec.components[0]?.image ?? '',
    ready: (document.status?.conditions ?? []).some(
      (condition) => condition.type === 'Ready' && condition.status === 'True',
    ),
  };
}
