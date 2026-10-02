import { STORAGE_HOSTGROUP } from '../workload';
import { ConsoleError, platformSentence } from './errors';

const RESOURCE_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HOST_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/i;
const SENSITIVE_KEY = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|API_KEY|_KEY$)/i;
const USERINFO = /:\/\/[^/\s:]+:[^/\s@]+@/;
const HIDDEN_CONFIG =
  /^(DI_CONTROL_|DI_QUEUE_|DI_CRON_|DI_SQLITE_|DI_STORAGE_)|^(ACTOR_STORAGE_DIR|QUEUE_DB_PATH|MIGRATION_DB_PATH)$/;
const PLATFORM_CONTRACTS = new Set([
  'wasi:http',
  'wasi:cli',
  'wasi:config',
  'wasi:logging',
  'wasi:random',
  'wasi:sockets',
  'wasi:filesystem',
  'wasi:clocks',
  'wasi:tls',
  'wasmcloud:postgres',
  'wasmcloud:keyvalue',
  'wasmcloud:messaging',
  'wasmcloud:blobstore',
]);
const ROUTES_OFF = 'di-framework.dev/routes-off';
/** The wasi:http host interface that was removed when its last route was turned off. */
const HTTP_OFF = 'di-framework.dev/http-off';
const WORKLOAD_INTERFACES = '/spec/template/spec/hostInterfaces';
const INTERFACE_ARRAY =
  /^\/spec\/template\/spec\/(hostInterfaces|components\/\d+\/hostInterfaces|service\/hostInterfaces)$/;
const DEFAULT_HTTP_INTERFACE: HostInterface = {
  namespace: 'wasi',
  package: 'http',
  version: '0.3.0',
  interfaces: ['handler'],
};
const NOT_READY = 'This application is not ready yet.';

export type JsonPatchOp = {
  op: 'add' | 'replace' | 'remove';
  path: string;
  value?: unknown;
};

export type PartView = {
  name: string;
  kind: 'service' | 'component';
  lifetime: 'long-lived' | 'on-demand';
};

export type RouteView = {
  id: string;
  host: string;
  path: string;
  enabled: boolean;
};

export type EnvView = { key: string; value: string };
export type SecretView = { name: string };

export type BackingBindingView = {
  name: string;
  service: string;
  className: string;
  ready: boolean;
  detail?: string;
};

export type PrivateBindingView = {
  name: string;
  contract: string;
  bound: boolean;
};

export type ApplicationSummary = {
  name: string;
  ready: boolean;
  detail?: string;
  services: number;
  components: number;
  routeCount: number;
};

export type ApplicationView = ApplicationSummary & {
  parts: PartView[];
  routes: RouteView[];
  environment: EnvView[];
  secrets: SecretView[];
  backingServices: BackingBindingView[];
  privateBindings: PrivateBindingView[];
};

export type HostInterface = {
  name?: string;
  namespace?: string;
  package?: string;
  version?: string;
  interfaces?: string[];
  config?: Record<string, string>;
  configFrom?: Array<{ name?: string }>;
  secretFrom?: Array<{ name?: string }>;
};

export type WorkloadPart = {
  name?: string;
  image?: string;
  service?: unknown;
  localResources?: {
    environment?: { config?: Record<string, string>; secretFrom?: Array<{ name?: string }> };
    allowedIpNameLookups?: string[];
  };
  hostInterfaces?: HostInterface[];
};

export type WorkloadDocument = {
  metadata?: {
    name?: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec?: {
    replicas?: number;
    template?: {
      spec?: {
        hostSelector?: { hostgroup?: string };
        hostInterfaces?: HostInterface[];
        components?: WorkloadPart[];
        service?: WorkloadPart;
      };
    };
  };
  status?: {
    readyReplicas?: number;
    replicas?: { ready?: number };
    conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }>;
  };
};

export type BindingDocument = {
  metadata?: { name?: string; labels?: Record<string, string> };
  spec?: {
    serviceName?: string;
    bindingName?: string;
    capability?: string;
    workloadName?: string;
  };
  status?: { conditions?: Array<{ type?: string; status?: string; message?: string }> };
};

