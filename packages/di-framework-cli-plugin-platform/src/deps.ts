import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformAsync } from '@babel/core';
import asyncToGenerator from '@babel/plugin-transform-async-to-generator';
import { rolldown } from 'rolldown';
import { emptyActorsModule } from './actors';
import { lowerForAwait } from './async-transform';
import { emptyGuestsModule } from './guests';
import { rolldownInject, wasmcloudNodeEnv } from './node-compat/env';
import {
  createNodeCompatSeed,
  EMPTY_NODE_COMPAT_SEED,
  isNodeCompatSeedSource,
  NODE_COMPAT_SEED_ID,
  type NodeCompatSeed,
  renderNodeCompatSeedModule,
} from './node-compat/seed';

export type ProcessRunOptions = {
  cwd: string;
  env?: Record<string, string | undefined>;
};

export type ProcessRunner = (
  command: string,
  args: readonly string[],
  options: ProcessRunOptions,
) => Promise<{ exitCode: number }>;

export type CapturedProcess = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type CapturedRunner = (
  command: string,
  args: readonly string[],
  options: ProcessRunOptions,
) => Promise<CapturedProcess>;

/** First output line of a probe command, or undefined when it is unavailable. */
export type CaptureRunner = (command: string, args: readonly string[]) => string | undefined;

export type BundleOptions = {
  adapterPath: string;
  entryPath: string;
  outFile: string;
  guestsPath?: string;
  actorsPath?: string;
  cronPath?: string;
  queuesPath?: string;
  projectRoot?: string;
  files?: Record<string, string>;
  env?: Record<string, string | undefined>;
  cwd?: string;
};

export type Bundler = (options: BundleOptions) => Promise<void>;

/** Component imports are WIT specifiers, not npm packages. */
export const COMPONENT_IMPORT_EXTERNAL = /^(wasi|wasmcloud|di-framework):/;

/** Every process, filesystem-adjacent, and toolchain boundary the commands touch. */
export type WasmcloudDeps = {
  runner: ProcessRunner;
  capture: CaptureRunner;
  /** Captures stdout/stderr for tools whose output the CLI must parse. */
  runCaptured: CapturedRunner;
  wait(ms: number): Promise<void>;
  bundler: Bundler;
  jcoCliPath(): string;
  /**
   * Optional componentize-qjs CLI built against wasmtime 48+ with
   * `concurrency_support`. Resolved from `DI_FRAMEWORK_COMPONENTIZE_QJS`,
   * `@di-framework/componentize-qjs`, or `PATH`. Stock jco 1.32.1 uses
   * wasmtime 47, which cannot stub imported `async func`s during wizer.
   */
  componentizeQjsPath(): string | undefined;
  /** jco needs real Node.js; it uses node internals Bun does not implement. */
  nodeBinaryPath(): string | undefined;
  /** wasmtime serve hosts WASI 0.3 HTTP components locally. */
  wasmtimeBinaryPath(): string | undefined;
  washBinaryPath(): string | undefined;
  assetsDirectory(): string;
  resolveFromProject(projectRoot: string, specifier: string): string | undefined;
  env: Record<string, string | undefined>;
  cwd(): string;
};

const NODE_COMPAT_SEED_RESOLVED = `\0${NODE_COMPAT_SEED_ID}`;

export type NodeCompatibilityPaths = {
  guestsPath?: string;
  actorsPath?: string;
  cronPath?: string;
  queuesPath?: string;
};

