import type { CommandNode } from '@di-framework/cli-extension';
import { runWasmcloudBuild } from './build';
import { runWasmcloudConsole } from './console/run';
import { runWasmcloudDeploy } from './deploy';
import { DEFAULT_DEPS, type WasmcloudDeps } from './deps';
import { runWasmcloudDestroy } from './destroy';
import { runWasmcloudDev } from './dev';
import { runWasmcloudDoctor } from './doctor';
import { runWasmcloudPlatformDeploy, runWasmcloudPlatformDestroy } from './platform';
import { runWasmcloudPlatformInit } from './platform-init';
import {
  runWasmcloudServiceClasses,
  runWasmcloudServiceCreate,
  runWasmcloudServiceDelete,
  runWasmcloudServiceGet,
  runWasmcloudServiceList,
} from './service';

export function createWasmcloudCommand(deps: WasmcloudDeps = DEFAULT_DEPS): CommandNode {
  return {
    description: 'Build, serve, and deploy DI Framework apps as wasmCloud components',
    children: {
      build: {
        description: 'Bundle the app entry and componentize it for WASI HTTP',
        usage: 'di-framework platform build',
        run: ({ args, io }) => runWasmcloudBuild(args, io, deps),
      },
      dev: {
        description: 'Build, then serve the component locally (wasmtime, wash, or jco)',
        usage: 'di-framework platform dev [--host <address>] [--port <port>]',
        options: [
          '--host <address>  Bind address (default: 127.0.0.1)',
          '--port <port>  Listen port (default: 8000)',
        ],
        run: ({ args, io }) => runWasmcloudDev(args, io, deps),
      },
      deploy: {
        description:
          'Build, publish, and apply a wasmCloud WorkloadDeployment for a project in di-framework.deploy.toml',
        usage: 'di-framework platform deploy [name] [--target <name>] [--yes]',
        options: [
          '--target <name>  Deployment target from di-framework.deploy.toml (default: default-target)',
          '--yes  Accepted for compatibility; application deploy does not prompt',
        ],
        run: ({ args, io }) => runWasmcloudDeploy(args, io, deps),
      },
      destroy: {
        description:
          'Remove the generated WorkloadDeployment and Service for a project; does not destroy the platform',
        usage: 'di-framework platform destroy [name] [--target <name>] [--yes]',
        options: [
          '--target <name>  Deployment target from di-framework.deploy.toml (default: default-target)',
          '--yes  Accepted for compatibility; application destroy does not prompt',
        ],
        run: ({ args, io }) => runWasmcloudDestroy(args, io, deps),
      },
      cluster: {
        description: 'Initialize, provision, or tear down a managed wasmCloud platform target',
        children: {
          init: {
            description:
              'Generate deploy/platform from wasmCloud templates and register it as the default local target',
            usage: 'di-framework platform cluster init [--force]',
            options: [
              '--force, -f  Overwrite existing platform files and the local target in di-framework.deploy.toml',
            ],
            run: ({ args, io }) => runWasmcloudPlatformInit(args, io, deps),
          },
          up: {
            description:
              'Run pulumi up for a managed target in di-framework.deploy.toml (k0s, registry, operator)',
            usage: 'di-framework platform cluster up [target] [--yes]',
            options: [
              '[target], --target <name>  Managed target from di-framework.deploy.toml (default: default-target)',
              '--yes  Skip the Pulumi confirmation prompt',
            ],
            run: ({ args, io }) => runWasmcloudPlatformDeploy(args, io, deps),
          },
          destroy: {
            description: 'Run pulumi destroy for a managed platform target only',
            usage: 'di-framework platform cluster destroy [target] [--yes]',
            options: [
              '[target], --target <name>  Managed target from di-framework.deploy.toml (default: default-target)',
              '--yes  Skip the Pulumi confirmation prompt',
            ],
            run: ({ args, io }) => runWasmcloudPlatformDestroy(args, io, deps),
          },
        },
      },
      doctor: {
        description: 'Check the project and local toolchain for wasmCloud readiness',
        usage: 'di-framework platform doctor',
        run: ({ args, io }) => runWasmcloudDoctor(args, io, deps),
      },
      console: {
        description: 'Open a local console for the applications on one tenant credential',
        usage:
          'di-framework platform console [--target <tenant>] [--host <address>] [--port <port>]',
        options: [
          '--target <tenant>  Tenant target (default: default-target). Uses that target’s kubeconfig only',
          '--host <address>  Loopback bind address (default: 127.0.0.1)',
          '--port <port>  Listen port (default: a free port chosen by the system)',
        ],
        run: ({ args, io }) => runWasmcloudConsole(args, io, deps),
      },
      service: {
        description:
          'Create and manage BackingService custom resources (keyvalue/messaging/blobstore/postgres/egress) via the cluster API',
        children: {
          create: {
            description: 'Create a BackingService custom resource for an approved capability type',
            usage:
              'di-framework platform service create <keyvalue|messaging|blobstore|postgres|egress> [<name> | --name=<name>] [--class=<class>] [--destination <host[:port]>]… [--target <name>] [--namespace <ns>] [--wait]',
            options: [
              '--name <name>  Required BackingService metadata.name (DNS label, max 40); may also follow the type',
              '--class <name>  Optional approved BackingServiceClass (defaults: keyvalue-redis, messaging-nats, blobstore-nats, postgres-dedicated, egress-public)',
              '--destination <d>  Egress only, repeatable: host, *.suffix, host:port, or *.suffix:port',
              '--memory <qty>  Optional sizing parameter (Kubernetes quantity)',
              '--storage <qty>  Optional sizing parameter (Kubernetes quantity)',
              '--cpu <qty>  Optional sizing parameter (Kubernetes quantity)',
              '--deletion-policy <Retain|Delete>  Retention when the CR is deleted (default Retain)',
              '--target <name>  Deployment target from di-framework.deploy.toml (default: default-target)',
              '--namespace <ns>  Override the target namespace',
              '--context <name>  Override the kubeconfig context',
              '--wait  Wait until the Ready condition is True',
              '--timeout <seconds>  Wait timeout in seconds (default: 120)',
            ],
            run: ({ args, io }) => runWasmcloudServiceCreate(args, io, deps),
          },
          list: {
            description: 'List BackingService resources in the target namespace',
            usage: 'di-framework platform service list [--target <name>] [--namespace <ns>]',
            options: [
              '--target <name>  Deployment target from di-framework.deploy.toml (default: default-target)',
              '--namespace <ns>  Override the target namespace',
              '--context <name>  Override the kubeconfig context',
            ],
            run: ({ args, io }) => runWasmcloudServiceList(args, io, deps),
          },
          get: {
            description:
              'Show Ready status, type, class, and endpoint summary for a BackingService',
            usage: 'di-framework platform service get <name> [--target <name>] [--namespace <ns>]',
            options: [
              '--target <name>  Deployment target from di-framework.deploy.toml (default: default-target)',
              '--namespace <ns>  Override the target namespace',
              '--context <name>  Override the kubeconfig context',
            ],
            run: ({ args, io }) => runWasmcloudServiceGet(args, io, deps),
          },
          delete: {
            description:
              'Delete a BackingService custom resource (controller retention/in-use rules still apply)',
            usage:
              'di-framework platform service delete <name> [--target <name>] [--namespace <ns>]',
            options: [
              '--target <name>  Deployment target from di-framework.deploy.toml (default: default-target)',
              '--namespace <ns>  Override the target namespace',
              '--context <name>  Override the kubeconfig context',
            ],
            run: ({ args, io }) => runWasmcloudServiceDelete(args, io, deps),
          },
          classes: {
            description:
              'Discover approved BackingServiceClass resources (falls back to platform defaults)',
            usage: 'di-framework platform service classes [--target <name>]',
            options: [
              '--target <name>  Deployment target from di-framework.deploy.toml (default: default-target)',
              '--namespace <ns>  Override the target namespace',
              '--context <name>  Override the kubeconfig context',
            ],
            run: ({ args, io }) => runWasmcloudServiceClasses(args, io, deps),
          },
        },
      },
    },
  };
}
