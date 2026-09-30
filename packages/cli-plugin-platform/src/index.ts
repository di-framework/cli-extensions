export {
  type DiscoveredCronJob,
  discoverScheduledJobs,
  discoverScheduledJobsInFile,
  normalizeCronExpression,
  renderCronAdapterModule,
  renderCronInvokerModule,
} from './cron';

import { defineExtension } from '@di-framework/cli-extension';
import { createWasmcloudCommand } from './command';

export {
  ACTORS_INVOCATION_PATH,
  type ActorDiscoveredRecord,
  type ActorMethodRecord,
  type ActorModuleOptions,
  createWasmcloudActorAdapter,
  discoverActors,
  emptyActorsModule,
  handleActorInvocationRequest,
  isActorInvocationRequest,
  renderActorsModule,
  WASMCLOUD_ACTORS_GLOBAL,
  type WasmcloudActorAdapter,
} from './actors';
export { parseAppCommandArgs, parsePlatformCommandArgs, parsePlatformInitArgs } from './args';
export {
  type BindingRecord,
  defaultSecretName,
  discoverBindings,
  parseBindingsFile,
  requirementsFromBindings,
} from './bindings';
export {
  BUILD_PROFILE,
  buildComponent,
  canonicalBuildDigest,
  requirementsForProject,
  runWasmcloudBuild,
  WASI_HTTP_INTERFACE,
  WASI_HTTP_VERSION,
} from './build';
export { createWasmcloudCommand } from './command';
export { runWasmcloudConsole } from './console/run';
export {
  runWasmcloudDeploy,
  type WasmcloudDeployData,
  type WasmcloudDeployResult,
} from './deploy';
export {
  type BundleOptions,
  COMPONENT_IMPORT_EXTERNAL,
  COMPONENTIZE_QJS_ENV,
  COMPONENTIZE_QJS_PACKAGE,
  componentizeQjsPlatformPackageName,
  DEFAULT_DEPS,
  findInstalledComponentizeQjsCli,
  nativeComponentizeQjsOnPath,
  nodeCompatibilityPlugin,
  resolveComponentizeQjsPath,
  type WasmcloudDeps,
} from './deps';
export { runWasmcloudDestroy } from './destroy';
export { parseDevArgs, runWasmcloudDev } from './dev';
export {
  DEV_RUNNER_ENV,
  requiresWasmCloudHost,
  resolveDevRunner,
} from './dev-runner';
export {
  discoverProjects,
  findConfigFiles,
  resolveApplication,
} from './discovery';
export { runWasmcloudDoctor } from './doctor';
export { emptyGuestsModule, renderGuestsModule, WASMCLOUD_GUESTS_GLOBAL } from './guests';
export { hostInterfacesFromRequirements } from './host-interface';
export {
  DEPLOY_MANIFEST_NAME,
  type DeployManifest,
  type DeployTarget,
  loadDeployManifest,
  parseDeployManifest,
} from './manifest';
export { wasmcloudNodeEnv, wasmcloudUnenvPreset } from './node-compat/env';
export {
  compactEnviron,
  createNodeCompatSeed,
  NODE_COMPAT_SEED_ID,
  type NodeCompatSeed,
} from './node-compat/seed';
export { OCI_ARTIFACT_PLATFORM } from './oci';
export {
  loadPlatformOutputs,
  PLATFORM_OUTPUT_SCHEMA_VERSION,
  type PlatformOutputs,
  resolvePlatformDirectory,
  runWasmcloudPlatformDeploy,
  runWasmcloudPlatformDestroy,
} from './platform';
export {
  createPlatformProjectName,
  LOCAL_PLATFORM_PATH,
  PLATFORM_PROJECT_TOKEN,
  PLATFORM_START_COMMAND,
  runWasmcloudPlatformInit,
} from './platform-init';
export {
  asWitIdentifier,
  CONFIG_FILE_NAME,
  findUp,
  loadProject,
  resolveInside,
  type WasmcloudProject,
} from './project';
export { contentDigest, ociReference, projectRelativePath, publishComponent } from './publish';
export { pulumiEnvironment, runPulumi } from './pulumi';
export {
  type DiscoveredQueueHandler,
  discoverQueueHandlers,
  isQueueWorkerProject,
  parseQueueHandlersInFile,
} from './queues';
export {
  materializeRegistry,
  type RegistryInput,
  type RegistryLocation,
  registryReferenceHost,
  registryUsesPlainHttp,
} from './registry';
export {
  BACKING_SERVICE_API_VERSION,
  BACKING_SERVICE_KIND,
  BACKING_SERVICE_RESOURCE,
  buildBackingServiceManifest,
  DEFAULT_SERVICE_CLASSES,
  isBackingServiceName,
  isServiceType,
  parseServiceCreateArgs,
  parseServiceListArgs,
  parseServiceNameArgs,
  runWasmcloudServiceClasses,
  runWasmcloudServiceCreate,
  runWasmcloudServiceDelete,
  runWasmcloudServiceGet,
  runWasmcloudServiceList,
  SERVICE_TYPES,
  summarizeService,
} from './service';
export { resolveConnection, resolveTarget } from './target';
export { renderWashDevYaml, writeWashDevConfig } from './wash-dev';
export {
  aggregateRequirements,
  COMPONENT_MODEL,
  DI_QUEUES_INTERFACE,
  DI_QUEUES_PACKAGE,
  DI_QUEUES_VERSION,
  defaultProjectRequirements,
  HTTP_ADAPTER_REQUIREMENTS,
  QUEUE_ADAPTER_REQUIREMENTS,
  QUEUE_ADAPTER_SOURCE,
  queueProjectRequirements,
  renderWorldWit,
  runtimeRequirementsFromJavaScript,
  socketRequirementsFromJavaScript,
  type WitRequirement,
} from './wit';
export {
  applyWorkload,
  CRON_INVOKER_IMAGE,
  controlSecretResourceName,
  DEFAULT_STORAGE_MOUNT,
  deleteWorkload,
  HOST_STORAGE_ROOT,
  hostStoragePath,
  isReady,
  renderWorkloadManifest,
  STORAGE_HOSTGROUP,
  type WorkloadManifestOptions,
} from './workload';

export default defineExtension({
  schemaVersion: 1,
  name: 'platform',
  description: 'Build, serve, and deploy DI Framework apps as wasmCloud components',
  command: createWasmcloudCommand(),
});
