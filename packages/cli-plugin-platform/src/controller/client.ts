import type {
  AuthInfo,
  ConfigList,
  ControllerPath,
  CreateServiceRequest,
  DeployBundle,
  Deployment,
  DeploymentList,
  DeploymentStats,
  DeploymentsQuery,
  DeployPlan,
  Env,
  LogEvent,
  LogsQuery,
  Principal,
  Problem,
  ProxyRequest,
  ProxySession,
  RegistryInfo,
  RollbackRequest,
  SecretList,
  Service,
  VarUnset,
} from './schema';
import { events } from './sse';

export type {
  AuthInfo,
  ConfigList,
  ControllerPath,
  CreateServiceRequest,
  DeployBundle,
  Deployment,
  DeploymentList,
  DeploymentStats,
  DeploymentsQuery,
  DeployPlan,
  Env,
  LogEvent,
  LogsQuery,
  Principal,
  Problem,
  ProxyRequest,
  ProxySession,
  RegistryInfo,
  RollbackRequest,
  SecretList,
  Service,
  VarUnset,
} from './schema';
export { events, type SseEvent } from './sse';

/**
 * Every path the client calls, checked against `ControllerPath` at compile time: an
 * operation that leaves the contract stops the client from building.
 */
const PATHS = {
  authInfo: '/v1/auth/info',
  whoami: '/v1/auth/whoami',
  logout: '/v1/auth/logout',
  previewDeploy: '/v1/deploy/preview',
  deploy: '/v1/deploy',
  registry: '/v1/deploy/registry',
  createService: '/v1/services',
  deleteService: '/v1/services/{service}',
  logs: '/v1/services/{service}/logs',
  proxy: '/v1/services/{service}/proxy',
  deployments: '/v1/deployments',
  deploymentStats: '/v1/deployments/stats',
  removeDeployment: '/v1/deployments/{service}',
  rollback: '/v1/deployments/rollback',
  secrets: '/v1/secrets',
  secret: '/v1/secrets/{name}',
  vars: '/v1/vars',
  var: '/v1/vars/{name}',
} as const satisfies Record<string, ControllerPath>;

/** A non-2xx answer from the controller, carrying its problem details when it sent any. */
export class ControllerError extends Error {
  constructor(
    readonly status: number,
    readonly problem: Partial<Problem>,
  ) {
    super(problem.detail ?? problem.title ?? `controller answered ${status}`);
    this.name = 'ControllerError';
  }
}

export interface ClientOptions {
  /** The controller's base URL, without a trailing slash. */
  baseUrl: string;
  /** Identity-server access token or tenant API key; absent only for `authInfo`. */
  token?: string;
  fetch?: typeof fetch;
}

type QueryValues = Record<string, string | number | boolean | undefined>;

interface Call {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  params?: Record<string, string>;
  query?: QueryValues;
  body?: unknown;
  accept?: string;
}