/** Resolves the virtual application module and Node built-ins through unenv. */
export function nodeCompatibilityPlugin(
  entryPath: string,
  guestsPath?: string | NodeCompatibilityPaths,
  seedOrActorsPath?: NodeCompatSeed | string,
  maybeSeed?: NodeCompatSeed,
) {
  let actorsPath: string | undefined;
  let cronPath: string | undefined;
  let queuesPath: string | undefined;
  let resolvedGuestsPath: string | undefined;
  let seed: NodeCompatSeed = EMPTY_NODE_COMPAT_SEED;

  if (guestsPath !== undefined && typeof guestsPath === 'object') {
    resolvedGuestsPath = guestsPath.guestsPath;
    actorsPath = guestsPath.actorsPath;
    cronPath = guestsPath.cronPath;
    queuesPath = guestsPath.queuesPath;
    if (typeof seedOrActorsPath === 'object' && seedOrActorsPath) {
      seed = seedOrActorsPath;
    } else if (maybeSeed) {
      seed = maybeSeed;
    }
  } else {
    resolvedGuestsPath = guestsPath;
    if (typeof seedOrActorsPath === 'string') {
      actorsPath = seedOrActorsPath;
      seed = maybeSeed ?? EMPTY_NODE_COMPAT_SEED;
    } else if (seedOrActorsPath && typeof seedOrActorsPath === 'object') {
      seed = seedOrActorsPath;
    } else if (maybeSeed) {
      seed = maybeSeed;
    }
  }

  const aliases = wasmcloudNodeEnv().alias;
  return {
    name: 'di-framework-component-runtime',
    resolveId(source: string, importer?: string) {
      if (
        resolvedGuestsPath &&
        importer === resolvedGuestsPath &&
        /^[a-z][a-z0-9-]*-(query|prepared)$/.test(source)
      )
        return { id: source, external: true };
      if (source === 'virtual:di-framework-application') return entryPath;
      if (source === 'virtual:di-framework-wasmcloud-runtime') {
        return join(
          dirname(fileURLToPath(import.meta.url)),
          'node-compat',
          `runtime-application.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`,
        );
      }
      if (source === 'virtual:di-framework-wasmcloud-guests') {
        return resolvedGuestsPath ?? '\0virtual:di-framework-wasmcloud-guests-empty';
      }
      if (source === 'virtual:di-framework-wasmcloud-actors') {
        return actorsPath ?? '\0virtual:di-framework-wasmcloud-actors-empty';
      }
      if (source === 'virtual:di-framework-wasmcloud-cron') {
        return cronPath ?? '\0virtual:di-framework-wasmcloud-cron-empty';
      }
      if (source === 'virtual:di-framework-wasmcloud-queues') {
        return queuesPath ?? '\0virtual:di-framework-wasmcloud-queues-empty';
      }
      if (isNodeCompatSeedSource(source)) return NODE_COMPAT_SEED_RESOLVED;
      return aliases[source] ?? null;
    },
    load(id: string) {
      if (id === '\0virtual:di-framework-wasmcloud-guests-empty') return emptyGuestsModule();
      if (id === '\0virtual:di-framework-wasmcloud-actors-empty') return emptyActorsModule();
      if (id === '\0virtual:di-framework-wasmcloud-cron-empty') {
        return 'export async function invokeJob() { throw new Error("No cron jobs registered"); }\n';
      }
      if (id === '\0virtual:di-framework-wasmcloud-queues-empty') {
        return 'export function getQueueBackend() { return undefined; }\nexport async function ensureQueueWorkers() {}\nexport async function pumpQueueWorkers() { return 0; }\n';
      }
      if (id === NODE_COMPAT_SEED_RESOLVED) return renderNodeCompatSeedModule(seed);
      return null;
    },
  };
}

/** Points at a wasmtime-48+ componentize-qjs CLI that can stub imported `async func`s. */
export const COMPONENTIZE_QJS_ENV = 'DI_FRAMEWORK_COMPONENTIZE_QJS';

/** npm wrapper that selects the matching optional platform CLI package. */
export const COMPONENTIZE_QJS_PACKAGE = '@di-framework/componentize-qjs';

// Real path, not a store symlink, so walking up reaches this package's node_modules.
const packageRoot = resolve(dirname(realpathSync(fileURLToPath(import.meta.url))), '..');

export function componentizeQjsPlatformPackageName(): string {
  return COMPONENTIZE_QJS_PACKAGE;
}

export function componentizeQjsPlatformPackageVersion(
  platform = process.platform,
  arch = process.arch,
  wrapperVersion = '0.4.4-di.3',
): string {
  return `${wrapperVersion}-${platform}-${arch}`;
}