export type WorkloadChange = { workload: string; ops: JsonPatchOp[] };

type SecretSource = { name: string; kind: 'config' | 'secret'; workload: string; pointer?: string };

export function assertResourceName(name: string, label: string): void {
  if (!isResourceName(name)) {
    throw new ConsoleError(
      400,
      'INVALID_NAME',
      `${label} must use lowercase letters, digits, and hyphens.`,
    );
  }
}

export function isResourceName(name: string): boolean {
  return name.length >= 1 && name.length <= 63 && RESOURCE_NAME.test(name);
}

/** A tenant credential is one scope. Persistent workloads use the storage host group. */
export function workloadInTenantScope(
  document: WorkloadDocument,
  scope: { namespace: string; hostgroup?: string; storageHostgroup?: string },
): boolean {
  const namespace = document.metadata?.namespace;
  if (namespace !== undefined && namespace !== scope.namespace) return false;
  const hostgroup = document.spec?.template?.spec?.hostSelector?.hostgroup;
  if (scope.hostgroup === undefined || hostgroup === undefined) return true;
  const storageHostgroup = scope.storageHostgroup ?? STORAGE_HOSTGROUP;
  return hostgroup === scope.hostgroup || hostgroup === storageHostgroup;
}

export function tenantIdentity(
  hostgroup: string | undefined,
  target: string,
): {
  tenant: string;
  hostgroup?: string;
} {
  if (hostgroup?.startsWith('tenant-') && hostgroup.length > 'tenant-'.length) {
    return { tenant: hostgroup.slice('tenant-'.length), hostgroup };
  }
  if (hostgroup !== undefined && hostgroup.length > 0) return { tenant: hostgroup, hostgroup };
  return { tenant: target };
}

export function summarizeApplications(
  documents: readonly WorkloadDocument[],
  bindings: readonly BindingDocument[] = [],
): ApplicationView[] {
  const groups = new Map<string, WorkloadDocument[]>();
  const labeled = new Map<string, WorkloadDocument[]>();
  for (const document of documents) {
    if (!isManaged(document)) continue;
    const label = document.metadata?.labels?.['di-framework.dev/workload'];
    if (typeof label === 'string' && isResourceName(label)) {
      const list = labeled.get(label) ?? [];
      list.push(document);
      labeled.set(label, list);
      continue;
    }
    const name = document.metadata?.name;
    if (name === undefined || !isResourceName(name)) continue;
    const list = groups.get(name) ?? [];
    list.push(document);
    groups.set(name, list);
  }
  for (const [label, members] of labeled) {
    if (members.length > 1) {
      groups.set(label, members);
      continue;
    }
    const only = members[0];
    const name = only?.metadata?.name;
    if (only !== undefined && name !== undefined && isResourceName(name)) {
      const list = groups.get(name) ?? [];
      list.push(only);
      groups.set(name, list);
    }
  }

  const applications: ApplicationView[] = [];
  for (const [name, members] of groups) {
    members.sort((left, right) =>
      (left.metadata?.name ?? '').localeCompare(right.metadata?.name ?? ''),
    );
    const parts = dedupePartNames(members.flatMap((member) => partsFrom(member)));
    const routes = routesFrom(members);
    const environment = environmentFrom(members);
    const secrets = secretsFrom(members).map((secret) => ({ name: secret.name }));
    const memberNames = members
      .map((member) => member.metadata?.name)
      .filter((entry): entry is string => typeof entry === 'string');
    const status = applicationStatus(members);
    applications.push({
      name,
      ready: status.ready,
      ...(status.detail ? { detail: status.detail } : {}),
      services: parts.filter((part) => part.kind === 'service').length,
      components: parts.filter((part) => part.kind === 'component').length,
      routeCount: routes.length,
      parts,
      routes,
      environment,
      secrets,
      backingServices: backingBindings(name, memberNames, bindings),
      privateBindings: privateBindings(members),
    });
  }
  return applications.sort((left, right) => left.name.localeCompare(right.name));
}

