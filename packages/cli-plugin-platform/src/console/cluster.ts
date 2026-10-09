import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WasmcloudDeps } from '../deps';
import { EGRESS_BINDING_NAME, egressResourceName } from '../egress';
import { captureKubectl } from '../kubernetes';
import { associationName } from '../managed-bindings';
import type { ClusterConnection } from '../target';
import { MANAGED_BY_LABEL, WORKLOAD_DEPLOYMENT_RESOURCE } from '../workload';
import type { BindingDocument, HostFailure, JsonPatchOp, WorkloadDocument } from './catalog';
import { ConsoleError, sanitizePublicText } from './errors';

const BINDING_RESOURCE = 'servicebindings.platform.di-framework.dev';
/** Published by the platform controller in each tenant namespace (contract C-ROUTES). */
const ROUTES_CONFIG_MAP = 'di-platform-routes';

/**
 * Secret names the platform controller owns. Mirrors `isManagedSecretName` (`di-binding-*`,
 * `di-bs-*`) and the Secret names of the `backend-config` admission policy (`di-tenant-stock`,
 * `di-platform-routes`), both in di-framework/platform `platform/platform/src/tenancy/admission.ts`.
 */
const MANAGED_SECRET_PREFIXES = ['di-binding-', 'di-bs-'] as const;
const MANAGED_SECRET_NAMES = new Set(['di-tenant-stock', ROUTES_CONFIG_MAP]);