function platformPackageBinMatches(
  packageDirectory: string,
  platform: string,
  arch: string,
): boolean {
  const packageJsonPath = join(packageDirectory, 'package.json');
  if (!existsSync(packageJsonPath)) return true;
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      os?: string[];
      cpu?: string[];
      version?: string;
    };
    if (Array.isArray(pkg.os) && pkg.os.length > 0 && !pkg.os.includes(platform)) {
      return false;
    }
    if (Array.isArray(pkg.cpu) && pkg.cpu.length > 0 && !pkg.cpu.includes(arch)) {
      return false;
    }
    if (
      typeof pkg.version === 'string' &&
      /-(?:darwin|linux|win32|android)-(?:arm64|x64)$/.test(pkg.version)
    ) {
      return pkg.version.endsWith(`-${platform}-${arch}`);
    }
  } catch {
    return true;
  }
  return true;
}

/**
 * Locate the native CLI shipped as `@di-framework/componentize-qjs@<version>-<os>-<arch>`.
 * Walks `node_modules` from `startDirectory` (same strategy as `findJcoEntry`)
 * so Bun's install cache is not required. The wrapper aliases that version into
 * an unscoped `componentize-qjs-<os>-<arch>` folder.
 */
export function findInstalledComponentizeQjsCli(
  startDirectory = packageRoot,
  platform = process.platform,
  arch = process.arch,
): string | undefined {
  const packageDirectories = (nodeModules: string) => [
    join(nodeModules, `componentize-qjs-${platform}-${arch}`),
    join(nodeModules, '@di-framework', 'componentize-qjs'),
  ];
  const binName = platform === 'win32' ? 'componentize-qjs.exe' : 'componentize-qjs';
  let previous = '';
  let current = startDirectory;
  while (current !== previous) {
    for (const packageDirectory of packageDirectories(join(current, 'node_modules'))) {
      const bin = join(packageDirectory, 'bin', binName);
      if (existsSync(bin) && platformPackageBinMatches(packageDirectory, platform, arch)) {
        return bin;
      }
    }
    previous = current;
    current = dirname(current);
  }
  try {
    const require = createRequire(join(startDirectory, 'package.json'));
    const loaded = require(COMPONENTIZE_QJS_PACKAGE) as {
      nativeCliPath?: (os?: string, cpu?: string) => string | undefined;
    };
    const fromPackage = loaded.nativeCliPath?.(platform, arch);
    return fromPackage !== undefined && existsSync(fromPackage) ? fromPackage : undefined;
  } catch {
    return undefined;
  }
}

export function resolveComponentizeQjsPath(
  env: Record<string, string | undefined> = process.env,
  installedCliPath?: string,
  pathCli?: string,
): string | undefined {
  const explicit = env[COMPONENTIZE_QJS_ENV]?.trim();
  if (explicit !== undefined && explicit !== '') return explicit;
  return installedCliPath ?? pathCli;
}

/** PATH entries inside node_modules are the npm wrapper, not a native wasmtime-48 CLI. */
export function nativeComponentizeQjsOnPath(
  whichPath = Bun.which('componentize-qjs') ?? undefined,
): string | undefined {
  if (whichPath === undefined) return undefined;
  if (whichPath.split(/[/\\]/).includes('node_modules')) return undefined;
  return whichPath;
}

/**
 * jco's entry inside a real node_modules tree, walking up from this package.
 * Bun's `import.meta.resolve` can return its global install cache, where jco's
 * own dependencies are not resolvable by Node; a node_modules path always is.
 */
export function findJcoEntry(startDirectory: string): string | undefined {
  let previous = '';
  let current = startDirectory;
  while (current !== previous) {
    const candidates = [
      join(current, 'node_modules', '@bytecodealliance', 'jco', 'dist', 'jco.js'),
      join(current, 'node_modules', '@bytecodealliance', 'jco', 'src', 'jco.js'),
    ];
    const candidate = candidates.find((path) => existsSync(path));
    if (candidate !== undefined) return candidate;
    previous = current;
    current = dirname(current);
  }
  return undefined;
}