export function toSummary(application: ApplicationView): ApplicationSummary {
  return {
    name: application.name,
    ready: application.ready,
    ...(application.detail ? { detail: application.detail } : {}),
    services: application.services,
    components: application.components,
    routeCount: application.routeCount,
  };
}

/**
 * wash rejects a wasi:http interface without `host` and keeps serving the old revision, so a route is
 * never turned off by leaving that config empty. Turning off the primary host promotes the next alias.
 * Turning off the last route removes the interface and remembers it in an annotation; turning a route
 * on again restores it.
 */
export function planRouteUpdate(
  documents: readonly WorkloadDocument[],
  routeId: string,
  enabled: boolean,
): WorkloadChange {
  const located = locateRoute(documents, routeId);
  if (located === undefined) {
    throw new ConsoleError(404, 'ROUTE_NOT_FOUND', 'No route with that address.');
  }
  if (located.enabled === enabled) return { workload: located.workload, ops: [] };
  const ops: JsonPatchOp[] = [];
  const annotations: Record<string, string | undefined> = {
    [ROUTES_OFF]: rememberedValue(located.document, located.host, located.path, enabled),
  };
  if (enabled) {
    const restored = located.slot === undefined ? removedInterface(located.document) : undefined;
    if (located.slot !== undefined) {
      ops.push(configOp(located.slot, addRoute(located.slot.config, located.host, located.path)));
    } else {
      const array = restored?.array ?? WORKLOAD_INTERFACES;
      const entry = restored?.entry ?? DEFAULT_HTTP_INTERFACE;
      const value = {
        ...entry,
        config: addRoute({ ...(entry.config ?? {}) }, located.host, located.path),
      };
      ops.push(
        interfaceArray(located.document, array) === undefined
          ? { op: 'add', path: array, value: [value] }
          : { op: 'add', path: `${array}/-`, value },
      );
      annotations[HTTP_OFF] = undefined;
    }
  } else {
    const slot = located.slot as HttpSlot;
    const next = promoteAlias(stripRoute(slot.config, located.host, located.path));
    if (next.host !== undefined) {
      ops.push(configOp(slot, next));
    } else if (hasRouteKeys(next)) {
      throw new ConsoleError(
        409,
        'ROUTE_REQUIRED',
        'Turn off the other paths on this host first. wasmCloud needs a host for them.',
      );
    } else {
      ops.push({ op: 'remove', path: slot.pointer });
      const entry: HostInterface = { ...slot.entry };
      delete entry.config;
      if (Object.keys(next).length > 0) entry.config = next;
      const removed: RemovedInterface = { array: slot.array, entry };
      annotations[HTTP_OFF] = JSON.stringify(removed);
    }
  }
  ops.push(...annotationOps(located.document, annotations));
  return { workload: located.workload, ops };
}

export function planEnvironmentSet(
  documents: readonly WorkloadDocument[],
  key: string,
  value: string,
): WorkloadChange {
  assertEnvKey(key);
  if (value.length === 0 || value.length > 4096) {
    throw new ConsoleError(
      400,
      'INVALID_ENVIRONMENT',
      'Environment values must be 1 to 4096 characters.',
    );
  }
  if (isSensitiveConfigKey(key) || containsCredential(value)) {
    throw new ConsoleError(
      400,
      'INVALID_ENVIRONMENT',
      'Add that credential under Secrets. Environment values cannot contain passwords.',
    );
  }
  const existing = findConfigKey(documents, key);
  const target = existing ?? firstConfigurable(documents);
  if (target === undefined) {
    throw new ConsoleError(400, 'NOT_CONFIGURABLE', 'This application has no configurable part.');
  }
  return { workload: target.workload, ops: configValueOps(target, key, value) };
}

export function planEnvironmentDelete(
  documents: readonly WorkloadDocument[],
  key: string,
): WorkloadChange {
  assertEnvKey(key);
  const existing = findConfigKey(documents, key);
  if (existing === undefined || existing.config[key] === undefined) {
    throw new ConsoleError(404, 'ENV_NOT_FOUND', `No environment variable named ${key}.`);
  }
  return {
    workload: existing.workload,
    ops: [{ op: 'remove', path: `${existing.pointer}/${key}` }],
  };
}

