import { createHash, type Hash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type CliIo, CommandFailure, type CommandResult } from '@di-framework/cli-extension';
import { discoverActors, renderActorsModule } from './actors';
import { type BindingRecord, discoverBindings, requirementsFromBindings } from './bindings';
import {
  type ComponentProvider,
  copyProviderWit,
  discoverComponentProviders,
  providerNamespaces,
  providerRequirementsFromJavaScript,
  providersToCompose,
} from './components';
import { discoverScheduledJobs, renderCronAdapterModule, renderCronInvokerModule } from './cron';
import { DEFAULT_DEPS, type WasmcloudDeps } from './deps';
import { renderGuestsModule } from './guests';
import { OCI_ARTIFACT_PLATFORM } from './oci';
import { loadProject, type WasmcloudProject } from './project';
import { discoverQueueHandlers, isQueueWorkerProject } from './queues';
import { renderQueuesModule } from './queues-module';
import { invalidUsage, requireNodeBinary, toolFailed } from './support';
import {
  buildWitLock,
  COMPONENT_MODEL,
  defaultProjectRequirements,
  digestBytes,
  queueProjectRequirements,
  renderWorldWit,
  runtimeRequirementsFromJavaScript,
  sqliteProjectRequirements,
  WASI_HTTP_INTERFACE,
  WASI_HTTP_VERSION,
  type WitLock,
  type WitRequirement,
} from './wit';
import { renderWorkloadServiceAdapter } from './workload-members';

export { COMPONENT_MODEL, WASI_HTTP_INTERFACE, WASI_HTTP_VERSION };
export const BUILD_PROFILE_NAME = 'wasmcloud-http';
export const CRON_BUILD_PROFILE_NAME = 'wasmcloud-cron';
export { BUILD_PROFILE_NAME as BUILD_PROFILE };

export type BuildSummary = {
  application: string;
  artifactDigest: string;
  component: string;
  componentModel: string;
  deploymentDigest: string;
  entry: string;
  profile: string;
  actors?: string[];
};

export function requirementsForProject(
  project: WasmcloudProject,
  deps: WasmcloudDeps = DEFAULT_DEPS,
): WitRequirement[] {
  const bindings = discoverBindings(project, deps);
  const queueHandlers = discoverQueueHandlers(project);
  const isWorker = isQueueWorkerProject(project, queueHandlers);
  const cronJobs = discoverScheduledJobs(project.projectRoot);
  const actors = discoverActors(project);
  const needsControlHttp =
    isWorker || cronJobs.length > 0 || queueHandlers.length > 0 || actors.length > 0;
  const hasHttp = (project.ingress !== false && !isWorker) || needsControlHttp;
  const service = project.workloadEntry?.kind === 'service' ? project.workloadEntry : undefined;
  const baseRequirements: WitRequirement[] = service?.subscriptions
    ? [
        {
          package: 'wasmcloud:messaging',
          version: '0.3.0',
          interfaces: ['handler'],
          direction: 'export',
          source: 'workload-service',
        },
      ]
    : isWorker
      ? queueProjectRequirements()
      : hasHttp
        ? defaultProjectRequirements()
        : [
            {
              package: 'wasi:cli',
              version: '0.3.0',
              interfaces: ['run'],
              direction: 'export' as const,
              source: 'cron-adapter',
            },
          ];
  return [...baseRequirements, ...requirementsFromBindings(bindings)];
}

function writeGuestsModule(generatedDirectory: string, bindings: readonly BindingRecord[]): void {
  writeFileSync(join(generatedDirectory, 'guests.js'), renderGuestsModule(bindings));
}

async function runComponentize(
  project: WasmcloudProject,
  generatedWit: string,
  bundledJavaScript: string,
  deps: WasmcloudDeps,
): Promise<{ exitCode: number; tool: string }> {
  const qjsCli = deps.componentizeQjsPath();
  if (qjsCli !== undefined) {
    const result = await deps.runner(
      qjsCli,
      [
        '--wit',
        generatedWit,
        '--js',
        bundledJavaScript,
        '-n',
        'application',
        '-o',
        project.outputPath,
      ],
      { cwd: project.projectRoot },
    );
    return { exitCode: result.exitCode, tool: 'componentize-qjs' };
  }
  const result = await deps.runner(
    requireNodeBinary(deps.nodeBinaryPath()),
    [
      deps.jcoCliPath(),
      'componentize',
      '--backend',
      'qjs',
      '-w',
      generatedWit,
      '-n',
      'application',
      '-o',
      project.outputPath,
      bundledJavaScript,
    ],
    { cwd: project.projectRoot },
  );
  return { exitCode: result.exitCode, tool: 'jco componentize' };
}

