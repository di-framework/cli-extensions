import type { AppView, ServiceClassView, ServiceView, TargetGroup, TargetView } from './types';

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

let csrfToken: string | undefined;

export function clearSession(): void {
  csrfToken = undefined;
}

async function send<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (csrfToken !== undefined && method !== 'GET') headers['x-di-console-csrf'] = csrfToken;
  const response = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const payload =
    text.length === 0 ? {} : (JSON.parse(text) as { error?: string; csrfToken?: string });
  if (typeof payload.csrfToken === 'string') csrfToken = payload.csrfToken;
  if (!response.ok) {
    if (response.status === 401) clearSession();
    throw new ApiError(payload.error ?? 'The request failed.', response.status);
  }
  return payload as T;
}

export function login(password: string): Promise<{ authenticated: boolean }> {
  return send('/api/login', 'POST', { password });
}

export function logout(): Promise<void> {
  return send('/api/logout', 'POST', {});
}

export function session(): Promise<{ authenticated: boolean }> {
  return send('/api/session');
}

export function targets(): Promise<{ targets: TargetView[] }> {
  return send('/api/targets');
}

export function apps(target?: string): Promise<{ results: TargetGroup[] }> {
  const query =
    target === undefined || target.length === 0 ? '' : `?target=${encodeURIComponent(target)}`;
  return send(`/api/apps${query}`);
}

export function saveApp(
  name: string,
  body: {
    target: string;
    replicas?: number;
    allowedIpNameLookups?: string[];
    queueSettings?: Array<{ key: string; value: number }>;
  },
): Promise<{ app: AppView }> {
  return send(`/api/apps/${encodeURIComponent(name)}`, 'PATCH', body);
}

export function setCronSuspend(
  name: string,
  target: string,
  suspend: boolean,
): Promise<{ cronJob: { name: string; suspend: boolean } }> {
  return send(`/api/cronjobs/${encodeURIComponent(name)}`, 'PATCH', { target, suspend });
}

export function services(target: string): Promise<{ services: ServiceView[] }> {
  return send(`/api/services?target=${encodeURIComponent(target)}`);
}

export function serviceClasses(
  target: string,
): Promise<{ classes: ServiceClassView[]; fromCluster: boolean }> {
  return send(`/api/service-classes?target=${encodeURIComponent(target)}`);
}

export function createService(body: {
  target: string;
  type: string;
  name: string;
  className?: string;
  memory?: string;
  storage?: string;
  cpu?: string;
  deletionPolicy?: string;
}): Promise<{ service: ServiceView }> {
  return send('/api/services', 'POST', body);
}

export function deleteService(
  target: string,
  name: string,
): Promise<{ name: string; deletionPolicy?: string }> {
  return send(
    `/api/services/${encodeURIComponent(name)}?target=${encodeURIComponent(target)}`,
    'DELETE',
  );
}
