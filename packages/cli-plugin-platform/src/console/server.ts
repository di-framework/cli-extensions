import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { type CliIo, isCommandFailure } from '@di-framework/cli-extension';
import type { WasmcloudDeps } from '../deps';
import { loadDeployManifest } from '../manifest';
import { isBackingServiceName, isServiceType, SERVICE_TYPES } from '../service';
import { type ClusterConnection, resolveConnection, resolveTarget } from '../target';
import {
  CSRF_HEADER,
  createSessionStore,
  passwordsMatch,
  readCookie,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  type SessionStore,
  sessionCookie,
  tokensMatch,
} from './auth';
import {
  assertResourceName,
  type CronJobDocument,
  cronInTenantScope,
  listTargetViews,
  parseAppUpdate,
  parseCronUpdate,
  planWorkloadUpdate,
  summarizeCron,
  summarizeWorkload,
  unassignedCronJobs,
  type WorkloadDocument,
  workloadInTenantScope,
} from './catalog';
import { type ConsoleCluster, createKubectlConsoleCluster } from './cluster';
import { ConsoleError, sanitizePublicText } from './errors';
import {
  type ConsoleServices,
  createCliConsoleServices,
  type ServiceCreateInput,
} from './services';

const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'cross-origin-resource-policy': 'same-origin',
  'cross-origin-opener-policy': 'same-origin',
  'cache-control': 'no-store',
} as const;

const ASSET_EXTENSIONS = new Set(['.js', '.css', '.map', '.woff', '.woff2', '.ttf', '.svg']);
const MAX_BODY_BYTES = 65_536;
const DELETION_POLICIES = new Set(['Retain', 'Delete']);

export type ConsoleServer = {
  port: number;
  url: string;
  close: () => Promise<void>;
};

export type ConsoleServerOptions = {
  host: string;
  port: number;
  password: string;
  /** Deployment target whose kubeconfig, namespace, and host group are the tenant credential. */
  target: string;
  deps: WasmcloudDeps;
  assetsDirectory: string;
  io?: CliIo;
  cluster?: ConsoleCluster;
  services?: ConsoleServices;
  now?: () => number;
};

type TargetGroup = {
  target: string;
  namespace?: string;
  apps: ReturnType<typeof summarizeWorkload>[];
  error?: string;
};