function isWasmMagic(path: string): boolean {
  const header = readFileSync(path).subarray(0, 4);
  return (
    header.length === 4 &&
    header[0] === 0 &&
    header[1] === 0x61 &&
    header[2] === 0x73 &&
    header[3] === 0x6d
  );
}

function sqliteToolsBin(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const fromEnv = process.env.DF_SQLITE_TOOLS_DIR;
  const candidates = [
    fromEnv ? join(fromEnv, 'bin') : undefined,
    join(here, '..', '..', 'di-framework-sqlite-component', '.tools', 'bin'),
    join(here, '..', '..', '..', '..', 'platform', 'platform', 'sqlite-component', '.tools', 'bin'),
    join(
      here,
      '..',
      '..',
      '..',
      '..',
      'di-framework',
      'packages',
      'di-framework-sqlite-component',
      '.tools',
      'bin',
    ),
  ].filter((path): path is string => path !== undefined);
  return candidates.find((path) => existsSync(join(path, 'wac')));
}

async function composeSqliteProvider(
  project: WasmcloudProject,
  deps: WasmcloudDeps,
  io: CliIo,
  namedImports = false,
): Promise<void> {
  const provider = join(deps.assetsDirectory(), 'sqlite', 'di-framework-sqlite.wasm');
  if (!existsSync(provider)) {
    throw new CommandFailure(
      'WASMCLOUD_SQLITE_PROVIDER_MISSING',
      `Packaged SQLite provider missing at ${provider}`,
      3,
      { application: project.applicationName },
    );
  }
  await composeProvider(project, deps, io, {
    label: 'di-framework:sqlite',
    wasm: provider,
    namedImports,
    failureCode: 'WASMCLOUD_SQLITE_COMPOSE_FAILED',
  });
}

async function composeComponentProvider(
  project: WasmcloudProject,
  deps: WasmcloudDeps,
  io: CliIo,
  provider: ComponentProvider,
  namedImports = false,
): Promise<void> {
  if (!existsSync(provider.wasm)) {
    throw new CommandFailure(
      'WASMCLOUD_COMPONENT_PROVIDER_MISSING',
      `Dependency ${provider.dependency} declares component ${provider.wasm}, which does not exist`,
      3,
      { application: project.applicationName, dependency: provider.dependency },
    );
  }
  await composeProvider(project, deps, io, {
    label: `${provider.package}@${provider.version} (${provider.dependency})`,
    wasm: provider.wasm,
    namedImports,
    failureCode: 'WASMCLOUD_COMPONENT_COMPOSE_FAILED',
  });
}

/**
 * Plugs one provider component into the built guest: `wac plug`, or the
 * componentize-qjs composer when the guest has named imports to preserve.
 */
async function composeProvider(
  project: WasmcloudProject,
  deps: WasmcloudDeps,
  io: CliIo,
  options: { label: string; wasm: string; namedImports: boolean; failureCode: string },
): Promise<void> {
  const composed = `${project.outputPath}.composed`;
  const toolsBin = sqliteToolsBin();
  const envPath = [toolsBin, process.env.PATH ?? ''].filter(Boolean).join(':');
  const wac =
    deps.capture('wac', ['--version']) !== undefined
      ? 'wac'
      : toolsBin
        ? join(toolsBin, 'wac')
        : 'wac';
  io.stdout.write(`Composing ${options.label} provider...\n`);
  const compiler = options.namedImports ? deps.componentizeQjsPath() : undefined;
  if (options.namedImports && !compiler)
    throw new CommandFailure(
      'WASMCLOUD_COMPILER_REQUIRED',
      'Managed PostgreSQL requires componentize-qjs 0.4.4-di.3 or newer',
      3,
    );
  const result = await deps.runCaptured(
    compiler ?? wac,
    compiler
      ? ['compose', project.outputPath, '--definition', options.wasm, '-o', composed]
      : ['plug', '--plug', options.wasm, project.outputPath, '-o', composed],
    { cwd: project.projectRoot, env: { ...process.env, PATH: envPath } },
  );
  if (result.exitCode !== 0) {
    throw new CommandFailure(
      options.failureCode,
      `Composition of ${options.label} failed: ${result.stderr || result.stdout}`,
      3,
      { application: project.applicationName, exitCode: result.exitCode },
    );
  }
  writeFileSync(project.outputPath, readFileSync(composed));
  rmSync(composed, { force: true });
}

