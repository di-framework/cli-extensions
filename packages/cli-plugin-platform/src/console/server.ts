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
  readCookie,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  type SessionStore,
  sessionCookie,
  tokensMatch,
} from './auth';
import {
  type ApplicationView,
  assertResourceName,
  planEnvironmentDelete,
  planEnvironmentSet,
  planRouteUpdate,
  planSecretReassign,
  summarizeApplications,
  tenantIdentity,
  toSummary,
  type WorkloadDocument,
  withRouteUrls,
  withServiceClasses,
  workloadInTenantScope,
} from './catalog';
import {
  type BindInput,
  type ConsoleCluster,
  createKubectlConsoleCluster,
  type SignalView,
} from './cluster';
import { ConsoleError, platformSentence, sanitizePublicText } from './errors';
import {
  type ConsoleServices,
  createCliConsoleServices,
  type ServiceCreateInput,
  type ServiceView,
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
const WRITES_FORBIDDEN = 'This credential cannot change the application.';

export type ConsoleServer = {
  port: number;
  url: string;
  close: () => Promise<void>;
};

export type ConsoleServerOptions = {
  host: string;
  port: number;
  /** Deployment target whose kubeconfig is the tenant credential. */
  target: string;
  deps: WasmcloudDeps;
  assetsDirectory: string;
  io?: CliIo;
  cluster?: ConsoleCluster;
  services?: ConsoleServices;
  now?: () => number;
};

export function startConsoleServer(options: ConsoleServerOptions): Promise<ConsoleServer> {
  const log = (line: string) => options.io?.stderr.write(`${line}\n`);
  const cluster = options.cluster ?? createKubectlConsoleCluster(options.deps, log);
  const services =
    options.services ?? createCliConsoleServices(options.deps, options.io ?? silentIo());
  const sessions = createSessionStore();
  const now = options.now ?? Date.now;
  const connections = new Map<string, Promise<ClusterConnection>>();
  const writers = new Map<string, Promise<boolean>>();
  const server = createServer((request, response) => {
    void handle(request, response, {
      ...options,
      cluster,
      services,
      sessions,
      now,
      connections,
      writers,
      log,
    }).catch((error) => {
      log(sanitizePublicText(error instanceof Error ? error.message : 'console request failed'));
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
  writers: Map<string, Promise<boolean>>;
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
    if (mapped.status >= 500) {
      options.log(sanitizePublicText(error instanceof Error ? error.message : 'request failed'));
    }
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
  if (method === 'GET' && url.pathname === '/api/session') {
    await openSession(request, response, options);
    return;
  }

  const session = options.sessions.read(
    readCookie(request.headers.cookie, SESSION_COOKIE),
    options.now(),
  );
  if (session === undefined) {
    sendJson(response, 401, {
      error: 'Reload the console and try again.',
      code: 'SESSION_REQUIRED',
    });
    return;
  }
  if (method !== 'GET' && method !== 'HEAD') {
    requireOrigin(request);
    const header = request.headers[CSRF_HEADER];
    const provided = Array.isArray(header) ? header[0] : header;
    if (!tokensMatch(provided, session.csrf)) {
      throw new ConsoleError(403, 'CSRF_REJECTED', 'The form token does not match this page.');
    }
    await requireWrite(options);
  }

  if (method === 'GET' && url.pathname === '/api/applications') {
    sendJson(response, 200, await listApplications(options));
    return;
  }
  if (method === 'GET' && url.pathname === '/api/signals') {
    sendJson(response, 200, await listSignals(options));
    return;
  }
  if (method === 'GET' && url.pathname === '/api/backing-services') {
    sendJson(response, 200, {
      services: (await options.services.list(options.target)).map(publicService),
    });
    return;
  }
  if (method === 'POST' && url.pathname === '/api/backing-services') {
    const input = parseServiceCreate(await readBody(request), options.target);
    sendJson(response, 201, { service: publicService(await options.services.create(input)) });
    return;
  }
  if (method === 'GET' && url.pathname === '/api/backing-service-classes') {
    const listed = await options.services.classes(options.target);
    sendJson(response, 200, {
      classes: listed.classes.map((entry) => ({
        name: entry.name,
        type: entry.type,
        default: entry.default,
      })),
    });
    return;
  }
  const serviceName = namedPath(url.pathname, '/api/backing-services/');
  if (serviceName !== undefined && method === 'DELETE') {
    if (!isBackingServiceName(serviceName)) {
      throw new ConsoleError(
        400,
        'INVALID_NAME',
        'Service name must use lowercase letters, digits, and hyphens.',
      );
    }
    await options.services.delete(options.target, serviceName);
    sendJson(response, 200, { name: serviceName });
    return;
  }

  const application = applicationPath(url.pathname);
  if (application === undefined) {
    sendJson(response, 404, { error: 'Not found', code: 'NOT_FOUND' });
    return;
  }
  assertResourceName(application.name, 'Application name');
  await routeApplication(method, application.name, application.rest, request, response, options);
}

async function routeApplication(
  method: string,
  name: string,
  rest: readonly string[],
  request: IncomingMessage,
  response: ServerResponse,
  options: HandlerOptions,
): Promise<void> {
  if (rest.length === 0 && method === 'GET') {
    sendJson(response, 200, { application: await present(options, name) });
    return;
  }
  if (rest.length === 1 && rest[0] === 'logs' && method === 'GET') {
    const loaded = await loadApplications(options);
    requireApplication(loaded.applications, name);
    sendJson(response, 200, await logsFor(options, loaded.connection, name));
    return;
  }
  if (rest.length === 2 && rest[0] === 'routes' && method === 'PATCH') {
    const body = recordBody(await readBody(request), ['enabled']);
    if (typeof body.enabled !== 'boolean') {
      throw new ConsoleError(400, 'INVALID_BODY', 'enabled must be true or false.');
    }
    const loaded = await loadApplications(options);
    const members = membersOf(loaded, name);
    const change = planRouteUpdate(members, rest[1] ?? '', body.enabled);
    if (change.ops.length > 0)
      await options.cluster.patchWorkload(loaded.connection, change.workload, change.ops);
    sendJson(response, 200, { application: await present(options, name) });
    return;
  }
  if (rest.length === 1 && rest[0] === 'environment' && method === 'PUT') {
    const body = recordBody(await readBody(request), ['key', 'value', 'part']);
    if (typeof body.key !== 'string' || typeof body.value !== 'string') {
      throw new ConsoleError(
        400,
        'INVALID_BODY',
        'An environment variable needs a name and a value.',
      );
    }
    if (body.part !== undefined && typeof body.part !== 'string') {
      throw new ConsoleError(400, 'INVALID_BODY', 'part must be the name of a part.');
    }
    const loaded = await loadApplications(options);
    const change = planEnvironmentSet(membersOf(loaded, name), body.key, body.value, body.part);
    if (change.ops.length > 0)
      await options.cluster.patchWorkload(loaded.connection, change.workload, change.ops);
    sendJson(response, 200, { application: await present(options, name) });
    return;
  }
  // DELETE environment/<key> removes the first match; environment/<part>/<key> names the part.
  if (
    (rest.length === 2 || rest.length === 3) &&
    rest[0] === 'environment' &&
    method === 'DELETE'
  ) {
    const loaded = await loadApplications(options);
    const [part, key] = rest.length === 3 ? [rest[1], rest[2]] : [undefined, rest[1]];
    const change = planEnvironmentDelete(membersOf(loaded, name), key ?? '', part);
    await options.cluster.patchWorkload(loaded.connection, change.workload, change.ops);
    sendJson(response, 200, { application: await present(options, name) });
    return;
  }
  if (rest.length === 2 && rest[0] === 'secrets' && method === 'POST') {
    const secretName = rest[1] ?? '';
    const body = recordBody(await readBody(request), ['value']);
    if (typeof body.value !== 'string') {
      throw new ConsoleError(400, 'INVALID_SECRET', 'Provide a new credential value.');
    }
    const loaded = await loadApplications(options);
    const planned = planSecretReassign(membersOf(loaded, name), secretName, body.value);
    if ('secret' in planned)
      await options.cluster.reassignSecret(loaded.connection, planned.secret, body.value);
    else if (planned.ops.length > 0) {
      await options.cluster.patchWorkload(loaded.connection, planned.workload, planned.ops);
    }
    sendJson(response, 200, { name: secretName });
    return;
  }
  if (rest.length === 1 && rest[0] === 'bindings' && method === 'POST') {
    const input = parseBind(await readBody(request), name);
    const loaded = await loadApplications(options);
    requireApplication(loaded.applications, name);
    if (input.capability === 'egress') input.workload = egressWorkload(membersOf(loaded, name));
    await options.cluster.bindService(loaded.connection, input);
    sendJson(response, 200, { application: await present(options, name) });
    return;
  }
  if (rest.length === 2 && rest[0] === 'bindings' && method === 'DELETE') {
    const loaded = await loadApplications(options);
    const application = requireApplication(loaded.applications, name);
    const binding = application.backingServices.find((entry) => entry.name === rest[1]);
    if (binding === undefined) {
      throw new ConsoleError(
        404,
        'BINDING_NOT_FOUND',
        'That backing service is not bound to this application.',
      );
    }
    await options.cluster.unbindService(loaded.connection, name, binding.name);
    sendJson(response, 200, { application: await present(options, name) });
    return;
  }
  sendJson(response, 404, { error: 'Not found', code: 'NOT_FOUND' });
}

async function openSession(
  request: IncomingMessage,
  response: ServerResponse,
  options: HandlerOptions,
): Promise<void> {
  const now = options.now();
  let current = options.sessions.read(readCookie(request.headers.cookie, SESSION_COOKIE), now);
  if (current === undefined) {
    const created = options.sessions.create(now);
    current = created.session;
    response.setHeader('set-cookie', sessionCookie(created.id, Math.floor(SESSION_TTL_MS / 1000)));
  }
  const connection = await connectionFor(options, options.target);
  const identity = tenantIdentity(connection.hostgroup, options.target);
  const writable = await writerFor(options, connection);
  sendJson(response, 200, {
    csrfToken: current.csrf,
    writable,
    tenant: identity.tenant,
    ...(identity.hostgroup ? { hostgroup: identity.hostgroup } : {}),
  });
}

async function listApplications(options: HandlerOptions): Promise<{
  applications: ReturnType<typeof toSummary>[];
  error?: string;
}> {
  try {
    const loaded = await loadApplications(options);
    return { applications: loaded.applications.map(toSummary) };
  } catch (error) {
    options.log(
      sanitizePublicText(error instanceof Error ? error.message : 'application query failed'),
    );
    const message =
      error instanceof ConsoleError ? error.message : 'The applications could not be read.';
    return { applications: [], error: message };
  }
}

/** Signals for every application in scope; an application whose projection fails is left out. */
async function listSignals(
  options: HandlerOptions,
): Promise<{ signals: Array<SignalView & { application: string }> }> {
  const loaded = await loadApplications(options);
  const read = await Promise.all(
    loaded.applications.map(async (application) => {
      try {
        const signals = await options.cluster.readSignals(loaded.connection, application.name);
        return signals ? { application: application.name, ...signals } : undefined;
      } catch (error) {
        options.log(
          sanitizePublicText(error instanceof Error ? error.message : 'signal query failed'),
        );
        return undefined;
      }
    }),
  );
  return { signals: read.filter((entry) => entry !== undefined) };
}

async function present(options: HandlerOptions, name: string) {
  const loaded = await loadApplications(options);
  const application = requireApplication(loaded.applications, name);
  const logs = await logsFor(options, loaded.connection, name);
  const signals = await options.cluster.readSignals(loaded.connection, name);
  const routes =
    application.routes.length === 0
      ? application.routes
      : withRouteUrls(
          application.routes,
          await options.cluster.readRouteTemplate(loaded.connection),
        );
  const backingServices =
    application.backingServices.length === 0
      ? application.backingServices
      : withServiceClasses(application.backingServices, await serviceClasses(options));
  return withProjections({ ...application, routes, backingServices }, logs, signals);
}

/** Class of each backing service by name; empty when the services cannot be read. */
async function serviceClasses(options: HandlerOptions): Promise<Map<string, string>> {
  try {
    const listed = await options.services.list(options.target);
    return new Map(listed.map((service) => [service.name, service.className]));
  } catch (error) {
    options.log(
      sanitizePublicText(error instanceof Error ? error.message : 'service query failed'),
    );
    return new Map();
  }
}

function withProjections(
  application: ApplicationView,
  logs: { unpublished: true } | { lines: string[] },
  signals: SignalView | undefined,
) {
  return { ...application, logs, ...(signals ? { signals } : {}) };
}

async function logsFor(
  options: HandlerOptions,
  connection: ClusterConnection,
  name: string,
): Promise<{ unpublished: true } | { lines: string[] }> {
  const lines = await options.cluster.readLogs(connection, name);
  return lines === undefined
    ? { unpublished: true }
    : { lines: lines.map((line) => sanitizePublicText(line, 500)) };
}

async function loadApplications(options: HandlerOptions) {
  const connection = await connectionFor(options, options.target);
  const [documents, bindings, failures] = await Promise.all([
    options.cluster.listWorkloads(connection),
    options.cluster.listBindings(connection),
    // Status without host failures is still useful; a projection read error is only logged.
    options.cluster.readFailures(connection).catch((error: unknown) => {
      options.log(
        sanitizePublicText(error instanceof Error ? error.message : 'failure query failed'),
      );
      return new Map();
    }),
  ]);
  const scoped = documents.filter((document) => workloadInTenantScope(document, connection));
  return {
    connection,
    documents: scoped,
    applications: summarizeApplications(scoped, bindings, failures),
  };
}

function membersOf(
  loaded: { documents: WorkloadDocument[]; applications: ApplicationView[] },
  name: string,
): WorkloadDocument[] {
  requireApplication(loaded.applications, name);
  return loaded.documents.filter((document) => {
    const workload = document.metadata?.labels?.['di-framework.dev/workload'];
    return document.metadata?.name === name || workload === name;
  });
}

function requireApplication(
  applications: readonly ApplicationView[],
  name: string,
): ApplicationView {
  const application = applications.find((entry) => entry.name === name);
  if (application === undefined) {
    throw new ConsoleError(404, 'APP_NOT_FOUND', `No application named ${name}.`);
  }
  return application;
}

async function requireWrite(options: HandlerOptions): Promise<void> {
  const connection = await connectionFor(options, options.target);
  if (!(await writerFor(options, connection))) {
    throw new ConsoleError(403, 'WRITES_FORBIDDEN', WRITES_FORBIDDEN);
  }
}

function writerFor(options: HandlerOptions, connection: ClusterConnection): Promise<boolean> {
  const cached = options.writers.get(options.target);
  if (cached !== undefined) return cached;
  const pending = options.cluster.canWrite(connection).catch((error) => {
    options.log(sanitizePublicText(error instanceof Error ? error.message : 'write check failed'));
    options.writers.delete(options.target);
    return false;
  });
  options.writers.set(options.target, pending);
  return pending;
}

function connectionFor(options: HandlerOptions, targetName: string): Promise<ClusterConnection> {
  const cached = options.connections.get(targetName);
  if (cached !== undefined) return cached;
  const manifest = loadDeployManifest(options.deps.cwd(), options.deps.env);
  const selected = manifest.targets[targetName];
  if (
    targetName !== options.target ||
    selected?.kind !== 'external' ||
    selected.hostgroup === undefined
  ) {
    throw new ConsoleError(404, 'TENANT_SCOPE', 'This console is scoped to one tenant.');
  }
  const target = resolveTarget(manifest, targetName);
  const pending = resolveConnection(target, manifest.workspaceRoot, manifest.path, options.deps);
  options.connections.set(target.name, pending);
  pending.catch(() => options.connections.delete(target.name));
  return pending;
}

function parseServiceCreate(body: unknown, target: string): ServiceCreateInput {
  const record = recordBody(body, ['type', 'name', 'className', 'memory', 'storage', 'cpu']);
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
      'Service name must use lowercase letters, digits, and hyphens.',
    );
  }
  if (record.type === 'egress') {
    throw new ConsoleError(
      400,
      'INVALID_SERVICE',
      'Egress services need destinations; create them with di-framework platform service create egress.',
    );
  }
  const input: ServiceCreateInput = { target, type: record.type, name: record.name };
  for (const key of ['className', 'memory', 'storage', 'cpu'] as const) {
    const value = record[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length === 0 || value.length > 40) {
      throw new ConsoleError(400, 'INVALID_SERVICE', `${key} must be a short string.`);
    }
    if (key === 'className' && !isBackingServiceName(value)) {
      throw new ConsoleError(
        400,
        'INVALID_NAME',
        'Class name must use lowercase letters, digits, and hyphens.',
      );
    }
    input[key] = value;
  }
  return input;
}

/** Egress is granted to one WorkloadDeployment, so only a single-part application can bind it here. */
export function egressWorkload(members: readonly WorkloadDocument[]): string {
  const only = members.length === 1 ? members[0]?.metadata?.name : undefined;
  if (only === undefined) {
    throw new ConsoleError(
      409,
      'EGRESS_PER_PART',
      'Egress is granted per part; set allowedIpNameLookups in that part and deploy it.',
    );
  }
  return only;
}

function parseBind(body: unknown, workload: string): BindInput {
  const record = recordBody(body, ['binding', 'service', 'capability']);
  if (typeof record.binding !== 'string' || !isBackingServiceName(record.binding, 54)) {
    throw new ConsoleError(
      400,
      'INVALID_NAME',
      'Binding name must use lowercase letters, digits, and hyphens.',
    );
  }
  if (typeof record.service !== 'string' || !isBackingServiceName(record.service)) {
    throw new ConsoleError(
      400,
      'INVALID_NAME',
      'Service name must use lowercase letters, digits, and hyphens.',
    );
  }
  if (typeof record.capability !== 'string' || !isServiceType(record.capability)) {
    throw new ConsoleError(
      400,
      'INVALID_SERVICE',
      `Service type must be one of ${SERVICE_TYPES.join(', ')}.`,
    );
  }
  return {
    workload,
    binding: record.binding,
    service: record.service,
    capability: record.capability,
  };
}

function recordBody(body: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ConsoleError(400, 'INVALID_BODY', 'Request body must be an object.');
  }
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.includes(key))) {
    throw new ConsoleError(400, 'INVALID_BODY', 'The request contains unsupported fields.');
  }
  return record;
}