export function startConsoleServer(options: ConsoleServerOptions): Promise<ConsoleServer> {
  const log = (line: string) => options.io?.stderr.write(`${line}\n`);
  const cluster = options.cluster ?? createKubectlConsoleCluster(options.deps, log);
  const services =
    options.services ?? createCliConsoleServices(options.deps, options.io ?? silentIo());
  const sessions = createSessionStore();
  const now = options.now ?? Date.now;
  const connections = new Map<string, Promise<ClusterConnection>>();
  const server = createServer((request, response) => {
    void handle(request, response, {
      ...options,
      cluster,
      services,
      sessions,
      now,
      connections,
      log,
    }).catch((error) => {
      log(error instanceof Error ? error.message : 'console request failed');
      sendJson(response, 500, {
        error: 'The console request failed.',
        code: 'CONSOLE_REQUEST_FAILED',
      });
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : options.port;
      resolve({
        port,
        url: `http://${options.host}:${port}`,
        close: () =>
          new Promise((done, fail) => {
            if (!server.listening) {
              done();
              return;
            }
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });
}

type HandlerOptions = ConsoleServerOptions & {
  cluster: ConsoleCluster;
  services: ConsoleServices;
  sessions: SessionStore;
  now: () => number;
  connections: Map<string, Promise<ClusterConnection>>;
  log: (line: string) => void;
};

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  options: HandlerOptions,
): Promise<void> {
  const hostHeader = request.headers.host;
  if (
    typeof hostHeader !== 'string' ||
    !allowedHost(hostHeader, options.host, boundPort(request))
  ) {
    sendJson(response, 403, {
      error: 'This host is not allowed to use the console.',
      code: 'HOST_NOT_ALLOWED',
    });
    return;
  }
  const url = new URL(request.url ?? '/', `http://${hostHeader}`);
  const method = request.method ?? 'GET';

  if (method === 'GET' && (url.pathname === '/' || isSpaPath(url.pathname))) {
    sendFile(response, join(options.assetsDirectory, 'index.html'), 'text/html; charset=utf-8');
    return;
  }
  if (method === 'GET' && url.pathname.startsWith('/assets/')) {
    const asset = resolveAsset(options.assetsDirectory, url.pathname.slice('/assets/'.length));
    if (asset === undefined) {
      sendJson(response, 404, { error: 'Not found', code: 'NOT_FOUND' });
      return;
    }
    sendFile(response, asset.path, asset.type);
    return;
  }
  if (!url.pathname.startsWith('/api/')) {
    sendJson(response, 404, { error: 'Not found', code: 'NOT_FOUND' });
    return;
  }

  try {
    await routeApi(method, url, request, response, options);
  } catch (error) {
    const mapped = publicError(error);
    if (mapped.status >= 500)
      options.log(sanitizePublicText(error instanceof Error ? error.message : 'request failed'));
    sendJson(response, mapped.status, mapped.body);
  }
}

async function routeApi(
  method: string,
  url: URL,
  request: IncomingMessage,
  response: ServerResponse,
  options: HandlerOptions,
): Promise<void> {
  if (method === 'POST' && url.pathname === '/api/login') {
    requireOrigin(request);
    await login(request, response, options);
    return;
  }

  const sessionId = readCookie(request.headers.cookie, SESSION_COOKIE);
  const session = options.sessions.read(sessionId, options.now());
  if (method === 'GET' && url.pathname === '/api/session') {
    if (session === undefined) {
      sendJson(response, 200, { authenticated: false });
      return;
    }
    sendJson(response, 200, { authenticated: true, csrfToken: session.csrf });
    return;
  }
  if (session === undefined) {
    sendJson(response, 401, { error: 'Sign in required.', code: 'SIGN_IN_REQUIRED' });
    return;
  }
  if (method !== 'GET') {
    requireOrigin(request);
    const header = request.headers[CSRF_HEADER];
    const provided = Array.isArray(header) ? header[0] : header;
    if (!tokensMatch(provided, session.csrf)) {
      throw new ConsoleError(403, 'CSRF_REJECTED', 'The form token does not match this session.');
    }
  }

  if (method === 'POST' && url.pathname === '/api/logout') {
    options.sessions.destroy(sessionId);
    response.setHeader('set-cookie', sessionCookie('', 0));
    sendJson(response, 200, { authenticated: false });
    return;
  }
  if (method === 'GET' && url.pathname === '/api/targets') {
    const manifest = loadManifest(options);
    assertTenantTarget(options, options.target);
    sendJson(response, 200, {
      targets: listTargetViews(manifest).filter((view) => view.name === options.target),
    });
    return;
  }
  if (method === 'GET' && url.pathname === '/api/apps') {
    const target = url.searchParams.get('target') ?? undefined;
    sendJson(response, 200, await listApps(options, target));
    return;
  }

  const appName = namedPath(url.pathname, '/api/apps/');
  if (appName !== undefined && method === 'GET') {
    assertResourceName(appName, 'Application name');
    const target = requiredQueryTarget(url);
    sendJson(response, 200, await oneApp(options, target, appName));
    return;
  }
  if (appName !== undefined && method === 'PATCH') {
    assertResourceName(appName, 'Application name');
    const update = parseAppUpdate(await readBody(request));
    sendJson(response, 200, await updateApp(options, appName, update));
    return;
  }

  const cronName = namedPath(url.pathname, '/api/cronjobs/');
  if (cronName !== undefined && method === 'PATCH') {
    assertResourceName(cronName, 'CronJob name');
    const update = parseCronUpdate(await readBody(request));
    sendJson(response, 200, await updateCron(options, cronName, update));
    return;
  }

  if (url.pathname === '/api/services' && method === 'GET') {
    const target = requiredQueryTarget(url);
    assertTenantTarget(options, target);
    sendJson(response, 200, { target, services: await options.services.list(target) });
    return;
  }
  if (url.pathname === '/api/services' && method === 'POST') {
    const input = parseServiceCreate(await readBody(request));
    assertTenantTarget(options, input.target);
    sendJson(response, 201, { service: await options.services.create(input) });
    return;
  }
  if (url.pathname === '/api/service-classes' && method === 'GET') {
    const target = requiredQueryTarget(url);
    assertTenantTarget(options, target);
    sendJson(response, 200, await options.services.classes(target));
    return;
  }
  const serviceName = namedPath(url.pathname, '/api/services/');
  if (serviceName !== undefined && method === 'DELETE') {
    if (!isBackingServiceName(serviceName)) {
      throw new ConsoleError(
        400,
        'INVALID_NAME',
        'Service name must be a DNS label of at most 40 characters.',
      );
    }
    const target = requiredQueryTarget(url);
    assertTenantTarget(options, target);
    sendJson(response, 200, await options.services.delete(target, serviceName));
    return;
  }

  sendJson(response, 404, { error: 'Not found', code: 'NOT_FOUND' });
}

async function login(
  request: IncomingMessage,
  response: ServerResponse,
  options: HandlerOptions,
): Promise<void> {
  const remote = request.socket.remoteAddress ?? 'unknown';
  if (!options.sessions.loginAllowed(remote, options.now())) {
    sendJson(response, 429, {
      error: 'Too many sign-in attempts. Wait before trying again.',
      code: 'SIGN_IN_LIMIT',
    });
    return;
  }
  const body = await readBody(request);
  const password =
    body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as { password?: unknown }).password
      : undefined;
  if (typeof password !== 'string' || !passwordsMatch(password, options.password)) {
    options.sessions.recordFailure(remote, options.now());
    sendJson(response, 401, { error: 'The password is not valid.', code: 'SIGN_IN_FAILED' });
    return;
  }
  options.sessions.clearFailures(remote);
  const created = options.sessions.create();
  response.setHeader('set-cookie', sessionCookie(created.id, Math.floor(SESSION_TTL_MS / 1000)));
  sendJson(response, 200, { authenticated: true, csrfToken: created.session.csrf });
}

async function listApps(
  options: HandlerOptions,
  target: string | undefined,
): Promise<{ results: TargetGroup[] }> {
  const names = [assertTenantTarget(options, target ?? options.target)];
  const results: TargetGroup[] = [];
  for (const name of names) {
    try {
      const loaded = await loadTarget(options, name);
      results.push({ target: name, namespace: loaded.connection.namespace, apps: loaded.apps });
    } catch (error) {
      options.log(
        sanitizePublicText(error instanceof Error ? error.message : 'target query failed'),
      );
      results.push({
        target: name,
        apps: [],
        error: error instanceof ConsoleError ? error.message : 'The cluster request failed.',
      });
    }
  }
  return { results };
}

async function oneApp(options: HandlerOptions, target: string, name: string) {
  assertTenantTarget(options, target);
  const loaded = await loadTarget(options, target);
  const app = loaded.apps.find((entry) => entry?.name === name);
  if (app === undefined)
    throw new ConsoleError(
      404,
      'APP_NOT_FOUND',
      `No deployed application named ${name} on this target.`,
    );
  return { app, unassignedCronJobs: loaded.unassigned };
}

async function updateApp(
  options: HandlerOptions,
  name: string,
  update: ReturnType<typeof parseAppUpdate>,
) {
  assertTenantTarget(options, update.target);
  const loaded = await loadTarget(options, update.target);
  const document = loaded.documents.find((entry) => entry.metadata?.name === name);
  if (document === undefined) {
    throw new ConsoleError(
      404,
      'APP_NOT_FOUND',
      `No deployed application named ${name} on this target.`,
    );
  }
  const ops = planWorkloadUpdate(document, update);
  if (ops.length > 0) await options.cluster.patchWorkload(loaded.connection, name, ops);
  const refreshed = await loadTarget(options, update.target);
  const app = refreshed.apps.find((entry) => entry?.name === name);
  if (app === undefined)
    throw new ConsoleError(
      404,
      'APP_NOT_FOUND',
      `No deployed application named ${name} on this target.`,
    );
  return { app };
}

async function updateCron(
  options: HandlerOptions,
  name: string,
  update: { target: string; suspend: boolean },
) {
  assertTenantTarget(options, update.target);
  const loaded = await loadTarget(options, update.target);
  const cron = loaded.cronJobs.map(summarizeCron).find((entry) => entry?.name === name);
  if (cron === undefined)
    throw new ConsoleError(404, 'CRON_NOT_FOUND', `No cron job named ${name} on this target.`);
  if (cron.suspend !== update.suspend) {
    await options.cluster.patchCronJob(loaded.connection, name, update.suspend);
  }
  return { cronJob: { ...cron, suspend: update.suspend } };
}

async function loadTarget(options: HandlerOptions, target: string) {
  const connection = await connectionFor(options, target);
  const [listedDocuments, listedCronJobs] = await Promise.all([
    options.cluster.listWorkloads(connection),
    options.cluster.listCronJobs(connection),
  ]);
  const documents = listedDocuments.filter((document) =>
    workloadInTenantScope(document, connection),
  );
  const cronJobs = listedCronJobs.filter((job) => cronInTenantScope(job, connection.namespace));
  const apps = documents
    .map((document) => summarizeWorkload(document, target, cronJobs))
    .filter((app): app is NonNullable<typeof app> => app !== undefined)
    .sort((left, right) => left.name.localeCompare(right.name));
  return {
    connection,
    documents,
    cronJobs,
    apps,
    unassigned: unassignedCronJobs(
      apps.filter((app): app is NonNullable<typeof app> => app !== undefined),
      cronJobs,
    ),
  };
}

function connectionFor(options: HandlerOptions, targetName: string): Promise<ClusterConnection> {
  const cached = options.connections.get(targetName);
  if (cached !== undefined) return cached;
  const manifest = loadManifest(options);
  const target = resolveTarget(manifest, targetName);
  const pending = resolveConnection(target, manifest.workspaceRoot, manifest.path, options.deps);
  options.connections.set(target.name, pending);
  pending.catch(() => options.connections.delete(target.name));
  return pending;
}

function loadManifest(options: HandlerOptions) {
  return loadDeployManifest(options.deps.cwd(), options.deps.env);
}

function assertTenantTarget(options: HandlerOptions, target: string): string {
  const selected = loadManifest(options).targets[target];
  const tenant = selected?.kind === 'external' && selected.hostgroup !== undefined;
  if (target !== options.target || !tenant) {
    throw new ConsoleError(404, 'TENANT_SCOPE', 'This console is scoped to one tenant.');
  }
  return target;
}

function requiredQueryTarget(url: URL): string {
  const target = url.searchParams.get('target');
  if (target === null || target.length === 0) {
    throw new ConsoleError(400, 'TARGET_REQUIRED', 'Choose a deployment target.');
  }
  return target;
}

function parseServiceCreate(body: unknown): ServiceCreateInput {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ConsoleError(400, 'INVALID_BODY', 'Request body must be an object.');
  }
  const record = body as Record<string, unknown>;
  const allowed = new Set([
    'target',
    'type',
    'name',
    'className',
    'memory',
    'storage',
    'cpu',
    'deletionPolicy',
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new ConsoleError(400, 'INVALID_BODY', 'The request contains unsupported fields.');
  }
  if (typeof record.target !== 'string' || record.target.length === 0) {
    throw new ConsoleError(400, 'INVALID_BODY', 'A deployment target is required.');
  }
  if (typeof record.type !== 'string' || !isServiceType(record.type)) {
    throw new ConsoleError(
      400,
      'INVALID_SERVICE',
      `Service type must be one of ${SERVICE_TYPES.join(', ')}.`,
    );
  }
  if (typeof record.name !== 'string' || !isBackingServiceName(record.name)) {
    throw new ConsoleError(
      400,
      'INVALID_NAME',
      'Service name must be a DNS label of at most 40 characters.',
    );
  }
  const input: ServiceCreateInput = { target: record.target, type: record.type, name: record.name };
  for (const key of ['className', 'memory', 'storage', 'cpu', 'deletionPolicy'] as const) {
    const value = record[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length === 0 || value.length > 40) {
      throw new ConsoleError(400, 'INVALID_SERVICE', `${key} must be a short string.`);
    }
    if (key === 'className' && !isBackingServiceName(value)) {
      throw new ConsoleError(
        400,
        'INVALID_NAME',
        'Class name must be a DNS label of at most 40 characters.',
      );
    }
    if (key === 'deletionPolicy' && !DELETION_POLICIES.has(value)) {
      throw new ConsoleError(400, 'INVALID_SERVICE', 'Deletion policy must be Retain or Delete.');
    }
    input[key] = value;
  }
  return input;
}

function namedPath(pathname: string, prefix: string): string | undefined {
  if (!pathname.startsWith(prefix)) return undefined;
  const rest = pathname.slice(prefix.length);
  if (rest.length === 0 || rest.includes('/')) return undefined;
  try {
    return decodeURIComponent(rest);
  } catch {
    return undefined;
  }
}

function requireOrigin(request: IncomingMessage): void {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (typeof origin !== 'string' || typeof host !== 'string' || origin !== `http://${host}`) {
    throw new ConsoleError(403, 'ORIGIN_REJECTED', 'The request origin is not allowed.');
  }
}

function allowedHost(hostHeader: string, bindHost: string, port: number): boolean {
  const normalized = hostHeader.trim().toLowerCase();
  const names = new Set([`${bindHost.toLowerCase()}:${port}`]);
  if (bindHost === '127.0.0.1' || bindHost === 'localhost' || bindHost === '::1') {
    names.add(`127.0.0.1:${port}`);
    names.add(`localhost:${port}`);
    names.add(`[::1]:${port}`);
  }
  return names.has(normalized);
}

function boundPort(request: IncomingMessage): number {
  const address = request.socket.localPort;
  return typeof address === 'number' ? address : 0;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      throw new ConsoleError(413, 'BODY_TOO_LARGE', 'The request body is too large.');
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new ConsoleError(400, 'INVALID_BODY', 'Request body must be JSON.');
  }
}

function publicError(error: unknown): { status: number; body: { error: string; code: string } } {
  if (error instanceof ConsoleError) {
    return { status: error.status, body: { error: error.message, code: error.code } };
  }
  if (isCommandFailure(error)) {
    const status =
      error.code === 'WASMCLOUD_SERVICE_NOT_FOUND' || error.code === 'WASMCLOUD_TARGET_NOT_FOUND'
        ? 404
        : error.code === 'WASMCLOUD_SERVICE_ALREADY_EXISTS'
          ? 409
          : error.code === 'WASMCLOUD_SERVICE_UNAUTHORIZED'
            ? 403
            : error.code === 'WASMCLOUD_SERVICE_IN_USE'
              ? 409
              : error.exitCode === 2
                ? 400
                : 502;
    if (status === 502) {
      return {
        status,
        body: { error: 'The cluster request failed.', code: 'CLUSTER_REQUEST_FAILED' },
      };
    }
    if (error.code === 'WASMCLOUD_SERVICE_UNAUTHORIZED') {
      return {
        status,
        body: {
          error: 'Not authorized to manage backing services on this target.',
          code: error.code,
        },
      };
    }
    return { status, body: { error: sanitizePublicText(error.message), code: error.code } };
  }
  return {
    status: 502,
    body: { error: 'The cluster request failed.', code: 'CLUSTER_REQUEST_FAILED' },
  };
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return;
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(payload);
}

function sendFile(response: ServerResponse, path: string, contentType: string): void {
  if (!existsSync(path)) {
    sendJson(response, 404, { error: 'Not found', code: 'NOT_FOUND' });
    return;
  }
  response.writeHead(200, { ...SECURITY_HEADERS, 'content-type': contentType });
  createReadStream(path).pipe(response);
}

function resolveAsset(root: string, name: string): { path: string; type: string } | undefined {
  if (name.length === 0 || name.includes('..') || name.includes('\\') || name.includes('\0'))
    return undefined;
  const full = normalize(join(root, name));
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (full !== root && !full.startsWith(prefix)) return undefined;
  if (!existsSync(full) || !statSync(full).isFile()) return undefined;
  const extension = extname(full).toLowerCase();
  if (!ASSET_EXTENSIONS.has(extension)) return undefined;
  return { path: full, type: contentType(extension) };
}

function contentType(extension: string): string {
  switch (extension) {
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.woff':
      return 'font/woff';
    case '.woff2':
      return 'font/woff2';
    case '.ttf':
      return 'font/ttf';
    default:
      return 'application/octet-stream';
  }
}

function isSpaPath(pathname: string): boolean {
  if (pathname.startsWith('/api/') || pathname.startsWith('/assets/')) return false;
  const leaf = pathname.split('/').pop() ?? '';
  return !leaf.includes('.');
}

function silentIo(): CliIo {
  return { stdout: { write: () => undefined }, stderr: { write: () => undefined } };
}

export type { CronJobDocument, WorkloadDocument };
