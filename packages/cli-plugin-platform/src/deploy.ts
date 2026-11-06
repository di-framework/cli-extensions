import type { CliIo, CommandResult } from '@di-framework/cli-extension';
import { type AppCommandOptions, parseAppCommandArgs } from './args';
import { type BuildSummary, buildComponent, type ComponentOrigin } from './build';
import { buildDeployBundle } from './bundle';
import {
  bearer,
  type Deployment,
  type DeployPlan,
  registryOrigin,
  registryUsername,
  resolveControllerSession,
  wrapControllerError,
} from './controller';
import { discoverScheduledJobs } from './cron';
import { DEFAULT_DEPS, type WasmcloudDeps } from './deps';
import { discoverProjects, resolveApplication } from './discovery';
import {
  type AccountTarget,
  type ControllerTarget,
  type DeployEnvironment,
  type DeployManifest,
  loadDeployManifest,
  tenantNamespace,
} from './manifest';
import { assertDistinctPgliteRoots } from './pglite';
import type { WasmcloudProject } from './project';
import { publishComponent } from './publish';
import { materializeRegistry, type RegistryLocation } from './registry';
import { isControllerBackedTarget, resolveConnection, resolveTarget } from './target';
import { applyWorkload, deploymentResourceName } from './workload';
import { writeWorkloadManifest } from './workload-members';

export type WasmcloudDeployData = {
  cronJobs?: Array<{ jobId: string; schedule: string | number; cronExpression: string }>;
  application: string;
  target: string;
  namespace: string;
  registry: RegistryLocation;
  image: string;
  publishedImage: string;
  digest: string;
  deploymentDigest: string;
  service: string;
  env?: DeployEnvironment;
  account?: string;
  controller?: string;
  deployment?: Deployment;
  preview?: DeployPlan;
  http?: { url: string; host: string };
  endpoints?: Record<string, string>;
  /**
   * Where the composed PGlite provider came from (a digest pin or a local file) and, when
   * `pglite.encryption` is set, its encryption layer.
   */
  pglite?: BuildSummary['pglite'];
};

export type WasmcloudDeployResult = Omit<CommandResult, 'data' | 'text'> & {
  data: WasmcloudDeployData;
  text: string;
};

async function runControllerDeploy(
  project: WasmcloudProject,
  target: AccountTarget | ControllerTarget,
  manifest: DeployManifest,
  options: AppCommandOptions,
  io: CliIo,
  deps: WasmcloudDeps,
): Promise<WasmcloudDeployResult> {
  try {
    const { credential, client } = await resolveControllerSession({ target }, deps);
    const registryInfo = await client.registry();
    const regOrigin = registryOrigin(registryInfo.url);
    const username = registryUsername(registryInfo.username);
    const env = options.env ?? target.env ?? manifest.env ?? 'prod';
    const repository = registryInfo.repositoryPrefix
      ? `${registryInfo.repositoryPrefix}/${project.witName}`
      : project.witName;

    io.stdout.write(
      `Deploying ${project.applicationName} to target ${target.name} (${credential.account}/${env})...\n`,
    );
    const bundle = await buildDeployBundle(
      {
        project,
        target: target.name,
        env,
        registry: regOrigin.origin,
        credentials: {
          username,
          password: bearer(credential),
          repository,
        },
      },
      io,
      deps,
    );

    const cronJobs = discoverScheduledJobs(project.projectRoot);
    const namespace = tenantNamespace(credential.account);
    const registry = materializeRegistry(regOrigin.origin);
    const deploymentDigest = bundle.component.digest.replace(/^sha256:/, '');

    if (options.preview) {
      const plan = await client.previewDeploy(bundle);
      const changesSummary =
        plan.changes.length === 0
          ? 'no changes'
          : plan.changes.map((c) => `${c.kind} ${c.resource}/${c.name}`).join(', ');
      const data: WasmcloudDeployData = {
        application: project.applicationName,
        target: target.name,
        namespace,
        registry,
        image: bundle.component.reference,
        publishedImage: bundle.component.reference,
        digest: bundle.component.digest,
        deploymentDigest,
        service: bundle.service,
        env,
        account: credential.account,
        controller: credential.controller.url,
        preview: plan,
      };
      const text = `Previewed ${project.applicationName} in ${plan.env} (${credential.account}): ${changesSummary}.`;
      return { data, text };
    }

    const deployment = await client.deploy(bundle);
    const cronSummary = cronJobs.map((j) => ({
      jobId: j.jobId,
      schedule: j.schedule,
      cronExpression: j.cronExpression,
    }));
    const data: WasmcloudDeployData = {
      application: project.applicationName,
      target: target.name,
      namespace,
      registry,
      image: bundle.component.reference,
      publishedImage: bundle.component.reference,
      digest: bundle.component.digest,
      deploymentDigest,
      service: bundle.service,
      env,
      account: credential.account,
      controller: credential.controller.url,
      deployment,
      ...(cronSummary.length > 0 ? { cronJobs: cronSummary } : {}),
    };
    const cronNote =
      cronJobs.length > 0
        ? ` Scheduled jobs (${cronJobs.length}): ${cronJobs.map((j) => j.jobId).join(', ')}`
        : '';
    const text = `Deployed ${project.applicationName} to ${target.name} (${credential.account}/${deployment.env}: ${deployment.id} ${deployment.status}, ${bundle.component.reference}).${cronNote}`;
    return { data, text };
  } catch (error) {
    wrapControllerError(error);
  }
}