async function inspectComponentImports(
  project: WasmcloudProject,
  requirements: readonly WitRequirement[],
  deps: WasmcloudDeps,
): Promise<void> {
  if (!isWasmMagic(project.outputPath)) return;
  const captured = await deps.runCaptured(
    requireNodeBinary(deps.nodeBinaryPath()),
    [deps.jcoCliPath(), 'wit', project.outputPath],
    { cwd: project.projectRoot },
  );
  if (captured.exitCode !== 0) {
    throw new CommandFailure(
      'WASMCLOUD_COMPONENT_IMPORTS_UNREADABLE',
      `Could not inspect component imports for ${project.applicationName}`,
      3,
      { application: project.applicationName },
    );
  }
  const wit = `${captured.stdout}\n${captured.stderr}`;
  for (const requirement of requirements) {
    if (requirement.direction !== 'import') continue;
    for (const iface of requirement.interfaces) {
      const needle = `${requirement.package}/${iface}@${requirement.version}`;
      if (!wit.includes(needle)) {
        throw new CommandFailure(
          'WASMCLOUD_COMPONENT_IMPORTS_MISMATCH',
          `Compiled component is missing declared import ${needle} (binding ${requirement.source})`,
          3,
          { application: project.applicationName, source: requirement.source, iface },
        );
      }
    }
  }
}