export function planSecretReassign(
  documents: readonly WorkloadDocument[],
  name: string,
  value: string,
): WorkloadChange | { secret: string } {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    throw new ConsoleError(400, 'INVALID_SECRET', 'Provide a new credential value.');
  }
  const sources = secretsFrom(documents);
  const match = sources.find((secret) => secret.name === name);
  if (match === undefined) {
    throw new ConsoleError(404, 'SECRET_NOT_FOUND', `No credential named ${name}.`);
  }
  if (match.kind === 'secret') return { secret: name };
  const located = findConfigKey(documents, name);
  if (located === undefined) {
    throw new ConsoleError(404, 'SECRET_NOT_FOUND', `No credential named ${name}.`);
  }
  return { workload: located.workload, ops: configValueOps(located, name, value) };
}

function isManaged(document: WorkloadDocument): boolean {
  return document.metadata?.labels?.['app.kubernetes.io/managed-by'] === 'di-framework';
}

function partsFrom(document: WorkloadDocument): PartView[] {
  const spec = document.spec?.template?.spec;
  const parts: PartView[] = [];
  if (spec?.service !== undefined && typeof spec.service === 'object') {
    parts.push(part(spec.service.name || document.metadata?.name || 'service', 'service'));
  }
  for (const component of spec?.components ?? []) {
    const longLived =
      component.service !== undefined ||
      (spec?.service === undefined && isLongLivedWorker(component, spec?.hostInterfaces));
    const kind =
      longLived && !parts.some((entry) => entry.kind === 'service') ? 'service' : 'component';
    parts.push(part(component.name || 'component', kind));
  }
  return parts;
}

function part(name: string, kind: PartView['kind']): PartView {
  return { name, kind, lifetime: kind === 'service' ? 'long-lived' : 'on-demand' };
}

function isLongLivedWorker(
  component: WorkloadPart,
  workloadInterfaces: HostInterface[] | undefined,
): boolean {
  const http = hasInterface(component, workloadInterfaces, 'wasi', 'http', [
    'handler',
    'incoming-handler',
  ]);
  const run = hasInterface(component, workloadInterfaces, 'wasi', 'cli', ['run']);
  const messaging = hasInterface(component, workloadInterfaces, 'wasmcloud', 'messaging', [
    'handler',
  ]);
  if (run) return true;
  if (messaging && !http) return true;
  const queue = component.localResources?.environment?.config?.DI_QUEUE_MODE;
  return typeof queue === 'string' && queue.length > 0 && !http;
}

function hasInterface(
  component: WorkloadPart,
  workloadInterfaces: HostInterface[] | undefined,
  namespace: string,
  pkg: string,
  names: readonly string[],
): boolean {
  return [...(component.hostInterfaces ?? []), ...(workloadInterfaces ?? [])].some(
    (entry) =>
      entry.namespace === namespace &&
      entry.package === pkg &&
      (entry.interfaces ?? []).some((name) => names.includes(name)),
  );
}

function dedupePartNames(parts: PartView[]): PartView[] {
  const seen = new Map<string, number>();
  return parts.map((entry) => {
    const count = seen.get(entry.name) ?? 0;
    seen.set(entry.name, count + 1);
    if (count === 0) return entry;
    return { ...entry, name: `${entry.name}-${count + 1}` };
  });
}

function applicationStatus(members: readonly WorkloadDocument[]): {
  ready: boolean;
  detail?: string;
} {
  for (const member of members) {
    const status = memberStatus(member);
    if (!status.ready) return status;
  }
  return { ready: true };
}

function memberStatus(document: WorkloadDocument): { ready: boolean; detail?: string } {
  const desired = document.spec?.replicas ?? 1;
  const readyCount = document.status?.readyReplicas ?? document.status?.replicas?.ready ?? 0;
  const condition = (document.status?.conditions ?? []).find(
    (entry) => entry.type === 'Ready' || entry.type === 'Available',
  );
  const ready = condition?.status === 'True' || (desired > 0 && readyCount >= desired);
  if (ready) return { ready: true };
  return { ready: false, detail: platformSentence(condition?.message) ?? NOT_READY };
}

