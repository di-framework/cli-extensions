import type {
  ApplicationDetail,
  ApplicationSignals,
  ApplicationSummary,
  BackingService,
  LogsView,
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

export function messageOf(error: unknown): string {
  return error instanceof ApiError ? error.message : 'The console request failed.';
}

export type ServiceInput = {
  type: string;
  name: string;
  className?: string;
  memory?: string;
  storage?: string;
  cpu?: string;
};

/**
 * The CSRF token belongs to the session in the store. The client reads it before each change and
 * hands back any token the server returns, so nothing about the session lives in this module.
 */
export type ClientSession = {
  csrfToken: () => string;
  receiveCsrfToken: (token: string) => void;
};

export type ConsoleClient = ReturnType<typeof createClient>;

export function createClient(session: ClientSession) {
  const send = <T>(path: string, method: string, body?: unknown): Promise<T> =>
    request<T>(path, method, body, session);
  const app = (name: string) => `/api/applications/${encodeURIComponent(name)}`;
  return {
    session: () => send<SessionView>('/api/session', 'GET'),
    applications: () =>
      send<{ applications: ApplicationSummary[]; error?: string }>('/api/applications', 'GET'),
    signals: () => send<{ signals: ApplicationSignals[] }>('/api/signals', 'GET'),
    application: (name: string) => send<{ application: ApplicationDetail }>(app(name), 'GET'),
    applicationLogs: (name: string) => send<LogsView>(`${app(name)}/logs`, 'GET'),
    setRoute: (name: string, routeId: string, enabled: boolean) =>
      send<{ application: ApplicationDetail }>(
        `${app(name)}/routes/${encodeURIComponent(routeId)}`,
        'PATCH',
        { enabled },
      ),
    setEnvironment: (name: string, key: string, value: string) =>
      send<{ application: ApplicationDetail }>(`${app(name)}/environment`, 'PUT', { key, value }),
    deleteEnvironment: (name: string, key: string) =>
      send<{ application: ApplicationDetail }>(
        `${app(name)}/environment/${encodeURIComponent(key)}`,
        'DELETE',
      ),
    reassignSecret: (name: string, secret: string, value: string) =>
      send<{ name: string }>(`${app(name)}/secrets/${encodeURIComponent(secret)}`, 'POST', {
        value,
      }),
    bindBackingService: (name: string, binding: string, service: string, capability: string) =>
      send<{ application: ApplicationDetail }>(`${app(name)}/bindings`, 'POST', {
        binding,
        service,
        capability,
      }),
    unbindBackingService: (name: string, binding: string) =>
      send<{ application: ApplicationDetail }>(
        `${app(name)}/bindings/${encodeURIComponent(binding)}`,
        'DELETE',
      ),
    backingServices: () => send<{ services: BackingService[] }>('/api/backing-services', 'GET'),
    serviceClasses: () => send<{ classes: ServiceClass[] }>('/api/backing-service-classes', 'GET'),
    createBackingService: (input: ServiceInput) =>
      send<{ service: BackingService }>('/api/backing-services', 'POST', input),
    deleteBackingService: (name: string) =>
      send<{ name: string }>(`/api/backing-services/${encodeURIComponent(name)}`, 'DELETE'),
  };
}

async function request<T>(
  path: string,
  method: string,
  body: unknown,
  session: ClientSession,
): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const token = session.csrfToken();
  if (method !== 'GET' && token.length > 0) headers['x-di-console-csrf'] = token;
  const response = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const payload = (await response.json()) as { error?: string; csrfToken?: string };
  if (typeof payload.csrfToken === 'string') session.receiveCsrfToken(payload.csrfToken);
  if (!response.ok) throw new ApiError(response.status, payload.error ?? 'The request failed.');
  return payload as T;
}