export function createClient(options: ClientOptions) {
  const base = options.baseUrl.replace(/\/$/, '');
  const doFetch = options.fetch ?? fetch;

  const url = (call: Call): string => {
    const path = call.path.replace(/\{(\w+)\}/g, (_, key: string) =>
      encodeURIComponent(call.params?.[key] ?? ''),
    );
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(call.query ?? {})) {
      if (value !== undefined) search.set(key, String(value));
    }
    const qs = search.toString();
    const querySuffix = qs ? `?${qs}` : '';
    return `${base}${path}${querySuffix}`;
  };

  const send = async (call: Call): Promise<Response> => {
    const headers = new Headers({ accept: call.accept ?? 'application/json' });
    if (options.token) headers.set('authorization', `Bearer ${options.token}`);
    if (call.body !== undefined) headers.set('content-type', 'application/json');
    const response = await doFetch(url(call), {
      method: call.method,
      headers,
      body: call.body === undefined ? undefined : JSON.stringify(call.body),
    });
    if (response.ok) return response;
    let problem: Partial<Problem> = {};
    try {
      problem = (await response.json()) as Partial<Problem>;
    } catch {
      // Not a problem document; the status alone carries the error.
    }
    throw new ControllerError(response.status, problem);
  };

  const json = async <T>(call: Call): Promise<T> => (await send(call)).json() as Promise<T>;
  const empty = async (call: Call): Promise<void> => {
    await send(call);
  };

  return {
    authInfo: () => json<AuthInfo>({ method: 'GET', path: PATHS.authInfo }),
    whoami: () => json<Principal>({ method: 'GET', path: PATHS.whoami }),
    logout: () => empty({ method: 'POST', path: PATHS.logout }),

    previewDeploy: (bundle: DeployBundle) =>
      json<DeployPlan>({ method: 'POST', path: PATHS.previewDeploy, body: bundle }),
    deploy: (bundle: DeployBundle) =>
      json<Deployment>({ method: 'POST', path: PATHS.deploy, body: bundle }),
    /** The tenant's OCI registry and how to log in to it; the credential is the caller's own. */
    registry: () => json<RegistryInfo>({ method: 'GET', path: PATHS.registry }),

    createService: (request: CreateServiceRequest) =>
      json<Service>({ method: 'POST', path: PATHS.createService, body: request }),
    proxy: (service: string, request: ProxyRequest) =>
      json<ProxySession>({ method: 'POST', path: PATHS.proxy, params: { service }, body: request }),

    /** Yields one LogEvent per `log` event until the server sends `end` or the stream closes. */
    async *logs(service: string, query: LogsQuery): AsyncGenerator<LogEvent> {
      const response = await send({
        method: 'GET',
        path: PATHS.logs,
        params: { service },
        query,
        accept: 'text/event-stream',
      });
      if (!response.body) return;
      for await (const event of events(response.body)) {
        if (event.event === 'end') return;
        if (event.event === undefined || event.event === 'log') {
          yield JSON.parse(event.data) as LogEvent;
        }
      }
    },

    deployments: (query: DeploymentsQuery) =>
      json<DeploymentList>({ method: 'GET', path: PATHS.deployments, query: { ...query } }),
    deploymentStats: (env: Env) =>
      json<DeploymentStats>({ method: 'GET', path: PATHS.deploymentStats, query: { env } }),
    rollback: (request: RollbackRequest) =>
      json<Deployment>({ method: 'POST', path: PATHS.rollback, body: request }),
    removeDeployment: (env: Env, service: string) =>
      empty({
        method: 'DELETE',
        path: PATHS.removeDeployment,
        params: { service },
        query: { env },
      }),
    deleteService: (env: Env, service: string) =>
      empty({ method: 'DELETE', path: PATHS.deleteService, params: { service }, query: { env } }),

    secrets: (env: Env) => json<SecretList>({ method: 'GET', path: PATHS.secrets, query: { env } }),
    setSecret: (env: Env, name: string, value: string) =>
      empty({
        method: 'PUT',
        path: PATHS.secret,
        params: { name },
        query: { env },
        body: { value },
      }),
    updateSecret: (env: Env, name: string, value: string) =>
      empty({
        method: 'PATCH',
        path: PATHS.secret,
        params: { name },
        query: { env },
        body: { value },
      }),
    unsetSecret: (env: Env, name: string) =>
      empty({ method: 'DELETE', path: PATHS.secret, params: { name }, query: { env } }),

    vars: (env: Env) => json<ConfigList>({ method: 'GET', path: PATHS.vars, query: { env } }),
    setVar: (env: Env, name: string, value: string) =>
      empty({ method: 'PUT', path: PATHS.var, params: { name }, query: { env }, body: { value } }),
    updateVar: (env: Env, name: string, value: string) =>
      empty({
        method: 'PATCH',
        path: PATHS.var,
        params: { name },
        query: { env },
        body: { value },
      }),
    /**
     * Removes the var; `warnings` names deployed workloads that injected it (platform#100). A
     * controller from before #100 answers 204 with no body, read as no warnings.
     */
    async unsetVar(env: Env, name: string): Promise<VarUnset> {
      const response = await send({
        method: 'DELETE',
        path: PATHS.var,
        params: { name },
        query: { env },
      });
      const text = await response.text();
      return text.trim() ? (JSON.parse(text) as VarUnset) : { warnings: [] };
    },
  };
}

export type TenantClient = ReturnType<typeof createClient>;