type RouteHit = {
  id: string;
  host: string;
  path: string;
  enabled: boolean;
  workload: string;
  document: WorkloadDocument;
  slot?: HttpSlot;
};

type RemovedInterface = { array: string; entry: HostInterface };

function routesFrom(members: readonly WorkloadDocument[]): RouteView[] {
  const routes = new Map<string, RouteView>();
  for (const member of members) {
    for (const slot of httpSlots(member)) {
      for (const route of routesInConfig(slot.config)) {
        routes.set(route.id, { ...route, enabled: true });
      }
    }
    for (const route of rememberedRoutes(member)) {
      if (!routes.has(route.id)) routes.set(route.id, { ...route, enabled: false });
    }
  }
  return [...routes.values()].sort((left, right) =>
    `${left.host}${left.path}`.localeCompare(`${right.host}${right.path}`),
  );
}

function locateRoute(
  documents: readonly WorkloadDocument[],
  routeId: string,
): RouteHit | undefined {
  for (const document of documents) {
    const workload = document.metadata?.name;
    if (workload === undefined) continue;
    for (const slot of httpSlots(document)) {
      for (const route of routesInConfig(slot.config)) {
        if (route.id !== routeId) continue;
        return { ...route, enabled: true, workload, document, slot };
      }
    }
    for (const route of rememberedRoutes(document)) {
      if (route.id !== routeId) continue;
      const slot = httpSlots(document)[0];
      return { ...route, enabled: false, workload, document, ...(slot ? { slot } : {}) };
    }
  }
  return undefined;
}

type HttpSlot = {
  /** JSON pointer of the interface entry. */
  pointer: string;
  /** JSON pointer of the array that holds it. */
  array: string;
  entry: HostInterface;
  hadConfig: boolean;
  config: Record<string, string>;
};

function httpSlots(document: WorkloadDocument): HttpSlot[] {
  const spec = document.spec?.template?.spec;
  const slots: HttpSlot[] = [];
  const visit = (interfaces: HostInterface[] | undefined, array: string) => {
    interfaces?.forEach((entry, index) => {
      if (entry.namespace !== 'wasi' || entry.package !== 'http') return;
      slots.push({
        pointer: `${array}/${index}`,
        array,
        entry,
        hadConfig: entry.config !== undefined,
        config: { ...(entry.config ?? {}) },
      });
    });
  };
  visit(spec?.hostInterfaces, WORKLOAD_INTERFACES);
  spec?.components?.forEach((component, index) => {
    visit(component.hostInterfaces, `/spec/template/spec/components/${index}/hostInterfaces`);
  });
  visit(spec?.service?.hostInterfaces, '/spec/template/spec/service/hostInterfaces');
  return slots;
}

function configOp(slot: HttpSlot, config: Record<string, string>): JsonPatchOp {
  return { op: slot.hadConfig ? 'replace' : 'add', path: `${slot.pointer}/config`, value: config };
}

/** wash needs a primary `host`; the first remaining alias takes over when the host is turned off. */
function promoteAlias(config: Record<string, string>): Record<string, string> {
  if (config.host !== undefined) return config;
  const [first, ...rest] = splitComma(config['host-aliases']);
  if (first === undefined) return config;
  const next: Record<string, string> = { ...config, host: first };
  if (rest.length === 0) delete next['host-aliases'];
  else next['host-aliases'] = rest.join(',');
  return next;
}

function hasRouteKeys(config: Record<string, string>): boolean {
  return config.localRoute !== undefined;
}

/** The interface array a pointer names, or undefined when it (or its component) is absent. */
function interfaceArray(document: WorkloadDocument, array: string): HostInterface[] | undefined {
  const spec = document.spec?.template?.spec;
  if (array === WORKLOAD_INTERFACES) return spec?.hostInterfaces;
  if (array === '/spec/template/spec/service/hostInterfaces') return spec?.service?.hostInterfaces;
  const index = Number(array.split('/')[5]);
  return spec?.components?.[index]?.hostInterfaces;
}