export async function runWasmcloudDeploy(
  args: readonly string[],
  io: CliIo,
  deps: WasmcloudDeps = DEFAULT_DEPS,
): Promise<WasmcloudDeployResult> {
  const options = parseAppCommandArgs(args, 'platform deploy');
  const manifest = loadDeployManifest(deps.cwd(), deps.env);
  const target = resolveTarget(manifest, options.target);
  const project = resolveApplication(
    deps.cwd(),
    options.name,
    manifest.workspaceRoot,
    manifest.discovery,
  );
  if (project.workload) {
    const members = [...discoverProjects(manifest.workspaceRoot, manifest.discovery).values()];
    assertDistinctPgliteRoots(project.workload, members);
    const path = writeWorkloadManifest(manifest.workspaceRoot, project.workload, members);
    io.stdout.write(`Generated workload manifest ${path}\n`);
  }

  if (isControllerBackedTarget(target)) {
    return runControllerDeploy(project, target, manifest, options, io, deps);
  }

  const build = await buildComponent(project, io, deps, { deploy: true });
  const connection = await resolveConnection(target, manifest.workspaceRoot, manifest.path, deps);

  io.stdout.write(`Deploying ${project.applicationName} to target ${connection.target}...\n`);
  const image = await publishComponent(project, connection, io, deps, build.deploymentDigest);
  await applyWorkload(project, connection, image.pullReference, io, deps);
  const service = deploymentResourceName(project);

  const hasHttp = project.ingress !== false;
  const cronJobs = discoverScheduledJobs(project.projectRoot);

  return {
    data: {
      application: project.applicationName,
      target: connection.target,
      namespace: connection.namespace,
      registry: connection.registry,
      image: image.pullReference,
      publishedImage: image.pushReference,
      digest: image.artifactDigest,
      deploymentDigest: image.digest,
      service,
      ...(hasHttp && connection.endpoints?.http !== undefined
        ? { http: { url: connection.endpoints.http, host: project.applicationName } }
        : {}),
      ...(connection.endpoints === undefined ? {} : { endpoints: connection.endpoints }),
      ...(build.pglite === undefined ? {} : { pglite: build.pglite }),
      ...(cronJobs.length > 0
        ? {
            cronJobs: cronJobs.map((j) => ({
              jobId: j.jobId,
              schedule: j.schedule,
              cronExpression: j.cronExpression,
            })),
          }
        : {}),
    },
    text: [
      `Deployed ${project.applicationName} to ${connection.target} (namespace ${connection.namespace}, ${image.pullReference}).`,
      hasHttp && connection.endpoints?.http !== undefined
        ? ` HTTP: ${connection.endpoints.http} with Host: ${project.applicationName}`
        : '',
      pgliteText(build.pglite),
      cronJobs.length > 0
        ? ` Scheduled jobs (${cronJobs.length}): ${cronJobs.map((j) => j.jobId).join(', ')}`
        : '',
    ].join(''),
  };
}

function originText(origin: ComponentOrigin): string {
  return origin.path === undefined ? `${origin.image}` : `local ${origin.path} (unverified)`;
}

function pgliteText(pglite: WasmcloudDeployData['pglite']): string {
  if (pglite === undefined) return '';
  const encryption =
    pglite.encryption === undefined
      ? ''
      : `, encrypted at rest by ${originText(pglite.encryption)}`;
  return ` PGlite: ${originText(pglite)}${encryption}.`;
}
