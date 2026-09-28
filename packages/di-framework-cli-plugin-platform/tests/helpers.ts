import { expect } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CliIo } from '@di-framework/cli-extension';
import {
  findInstalledComponentizeQjsCli,
  resolveComponentizeQjsPath,
  type WasmcloudDeps,
} from '../src/deps';

export type RunnerInvocation = {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  captured?: boolean;
};

export const READY_WORKLOAD_JSON = JSON.stringify({
  spec: { replicas: 1 },
  status: {
    readyReplicas: 1,
    conditions: [{ type: 'Available', status: 'True' }],
  },
});

export function captureIo(): { stdout: string[]; stderr: string[]; io: CliIo } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: { write: (chunk) => stdout.push(chunk) },
      stderr: { write: (chunk) => stderr.push(chunk) },
    },
  };
}

/** Temp project with `di-framework.config.json`, an entry module, and a package.json. */
export function makeProject(
  config: Record<string, unknown> = { name: 'Demo App', entry: 'src/app.ts' },
  packageJson: Record<string, unknown> | null = { name: 'demo', version: '1.2.3' },
): string {
  const root = mkdtempSync(join(tmpdir(), 'wasmcloud-project-'));
  writeFileSync(join(root, 'di-framework.config.json'), `${JSON.stringify(config)}\n`);
  if (packageJson !== null) {
    writeFileSync(join(root, 'package.json'), `${JSON.stringify(packageJson)}\n`);
  }
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'app.ts'), 'export default () => new Response("ok");\n');
  return root;
}

/** Temp assets directory shaped like the shipped `dist/assets`. */
export function makeAssets(): string {
  const root = mkdtempSync(join(tmpdir(), 'wasmcloud-assets-'));
  mkdirSync(join(root, 'wit', 'deps', 'wasi-http'), { recursive: true });
  writeFileSync(
    join(root, 'wit', 'deps', 'wasi-http', 'package.wit'),
    'package wasi:http@0.3.0;\n',
  );
  writeFileSync(join(root, 'http-adapter.js'), 'export const handler = {};\n');
  return root;
}

/** wasmtime-48+ componentize-qjs CLI that can stub imported `async func`s. */
export function patchedComponentizeQjsPath(): string | undefined {
  const resolved = resolveComponentizeQjsPath(process.env, findInstalledComponentizeQjsCli());
  if (resolved !== undefined && existsSync(resolved)) return resolved;
  const local = '/tmp/componentize-qjs/target/release/componentize-qjs';
  return existsSync(local) ? local : undefined;
}

export function invocationKey(command: string, args: readonly string[]): string {
  if (command === 'pulumi') {
    return args.includes('output') ? 'pulumi stack output' : `pulumi ${args[0]}`;
  }
  if (command === 'kubectl') {
    const verb = args.find((token) =>
      ['apply', 'delete', 'get', 'wait', 'create', 'label'].includes(token),
    );
    if (verb === 'get' && args.includes('secret')) return 'kubectl get secret';
    if (verb === 'create' && args.includes('secret')) return 'kubectl create secret';
    if (verb === 'label' && args.includes('secret')) return 'kubectl label secret';
    const backing = args.find(
      (token) =>
        typeof token === 'string' &&
        (token.includes('backingservice') || token.includes('BackingService')),
    );
    if (backing !== undefined && verb !== undefined) {
      if (verb === 'get' && args.includes('-o') && args.includes('name')) {
        return 'kubectl get backingservice name';
      }
      if (
        verb === 'get' &&
        args.includes('-o') &&
        args.includes('json') &&
        args.some((token) => token.includes('backingserviceclasses'))
      ) {
        return 'kubectl get backingserviceclasses';
      }
      if (
        verb === 'get' &&
        args.includes('-o') &&
        args.includes('json') &&
        !args.some(
          (token, index) =>
            typeof token === 'string' &&
            token.includes('backingservice') &&
            args[index + 1] !== undefined &&
            !String(args[index + 1]).startsWith('-'),
        )
      ) {
        return 'kubectl get backingservices';
      }
      if (verb === 'get') return 'kubectl get backingservice';
      if (verb === 'create') return 'kubectl create backingservice';
      if (verb === 'delete') return 'kubectl delete backingservice';
      return `kubectl ${verb} backingservice`;
    }
    return verb === undefined ? 'kubectl' : `kubectl ${verb}`;
  }
  if (command === 'oras') return args[0] === 'push' ? 'oras push' : 'oras manifest fetch';
  if (command === 'wasmtime' || /(?:^|\/)wasmtime$/.test(command)) {
    return args[0] === 'serve' ? 'wasmtime serve' : `wasmtime ${args[0]}`;
  }
  if (/componentize-qjs/.test(command)) return 'componentize-qjs';
  return args[1] ?? command;
}