/** The disposable `.di-framework/` build directory: WIT world, bundle, and manifests. */
export async function buildComponent(
  project: WasmcloudProject,
  io: CliIo,
  deps: WasmcloudDeps,
  options: { guestLogging?: boolean } = {},
): Promise<BuildSummary> {
  const generatedDirectory = join(project.projectRoot, '.di-framework');
  const generatedWit = join(generatedDirectory, 'wit');
  const bundledJavaScript = join(generatedDirectory, 'component.js');
  const bindings = discoverBindings(project, deps);
  const cronJobs = discoverScheduledJobs(project.projectRoot);
  const isWorker = isQueueWorkerProject(project, discoverQueueHandlers(project));
  const queueHandlers = discoverQueueHandlers(project);
  const needsControlHttp = isWorker || cronJobs.length > 0;
  const hasHttp = (project.ingress !== false && !isWorker) || needsControlHttp;
  const profile =
    project.workloadEntry?.kind === 'service'
      ? 'wasmcloud-service'
      : isWorker
        ? 'wasmcloud-worker'
        : hasHttp
          ? BUILD_PROFILE_NAME
          : CRON_BUILD_PROFILE_NAME;
  const actors = discoverActors(project);
  const requirements = requirementsForProject(project, deps);
  if (actors.length > 0) {
    for (const requirement of sqliteProjectRequirements()) {
      if (
        !requirements.some(
          (entry) =>
            entry.package === requirement.package &&
            entry.interfaces.join(',') === requirement.interfaces.join(','),
        )
      ) {
        requirements.push(requirement);
      }
    }
  }

  const providers = discoverComponentProviders(project.projectRoot);

  rmSync(generatedDirectory, { recursive: true, force: true });
  mkdirSync(join(generatedWit, 'deps'), { recursive: true });
  mkdirSync(dirname(project.outputPath), { recursive: true });
  cpSync(join(deps.assetsDirectory(), 'wit', 'deps'), join(generatedWit, 'deps'), {
    recursive: true,
  });
  copyProviderWit(providers, join(generatedWit, 'deps'));

  writeFileSync(
    join(generatedWit, 'world.wit'),
    renderWorldWit(project.witName, project.version, requirements),
  );
  let lock = buildWitLock(requirements, join(generatedWit, 'deps'));
  writeFileSync(join(generatedDirectory, 'wit.lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
  writeFileSync(
    join(generatedDirectory, 'oci-config.json'),
    `${JSON.stringify(OCI_ARTIFACT_PLATFORM, null, 2)}\n`,
  );
  if (bindings.length > 0) writeGuestsModule(generatedDirectory, bindings);
  if (cronJobs.length > 0) {
    writeFileSync(join(generatedDirectory, 'cron.json'), `${JSON.stringify(cronJobs, null, 2)}\n`);
  }
  if (cronJobs.length > 0 || !hasHttp) {
    writeFileSync(join(generatedDirectory, 'cron-invoker.js'), renderCronInvokerModule(cronJobs));
  }
  if (!hasHttp && !isWorker) {
    const service = project.workloadEntry?.kind === 'service' ? project.workloadEntry : undefined;
    writeFileSync(
      join(generatedDirectory, 'cron-adapter.js'),
      service ? renderWorkloadServiceAdapter(service) : renderCronAdapterModule(cronJobs),
    );
  }
  if (actors.length > 0)
    writeFileSync(join(generatedDirectory, 'actors.js'), renderActorsModule(actors));
  if (queueHandlers.length > 0) {
    writeFileSync(join(generatedDirectory, 'queues.js'), renderQueuesModule(queueHandlers));
  }

  let applicationEntry = project.entryPath;
  if (project.workloadEntry?.kind === 'component') {
    applicationEntry = join(generatedDirectory, 'application-entry.js');
    const entry = project.workloadEntry;
    writeFileSync(
      applicationEntry,
      [
        `import { ${entry.exportName} as invoke } from ${JSON.stringify(project.entryPath)};`,
        `export * from ${JSON.stringify(project.entryPath)};`,
        `export default function fetch(request) {`,
        ...(entry.path && entry.path !== '/'
          ? [
              `  if (new URL(request.url).pathname !== ${JSON.stringify(entry.path)}) return new Response(null, { status: 404 });`,
            ]
          : []),
        `  return invoke(request);`,
        `}`,
        '',
      ].join('\n'),
    );
  }
  io.stdout.write(`Building ${project.applicationName}...\n`);
  try {
    await deps.bundler({
      adapterPath: hasHttp
        ? join(deps.assetsDirectory(), 'http-adapter.js')
        : join(generatedDirectory, 'cron-adapter.js'),
      entryPath: applicationEntry,
      outFile: bundledJavaScript,
      guestsPath: bindings.length > 0 ? join(generatedDirectory, 'guests.js') : undefined,
      actorsPath: actors.length > 0 ? join(generatedDirectory, 'actors.js') : undefined,
      cronPath: cronJobs.length > 0 ? join(generatedDirectory, 'cron-invoker.js') : undefined,
      queuesPath: queueHandlers.length > 0 ? join(generatedDirectory, 'queues.js') : undefined,
      projectRoot: project.projectRoot,
      // `"logs": false` wins over the caller: the guest keeps the noop console.
      guestLogging: project.logs === false ? false : options.guestLogging,
      externalNamespaces: providerNamespaces(providers),
    });
  } catch (error) {
    throw new CommandFailure(
      'WASMCLOUD_BUILD_FAILED',
      `Bundling failed: ${error instanceof Error ? error.message : String(error)}`,
      3,
      { entry: relative(project.projectRoot, project.entryPath) },
    );
  }

  const bundledSource = readFileSync(bundledJavaScript, 'utf8');
  const runtimeRequirements = [
    ...runtimeRequirementsFromJavaScript(bundledSource),
    ...providerRequirementsFromJavaScript(bundledSource, providers),
  ];
  const finalRequirements = [...requirements, ...runtimeRequirements];
  if (runtimeRequirements.length > 0) {
    writeFileSync(
      join(generatedWit, 'world.wit'),
      renderWorldWit(project.witName, project.version, finalRequirements),
    );
    lock = buildWitLock(finalRequirements, join(generatedWit, 'deps'));
    writeFileSync(join(generatedDirectory, 'wit.lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
  }

  const componentize = await runComponentize(project, generatedWit, bundledJavaScript, deps);
  if (componentize.exitCode !== 0) {
    throw toolFailed(componentize.tool, componentize.exitCode);
  }

  const needsSqliteCompose = finalRequirements.some(
    (requirement) =>
      requirement.package === 'di-framework:sqlite' && requirement.direction === 'import',
  );
  const namedImports = finalRequirements.some((r) => r.namedImport);
  if (needsSqliteCompose) {
    await composeSqliteProvider(project, deps, io, namedImports);
  }
  const composedProviders = providersToCompose(providers, finalRequirements);
  for (const provider of composedProviders) {
    await composeComponentProvider(project, deps, io, provider, namedImports);
  }
  const composedPackages = new Set(composedProviders.map((provider) => provider.package));

  await inspectComponentImports(
    project,
    finalRequirements.filter(
      (requirement) =>
        !(
          requirement.direction === 'import' &&
          (requirement.package === 'di-framework:sqlite' ||
            composedPackages.has(requirement.package))
        ),
    ),
    deps,
  );

  const deploymentDigest = canonicalBuildDigest(
    bundledJavaScript,
    generatedWit,
    join(generatedDirectory, 'oci-config.json'),
    lock,
    profile,
    needsSqliteCompose
      ? join(deps.assetsDirectory(), 'sqlite', 'di-framework-sqlite.wasm')
      : undefined,
    composedProviders.map((provider) => provider.wasm),
  );
  const artifactDigest = digestBytes(readFileSync(project.outputPath));
  const summary: BuildSummary = {
    application: project.applicationName,
    artifactDigest,
    component: relative(project.projectRoot, project.outputPath),
    componentModel: COMPONENT_MODEL,
    deploymentDigest,
    entry: relative(project.projectRoot, project.entryPath),
    profile,
    ...(actors.length > 0 ? { actors: actors.map((a) => a.actorName) } : {}),
  };
  writeFileSync(
    join(generatedDirectory, 'build.json'),
    `${JSON.stringify({ schemaVersion: 1, ...summary }, null, 2)}\n`,
  );

  io.stdout.write(`Built ${summary.component}\n`);
  return summary;
}

/**
 * Stable logical version for deployment. ComponentizeJS snapshots can contain
 * nondeterministic engine bytes, so the rollout key is the canonical bundle,
 * WIT lock, OCI configuration, pinned build profile, and (when composed) the
 * pinned SQLite provider artifact — not the final componentize output bytes.
 */
export function canonicalBuildDigest(
  bundledJavaScript: string,
  witDirectory: string,
  ociConfig: string,
  lock: WitLock,
  profile: string = BUILD_PROFILE_NAME,
  sqliteProvider?: string,
  composedProviders: readonly string[] = [],
): string {
  const hash = createHash('sha256');
  addDigestEntry(hash, 'profile', `${profile}\n${COMPONENT_MODEL}`);
  addDigestEntry(hash, 'wit-lock', JSON.stringify(lock));
  addDigestEntry(hash, 'bundle', readFileSync(bundledJavaScript));
  addDigestEntry(hash, 'oci-config', readFileSync(ociConfig));
  for (const file of listFiles(witDirectory)) {
    const name = relative(witDirectory, file).split(sep).join('/');
    addDigestEntry(hash, `wit/${name}`, readFileSync(file));
  }
  if (sqliteProvider !== undefined) {
    addDigestEntry(hash, 'sqlite-provider', readFileSync(sqliteProvider));
  }
  for (const provider of composedProviders) {
    addDigestEntry(hash, `component-provider/${basename(provider)}`, readFileSync(provider));
  }
  return hash.digest('hex');
}

function addDigestEntry(hash: Hash, name: string, content: string | Buffer): void {
  const bytes = typeof content === 'string' ? Buffer.from(content) : content;
  hash.update(`${name.length}:${name}:${bytes.length}:`);
  hash.update(bytes);
}

function listFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  walk(root);
  return files.sort();
}

export async function runWasmcloudBuild(
  args: readonly string[],
  io: CliIo,
  deps: WasmcloudDeps = DEFAULT_DEPS,
): Promise<CommandResult> {
  if (args.length > 0) {
    invalidUsage(`platform build does not accept arguments: ${args[0]}`, args[0] ?? '');
  }
  const project = loadProject(deps.cwd());
  const summary = await buildComponent(project, io, deps);
  return { data: { ...summary }, text: `Built ${summary.component}` };
}
