# di-framework/cli-extensions

Installable `di-framework` command groups.

First-party plugins: `@di-framework/cli-plugin-platform` (`di-framework extensions install platform`) and `@di-framework/cli-plugin-ai` (`di-framework extensions install ai`).

Community plugins use `di-framework-cli-plugin-<name>` (unscoped or `@scope/di-framework-cli-plugin-<name>`).

First publish from this remote is **6.0.0**.

## Usage examples

These examples assume `di-framework` is installed and available on your PATH.
Install the first-party platform plugin to add the `platform` command group:

```sh
di-framework extensions install platform
```

### Build and serve an application locally

In an existing DI Framework HTTP application with its dependencies installed,
configure `di-framework.config.json` to point to your application entry:

```json
{
  "name": "greeter",
  "entry": "src/app.ts",
  "output": "dist/greeter.wasm"
}
```

Run these commands from that application's directory:

```sh
di-framework platform doctor                  # check the project and toolchain
di-framework platform build                   # produce dist/greeter.wasm
di-framework platform dev --port 8000         # rebuild and serve locally
```

With the development server running, send a request from another terminal:

```sh
curl http://127.0.0.1:8000/
```

Local serving uses Wasmtime, wash, or jco, depending on available tools and the
application's host requirements. See the [platform guide](packages/cli-plugin-platform/README.md)
for runtime requirements and binding configuration.

### Deploy to a managed local cluster

With Docker running and Pulumi, kubectl, and ORAS installed, run the following
from the workspace root containing the `greeter` project:

```sh
di-framework platform cluster init      # generate deploy/platform and the default local target
di-framework platform cluster up --yes  # provision the platform
di-framework platform deploy greeter
curl -H 'Host: greeter' http://127.0.0.1:28180/
```

The generated `local` target is the platform admin credential. The console is a separate
command for a tenant target, described in the
[platform guide](packages/cli-plugin-platform/README.md#console). A target is a local deploy
destination in `di-framework.deploy.toml` (credential, namespace, host group, registry); a tenant
is the platform's isolation unit (namespaces `di-tenant-<t>` and `di-runtime-<t>`, host group
`tenant-<t>`, RBAC). One tenant can have several targets, and `tenant = "<t>"` points a target at
one. See [Targets and tenants](packages/cli-plugin-platform/README.md#targets-and-tenants).
The generated `di-framework.deploy.toml` describes deployment targets. Named
projects are discovered by their configured `name` within the workspace. The
HTTP example uses the generated platform's default port.

To remove the application and then tear down the local platform:

```sh
di-framework platform destroy greeter
di-framework platform cluster destroy --yes
```

Every command uses `default-target` from `di-framework.deploy.toml` unless you pass
`--target <name>`.

For deployment to an existing cluster, configure a target as described in the
[deployment manifest guide](packages/cli-plugin-platform/README.md#deployment-manifest),
then select it explicitly (or make it the `default-target`):

```sh
di-framework platform deploy greeter --target development
```