function applicationPath(pathname: string): { name: string; rest: string[] } | undefined {
  if (!pathname.startsWith('/api/applications/')) return undefined;
  const tail = pathname.slice('/api/applications/'.length);
  if (tail.length === 0) return undefined;
  const [rawName, ...rest] = tail.split('/');
  if (rawName === undefined || rawName.length === 0 || rest.some((part) => part.length === 0))
    return undefined;
  try {
    return {
      name: decodeURIComponent(rawName),
      rest: rest.map((part) => decodeURIComponent(part)),
    };
  } catch {
    return undefined;
  }
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

function publicService(service: ServiceView): {
  name: string;
  className: string;
  type: string;
  ready: boolean;
  detail?: string;
} {
  const ready = service.ready === 'True';
  const detail = ready ? undefined : platformSentence(service.message);
  return {
    name: service.name,
    className: service.className,
    type: service.type,
    ready,
    ...(detail ? { detail } : {}),
  };
}

function publicError(error: unknown): { status: number; body: { error: string; code: string } } {
  if (error instanceof ConsoleError) {
    return { status: error.status, body: { error: error.message, code: error.code } };
  }
  if (isCommandFailure(error)) {
    const status =
      error.code === 'WASMCLOUD_SERVICE_NOT_FOUND' || error.code === 'WASMCLOUD_TARGET_NOT_FOUND'
        ? 404
        : error.code === 'WASMCLOUD_SERVICE_ALREADY_EXISTS' ||
            error.code === 'WASMCLOUD_SERVICE_IN_USE'
          ? 409
          : error.code === 'WASMCLOUD_SERVICE_UNAUTHORIZED'
            ? 403
            : error.exitCode === 2
              ? 400
              : 502;
    return {
      status,
      body: { error: failureSentence(error.code, error.message, status), code: error.code },
    };
  }
  return {
    status: 502,
    body: { error: 'The application could not be read.', code: 'REQUEST_FAILED' },
  };
}

function failureSentence(code: string, message: string, status: number): string {
  if (code === 'WASMCLOUD_SERVICE_UNAUTHORIZED')
    return 'This credential cannot change backing services.';
  if (code === 'WASMCLOUD_SERVICE_NOT_FOUND') return 'No backing service with that name.';
  if (code === 'WASMCLOUD_TARGET_NOT_FOUND') return 'This tenant could not be opened.';
  if (code === 'WASMCLOUD_SERVICE_IN_USE')
    return 'That backing service is still bound to an application.';
  if (code === 'WASMCLOUD_SERVICE_ALREADY_EXISTS')
    return 'A backing service with that name already exists.';
  const sentence = platformSentence(message);
  if (sentence !== undefined) return sentence;
  return status === 400 ? 'The request was not accepted.' : 'The request could not be completed.';
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(body));
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