function removedInterface(document: WorkloadDocument): RemovedInterface | undefined {
  const raw = document.metadata?.annotations?.[HTTP_OFF];
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  try {
    const parsed = JSON.parse(raw) as { array?: unknown; entry?: unknown };
    const { array, entry } = parsed;
    if (typeof array !== 'string' || !INTERFACE_ARRAY.test(array)) return undefined;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
    const candidate = entry as HostInterface;
    if (candidate.namespace !== 'wasi' || candidate.package !== 'http') return undefined;
    // A component array whose component is gone cannot take the interface back.
    if (array.includes('/components/') && !componentExists(document, array)) return undefined;
    return { array, entry: candidate };
  } catch {
    return undefined;
  }
}

function componentExists(document: WorkloadDocument, array: string): boolean {
  const index = Number(array.split('/')[5]);
  return document.spec?.template?.spec?.components?.[index] !== undefined;
}

function routesInConfig(config: Record<string, string>): Array<Omit<RouteView, 'enabled'>> {
  const routes: Array<Omit<RouteView, 'enabled'>> = [];
  const seen = new Set<string>();
  const add = (host: string, path: string) => {
    if (!isHost(host) || !isPath(path)) return;
    const id = routeId(host, path);
    if (seen.has(id)) return;
    seen.add(id);
    routes.push({ id, host, path });
  };
  if (typeof config.host === 'string') add(config.host, '/');
  for (const alias of splitComma(config['host-aliases'])) add(alias, '/');
  for (const entry of splitComma(config.localRoute)) {
    const slash = entry.indexOf('/');
    if (slash === -1) add(entry, '/');
    else add(entry.slice(0, slash), entry.slice(slash));
  }
  return routes;
}

function rememberedRoutes(document: WorkloadDocument): Array<Omit<RouteView, 'enabled'>> {
  const raw = document.metadata?.annotations?.[ROUTES_OFF];
  if (typeof raw !== 'string' || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const routes: Array<Omit<RouteView, 'enabled'>> = [];
    for (const entry of parsed) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const host = (entry as { host?: unknown }).host;
      const path = (entry as { path?: unknown }).path;
      if (typeof host !== 'string' || typeof path !== 'string' || !isHost(host) || !isPath(path))
        continue;
      routes.push({ id: routeId(host, path), host, path });
    }
    return routes;
  } catch {
    return [];
  }
}

function routeId(host: string, path: string): string {
  return Buffer.from(`${host}\n${path}`).toString('base64url');
}

function addRoute(
  config: Record<string, string>,
  host: string,
  path: string,
): Record<string, string> {
  const next = { ...config };
  if (path === '/') {
    if (next.host === undefined || next.host.length === 0) next.host = host;
    else if (next.host !== host)
      next['host-aliases'] = joinComma(splitComma(next['host-aliases']), host);
    return next;
  }
  next.localRoute = joinComma(splitComma(next.localRoute), `${host}${path}`);
  return next;
}

function stripRoute(
  config: Record<string, string>,
  host: string,
  path: string,
): Record<string, string> {
  const next = { ...config };
  if (path === '/' && next.host === host) delete next.host;
  if (path === '/') {
    const aliases = splitComma(next['host-aliases']).filter((entry) => entry !== host);
    if (aliases.length === 0) delete next['host-aliases'];
    else next['host-aliases'] = aliases.join(',');
  }
  const token = path === '/' ? host : `${host}${path}`;
  const local = splitComma(next.localRoute).filter((entry) => entry !== token);
  if (local.length === 0) delete next.localRoute;
  else next.localRoute = local.join(',');
  return next;
}

function rememberedValue(
  document: WorkloadDocument,
  host: string,
  path: string,
  enabled: boolean,
): string {
  const current = rememberedRoutes(document).map((route) => ({
    host: route.host,
    path: route.path,
  }));
  const next = enabled
    ? current.filter((route) => route.host !== host || route.path !== path)
    : current.some((route) => route.host === host && route.path === path)
      ? current
      : [...current, { host, path }];
  return JSON.stringify(next);
}

