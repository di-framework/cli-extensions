# @di-framework/cli-plugin-platform

di-framework CLI extension for targeting [wasmCloud](https://wasmcloud.com): build a DI Framework
HTTP app into a WASI 0.3 WebAssembly component, serve it locally, and deploy it from a workspace
manifest.

```bash
di-framework extensions install platform

di-framework platform build                               # bundle + jco componentize → dist/<name>.wasm
di-framework platform dev                                 # build, then serve locally (wasmtime by default)
di-framework platform deploy                              # nearest project, default target
di-framework platform deploy greeter                      # named project anywhere in the workspace
di-framework platform deploy greeter --target development # a target other than default-target
di-framework platform destroy greeter
di-framework platform cluster init                        # generate deploy/platform + local target
di-framework platform cluster up --yes                    # start the generated platform (default-target)
di-framework platform cluster destroy --yes
di-framework platform doctor                              # project + toolchain readiness checks
```

Run these commands directly. Do not wrap them in `package.json` scripts.

## Project convention

A component project is marked by `di-framework.config.json`:

```json
{ "name": "my-app", "entry": "src/app.ts", "output": "dist/my-app.wasm" }
```

Named wasmCloud host-interface bindings live in `src/bindings.ts` (override with `"bindings"`).
Each exported class extending a `@di-framework/bindings` base and decorated with
`@PlatformBinding('name')` is discovered statically and added to the WIT requirement graph.
`@WasmCloudBinding('name')` remains a deprecated alias of the same decorator.
The binding name selects its configuration overlay and normally becomes `hostInterfaces[].name`.
For `wasmcloud:postgres`, `wasmcloud:keyvalue`, `wasmcloud:blobstore`,
`wasmcloud:messaging`, and `wasmcloud:secrets`, host declarations omit the name to
select the provider route that links QuickJS imports. The generated guest world uses unlabeled
`import pkg/iface@version` statements because `jco --backend qjs` cannot encode
`import name: pkg/iface` (`cm-implements`). Secret values are never taken from source;
`secretFrom` defaults to `<application>-<binding>`. Unnamed bindings such as config and
outgoing HTTP retain their overlays through the binding class that contributed the requirements.

Host declarations reflect the interfaces advertised by the runtime: key-value `types`
is linked internally, and the core links `wasi:http/client`. Both remain in the guest WIT
imports but are omitted from host discovery. HTTP ingress and outgoing requirements
share one unnamed host declaration per version, retaining configuration from both.
Outgoing requests also require the workload component’s `localResources.allowedHosts`
to allow the destination; the binding itself does not grant egress access.

Build writes `.di-framework/guests.js` with real WIT `import * as` specifiers and installs
those modules on `globalThis` before the application runs, which is how
`@di-framework/bindings` constructors receive the guest.

The configured `name` is the only project identity. The extension owns the WebAssembly/WASI
boundary: it records WIT requirements (the HTTP adapter exports `wasi:http/handler@0.3.0` today),
generates one world and a `wit.lock.json` from that graph, bundles the entry behind a WASI-HTTP ↔
Web Fetch adapter, and componentizes with `@di-framework/componentize-qjs` (a wasmtime-48
fork of componentize-qjs 0.4.4 that can stub imported `async func`s such as
`wasmcloud:postgres@0.2.0`). Set `DI_FRAMEWORK_COMPONENTIZE_QJS` to override the
resolved CLI.

The bootstrap installs text encoding and Fetch globals before evaluating application
imports, including Node modules with module-level constants. `node:timers` and global
`setTimeout`, `setInterval`, and `setImmediate` use the WASI monotonic clock. Timer
handles support cancellation, refresh, and ref/unref flags; process-lifetime ref
semantics do not apply to an invocation-driven component.

`node:async_hooks` supplies context scopes and binding. The bundler lowers async
functions and `for await` loops into Promise continuations, whose callbacks retain
the calling context. Timer callbacks also retain context. Native async-generator
bodies and dynamically evaluated async code are not instrumented by this transform.

A workload must explicitly permit WASI DNS lookups. Add hostnames or wildcard suffixes
to the project configuration, for example:

```json
{
  "name": "socket-app",
  "entry": "src/app.ts",
  "allowedIpNameLookups": ["echo.wasmcloud.svc.cluster.local"]
}
```

On a target without a `hostgroup`, the deployer writes these names under the component's
`localResources.allowedIpNameLookups`. Omission keeps the host's default denial;
it does not implicitly grant unrestricted DNS access. Tenant targets request egress from
the platform instead; see [Egress on tenant targets](#egress-on-tenant-targets).

Guest JS keeps the framework's Node contract. The bundler runs [unenv](https://github.com/unjs/unenv)
`nodeCompat` plus a wasmCloud preset: `node:path`, `Buffer`, and the rest of
the Node builtin map come from unenv; `node:fs` and `node:fs/promises` are an in-memory
filesystem (with `ENOENT`), except under the storage mount (`/data`, or `DI_STORAGE_DIR`), which
reads and writes the host's preopened directory through `wasi:filesystem@0.2.12`,
`process.env` / `process.cwd()` are guest-shaped (not the host process), and `createRequire` throws
`MODULE_NOT_FOUND`. `node:net` and `node:dgram` overlay WASI 0.3 `wasi:sockets` (`tcp-socket` /
`udp-socket` / `ip-name-lookup`) so `@di-framework/socket`'s Node TCP/UDP adapters run unchanged.
`node:crypto` overlays `wasi:random@0.3.0` plus guest hashes and the Web Crypto subset used by
socket security (`createHash` / `createHmac` / `randomBytes` / `randomUUID` / `subtle` HMAC, HKDF,
AES-GCM, ECDH P-256). `node:http` is HTTP/1.1 on that TCP overlay (`createServer`, `request` /
`get`, `'upgrade'`) so the Node WebSocket adapter (`ws`) can handshake. Those WIT imports are added
to the guest world only when the bundle actually uses them; they are runtime WASI, not wasmCloud
`hostInterfaces`. `node:tls` supplies client `connect` / `TLSSocket` (including an existing
`node:net` socket for STARTTLS) through the host's `wasi:tls/client@0.3.0-draft` encryption
and decryption streams. `node:https` supplies HTTP/1.1 `request` / `get` and an Agent
that carries connection options; requests wait for verified `secureConnect` before sending.
`child_process` stays an unenv mock. Config files from the project (`*.json` / `*.yaml` / `*.toml` / `.env`) are
seeded into that filesystem at componentize time. Do not put secrets in those files. Stock jco 1.32.1 / componentize-qjs 0.4.4 uses wasmtime 47,
which stubs unknown imports with sync `func_new` and fails at wizer with
`type mismatch with async`. Sync imports such as `wasi:config@0.2.0-rc.1` also
componentize with stock jco and run on `wasmtime serve -S config`. Build state
lives in the disposable `.di-framework/` directory.

TLS requires a host with the opt-in `wasi-tls` feature, such as a TLS-enabled
`wash-runtime` build, or Wasmtime 48 with `-S p3=y,tls=y,inherit-network=y,allow-ip-name-lookup=y`.
The draft WIT is pinned to the wasmCloud interface; importing TLS or HTTPS adds it to the
component world automatically. `platform dev` enables TLS and outbound network access
automatically when using Wasmtime for a component that imports TLS. Other runners need
their own TLS-enabled host configuration. A host without TLS cannot instantiate that component.
See [wasmCloud host TLS configuration](https://wasmcloud.com/docs/runtime/building-custom-hosts/#tls-for-wasitls-components).

Certificate chain and server-name verification are mandatory and use the host's trust store.
Use `servername` when connecting by address to a DNS-named service, and configure private
CA trust on the host, including in local development. Guest `ca` / client certificates,
`rejectUnauthorized: false`, custom identity checks, TLS versions/ciphers, ALPN, sessions,
and certificate inspection are unsupported and throw explicit errors. Server-side
`tls.createServer` / `https.createServer` are unsupported; incoming HTTPS terminates at
the host ingress. This is a client subset, without connection pooling or HTTP/2.
Use `tls.connect(options)` rather than calling `.connect()` on a `TLSSocket`.

HTTPS responses without `Content-Length` or chunked encoding finish only when the
peer closes the connection. If the peer keeps it open, the response can wait indefinitely.
Set `options.timeout` and destroy the request in its `timeout` handler; the timeout
is an inactivity notification and does not cancel the request automatically:

```ts
import { get } from 'node:https';

const req = get('https://example.com/', { timeout: 10_000 }, (res) => {
  res.on('data', (chunk) => console.log(chunk.toString()));
  res.on('error', (error) => console.error(error));
});
req.on('timeout', () => req.destroy(new Error('HTTPS request timed out')));
req.on('error', (error) => console.error(error));
```

Use a separate deadline timer if the entire operation must finish within a fixed
time, including a peer that keeps sending data without closing the response.

Run `DI_WASI_TLS_SMOKE=1 bun test tests/node-compat-tls-native.test.ts` from this package
to compile and exercise both clients against real Wasmtime TLS. This opt-in check needs
the componentizer, Wasmtime 48, OpenSSL, and network access to `example.com`; it also
starts a temporary local HTTPS server to confirm that an untrusted certificate is rejected.

Package versions are independent of the component-model preview: a WASI 0.3 guest may
still import `wasmcloud:*` packages at their own versions.

Local `platform dev` uses `wasmtime serve -S cli -S p3 -S config` when wasmtime 46+ is on
PATH, then `wash dev`, then `jco serve`. A guest that imports `wasmcloud:*` selects `wash`
even when wasmtime is present. Set `DI_FRAMEWORK_WASMCLOUD_DEV_RUNNER` to
`wasmtime`, `wash`, or `jco` to pin one. Wasmtime hosts WASI HTTP and unlabeled
`wasi:config` locally (`-S config-var=key=value` to seed values). wasmCloud-only imports
such as `wasmcloud:postgres` still need `wash` or a wasmCloud host.

Guest `console.log`, `info`, `debug`, `warn`, and `error` write through
`wasi:logging/logging@0.1.0-draft`, one `log(level, "console", line)` call per line.
QuickJS has no console of its own, and wash 2.8 writes raw guest stdio to the host log
without saying which workload produced it; `wasi:logging` lines carry `workload.name`
and `workload.namespace`. Builds therefore link that import and every WorkloadDeployment
declares an unnamed `wasi:logging` host interface (`interfaces: [logging]`). `platform dev`
links it only for `wash`; wasmtime and jco cannot provide it, so those builds keep a
console that discards output.

Logs are on by default. Set `"logs": false` in `di-framework.config.json` to opt a project out:

```json
{ "name": "quiet-app", "entry": "src/app.ts", "logs": false }
```

The build then links no `wasi:logging` import and keeps the console that discards output, in
`platform deploy` and `platform dev` alike. The WorkloadDeployment declares no `wasi:logging`
host interface and carries the annotation `di-framework.dev/logs: "false"`, so the platform
publishes none of the application's console lines. It still publishes the host's WARN and
ERROR lines for the application's workloads (for example a workload that failed to start)
with the application's logs, and the console still uses them to mark a failed workload.
Each workload member reads its own config, so the setting applies per member. `logs` must
be a boolean; omitting it or setting `true` keeps logs on and adds no annotation.

`wash` 2.5.x has no `--address` flag. The extension writes
`.di-framework/wash-dev.yaml` (`dev.address`, `host_interfaces`,
`wasm_proposals: [component-model-async]`) and runs `wash dev --user-config` against it.
Set `WASMCLOUD_POSTGRES_URL` to populate `dev.postgres_url`; never put secrets in source.

## Deployment manifest

Deployment topology lives in `di-framework.deploy.toml` at the workspace root. The CLI finds it by
walking upward from the current directory. The file describes **targets**, not applications: there
is no `apps` table, and projects may live in any directory layout.

```toml
default-target = "local"

[targets.local]
platform = "deploy/platform"
stack = "dev"

[targets.development]
kubeconfig = "${KUBECONFIG}"
context = "team-development"
namespace = "wasmcloud"

[targets.development.registry]
push = "https://registry.example.com/team"
pull = "registry.internal.example.com/team"
insecure = false

[targets.warehouse]
kubeconfig = "${WAREHOUSE_KUBECONFIG}"
tenant = "warehouse"            # namespace di-tenant-warehouse, hostgroup tenant-warehouse
registry = "registry.example.com/warehouse"
```

- Every command that takes `--target` (`deploy`, `destroy`, `console`, `service …`, and
  `cluster up` / `cluster destroy`) uses `default-target` when `--target` is left out. Pass
  `--target <name>` only to pick a different target.
- `di-framework platform deploy` with no name uses the nearest `di-framework.config.json`.
- `di-framework platform deploy greeter` recursively discovers projects (skipping `.git`,
  `node_modules`, `.di-framework`, and generated output by default) and matches the configured
  `name`. Duplicate names fail with every conflicting path.
- `${VAR}` interpolation fails if the variable is unset or empty. Do not put credentials in the
  manifest.

### Targets and tenants

A **target** and a **tenant** are different things:

- A **target** is a local deploy destination: one `[targets.<name>]` table in
  `di-framework.deploy.toml`. It bundles a credential (kubeconfig and optional context), a
  namespace, a host group, and a registry. Only your workspace knows about it.
- A **tenant** is the platform's isolation unit, declared by the platform administrator. The
  platform gives tenant `<t>` the workload namespace `di-tenant-<t>`, the runtime namespace
  `di-runtime-<t>`, the host group `tenant-<t>`, and RBAC for its users.

One tenant can have several targets, for example one per user, credential, or registry. A target
points at no tenant (an admin or plain-cluster target such as `local` or `development` above) or
exactly one. Set `tenant = "<t>"` on an external target to point it at a tenant: it fills in
`namespace = "di-tenant-<t>"` and `hostgroup = "tenant-<t>"`. An explicit `namespace` or
`hostgroup` still wins. Tenant names follow the platform's rule: 1–40 characters, lowercase
letters, digits, and single hyphens, starting with a letter. An external target needs
`kubeconfig`, `registry`, and either `tenant` or `namespace`.

### Managed Pulumi target

From the workspace root, generate a self-contained local platform (k0s, a local OCI registry, and
the wasmCloud operator) from templates shipped with this extension:

```bash
di-framework platform cluster init
di-framework platform cluster up --yes
```

`platform init` writes `deploy/platform` and creates or updates `di-framework.deploy.toml` so
`local` is a managed target (`platform = "deploy/platform"`, `stack = "dev"`). Existing files are
left alone unless you pass `--force`. When the manifest has no `default-target` yet, `local`
becomes the default, so the commands below need no target name. The command prints the exact start command when it finishes.
Platform deploy runs the package-manager-neutral `pulumi install` command automatically, so the
generated project works immediately in a blank consumer workspace without a root workspace entry
or a manual install inside `deploy/platform`.

The generated Pulumi project provisions only platform concerns. It has workspace- and stack-scoped
Docker names, a dedicated network, persistent k0s state/log volumes, pinned images and chart,
readiness checks, and loopback-only high ports. It must not contain application names, component
builds, application Services, or WorkloadDeployments. The defaults are Kubernetes `26443`, registry
`25000`, and HTTP `28180`; set `apiPort`, `registryPort`, or `httpPort` with `pulumi config set` in
`deploy/platform` to choose another distinct port from 1024 through 65535.

The CLI reads a small output contract from `pulumi stack output --json`:

| Output | Required | Meaning |
| --- | --- | --- |
| `kubeconfig` | yes | kubeconfig YAML or a filesystem path |
| `namespace` | yes | Kubernetes namespace for workloads |
| `registry` | yes | legacy string shorthand, or `{ push, pull, insecure }` transport object |
| `context` | no | kubectl context |
| `endpoints.http` / `endpoints.kubernetes` / `endpoints.registry` | no | optional URLs |

Provision and tear down that stack explicitly (add the target name, positionally or with
`--target`, when it is not the `default-target`):

```bash
di-framework platform cluster up --yes
di-framework platform cluster destroy --yes
```

Application `destroy` never runs `pulumi destroy`.

### Control Secret

An application that serves HTTP, cron, queues or actors gets a Secret
`<deployment>-control` holding `DI_CONTROL_TOKEN` and `DI_CONTROL_IDENTITY`. Tenant
developers may create, update and delete Secrets but not read, list, watch or patch them,
so the CLI never reads it back:

- `deploy` writes a new random token every time: it creates the Secret and, if it already
  exists, replaces the whole Secret with an unconditional update. Keys added to it by hand
  are dropped. The WorkloadDeployment carries `DI_CONTROL_TOKEN_REVISION` (a digest of the
  token), so every deploy rolls the workload onto the new token together with its cron
  invokers.
- `destroy` deletes the Secret by name, after the WorkloadDeployment, Service and CronJobs.
- The console's credential reassignment replaces the named Secret with one holding only
  `credential`; other keys, labels and annotations on it are not kept.

The generated local target publishes through its loopback registry NodePort and puts the equivalent
in-cluster registry address in the WorkloadDeployment. Both references use the same repository and
stable canonical-input tag. An `http://` push URL or `insecure = true` adds ORAS `--plain-http` only
for that target; TLS remains the default everywhere else.

### Existing cluster

When kubeconfig and a registry are already available, declare an external target with only access
information (as `development` above) and deploy:

```bash
export KUBECONFIG="$HOME/.kube/config"
di-framework platform deploy greeter --target development
```

## Application deploy

For the selected project the extension:

1. Builds the component.
2. Publishes it with `oras` from the project root using project-relative artifact paths and a stable
   canonical-input reference (`<registry>/<wit-name>:sha256-<deployment-digest>`). The actual
   component-byte digest is calculated and reported separately because ComponentizeJS snapshots may
   vary byte-for-byte for identical inputs.
3. Derives a wasmCloud `WorkloadDeployment` and Kubernetes `Service` (written under `.di-framework/deploy/`, not checked in).
4. Configures `wasi:http/handler@0.3.0` with the project name as its host, applies the resources,
   and waits for current `Ready=True` or compatible older readiness schemas.

## Console

`di-framework platform console` serves a local control panel for one tenant. The tenant credential
is the only authentication: there is no login. The process binds to loopback and keeps that
credential in memory.

The console shows each deployed application as a workload of services and components. A developer
can read its routes, environment, secret names, backing-service bindings, private bindings, and
logs. Secret values are write-only. Routes can be turned on or off without a rebuild. Logs and
success or compute signals appear only when the platform publishes them for that application.

```toml
default-target = "warehouse"

[targets.warehouse]
kubeconfig = "${WAREHOUSE_KUBECONFIG}"
tenant = "warehouse"
registry = "registry.example.com/warehouse"
```

```bash
di-framework platform console
di-framework platform console --port 8790
```

Without `--port` the system picks a free port. The console prints `Console listening on <url>` with
the real address as soon as it is serving, also when stdout is redirected to a file.

`--target` defaults to `default-target`. The target must be a tenant credential (a tenant user's
`kubeconfig` with `tenant`, or with `namespace` and `hostgroup`), not the platform admin
credential. A viewer credential sees the same screens and cannot change them.

For the generated local platform the result reports the HTTP URL and required Host header. It is
directly reachable without `kubectl port-forward`, for example:

```sh
curl -H 'Host: greeter' http://127.0.0.1:28180/
```

## Demonstration layout

A complete workspace is in [`examples/workspace`](./examples/workspace): `deploy/platform` plus
projects at `services/greeter` and `nested/deep/echo`. Copy that tree or start from the TOML
above.

The manifest contract for extensions is documented in
[`@di-framework/cli-extension`](https://www.npmjs.com/package/@di-framework/cli-extension).

## Live integration test

The opt-in test packs the CLI and extension dependencies, installs those tarballs in a blank
temporary workspace, and runs the full platform/application lifecycle against Docker:

```sh
DI_FRAMEWORK_WASMCLOUD_LIVE=1 bun test packages/cli-plugin-platform/tests/live-workflow.test.ts
```

It requires Docker, Pulumi, kubectl, ORAS, npm, Bun, and curl. The test selects unused loopback
ports and removes its scoped platform resources in a `finally` cleanup.

## Actor Integration with wasmCloud

The wasmCloud plugin natively integrates virtual actors from `@di-framework/actors` into WebAssembly components and Kubernetes deployments.

### 1. Build-Time Actor Scanning & Dispatch Generation
- **Static Discovery**: During `di-framework platform build`, source files are scanned for `@Actor` and `@ActorMethod` decorators using TypeScript AST analysis.
- **Dispatch Module Generation**: The build generates `.di-framework/actors.js` which explicitly imports actor classes, registers them with `ActorRuntime`, sets up `SqliteActorStorage`, and exports `dispatchActorInvocation`. This prevents registered actors and their methods from being eliminated by Rolldown tree-shaking.
- **Private Invocations**: Invocations are delivered privately via `/_actors/invoke` or private service bindings without exposing public HTTP routes.

### 2. Runtime Execution Model
- **Activation & Scheduling**: Actor activations live in-memory within the host component instance. Per-actor mailbox queues asynchronously serialize calls to the same actor identity (`namespace:actorName:actorKey`) while allowing distinct actors to execute concurrently.
- **Host Storage Capabilities**: Persistent storage is bound via host capabilities (filesystem volume mount at `/data/actors`, configured via `ACTOR_STORAGE_DIR`). Each actor has an isolated SQLite database file with single-writer process file locking.
- **Transactions & Migrations**: Method invocations execute within actor-scoped transactions that commit on success and roll back on errors. Schema migrations run automatically before an actor's first activation; migration failures reject activation before calls can proceed.

### 3. Deployment & Operating Safety Constraints
- **Single-Host Constraint**: To ensure data consistency and prevent database split-brain with SQLite file locking, actor workloads enforce `replicas: 1`. Accidental configurations with `replicas > 1` are rejected with `WASMCLOUD_ACTORS_REPLICA_CONSTRAINT`.
- **Persistent Volumes**: Generated manifests provision a Kubernetes `PersistentVolumeClaim` mounted at `/data/actors`.
- **Upgrade & Drain Behavior**: The workload uses Kubernetes rollout `strategy: { type: "Recreate" }`, guaranteeing that the terminating pod drains active calls and releases SQLite locks before the new version activates and executes pending migrations.
- **Single-Host vs. Distributed**: Single-host wasmCloud actor deployment is designed for standalone, resilient edge or single-node deployments. Distributed actor clustering, key partitioning, and remote consensus across wasmCloud nodes are part of distributed actor capabilities.

Actor HTTP dispatch is restricted to the reserved `/_actors/` path. Actor headers on other paths do not intercept application requests. Error responses expose stable error names and generic messages; they omit internal exception details and migration objects.

## Building from source

The package build compiles the SQLite provider from
`../di-framework-sqlite-component` using its pinned Rust, WASI SDK, and wasm-tools
versions. Install that toolchain from the repository root before `bun install`
(the root postinstall builds the workspace):

```sh
bash packages/di-framework-sqlite-component/scripts/install-tools.sh --rust
bun install --frozen-lockfile
```

Subsequent `bun run build` runs rebuild the provider through Cargo's incremental
build cache and stage its WASM, WIT, metadata, and checksums under
`dist/assets/sqlite`. Generated artifacts are ignored by Git and included in the
published npm package; npm consumers do not need the Rust build toolchain.

## Implicit workloads

A package can declare `"workload": "warehouse"` in `di-framework.config.json`.
The CLI discovers other packages with that name and generates
`.di-framework/workloads/warehouse.json` at the deployment workspace root. No parent
application or explicit member list is required. Member deployments remain independent
and carry a `di-framework.dev/workload` Kubernetes label.

In the entry module, export one variable wrapped in `WorkloadComponent({ path: '/take' })`
or `WorkloadService({ path: '/sync', subscriptions: ['warehouse.stock'] })`, imported from
`@di-framework/bindings`. The workload name lives in config; source describes behavior.
The CLI statically reads literal options, rejects conflicting member paths, and selects
the exported handler without requiring a default export. A service with subscriptions
exports `wasmcloud:messaging/handler@0.3.0` and deploys as a component; a service without
subscriptions exports `wasi:cli/run@0.3.0` and deploys as the workload's
`spec.template.spec.service`, the only place wash runs a long-lived program. Both initialize
declared host bindings before loading the entrypoint.

The inferred manifest records routes but does not install a shared HTTP router. On the
current Kubernetes runtime, HTTP members retain their individual Host headers. See the
[warehouse example](../../examples/warehouse/README.md) for the complete deployment.

## Tenant deployment targets

Each external target selects a user's credentials, namespace, registry, and host groups. Two
users of the `warehouse` tenant each get their own target:

```toml
default-target = "alice"

[targets.alice]
kubeconfig = "${ALICE_KUBECONFIG}"
context = "alice"
tenant = "warehouse"

[targets.alice.registry]
push = "https://registry.example.com/alice"
pull = "registry.example.com/alice"

[targets.bob]
kubeconfig = "${BOB_KUBECONFIG}"
tenant = "warehouse"
registry = "registry.example.com/bob"
```

Run `di-framework platform deploy warehouse-take` as alice, or add `--target bob`. All Kubernetes calls,
including deletion and diagnostics, use that target's kubeconfig, context, and namespace.
The generated WorkloadDeployment also sets `spec.template.spec.environment` to the target
namespace, so host selection cannot silently fall back to another environment when the
matching pool is unavailable. `hostgroup` defaults to `default`. These selectors refer to
existing host pools; application deployment does not provision them.

A target with a `hostgroup` is a tenant target, and its storage belongs to the platform.
Actors, queues, workers, and `persistentStorage: true` deploy with the annotation
`di-framework.dev/persistent-storage: "true"` (plus `di-framework.dev/storage-mount:
"/data/actors"` for actors) and no volume, volume mount, or host path. The platform
controller creates `<storageRoot>/di-tenants/<tenant uid>/workloads/<workload>`, shared by
the members of one `di-framework.dev/workload` and private to the tenant, and injects the
volume and the `/data` preopen. The guest still reads `DI_STORAGE_DIR`; `node:fs` paths under
it reach that directory, so members see each other's files. `storage-hostgroup`
applies only to targets without a `hostgroup`, which keep the host path under
`/var/lib/di-framework/storage` on the `storage` pool.

Generated managed platforms set `operator.allowSharedHosts: false`. Existing generated
platforms and external clusters, including di-framework-kube, need their operator Helm
values updated separately. Application deploy does not reconfigure the operator.

Generated platforms provision namespaces, host pools, isolated Redis/NATS backends,
network policies, quotas, ServiceAccounts, and RBAC from declarative Tenant/User
resources. Administrators issue expiring ServiceAccount tokens; no identity provider
or login service is required. External clusters need equivalent provisioning.
The local registry remains shared and unauthenticated. Never distribute the platform's
administrative kubeconfig as a user's deployment credential.

An existing target that intentionally used a host in another environment must now have
a host in its own namespace environment. Workload names and decorator paths remain local
to the implicit workload; they do not select user identity or Kubernetes namespaces.

Generated platforms support declarative `tenants` and `users` in their Pulumi stack configuration. See [the generated platform guide](assets/platform/README.md#users-and-tenants) for CRDs, roles, token issuance, and lifecycle behavior.

### Managed PostgreSQL (upcoming release)

`di-framework platform service create postgres --name orders --wait` provisions
a dedicated instance through the default `postgres-dedicated` class. A
`@WasmCloudBinding('orders-db', { serviceName: 'orders' })` on a `Postgres` subclass
selects it. Deployment validates references and waits for controller-managed
ServiceBindings before applying the workload. Successful updates and workload
deletion remove obsolete deployment-owned associations. Shared projections stay
while other workloads use them.

See [PostgreSQL storage, deletion, and recovery](../di-framework-platform/README.md#dedicated-postgresql-upcoming-release).

### Blobstore services

`di-framework platform service create blobstore --name catalog --wait` provisions a
JetStream NATS object store through the default `blobstore-nats` class. It takes the
same `--class`, `--memory`, `--storage`, `--cpu`, `--deletion-policy`, and `--timeout`
flags as the other types. Bind it to an application in the console (or with a
`ServiceBinding` whose `bindingName` is `objects` and `capability` is `blobstore`); the
controller projects ConfigMap `di-binding-objects`, and the guest selects it with
`configFrom`:

```ts
@WasmCloudBinding('objects', { configFrom: 'di-binding-objects' })
@Container()
export class MeshObjects extends Blobstore {}
```

The host interface stays unnamed; `configFrom` is the only addition. Each guest
container becomes its own object-store bucket. An unnamed blobstore without
`configFrom` uses the host default, which in wash 2.8 is an in-memory store that is
neither shared between components nor kept across restarts, so a workload whose
members share objects should bind a created service. `serviceName` stays
Postgres-only.

### Egress on tenant targets

Tenant credentials cannot write `allowedHosts` or `allowedIpNameLookups` into a
WorkloadDeployment. On a tenant target (one with a `hostgroup`), `deploy` turns the
project's `allowedIpNameLookups` into a platform request instead:

- BackingService `<deployment>-egress` with `spec.type: egress` and
  `spec.destinations` set to the names, and
- ServiceBinding `<deployment>-egress` with `capability: egress`,
  `bindingName: egress`, and `workloadName: <deployment>`.

`<deployment>` is the WorkloadDeployment name. Deploys update the destinations when the
names change, and remove both resources when the setting is removed or the application is
destroyed. The resources carry `app.kubernetes.io/managed-by: di-framework`; deploy refuses
to adopt same-named resources it did not create. `"*"` cannot be requested on a tenant
target. The WorkloadDeployment itself carries neither field: once the platform approves
the destinations, its controller patches `allowedHosts` and `allowedIpNameLookups` in and
opens the tenant host's network policy for the approved ports.

Approval comes from the egress class policy (`egressAllowedDestinations` in the platform's
Pulumi config, empty by default). After the rollout, deploy prints the approved `host:port`
entries, or a note when the service is `NotApproved` or not yet Ready. The deploy itself
still succeeds; outbound connections stay blocked until a platform admin allows the
destination.

You can also create and bind an egress service yourself:

```sh
di-framework platform service create egress outbound \
  --destination api.example.com:443 --destination '*.example.org'
di-framework platform service get outbound    # Destinations / Approved / Ready reason
```

Each destination is `host`, `*.suffix`, `host:port`, or `*.suffix:port`; a destination
without a port is approved for the policy ports that match its name. Bind it from the
console's Bindings tab (single-part applications only, since egress is granted per
WorkloadDeployment). `list`, `get`, and `delete` work for egress like the other types; the
console create form does not offer egress because it does not collect destinations.

**TLS.** If the built component imports `wasi:tls` and the target is a tenant
(`hostgroup = "tenant-<t>"`), deploy reads the image of the host pods labelled
`wasmcloud.com/hostgroup=tenant-<t>` in `di-runtime-<t>`. Unless the image tag contains
`wasi-tls` (for example `…/wash:2.8.0-wasi-tls`), it warns that TLS connections will fail;
stock `ghcr.io/wasmcloud/wash:<version>` images have no `wasi:tls` provider. The check
never blocks the deploy and stays silent when the pods cannot be read.