/** True for a Secret the platform manages; a tenant user may not replace it. */
export function isPlatformManagedSecretName(name: string): boolean {
  return (
    MANAGED_SECRET_NAMES.has(name) ||
    MANAGED_SECRET_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

/**
 * Denial messages of the platform's `tenant-secret-update` ValidatingAdmissionPolicy
 * (`SECRET_UPDATE_KEYS_MESSAGE` / `SECRET_UPDATE_MANAGED_MESSAGE`, di-framework/platform#112,
 * PR #114) and of the older `backend-config` policy, which a managed name can trip first.
 * Matched by substring: kubectl prefixes them with the policy and binding names.
 */
export const SECRET_UPDATE_KEYS_MESSAGE =
  'tenant users may update a Secret only if it keeps every existing data key';
export const MANAGED_SECRET_DENIALS = [
  'tenant users cannot update platform-managed di-binding-*/di-bs-* Secrets',
  'di-tenant-stock, di-platform-routes, di-bs-*, and di-binding-* ConfigMaps/Secrets are managed by the platform controller',
] as const;

export type SignalView = {
  success: number;
  error: number;
  compute?: number[];
};

export type BindInput = {
  workload: string;
  binding: string;
  service: string;
  capability: string;
};

export type ConsoleCluster = {
  listWorkloads(connection: ClusterConnection): Promise<WorkloadDocument[]>;
  listBindings(connection: ClusterConnection): Promise<BindingDocument[]>;
  patchWorkload(
    connection: ClusterConnection,
    name: string,
    ops: readonly JsonPatchOp[],
  ): Promise<void>;
  reassignSecret(connection: ClusterConnection, name: string, value: string): Promise<void>;
  canWrite(connection: ClusterConnection): Promise<boolean>;
  readLogs(connection: ClusterConnection, application: string): Promise<string[] | undefined>;
  readSignals(connection: ClusterConnection, application: string): Promise<SignalView | undefined>;
  /** `data.urlTemplate` of the tenant's `di-platform-routes` ConfigMap, if the platform has one. */
  readRouteTemplate(connection: ClusterConnection): Promise<string | undefined>;
  /** Host failures by WorkloadDeployment name, from every logs projection in the namespace. */
  readFailures(connection: ClusterConnection): Promise<Map<string, HostFailure>>;
  bindService(connection: ClusterConnection, input: BindInput): Promise<void>;
  unbindService(connection: ClusterConnection, workload: string, binding: string): Promise<void>;
};

export function createKubectlConsoleCluster(
  deps: WasmcloudDeps,
  log: (line: string) => void = () => undefined,
): ConsoleCluster {
  const label = `app.kubernetes.io/managed-by=${MANAGED_BY_LABEL}`;
  return {
    async listWorkloads(connection) {
      const body = await kubectlJson(
        deps,
        connection,
        ['get', WORKLOAD_DEPLOYMENT_RESOURCE, '-l', label, '-o', 'json'],
        log,
      );
      return items(body) as WorkloadDocument[];
    },
    async listBindings(connection) {
      const result = await captureKubectl(
        deps,
        connection,
        ['get', BINDING_RESOURCE, '-o', 'json'],
        deps.cwd(),
      );
      if (result.exitCode !== 0 && /forbidden|not found|resource type/i.test(result.stderr)) {
        log(sanitizePublicText(result.stderr));
        return [];
      }
      if (result.exitCode !== 0) {
        log(sanitizePublicText(result.stderr || result.stdout || 'request failed'));
        throw new ConsoleError(502, 'REQUEST_FAILED', 'Backing services could not be read.');
      }
      try {
        return items(JSON.parse(result.stdout) as unknown) as BindingDocument[];
      } catch (error) {
        if (error instanceof ConsoleError) throw error;
        log('The backing service list could not be read.');
        throw new ConsoleError(502, 'REQUEST_FAILED', 'Backing services could not be read.');
      }
    },
    async patchWorkload(connection, name, ops) {
      await kubectlOk(
        deps,
        connection,
        ['patch', WORKLOAD_DEPLOYMENT_RESOURCE, name, '--type=json', `-p=${JSON.stringify(ops)}`],
        log,
        'The application could not be updated.',
      );
    },
    // Tenant developers can update Secrets but not read or patch them (platform#112), so the
    // credential is written as a whole Secret with an unconditional PUT. A Secret is not
    // created by an update, so a missing one still answers NotFound. The console cannot see
    // the Secret's keys, so the platform's `tenant-secret-update` admission policy refuses a
    // replace that would drop any (409) or that targets a platform-managed name (403).
    async reassignSecret(connection, name, value) {
      if (isPlatformManagedSecretName(name)) {
        throw new ConsoleError(
          403,
          'SECRET_MANAGED',
          `${name} is managed by the platform and cannot be reassigned.`,
        );
      }
      const directory = mkdtempSync(join(tmpdir(), 'di-console-secret-'));
      try {
        const path = join(directory, 'secret.json');
        const document = {
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: { name, namespace: connection.namespace },
          type: 'Opaque',
          data: { credential: Buffer.from(value, 'utf8').toString('base64') },
        };
        writeFileSync(path, JSON.stringify(document), { mode: 0o600 });
        const uri = `/api/v1/namespaces/${encodeURIComponent(connection.namespace)}/secrets/${encodeURIComponent(name)}`;
        const result = await captureKubectl(
          deps,
          connection,
          ['replace', '--raw', uri, '-f', path],
          deps.cwd(),
        );
        if (result.exitCode !== 0 && /not ?found/i.test(result.stderr)) {
          log(sanitizePublicText(result.stderr));
          throw new ConsoleError(404, 'SECRET_NOT_FOUND', `No credential named ${name}.`);
        }
        if (result.exitCode !== 0 && result.stderr.includes(SECRET_UPDATE_KEYS_MESSAGE)) {
          log(sanitizePublicText(result.stderr));
          throw new ConsoleError(
            409,
            'SECRET_NOT_SINGLE_KEY',
            `${name} holds values other than a single credential, so it cannot be reassigned here.`,
          );
        }
        if (
          result.exitCode !== 0 &&
          MANAGED_SECRET_DENIALS.some((message) => result.stderr.includes(message))
        ) {
          log(sanitizePublicText(result.stderr));
          throw new ConsoleError(
            403,
            'SECRET_MANAGED',
            `${name} is managed by the platform and cannot be reassigned.`,
          );
        }
        if (result.exitCode !== 0 && /forbidden/i.test(result.stderr)) {
          log(sanitizePublicText(result.stderr));
          throw new ConsoleError(
            403,
            'WRITES_FORBIDDEN',
            'This credential cannot change the application.',
          );
        }
        if (result.exitCode !== 0) {
          log(sanitizePublicText(result.stderr || result.stdout || 'request failed'));
          throw new ConsoleError(502, 'REQUEST_FAILED', 'The credential could not be reassigned.');
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    async canWrite(connection) {
      const result = await captureKubectl(
        deps,
        connection,
        ['auth', 'can-i', 'update', WORKLOAD_DEPLOYMENT_RESOURCE],
        deps.cwd(),
      );
      if (result.exitCode !== 0) {
        log(sanitizePublicText(result.stderr || result.stdout || 'request failed'));
        return false;
      }
      return result.stdout.trim() === 'yes';
    },
    async readLogs(connection, application) {
      return readProjection(deps, connection, application, 'logs', log, (data) => {
        const raw = data.lines ?? data.log;
        if (typeof raw !== 'string') return undefined;
        const lines = raw
          .split('\n')
          .slice(0, 200)
          .map((line) => sanitizePublicText(line, 500));
        return lines;
      });
    },
    async readSignals(connection, application) {
      return readProjection(deps, connection, application, 'signals', log, (data) => {
        const success = whole(data.success);
        const error = whole(data.error);
        if (success === undefined || error === undefined) return undefined;
        const compute = series(data.compute);
        return { success, error, ...(compute ? { compute } : {}) };
      });
    },
    async readRouteTemplate(connection) {
      const result = await captureKubectl(
        deps,
        connection,
        ['get', 'configmap', ROUTES_CONFIG_MAP, '-o', 'json'],
        deps.cwd(),
      );
      if (result.exitCode !== 0) {
        // No ConfigMap means no gateway is known; the console then shows hosts as text.
        if (/not ?found|forbidden/i.test(result.stderr)) return undefined;
        log(sanitizePublicText(result.stderr || result.stdout || 'request failed'));
        return undefined;
      }
      try {
        const template = (JSON.parse(result.stdout) as { data?: { urlTemplate?: unknown } } | null)
          ?.data?.urlTemplate;
        return typeof template === 'string' && template.length > 0 ? template : undefined;
      } catch {
        log('The route address template could not be read.');
        return undefined;
      }
    },
    async readFailures(connection) {
      const result = await captureKubectl(
        deps,
        connection,
        ['get', 'configmap', '-l', 'di-framework.dev/projection=logs', '-o', 'json'],
        deps.cwd(),
      );
      const failures = new Map<string, HostFailure>();
      if (result.exitCode !== 0) {
        log(sanitizePublicText(result.stderr || result.stdout || 'request failed'));
        if (/forbidden|not found/i.test(result.stderr)) return failures;
        throw new ConsoleError(502, 'REQUEST_FAILED', 'The application could not be read.');
      }
      let list: unknown[];
      try {
        list = items(JSON.parse(result.stdout) as unknown);
      } catch {
        log('The logs projections could not be read.');
        throw new ConsoleError(502, 'REQUEST_FAILED', 'The application could not be read.');
      }
      for (const entry of list) {
        const raw = (entry as { data?: { failures?: unknown } } | null)?.data?.failures;
        for (const [name, failure] of parseFailures(raw)) {
          const current = failures.get(name);
          if (current === undefined || failure.time > current.time) failures.set(name, failure);
        }
      }
      return failures;
    },
    async bindService(connection, input) {
      const directory = mkdtempSync(join(tmpdir(), 'di-console-binding-'));
      try {
        const path = join(directory, 'binding.json');
        writeFileSync(
          path,
          JSON.stringify({
            apiVersion: 'platform.di-framework.dev/v1alpha1',
            kind: 'ServiceBinding',
            metadata: {
              name: associationName(input.workload, input.binding),
              labels: {
                'app.kubernetes.io/managed-by': MANAGED_BY_LABEL,
                'di-framework.dev/binding-workload': input.workload,
              },
            },
            spec: {
              serviceName: input.service,
              bindingName: input.binding,
              capability: input.capability,
              workloadName: input.workload,
            },
          }),
          { mode: 0o600 },
        );
        await kubectlOk(
          deps,
          connection,
          ['apply', '-f', path],
          log,
          'The backing service could not be bound.',
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    async unbindService(connection, workload, binding) {
      let result = await captureKubectl(
        deps,
        connection,
        ['delete', BINDING_RESOURCE, associationName(workload, binding)],
        deps.cwd(),
      );
      // Deploy names the egress binding after the WorkloadDeployment.
      if (
        result.exitCode !== 0 &&
        binding === EGRESS_BINDING_NAME &&
        /not ?found/i.test(result.stderr)
      )
        result = await captureKubectl(
          deps,
          connection,
          ['delete', BINDING_RESOURCE, egressResourceName(workload)],
          deps.cwd(),
        );
      if (result.exitCode !== 0 && /not ?found/i.test(result.stderr)) {
        log(sanitizePublicText(result.stderr));
        throw new ConsoleError(
          404,
          'BINDING_NOT_FOUND',
          'That backing service is not bound to this application.',
        );
      }
      if (result.exitCode !== 0) {
        log(sanitizePublicText(result.stderr || result.stdout || 'request failed'));
        throw new ConsoleError(502, 'REQUEST_FAILED', 'The backing service could not be unbound.');
      }
    },
  };
}

async function readProjection<T>(
  deps: WasmcloudDeps,
  connection: ClusterConnection,
  application: string,
  projection: 'logs' | 'signals',
  log: (line: string) => void,
  parse: (data: Record<string, string>) => T | undefined,
): Promise<T | undefined> {
  const result = await captureKubectl(
    deps,
    connection,
    [
      'get',
      'configmap',
      '-l',
      `di-framework.dev/projection=${projection},di-framework.dev/application=${application}`,
      '-o',
      'json',
    ],
    deps.cwd(),
  );
  if (result.exitCode !== 0) {
    log(sanitizePublicText(result.stderr || result.stdout || 'request failed'));
    if (/forbidden|not found/i.test(result.stderr)) return undefined;
    throw new ConsoleError(502, 'REQUEST_FAILED', 'The application could not be read.');
  }
  let body: unknown;
  try {
    body = JSON.parse(result.stdout) as unknown;
  } catch {
    log('The application projection could not be read.');
    throw new ConsoleError(502, 'REQUEST_FAILED', 'The application could not be read.');
  }
  const list = items(body);
  const first = list[0];
  if (first === undefined || first === null || typeof first !== 'object') return undefined;
  const data = (first as { data?: unknown }).data;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const strings: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string') strings[key] = value;
  }
  return parse(strings);
}

async function kubectlJson(
  deps: WasmcloudDeps,
  connection: ClusterConnection,
  args: readonly string[],
  log: (line: string) => void,
): Promise<unknown> {
  const result = await captureKubectl(deps, connection, args, deps.cwd());
  if (result.exitCode !== 0) {
    log(sanitizePublicText(result.stderr || result.stdout || 'request failed'));
    throw new ConsoleError(502, 'REQUEST_FAILED', 'The application could not be read.');
  }
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    log('The application list could not be read.');
    throw new ConsoleError(502, 'REQUEST_FAILED', 'The application could not be read.');
  }
}

async function kubectlOk(
  deps: WasmcloudDeps,
  connection: ClusterConnection,
  args: readonly string[],
  log: (line: string) => void,
  message: string,
): Promise<void> {
  const result = await captureKubectl(deps, connection, args, deps.cwd());
  if (result.exitCode !== 0) {
    log(sanitizePublicText(result.stderr || result.stdout || 'request failed'));
    if (/forbidden/i.test(result.stderr)) {
      throw new ConsoleError(
        403,
        'WRITES_FORBIDDEN',
        'This credential cannot change the application.',
      );
    }
    throw new ConsoleError(502, 'REQUEST_FAILED', message);
  }
}

function items(body: unknown): unknown[] {
  if (body === null || typeof body !== 'object' || !('items' in body)) {
    throw new ConsoleError(502, 'REQUEST_FAILED', 'The application could not be read.');
  }
  const list = (body as { items?: unknown }).items;
  if (!Array.isArray(list)) {
    throw new ConsoleError(502, 'REQUEST_FAILED', 'The application could not be read.');
  }
  return list;
}

/** `data.failures` entries; malformed JSON or entries are ignored. */
function parseFailures(raw: unknown): Array<[string, HostFailure]> {
  if (typeof raw !== 'string') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const entries: Array<[string, HostFailure]> = [];
  for (const [name, value] of Object.entries(parsed)) {
    const failure = value as Partial<HostFailure> | null;
    if (
      typeof failure?.workload === 'string' &&
      typeof failure.time === 'string' &&
      (failure.level === 'WARN' || failure.level === 'ERROR') &&
      typeof failure.message === 'string'
    ) {
      entries.push([
        name,
        {
          workload: failure.workload,
          time: failure.time,
          level: failure.level,
          message: failure.message,
        },
      ]);
    }
  }
  return entries;
}

function whole(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function series(value: string | undefined): number[] | undefined {
  if (value === undefined || value.length === 0) return undefined;
  const numbers = value.split(',').map((entry) => Number(entry.trim()));
  if (numbers.length === 0 || numbers.some((entry) => !Number.isFinite(entry))) return undefined;
  return numbers;
}