/** Sets (string) or removes (undefined) annotations. */
function annotationOps(
  document: WorkloadDocument,
  changes: Record<string, string | undefined>,
): JsonPatchOp[] {
  const annotations = document.metadata?.annotations;
  if (annotations === undefined) {
    const value: Record<string, string> = {};
    for (const [key, entry] of Object.entries(changes)) if (entry !== undefined) value[key] = entry;
    return [{ op: 'add', path: '/metadata/annotations', value }];
  }
  const ops: JsonPatchOp[] = [];
  for (const [key, value] of Object.entries(changes)) {
    const path = `/metadata/annotations/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
    const exists = annotations[key] !== undefined;
    if (value !== undefined) ops.push({ op: exists ? 'replace' : 'add', path, value });
    else if (exists) ops.push({ op: 'remove', path });
  }
  return ops;
}

function environmentFrom(members: readonly WorkloadDocument[]): EnvView[] {
  const values = new Map<string, string>();
  for (const member of members) {
    for (const config of configs(member)) {
      for (const key of Object.keys(config).sort()) {
        const value = config[key] ?? '';
        if (HIDDEN_CONFIG.test(key) || isSensitiveConfigKey(key) || containsCredential(value))
          continue;
        values.set(key, value);
      }
    }
  }
  return [...values.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => ({ key, value }));
}

function secretsFrom(members: readonly WorkloadDocument[]): SecretSource[] {
  const secrets: SecretSource[] = [];
  const seen = new Set<string>();
  const add = (secret: SecretSource) => {
    if (
      seen.has(secret.name) ||
      secret.name.endsWith('-control') ||
      secret.name.startsWith('di-binding-')
    )
      return;
    if (!isResourceName(secret.name) && !ENV_KEY.test(secret.name)) return;
    seen.add(secret.name);
    secrets.push(secret);
  };
  for (const member of members) {
    const workload = member.metadata?.name;
    if (workload === undefined) continue;
    for (const located of configLocations(member)) {
      for (const key of Object.keys(located.config)) {
        const value = located.config[key] ?? '';
        if (HIDDEN_CONFIG.test(key)) continue;
        if (!isSensitiveConfigKey(key) && !containsCredential(value)) continue;
        add({ name: key, kind: 'config', workload, pointer: located.pointer });
      }
      for (const ref of located.secretFrom) {
        if (typeof ref.name === 'string') add({ name: ref.name, kind: 'secret', workload });
      }
    }
  }
  return secrets.sort((left, right) => left.name.localeCompare(right.name));
}

function backingBindings(
  application: string,
  memberNames: readonly string[],
  bindings: readonly BindingDocument[],
): BackingBindingView[] {
  const names = new Set([application, ...memberNames]);
  const views: BackingBindingView[] = [];
  for (const binding of bindings) {
    const name = binding.spec?.bindingName;
    const service = binding.spec?.serviceName;
    const workload = binding.spec?.workloadName;
    if (typeof name !== 'string' || typeof service !== 'string' || typeof workload !== 'string')
      continue;
    if (!names.has(workload)) continue;
    const condition = (binding.status?.conditions ?? []).find((entry) => entry.type === 'Ready');
    const ready = condition?.status === 'True';
    const detail = ready ? undefined : platformSentence(condition?.message);
    views.push({
      name,
      service,
      className: binding.spec?.capability ?? '',
      ready,
      ...(detail ? { detail } : {}),
    });
  }
  return views.sort((left, right) => left.name.localeCompare(right.name));
}

function privateBindings(members: readonly WorkloadDocument[]): PrivateBindingView[] {
  const views = new Map<string, PrivateBindingView>();
  for (const member of members) {
    for (const entry of allInterfaces(member)) {
      const namespace = entry.namespace ?? '';
      const pkg = entry.package ?? '';
      const contract = `${namespace}:${pkg}`;
      if (PLATFORM_CONTRACTS.has(contract) || namespace.length === 0 || pkg.length === 0) continue;
      const name = entry.name ?? pkg;
      const key = `${name}\n${contract}`;
      views.set(key, { name, contract, bound: (entry.interfaces ?? []).length > 0 });
    }
  }
  return [...views.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function allInterfaces(document: WorkloadDocument): HostInterface[] {
  const spec = document.spec?.template?.spec;
  return [
    ...(spec?.hostInterfaces ?? []),
    ...(spec?.components ?? []).flatMap((component) => component.hostInterfaces ?? []),
    ...(spec?.service?.hostInterfaces ?? []),
  ];
}

type ConfigLocation = {
  workload: string;
  pointer: string;
  config: Record<string, string>;
  secretFrom: Array<{ name?: string }>;
  part: WorkloadPart;
};

function configLocations(document: WorkloadDocument): ConfigLocation[] {
  const workload = document.metadata?.name;
  if (workload === undefined) return [];
  const spec = document.spec?.template?.spec;
  const locations: ConfigLocation[] = [];
  spec?.components?.forEach((component, index) => {
    locations.push(location(workload, component, `/spec/template/spec/components/${index}`));
  });
  if (spec?.service !== undefined) {
    locations.push(location(workload, spec.service, '/spec/template/spec/service'));
  }
  return locations;
}

function location(workload: string, part: WorkloadPart, pointer: string): ConfigLocation {
  return {
    workload,
    pointer: `${pointer}/localResources/environment/config`,
    config: { ...(part.localResources?.environment?.config ?? {}) },
    secretFrom: part.localResources?.environment?.secretFrom ?? [],
    part,
  };
}

function configs(document: WorkloadDocument): Record<string, string>[] {
  return configLocations(document).map((entry) => entry.config);
}

function findConfigKey(
  documents: readonly WorkloadDocument[],
  key: string,
): ConfigLocation | undefined {
  for (const document of documents) {
    for (const located of configLocations(document)) {
      if (located.config[key] !== undefined) return located;
    }
  }
  return undefined;
}

function firstConfigurable(documents: readonly WorkloadDocument[]): ConfigLocation | undefined {
  for (const document of documents) {
    const located = configLocations(document)[0];
    if (located !== undefined) return located;
  }
  return undefined;
}

function configValueOps(located: ConfigLocation, key: string, value: string): JsonPatchOp[] {
  const resources = located.part.localResources;
  const base = located.pointer.replace(/\/localResources\/environment\/config$/, '');
  if (resources === undefined) {
    return [
      {
        op: 'add',
        path: `${base}/localResources`,
        value: { environment: { config: { [key]: value } } },
      },
    ];
  }
  if (resources.environment === undefined) {
    return [
      {
        op: 'add',
        path: `${base}/localResources/environment`,
        value: { config: { [key]: value } },
      },
    ];
  }
  if (resources.environment.config === undefined) {
    return [
      { op: 'add', path: `${base}/localResources/environment/config`, value: { [key]: value } },
    ];
  }
  return [
    {
      op: resources.environment.config[key] === undefined ? 'add' : 'replace',
      path: `${located.pointer}/${key}`,
      value,
    },
  ];
}

function assertEnvKey(key: string): void {
  if (!ENV_KEY.test(key) || key.length > 128) {
    throw new ConsoleError(
      400,
      'INVALID_ENVIRONMENT',
      'Environment names use letters, digits, and underscores.',
    );
  }
  if (HIDDEN_CONFIG.test(key)) {
    throw new ConsoleError(
      400,
      'INVALID_ENVIRONMENT',
      'That setting is not an environment variable.',
    );
  }
}

function isSensitiveConfigKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

function containsCredential(value: string): boolean {
  return USERINFO.test(value);
}

function isHost(value: string): boolean {
  return value.length > 0 && value.length <= 253 && HOST_NAME.test(value) && !value.includes('*');
}

function isPath(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//') && !/[\s?#]/.test(value);
}

function splitComma(value: string | undefined): string[] {
  if (value === undefined || value.length === 0) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function joinComma(values: readonly string[], extra: string): string {
  return [...values.filter((entry) => entry !== extra), extra].join(',');
}
