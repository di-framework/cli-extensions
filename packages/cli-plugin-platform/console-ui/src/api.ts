import type {
  ApplicationDetail,
  ApplicationSignals,
  ApplicationSummary,
  BackingService,
  ServiceClass,
  SessionView,
} from './types';

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

let csrfToken = '';

export function session(): Promise<SessionView> {
  return send<SessionView>('/api/session', 'GET');
}

export function applications(): Promise<{ applications: ApplicationSummary[]; error?: string }> {
  return send('/api/applications', 'GET');
}

export function signals(): Promise<{ signals: ApplicationSignals[] }> {
  return send('/api/signals', 'GET');
}

export function application(name: string): Promise<{ application: ApplicationDetail }> {
  return send(`/api/applications/${encodeURIComponent(name)}`, 'GET');
}

export function applicationLogs(
  name: string,
): Promise<{ unpublished: true } | { lines: string[] }> {
  return send(`/api/applications/${encodeURIComponent(name)}/logs`, 'GET');
}

export function setRoute(
  name: string,
  routeId: string,
  enabled: boolean,
): Promise<{ application: ApplicationDetail }> {
  return send(
    `/api/applications/${encodeURIComponent(name)}/routes/${encodeURIComponent(routeId)}`,
    'PATCH',
    {
      enabled,
    },
  );
}

export function setEnvironment(
  name: string,
  key: string,
  value: string,
): Promise<{ application: ApplicationDetail }> {
  return send(`/api/applications/${encodeURIComponent(name)}/environment`, 'PUT', { key, value });
}

export function deleteEnvironment(
  name: string,
  key: string,
): Promise<{ application: ApplicationDetail }> {
  return send(
    `/api/applications/${encodeURIComponent(name)}/environment/${encodeURIComponent(key)}`,
    'DELETE',
  );
}

export function reassignSecret(
  name: string,
  secret: string,
  value: string,
): Promise<{ name: string }> {
  return send(
    `/api/applications/${encodeURIComponent(name)}/secrets/${encodeURIComponent(secret)}`,
    'POST',
    {
      value,
    },
  );
}

export function bindBackingService(
  name: string,
  binding: string,
  service: string,
  capability: string,
): Promise<{ application: ApplicationDetail }> {
  return send(`/api/applications/${encodeURIComponent(name)}/bindings`, 'POST', {
    binding,
    service,
    capability,
  });
}

export function unbindBackingService(
  name: string,
  binding: string,
): Promise<{ application: ApplicationDetail }> {
  return send(
    `/api/applications/${encodeURIComponent(name)}/bindings/${encodeURIComponent(binding)}`,
    'DELETE',
  );
}

export function backingServices(): Promise<{ services: BackingService[] }> {
  return send('/api/backing-services', 'GET');
}

export function serviceClasses(): Promise<{ classes: ServiceClass[] }> {
  return send('/api/backing-service-classes', 'GET');
}

export function createBackingService(input: {
  type: string;
  name: string;
  className?: string;
  memory?: string;
  storage?: string;
  cpu?: string;
}): Promise<{ service: BackingService }> {
  return send('/api/backing-services', 'POST', input);
}

export function deleteBackingService(name: string): Promise<{ name: string }> {
  return send(`/api/backing-services/${encodeURIComponent(name)}`, 'DELETE');
}

async function send<T>(path: string, method: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken.length > 0) headers['x-di-console-csrf'] = csrfToken;
  const response = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const payload = (await response.json()) as { error?: string; csrfToken?: string };
  if (typeof payload.csrfToken === 'string') csrfToken = payload.csrfToken;
  if (!response.ok) throw new ApiError(response.status, payload.error ?? 'The request failed.');
  return payload as T;
}
