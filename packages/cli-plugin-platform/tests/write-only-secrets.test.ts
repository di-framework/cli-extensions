import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKubectlConsoleCluster } from '../src/console/cluster';
import { runWasmcloudDeploy } from '../src/deploy';
import type { WasmcloudDeps } from '../src/deps';
import { runWasmcloudDestroy } from '../src/destroy';
import { loadProject } from '../src/project';
import type { ClusterConnection } from '../src/target';
import {
  CONTROL_TOKEN_ROTATED_NOTICE,
  deleteControlSecret,
  writeControlSecret,
} from '../src/workload';
import { captureIo, fakeDeps, makeWorkspace, type RunnerInvocation } from './helpers';

/**
 * A Kubernetes API as a tenant developer sees it after platform#112: Secrets can be created,
 * updated (PUT) and deleted, while get, list, watch and patch answer 403. Every kubectl call
 * that touches Secrets is translated into the API requests kubectl would send.
 */
type ApiRequest = { verb: string; path: string; status: number };
type StoredSecret = {
  metadata: { name: string; namespace?: string; labels?: Record<string, string> };
  type?: string;
  data?: Record<string, string>;
};

const FORBIDDEN_SECRET_VERBS = new Set(['get', 'list', 'watch', 'patch']);

/** Denial messages of the platform's `tenant-secret-update` admission policy (platform PR #114). */
const MANAGED_DENIAL = 'tenant users cannot update platform-managed di-binding-*/di-bs-* Secrets';
const KEYS_DENIAL = 'tenant users may update a Secret only if it keeps every existing data key';
const BACKEND_CONFIG_DENIAL =
  'di-tenant-stock, di-platform-routes, di-bs-*, and di-binding-* ConfigMaps/Secrets are managed by the platform controller';

/** How the API server words a ValidatingAdmissionPolicy denial (reason Forbidden, 403). */
function admissionDenial(name: string, policy: string, message: string): string {
  return `secrets "${name}" is forbidden: ValidatingAdmissionPolicy 'wasmcloud-${policy}' with binding 'wasmcloud-${policy}' denied request: ${message}`;
}

/** Mirrors the `tenant-secret-update` CEL rules for a `di-user-*` caller. */
function updateDenial(name: string, old: StoredSecret, next: StoredSecret): string | undefined {
  if (name.startsWith('di-binding-') || name.startsWith('di-bs-')) return MANAGED_DENIAL;
  const kept = new Set(Object.keys(next.data ?? {}));
  if (Object.keys(old.data ?? {}).some((key) => !kept.has(key))) return KEYS_DENIAL;
  return undefined;
}