export function fakeDeps(options: {
  invocations?: RunnerInvocation[];
  cwd: string;
  assets?: string;
  env?: Record<string, string | undefined>;
  exitCodes?: Record<string, number>;
  captures?: Record<string, string | undefined>;
  capturedStdout?: Record<string, string | undefined>;
  resolutions?: Record<string, string | undefined>;
  bundlerError?: Error;
  bundleContents?: string;
  componentOutput?: (buildNumber: number) => string;
  /** null = no node binary available. */
  nodeBinaryPath?: string | null;
  /** null = no wasmtime binary available. */
  wasmtimeBinaryPath?: string | null;
  /** null = no wash binary available. */
  washBinaryPath?: string | null;
  /** Patched componentize-qjs CLI; undefined uses jco. */
  componentizeQjsPath?: string;
}): WasmcloudDeps {
  const invocations = options.invocations ?? [];
  let componentBuilds = 0;
  const run = async (
    command: string,
    args: readonly string[],
    runOptions: { cwd: string; env?: Record<string, string | undefined> },
    captured: boolean,
  ) => {
    invocations.push({
      command,
      args: [...args],
      cwd: runOptions.cwd,
      env: runOptions.env,
      captured,
    });
    if (args.includes('componentize') || /componentize-qjs/.test(command)) {
      const outputFlag = args.includes('--output') ? '--output' : '-o';
      const outputPath = args[args.indexOf(outputFlag) + 1];
      if (outputPath !== undefined) {
        mkdirSync(dirname(outputPath), { recursive: true });
        componentBuilds += 1;
        writeFileSync(
          outputPath,
          options.componentOutput?.(componentBuilds) ?? 'fake-wasm-component',
        );
      }
    }
    if (args[0] === 'plug') {
      const outputFlag = args.includes('-o') ? '-o' : '--output';
      const outputPath = args[args.indexOf(outputFlag) + 1];
      if (outputPath !== undefined) {
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, 'composed-sqlite-component');
      }
    }
    const key = invocationKey(command, args);
    const kubectlLabelQuery = args.find(
      (arg) => typeof arg === 'string' && arg.startsWith('di-framework.dev/application!='),
    );
    const defaultExit =
      options.exitCodes?.[key] ??
      (key === 'kubectl get secret' ? 1 : command === 'oras' && args[0] === 'manifest' ? 1 : 0);
    return {
      exitCode: defaultExit,
      stdout:
        options.capturedStdout?.[key] ??
        (command === 'kubectl' && args.includes('get') && kubectlLabelQuery
          ? (options.capturedStdout?.['kubectl ownership'] ?? '{"items":[]}')
          : command === 'kubectl' && args.includes('get')
            ? READY_WORKLOAD_JSON
            : ''),
      stderr: '',
    };
  };
  return {
    runner: async (command, args, runOptions) => {
      const result = await run(command, args, runOptions, false);
      return { exitCode: result.exitCode };
    },
    runCaptured: async (command, args, runOptions) => run(command, args, runOptions, true),
    wait: async () => undefined,
    capture: (command) => options.captures?.[command],
    bundler: async ({ outFile }) => {
      if (options.bundlerError) throw options.bundlerError;
      mkdirSync(dirname(outFile), { recursive: true });
      writeFileSync(outFile, options.bundleContents ?? 'export const bundled = true;\n');
    },
    jcoCliPath: () => '/fake/jco.js',
    componentizeQjsPath: () => options.componentizeQjsPath,
    nodeBinaryPath: () =>
      options.nodeBinaryPath === null ? undefined : (options.nodeBinaryPath ?? '/fake/node'),
    wasmtimeBinaryPath: () =>
      options.wasmtimeBinaryPath === null
        ? undefined
        : (options.wasmtimeBinaryPath ?? '/fake/wasmtime'),
    washBinaryPath: () =>
      options.washBinaryPath === null ? undefined : (options.washBinaryPath ?? undefined),
    assetsDirectory: () => options.assets ?? makeAssets(),
    resolveFromProject: (_projectRoot, specifier) => options.resolutions?.[specifier],
    env: options.env ?? {},
    cwd: () => options.cwd,
  };
}

/** Workspace with a deploy manifest, platform Pulumi project, and arbitrarily located apps. */
export function makeWorkspace(
  options: { manifest?: string; env?: Record<string, string | undefined> } = {},
): {
  root: string;
  greeter: string;
  echo: string;
  kubeconfig: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'wasmcloud-workspace-'));
  const kubeconfig = join(root, 'kubeconfig.yaml');
  writeFileSync(kubeconfig, 'apiVersion: v1\nkind: Config\n');
  writeFileSync(
    join(root, 'di-framework.deploy.toml'),
    options.manifest ??
      `default-target = "local"

[targets.local]
platform = "deploy/platform"
stack = "dev"

[targets.development]
kubeconfig = "${kubeconfig}"
context = "team-development"
namespace = "wasmcloud"
registry = "registry.example.com/team"
`,
  );
  mkdirSync(join(root, 'deploy', 'platform'), { recursive: true });
  writeFileSync(
    join(root, 'deploy', 'platform', 'Pulumi.yaml'),
    'name: wasmcloud-platform\nruntime: nodejs\n',
  );
  writeFileSync(
    join(root, 'deploy', 'platform', 'index.ts'),
    'export const kubeconfig = "unused";\n',
  );

  const greeter = join(root, 'services', 'greeter');
  writeProject(greeter, 'greeter');
  const echo = join(root, 'nested', 'deep', 'echo');
  writeProject(echo, 'echo');
  return { root, greeter, echo, kubeconfig };
}

export function writeProject(root: string, name: string): void {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'di-framework.config.json'),
    `${JSON.stringify({ name, entry: 'src/app.ts' })}\n`,
  );
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ name, version: '1.0.0' })}\n`);
  writeFileSync(join(root, 'src', 'app.ts'), 'export default () => new Response("ok");\n');
}

export function platformOutputJson(kubeconfig: string): string {
  return `${JSON.stringify({
    schemaVersion: 2,
    kubeconfig,
    namespace: 'wasmcloud',
    registry: {
      push: 'http://127.0.0.1:25000',
      pull: 'di-framework-registry.wasmcloud.svc.cluster.local:5000',
      insecure: true,
    },
    endpoints: { http: 'http://127.0.0.1:28180' },
  })}\n`;
}

export function expectFailure(run: () => unknown, code: string, exitCode: number): void {
  try {
    run();
  } catch (error) {
    expect(error).toMatchObject({ code, exitCode });
    return;
  }
  throw new Error(`Expected a ${code} failure`);
}