export const DEFAULT_DEPS: WasmcloudDeps = {
  runner: async (command, args, options) => {
    const child = Bun.spawn([command, ...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['inherit', 'inherit', 'inherit'],
    });
    return { exitCode: await child.exited };
  },
  capture: (command, args) => {
    // Bounded so a wedged tool (e.g. docker with an unreachable daemon) reads as unavailable.
    const result = spawnSync(command, args as string[], { encoding: 'utf8', timeout: 5_000 });
    if (result.error || result.status !== 0) return undefined;
    return (result.stdout || result.stderr).trim().split('\n')[0];
  },
  runCaptured: async (command, args, options) => {
    const child = Bun.spawn([command, ...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    return { exitCode: await child.exited, stdout, stderr };
  },
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  bundler: async ({
    adapterPath,
    entryPath,
    outFile,
    guestsPath,
    actorsPath,
    cronPath,
    queuesPath,
    projectRoot,
    files,
    env,
    cwd,
  }) => {
    const nodeEnv = wasmcloudNodeEnv();
    const bundle = await rolldown({
      input: 'virtual:di-framework-runtime-entry',
      external: COMPONENT_IMPORT_EXTERNAL,
      resolve: { alias: { ...nodeEnv.alias }, conditionNames: ['wasmcloud', 'import', 'default'] },
      plugins: [
        {
          name: 'di-framework-runtime-bootstrap',
          resolveId(id) {
            if (id === 'virtual:di-framework-runtime-entry') return `\0${id}`;
          },
          load(id) {
            if (id === '\0virtual:di-framework-runtime-entry') {
              const bootstrap = join(
                dirname(fileURLToPath(import.meta.url)),
                'node-compat',
                `bootstrap.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`,
              );
              return `import ${JSON.stringify(bootstrap)}; export * from ${JSON.stringify(adapterPath)};`;
            }
          },
        },
        nodeCompatibilityPlugin(
          entryPath,
          { guestsPath, actorsPath, cronPath, queuesPath },
          createNodeCompatSeed({ files, env, cwd, projectRoot }),
        ),
      ],
      transform: {
        decorator: { legacy: true },
        inject: rolldownInject(nodeEnv.inject),
      },
      // Registration modules and application initialization are observable side effects.
      treeshake: { moduleSideEffects: true },
    });
    try {
      await bundle.write({
        file: outFile,
        format: 'esm',
        codeSplitting: false,
        plugins: [
          {
            name: 'di-framework-async-context',
            async renderChunk(code) {
              // Transform async functions only. Broad ES2016 lowering changes the
              // prototype of async generators used by unenv's EventEmitter.
              const transformed = await transformAsync(code, {
                babelrc: false,
                configFile: false,
                sourceType: 'module',
                plugins: [lowerForAwait, asyncToGenerator],
              });
              if (!transformed?.code) throw new Error('Failed to lower guest async functions');
              return { code: transformed.code, map: null };
            },
          },
        ],
      });
    } finally {
      await bundle.close();
    }
  },
  jcoCliPath: () =>
    findJcoEntry(packageRoot) ??
    join(dirname(fileURLToPath(import.meta.resolve('@bytecodealliance/jco'))), 'jco.js'),
  componentizeQjsPath: () =>
    resolveComponentizeQjsPath(
      process.env,
      findInstalledComponentizeQjsCli(),
      nativeComponentizeQjsOnPath(),
    ),
  nodeBinaryPath: () => Bun.which('node') ?? undefined,
  wasmtimeBinaryPath: () => Bun.which('wasmtime') ?? undefined,
  washBinaryPath: () => Bun.which('wash') ?? undefined,
  // Assets ship transpiled under dist/assets; src and dist are siblings of it.
  assetsDirectory: () => join(packageRoot, 'dist', 'assets'),
  resolveFromProject: (projectRoot, specifier) => {
    try {
      return createRequire(join(projectRoot, 'package.json')).resolve(specifier);
    } catch {
      return undefined;
    }
  },
  env: process.env,
  cwd: () => process.cwd(),
};