function writeOnlySecretsApi(namespace = 'wasmcloud') {
  const requests: ApiRequest[] = [];
  const secrets = new Map<string, StoredSecret>();
  const collection = `/api/v1/namespaces/${namespace}/secrets`;

  let denied = '';
  const request = (verb: string, name?: string, body?: StoredSecret) => {
    const path = name === undefined ? collection : `${collection}/${name}`;
    let status = 200;
    denied = '';
    if (FORBIDDEN_SECRET_VERBS.has(verb)) status = 403;
    else if (verb === 'create' && body !== undefined) {
      if (secrets.has(body.metadata.name)) status = 409;
      else {
        secrets.set(body.metadata.name, body);
        status = 201;
      }
    } else if (verb === 'update' && name !== undefined && body !== undefined) {
      // Secrets are not created by an update.
      const existing = secrets.get(name);
      const denial = existing === undefined ? undefined : updateDenial(name, existing, body);
      if (existing === undefined) status = 404;
      else if (denial !== undefined) {
        status = 403;
        denied = admissionDenial(name, 'tenant-secret-update', denial);
      } else secrets.set(name, body);
    } else if (verb === 'delete' && name !== undefined) {
      if (!secrets.delete(name)) status = 404;
    }
    requests.push({ verb, path, status });
    return status;
  };

  const failure = (status: number, name = '') => {
    if (denied !== '')
      return { exitCode: 1, stdout: '', stderr: `Error from server (Forbidden): ${denied}` };
    const reason =
      status === 403
        ? 'Forbidden): secrets is forbidden: User "developer" cannot get resource "secrets"'
        : status === 409
          ? `AlreadyExists): secrets "${name}" already exists`
          : `NotFound): secrets "${name}" not found`;
    return { exitCode: 1, stdout: '', stderr: `Error from server (${reason}` };
  };

  /** Returns undefined for kubectl calls that do not involve Secrets. */
  const kubectl = (
    args: readonly string[],
  ): { exitCode: number; stdout: string; stderr: string } | undefined => {
    const verbIndex = args.findIndex((token) =>
      ['apply', 'create', 'replace', 'delete', 'get', 'label', 'patch', 'annotate'].includes(token),
    );
    const verb = args[verbIndex];
    const rest = args.slice(verbIndex + 1);
    const ok = { exitCode: 0, stdout: '', stderr: '' };
    const raw = rest.includes('--raw') ? rest[rest.indexOf('--raw') + 1] : undefined;
    if (raw !== undefined) {
      if (!raw.startsWith(collection)) return undefined;
      const file = rest[rest.indexOf('-f') + 1] ?? '';
      const body = JSON.parse(readFileSync(file, 'utf8')) as StoredSecret;
      const name = raw.slice(collection.length + 1) || undefined;
      const status = request(verb === 'create' ? 'create' : 'update', name, body);
      return status < 300 ? ok : failure(status, name ?? body.metadata.name);
    }
    if (verb === 'apply') {
      const file = rest[rest.indexOf('-f') + 1] ?? '';
      const documents = readFileSync(file, 'utf8').split(/^---$/m);
      if (!documents.some((document) => /^kind: Secret$/m.test(document))) return undefined;
      // Client-side apply reads the live object, then patches it.
      return failure(request('get', 'applied'));
    }
    const types = (rest[0] ?? '').split(',');
    if (!types.some((type) => /^secrets?$/.test(type))) return undefined;
    const selector = rest.includes('-l') || rest.includes('--selector');
    const name = selector || rest[1]?.startsWith('-') ? undefined : rest[1];
    if (verb === 'get') return failure(request(name === undefined ? 'list' : 'get', name));
    if (verb === 'label' || verb === 'patch' || verb === 'annotate') {
      return failure(request('patch', name));
    }
    if (verb === 'delete') {
      if (name === undefined) return failure(request('list'));
      const status = request('delete', name);
      if (status === 404 && !rest.includes('--ignore-not-found')) return failure(status, name);
      // kubectl delete waits by default, polling the object with GET.
      if (!rest.includes('--wait=false')) return failure(request('get', name));
      return ok;
    }
    if (verb === 'create') {
      const literal = (key: string) =>
        rest.find((token) => token.startsWith(`--from-literal=${key}=`))?.split('=')[2] ?? '';
      const secretName = rest[2] ?? '';
      const status = request('create', undefined, {
        metadata: { name: secretName },
        data: { DI_CONTROL_TOKEN: literal('DI_CONTROL_TOKEN') },
      });
      return status < 300 ? ok : failure(status, secretName);
    }
    return undefined;
  };

  const forbidden = () => requests.filter((entry) => entry.status === 403);
  return { requests, secrets, kubectl, forbidden };
}

function depsWithApi(
  cwd: string,
  api: ReturnType<typeof writeOnlySecretsApi>,
  invocations: RunnerInvocation[] = [],
  options: Omit<Parameters<typeof fakeDeps>[0], 'cwd' | 'invocations'> = {},
): WasmcloudDeps {
  const base = fakeDeps({ ...options, cwd, invocations });
  return {
    ...base,
    runner: async (command, args, options) => {
      const answered = command === 'kubectl' ? api.kubectl(args) : undefined;
      if (answered !== undefined) {
        invocations.push({ command, args: [...args], cwd: options.cwd, captured: false });
        return { exitCode: answered.exitCode };
      }
      return base.runner(command, args, options);
    },
    runCaptured: async (command, args, options) => {
      const answered = command === 'kubectl' ? api.kubectl(args) : undefined;
      if (answered !== undefined) {
        invocations.push({ command, args: [...args], cwd: options.cwd, captured: true });
        return answered;
      }
      return base.runCaptured(command, args, options);
    },
  };
}

function decoded(secret: StoredSecret | undefined, key: string): string | undefined {
  const value = secret?.data?.[key];
  return value === undefined ? undefined : Buffer.from(value, 'base64').toString('utf8');
}

