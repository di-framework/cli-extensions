import type { CliIo, JsonValue } from '@di-framework/cli-extension';
import type { WasmcloudDeps } from '../deps';
import {
  runWasmcloudServiceClasses,
  runWasmcloudServiceCreate,
  runWasmcloudServiceDelete,
  runWasmcloudServiceList,
} from '../service';
import { sanitizePublicText } from './errors';

export type ServiceClassView = {
  name: string;
  type: string;
  provider: string;
  default: boolean;
};

export type ServiceView = {
  name: string;
  namespace: string;
  type: string;
  className: string;
  ready: string;
  reason?: string;
  message?: string;
  endpoint?: { host: string; port: number; capability: string };
  deletionPolicy?: string;
  target: string;
};

export type ServiceCreateInput = {
  target: string;
  type: string;
  name: string;
  className?: string;
  memory?: string;
  storage?: string;
  cpu?: string;
  deletionPolicy?: string;
};

export type ConsoleServices = {
  list(target: string): Promise<ServiceView[]>;
  classes(target: string): Promise<{ classes: ServiceClassView[]; fromCluster: boolean }>;
  create(input: ServiceCreateInput): Promise<ServiceView>;
  delete(target: string, name: string): Promise<{ name: string; deletionPolicy?: string }>;
};

export function createCliConsoleServices(deps: WasmcloudDeps, io: CliIo): ConsoleServices {
  return {
    async list(target) {
      const result = await runWasmcloudServiceList(['--target', target], io, deps);
      return readServices(record(result.data).services).map((service) => toView(service, target));
    },
    async classes(target) {
      const result = await runWasmcloudServiceClasses(['--target', target], io, deps);
      const data = record(result.data);
      return {
        // Egress needs destinations, which the console create form does not collect.
        classes: readClasses(data.classes).filter((entry) => entry.type !== 'egress'),
        fromCluster: data.fromCluster === true,
      };
    },
    async create(input) {
      const args = ['--target', input.target, '--name', input.name];
      if (input.className !== undefined) args.push('--class', input.className);
      if (input.memory !== undefined) args.push('--memory', input.memory);
      if (input.storage !== undefined) args.push('--storage', input.storage);
      if (input.cpu !== undefined) args.push('--cpu', input.cpu);
      if (input.deletionPolicy !== undefined) args.push('--deletion-policy', input.deletionPolicy);
      const result = await runWasmcloudServiceCreate([input.type, ...args], io, deps);
      const data = record(result.data);
      return {
        name: stringField(data.name, input.name),
        namespace: stringField(data.namespace, ''),
        type: stringField(data.type, input.type),
        className: stringField(data.className, input.className ?? ''),
        ready: stringField(data.ready, 'Unknown'),
        target: input.target,
        ...(data.deletionPolicy !== undefined
          ? { deletionPolicy: stringField(data.deletionPolicy, '') }
          : {}),
        ...(isEndpoint(data.endpoint) ? { endpoint: data.endpoint } : {}),
      };
    },
    async delete(target, name) {
      const result = await runWasmcloudServiceDelete([name, '--target', target], io, deps);
      const policy = record(result.data).deletionPolicy;
      return {
        name,
        ...(typeof policy === 'string' ? { deletionPolicy: policy } : {}),
      };
    },
  };
}

function toView(service: Record<string, JsonValue | undefined>, target: string): ServiceView {
  const endpoint = isEndpoint(service.endpoint) ? service.endpoint : undefined;
  const reason = typeof service.reason === 'string' ? service.reason : undefined;
  const message = typeof service.message === 'string' ? service.message : undefined;
  const deletionPolicy =
    typeof service.deletionPolicy === 'string' ? service.deletionPolicy : undefined;
  return {
    name: stringField(service.name, ''),
    namespace: stringField(service.namespace, ''),
    type: stringField(service.type, ''),
    className: stringField(service.className, ''),
    ready: stringField(service.ready, 'Unknown'),
    target,
    ...(reason ? { reason } : {}),
    ...(message ? { message: sanitizePublicText(message, 200) } : {}),
    ...(endpoint ? { endpoint } : {}),
    ...(deletionPolicy ? { deletionPolicy } : {}),
  };
}

function record(value: JsonValue | undefined): Record<string, JsonValue | undefined> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function readServices(value: JsonValue | undefined): Array<Record<string, JsonValue | undefined>> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is Record<string, JsonValue | undefined> =>
      entry !== null &&
      typeof entry === 'object' &&
      !Array.isArray(entry) &&
      typeof entry.name === 'string',
  );
}

function readClasses(value: JsonValue | undefined): ServiceClassView[] {
  if (!Array.isArray(value)) return [];
  const classes: ServiceClassView[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    if (typeof entry.name !== 'string' || typeof entry.type !== 'string') continue;
    classes.push({
      name: entry.name,
      type: entry.type,
      provider: typeof entry.provider === 'string' ? entry.provider : '',
      default: entry.default === true,
    });
  }
  return classes;
}

function stringField(value: JsonValue | undefined, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function isEndpoint(
  value: JsonValue | undefined,
): value is { host: string; port: number; capability: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return (
    typeof value.host === 'string' &&
    typeof value.port === 'number' &&
    typeof value.capability === 'string'
  );
}