const CONNECTION: ClusterConnection = {
  target: 'development',
  kubeconfig: '/tmp/kube',
  namespace: 'wasmcloud',
  registry: {
    push: 'registry.example.com/team',
    pull: 'registry.example.com/team',
    insecure: false,
  },
};

describe('write-only Secrets (platform#112)', () => {
  it('the fake API forbids the Secret reads the previous implementation relied on', () => {
    const api = writeOnlySecretsApi();
    expect(api.kubectl(['get', 'secret', 'greeter-control'])?.exitCode).toBe(1);
    expect(
      api.kubectl(['label', 'secret', 'greeter-control', 'a=b', '--overwrite'])?.exitCode,
    ).toBe(1);
    expect(
      api.kubectl(['delete', 'workloaddeployments,secret', '-l', 'app=greeter'])?.exitCode,
    ).toBe(1);
    expect(api.kubectl(['get', 'pods'])).toBeUndefined();
    expect(api.forbidden().map((entry) => entry.verb)).toEqual(['get', 'patch', 'list']);
  });

  it('deploys twice and destroys without reading, listing, watching or patching a Secret', async () => {
    const { greeter } = makeWorkspace();
    const api = writeOnlySecretsApi();
    const invocations: RunnerInvocation[] = [];
    const deps = depsWithApi(greeter, api, invocations);

    await runWasmcloudDeploy(['--target', 'development'], captureIo().io, deps);
    const first = api.secrets.get('greeter-control');
    expect(first?.metadata).toMatchObject({
      name: 'greeter-control',
      namespace: 'wasmcloud',
      labels: {
        'app.kubernetes.io/managed-by': 'di-framework',
        'app.kubernetes.io/name': 'greeter',
      },
    });
    expect(first?.type).toBe('Opaque');
    expect(decoded(first, 'DI_CONTROL_IDENTITY')).toBe('greeter');
    const firstToken = decoded(first, 'DI_CONTROL_TOKEN');
    expect(firstToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    await runWasmcloudDeploy(['--target', 'development'], captureIo().io, deps);
    const second = api.secrets.get('greeter-control');
    const secondToken = decoded(second, 'DI_CONTROL_TOKEN');
    // The token cannot be read back, so each deploy writes a fresh one ...
    expect(secondToken).not.toBe(firstToken);
    expect(decoded(second, 'DI_CONTROL_IDENTITY')).toBe('greeter');
    // ... and the manifest carries its digest so the workload rolls onto the new token.
    const yaml = readFileSync(join(greeter, '.di-framework', 'deploy', 'workload.yaml'), 'utf8');
    const revision = createHash('sha256')
      .update(secondToken ?? '')
      .digest('hex')
      .slice(0, 16);
    expect(yaml).toContain(`DI_CONTROL_TOKEN_REVISION: "${revision}"`);
    expect(yaml).not.toContain(secondToken ?? '');

    await runWasmcloudDestroy(['--target', 'development'], captureIo().io, deps);
    expect(api.secrets.has('greeter-control')).toBe(false);

    expect(api.forbidden()).toEqual([]);
    expect(api.requests.map((entry) => `${entry.verb} ${entry.status}`)).toEqual([
      'create 201',
      'create 409',
      'update 200',
      'delete 200',
    ]);
    expect(api.requests[2]?.path).toBe('/api/v1/namespaces/wasmcloud/secrets/greeter-control');
  });

  it('destroys a workload whose control Secret is already gone', async () => {
    const { greeter } = makeWorkspace();
    const api = writeOnlySecretsApi();
    await runWasmcloudDestroy(
      ['--target', 'development'],
      captureIo().io,
      depsWithApi(greeter, api),
    );
    expect(api.requests).toEqual([
      {
        verb: 'delete',
        path: '/api/v1/namespaces/wasmcloud/secrets/greeter-control',
        status: 404,
      },
    ]);
  });

  it('surfaces create and replace failures that are not AlreadyExists', async () => {
    const { greeter } = makeWorkspace();
    const project = loadProject(greeter);
    const respond = (exitCode: number, stderr: string) => {
      const deps = fakeDeps({ cwd: greeter });
      deps.runCaptured = async () => ({ exitCode, stdout: '', stderr });
      return deps;
    };
    await expect(
      writeControlSecret(
        project,
        CONNECTION,
        respond(1, 'Error from server (Forbidden): secrets is forbidden: exceeded quota\n'),
      ),
    ).rejects.toMatchObject({
      code: 'WASMCLOUD_TOOL_FAILED',
      message:
        'kubectl create failed with exit code 1: Error from server (Forbidden): secrets is forbidden: exceeded quota',
      details: { command: 'kubectl create' },
    });
    await expect(writeControlSecret(project, CONNECTION, respond(7, ''))).rejects.toMatchObject({
      message: 'kubectl create failed with exit code 7',
      details: { command: 'kubectl create', exitCode: 7, stderr: '' },
    });

    const deps = fakeDeps({ cwd: greeter });
    deps.runCaptured = async (_command, args) =>
      args.includes('create')
        ? { exitCode: 1, stdout: '', stderr: 'Error from server (AlreadyExists): exists' }
        : { exitCode: 1, stdout: '', stderr: 'Error from server (Invalid): type is immutable' };
    await expect(writeControlSecret(project, CONNECTION, deps)).rejects.toMatchObject({
      code: 'WASMCLOUD_TOOL_FAILED',
      message:
        'kubectl replace failed with exit code 1: Error from server (Invalid): type is immutable',
      details: { command: 'kubectl replace' },
    });
  });

  it('never shows the token when a failure echoes the request body', async () => {
    const { greeter } = makeWorkspace();
    const project = loadProject(greeter);
    let body = '';
    const deps = fakeDeps({ cwd: greeter });
    deps.runCaptured = async (_command, args) => {
      body = readFileSync(args[args.indexOf('-f') + 1] ?? '', 'utf8');
      return { exitCode: 1, stdout: '', stderr: `Error from server (BadRequest): ${body}` };
    };
    const failure = await writeControlSecret(project, CONNECTION, deps).then(
      () => undefined,
      (error: unknown) => error as { message: string; details: { stderr: string } },
    );
    const sent = JSON.parse(body) as StoredSecret;
    const encoded = sent.data?.DI_CONTROL_TOKEN ?? '';
    const token = Buffer.from(encoded, 'base64').toString('utf8');
    expect(token.length).toBeGreaterThan(0);
    for (const text of [failure?.message ?? '', failure?.details.stderr ?? '']) {
      expect(text).toContain('Error from server (BadRequest)');
      expect(text).not.toContain(token);
      expect(text).not.toContain(encoded);
    }
  });

  it('tells the user to delete a control Secret that has keys the CLI did not write', async () => {
    const { greeter } = makeWorkspace();
    const project = loadProject(greeter);
    const api = writeOnlySecretsApi();
    const encode = (value: string) => Buffer.from(value, 'utf8').toString('base64');
    api.secrets.set('greeter-control', {
      metadata: { name: 'greeter-control' },
      data: {
        DI_CONTROL_TOKEN: encode('old'),
        DI_CONTROL_IDENTITY: encode('greeter'),
        EXTRA: encode('hand-added'),
      },
    });
    await expect(
      writeControlSecret(project, CONNECTION, depsWithApi(greeter, api)),
    ).rejects.toMatchObject({
      code: 'WASMCLOUD_CONTROL_SECRET_FOREIGN_KEYS',
      message:
        "The control Secret greeter-control has keys this CLI didn't write; delete it with " +
        '`kubectl delete secret greeter-control --namespace wasmcloud` and redeploy',
      details: { name: 'greeter-control', command: 'kubectl replace' },
    });
    // The denied replace left the Secret as it was.
    expect(decoded(api.secrets.get('greeter-control'), 'EXTRA')).toBe('hand-added');
    expect(api.requests.map((entry) => `${entry.verb} ${entry.status}`)).toEqual([
      'create 409',
      'update 403',
    ]);
  });

  it('says the token was rotated when the deploy fails after the control Secret write', async () => {
    const { greeter } = makeWorkspace();
    const api = writeOnlySecretsApi();
    const encode = (value: string) => Buffer.from(value, 'utf8').toString('base64');
    api.secrets.set('greeter-control', {
      metadata: { name: 'greeter-control' },
      data: { DI_CONTROL_TOKEN: encode('running'), DI_CONTROL_IDENTITY: encode('greeter') },
    });
    const applyFails = depsWithApi(greeter, api, [], { exitCodes: { 'kubectl apply': 1 } });
    await expect(
      runWasmcloudDeploy(['--target', 'development'], captureIo().io, applyFails),
    ).rejects.toMatchObject({
      code: 'WASMCLOUD_TOOL_FAILED',
      message: `kubectl apply failed with exit code 1; ${CONTROL_TOKEN_ROTATED_NOTICE}`,
      exitCode: 3,
      details: { command: 'kubectl apply', exitCode: 1, controlTokenRotated: true },
    });
    // The write happened: cron invokers now read a token the running workload does not have.
    expect(decoded(api.secrets.get('greeter-control'), 'DI_CONTROL_TOKEN')).not.toBe('running');

    const neverReady = depsWithApi(greeter, api, [], { capturedStdout: { 'kubectl get': '{}' } });
    await expect(
      runWasmcloudDeploy(['--target', 'development'], captureIo().io, neverReady),
    ).rejects.toMatchObject({
      code: 'WASMCLOUD_DEPLOYMENT_NOT_READY',
      message: `WorkloadDeployment greeter in wasmcloud did not become ready; ${CONTROL_TOKEN_ROTATED_NOTICE}`,
      details: { name: 'greeter', controlTokenRotated: true },
    });
  });

  it('leaves errors that are not command failures as they are', async () => {
    const { greeter } = makeWorkspace();
    const api = writeOnlySecretsApi();
    const deps = depsWithApi(greeter, api);
    const interrupted = new Error('interrupted');
    const runner = deps.runner;
    deps.runner = async (command, args, options) => {
      if (command === 'kubectl' && args.includes('apply')) throw interrupted;
      return runner(command, args, options);
    };
    await expect(
      runWasmcloudDeploy(['--target', 'development'], captureIo().io, deps),
    ).rejects.toBe(interrupted);
  });

  it('reassigns a console credential with a full update and never a patch', async () => {
    const api = writeOnlySecretsApi();
    api.secrets.set('db-password', { metadata: { name: 'db-password' } });
    const logs: string[] = [];
    const cluster = createKubectlConsoleCluster(depsWithApi('/tmp', api), (line) =>
      logs.push(line),
    );
    await cluster.reassignSecret(CONNECTION, 'db-password', 'next-value');
    expect(decoded(api.secrets.get('db-password'), 'credential')).toBe('next-value');
    expect(api.secrets.get('db-password')?.metadata).toEqual({
      name: 'db-password',
      namespace: 'wasmcloud',
    });
    await expect(cluster.reassignSecret(CONNECTION, 'missing', 'next-value')).rejects.toMatchObject(
      { status: 404, code: 'SECRET_NOT_FOUND' },
    );
    expect(api.forbidden()).toEqual([]);
    expect(api.requests.map((entry) => `${entry.verb} ${entry.status}`)).toEqual([
      'update 200',
      'update 404',
    ]);

    const denied = createKubectlConsoleCluster(
      {
        ...fakeDeps({ cwd: '/tmp' }),
        runCaptured: async () => ({
          exitCode: 1,
          stdout: '',
          stderr: 'Error from server (Forbidden): secrets "db-password" is forbidden',
        }),
      },
      (line) => logs.push(line),
    );
    await expect(
      denied.reassignSecret(CONNECTION, 'db-password', 'next-value'),
    ).rejects.toMatchObject({ status: 403, code: 'WRITES_FORBIDDEN' });
  });

  it('reassigns only a single-credential Secret and maps a key-dropping denial to 409', async () => {
    const api = writeOnlySecretsApi();
    const encode = (value: string) => Buffer.from(value, 'utf8').toString('base64');
    api.secrets.set('db-password', {
      metadata: { name: 'db-password' },
      data: { credential: encode('old') },
    });
    api.secrets.set('db-login', {
      metadata: { name: 'db-login' },
      data: { credential: encode('old'), username: encode('app') },
    });
    api.secrets.set('api-key', {
      metadata: { name: 'api-key' },
      data: { password: encode('old') },
    });
    const cluster = createKubectlConsoleCluster(depsWithApi('/tmp', api));

    await cluster.reassignSecret(CONNECTION, 'db-password', 'next-value');
    expect(decoded(api.secrets.get('db-password'), 'credential')).toBe('next-value');
    for (const name of ['db-login', 'api-key']) {
      await expect(cluster.reassignSecret(CONNECTION, name, 'next-value')).rejects.toMatchObject({
        status: 409,
        code: 'SECRET_NOT_SINGLE_KEY',
      });
    }
    // The denied replaces left both Secrets as they were.
    expect(decoded(api.secrets.get('db-login'), 'username')).toBe('app');
    expect(decoded(api.secrets.get('api-key'), 'password')).toBe('old');
    expect(api.requests.map((entry) => `${entry.verb} ${entry.status}`)).toEqual([
      'update 200',
      'update 403',
      'update 403',
    ]);
  });

  it('refuses a platform-managed Secret locally, before any request', async () => {
    const api = writeOnlySecretsApi();
    const invocations: RunnerInvocation[] = [];
    const cluster = createKubectlConsoleCluster(depsWithApi('/tmp', api, invocations));
    for (const name of [
      'di-binding-orders',
      'di-bs-orders',
      'di-tenant-stock',
      'di-platform-routes',
    ]) {
      await expect(cluster.reassignSecret(CONNECTION, name, 'next-value')).rejects.toMatchObject({
        status: 403,
        code: 'SECRET_MANAGED',
      });
    }
    expect(invocations).toEqual([]);
    expect(api.requests).toEqual([]);
  });

  it('maps a managed-name admission denial to 403 when the API server refuses it', async () => {
    for (const message of [MANAGED_DENIAL, BACKEND_CONFIG_DENIAL]) {
      const cluster = createKubectlConsoleCluster({
        ...fakeDeps({ cwd: '/tmp' }),
        runCaptured: async () => ({
          exitCode: 1,
          stdout: '',
          stderr: `Error from server (Forbidden): ${admissionDenial('orders-creds', 'tenant-secret-update', message)}`,
        }),
      });
      await expect(
        cluster.reassignSecret(CONNECTION, 'orders-creds', 'next-value'),
      ).rejects.toMatchObject({ status: 403, code: 'SECRET_MANAGED' });
    }
  });
});

/**
 * The same contract against the real kubectl binary and an HTTP API server, to pin down the
 * requests kubectl itself sends (e.g. that `replace -f` would GET first, and `delete` waits
 * with a GET unless told not to). Skipped where kubectl is not installed.
 */
const kubectlPath = Bun.which('kubectl');
describe.skipIf(kubectlPath === null)('write-only Secrets with the real kubectl', () => {
  const requests: string[] = [];
  const secrets = new Map<string, unknown>();
  let server: ReturnType<typeof Bun.serve>;
  let connection: ClusterConnection;
  const status = (code: number, reason: string, message: string) =>
    Response.json(
      { kind: 'Status', apiVersion: 'v1', status: 'Failure', reason, code, message },
      { status: code },
    );

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(incoming) {
        const url = new URL(incoming.url);
        const match = url.pathname.match(/^\/api\/v1\/namespaces\/([^/]+)\/secrets(?:\/(.+))?$/);
        if (url.pathname === '/api') {
          return Response.json({
            kind: 'APIVersions',
            versions: ['v1'],
            serverAddressByClientCIDRs: [{ clientCIDR: '0.0.0.0/0', serverAddress: 'fake' }],
          });
        }
        if (url.pathname === '/apis') {
          return Response.json({ kind: 'APIGroupList', apiVersion: 'v1', groups: [] });
        }
        if (url.pathname === '/api/v1') {
          return Response.json({
            kind: 'APIResourceList',
            groupVersion: 'v1',
            resources: [
              {
                name: 'secrets',
                singularName: 'secret',
                namespaced: true,
                kind: 'Secret',
                verbs: ['create', 'delete', 'get', 'list', 'patch', 'update', 'watch'],
              },
            ],
          });
        }
        if (match === null) return new Response('not found', { status: 404 });
        requests.push(`${incoming.method} ${url.pathname}`);
        const name = match[2];
        if (incoming.method === 'GET' || incoming.method === 'PATCH') {
          return status(403, 'Forbidden', 'secrets is forbidden');
        }
        if (incoming.method === 'POST') {
          const body = (await incoming.json()) as StoredSecret;
          if (secrets.has(body.metadata.name)) {
            return status(409, 'AlreadyExists', `secrets "${body.metadata.name}" already exists`);
          }
          secrets.set(body.metadata.name, body);
          return Response.json(body, { status: 201 });
        }
        if (incoming.method === 'PUT' && name !== undefined) {
          const existing = secrets.get(name) as StoredSecret | undefined;
          if (existing === undefined) {
            return status(404, 'NotFound', `secrets "${name}" not found`);
          }
          const body = (await incoming.json()) as StoredSecret;
          // A name the platform manages that this CLI does not know of yet still reaches the
          // policy; it stands in for the server-side managed-name rule.
          const denial = name.startsWith('future-managed-')
            ? MANAGED_DENIAL
            : updateDenial(name, existing, body);
          if (denial !== undefined) {
            return status(403, 'Forbidden', admissionDenial(name, 'tenant-secret-update', denial));
          }
          secrets.set(name, body);
          return Response.json(body);
        }
        if (incoming.method === 'DELETE' && name !== undefined) {
          const existing = secrets.get(name);
          if (existing === undefined) {
            return status(404, 'NotFound', `secrets "${name}" not found`);
          }
          secrets.delete(name);
          return Response.json(existing);
        }
        return status(405, 'MethodNotAllowed', 'unsupported');
      },
    });
    const directory = mkdtempSync(join(tmpdir(), 'write-only-kubeconfig-'));
    const kubeconfig = join(directory, 'kubeconfig.yaml');
    writeFileSync(
      kubeconfig,
      `apiVersion: v1
kind: Config
clusters: [{name: fake, cluster: {server: "http://127.0.0.1:${server.port}"}}]
users: [{name: developer, user: {token: developer}}]
contexts: [{name: fake, context: {cluster: fake, user: developer}}]
current-context: fake
`,
    );
    connection = { ...CONNECTION, kubeconfig, context: 'fake' };
  });

  afterAll(() => {
    server.stop(true);
  });

  const realDeps = (cwd: string): WasmcloudDeps => {
    // Asynchronous: the fake API server answers on this process's event loop.
    const spawn = async (args: readonly string[]) => {
      const child = Bun.spawn(['kubectl', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { exitCode, stdout, stderr };
    };
    return {
      ...fakeDeps({ cwd }),
      runner: async (_command, args) => ({ exitCode: (await spawn(args)).exitCode }),
      runCaptured: async (_command, args) => spawn(args),
    };
  };

  it('creates, replaces and deletes the control Secret with POST, PUT and DELETE only', async () => {
    const { greeter } = makeWorkspace();
    const project = loadProject(greeter);
    const deps = realDeps(greeter);
    await writeControlSecret(project, connection, deps);
    await writeControlSecret(project, connection, deps);
    await deleteControlSecret(project, connection, deps);
    await deleteControlSecret(project, connection, deps);
    const cluster = createKubectlConsoleCluster(deps);
    await expect(cluster.reassignSecret(connection, 'absent', 'value')).rejects.toMatchObject({
      status: 404,
    });
    const collection = '/api/v1/namespaces/wasmcloud/secrets';
    const encode = (value: string) => Buffer.from(value, 'utf8').toString('base64');
    secrets.set('db-login', {
      metadata: { name: 'db-login' },
      data: { credential: encode('old'), username: encode('app') },
    });
    secrets.set('future-managed-creds', { metadata: { name: 'future-managed-creds' } });
    await expect(cluster.reassignSecret(connection, 'db-login', 'value')).rejects.toMatchObject({
      status: 409,
      code: 'SECRET_NOT_SINGLE_KEY',
    });
    await expect(
      cluster.reassignSecret(connection, 'future-managed-creds', 'value'),
    ).rejects.toMatchObject({ status: 403, code: 'SECRET_MANAGED' });
    await expect(cluster.reassignSecret(connection, 'di-bs-orders', 'value')).rejects.toMatchObject(
      { status: 403, code: 'SECRET_MANAGED' },
    );
    expect(requests).toEqual([
      `POST ${collection}`,
      `POST ${collection}`,
      `PUT ${collection}/greeter-control`,
      `DELETE ${collection}/greeter-control`,
      `DELETE ${collection}/greeter-control`,
      `PUT ${collection}/absent`,
      `PUT ${collection}/db-login`,
      `PUT ${collection}/future-managed-creds`,
    ]);
  }, 30_000);
});
