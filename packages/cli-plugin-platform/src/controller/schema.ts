export type ControllerPath =
  | '/v1/auth/info'
  | '/v1/auth/logout'
  | '/v1/auth/whoami'
  | '/v1/deploy'
  | '/v1/deploy/preview'
  | '/v1/deploy/registry'
  | '/v1/deployments'
  | '/v1/deployments/stats'
  | '/v1/deployments/{service}'
  | '/v1/deployments/rollback'
  | '/v1/secrets'
  | '/v1/secrets/{name}'
  | '/v1/services'
  | '/v1/services/{service}'
  | '/v1/services/{service}/logs'
  | '/v1/services/{service}/proxy'
  | '/v1/vars'
  | '/v1/vars/{name}';

export type Env = 'prod' | 'staging';

export type Problem = {
  type?: string;
  title: string;
  status: number;
  detail?: string;
};

export type AuthInfo = {
  account: string;
  issuer: string;
  clientId: string;
};

export type Principal = {
  user: string;
  account: string;
  role: 'developer' | 'viewer';
  via: 'identity' | 'api-key';
  credentialId?: string;
};

export type ComponentReference = {
  reference: string;
  digest: string;
};

export type Binding = {
  name: string;
  capability: string;
  serviceName?: string;
  config?: Record<string, string>;
};

export type DeployBundle = {
  env: Env;
  service: string;
  component: ComponentReference;
  workload: Record<string, unknown>;
  bindings: Binding[];
  secrets: string[];
};

export type RegistryInfo = {
  url: string;
  repositoryPrefix?: string;
  auth: 'basic-identity';
  username: string;
};

export type DeployChange = {
  kind: 'create' | 'update' | 'unchanged' | 'delete';
  resource: string;
  name: string;
  detail?: string;
};

export type DeployPlan = {
  env: Env;
  service: string;
  changes: DeployChange[];
};

export type Deployment = {
  id: string;
  service: string;
  env: Env;
  status: 'pending' | 'rolling' | 'ready' | 'failed' | 'rolled-back';
  component: ComponentReference;
  createdAt: string;
  readyAt?: string;
  rollbackOf?: string;
};

export type DeploymentsQuery = {
  env: Env;
  service?: string;
};

export type DeploymentList = {
  items: Deployment[];
};

export type DeploymentStats = {
  env: Env;
  services: number;
  deployments: number;
  ready: number;
  failed: number;
  lastDeployedAt?: string;
};

export type RollbackRequest = {
  env: Env;
  service: string;
  to?: string;
};

export type ControllerServiceType = 'keyvalue' | 'messaging' | 'blobstore' | 'postgres' | 'egress';

export type ServiceParameters = {
  storage?: string;
  memory?: string;
  cpu?: string;
};

export type CreateServiceRequest = {
  env: Env;
  type: ControllerServiceType;
  name: string;
  className?: string;
  parameters?: ServiceParameters;
  deletionPolicy?: 'Retain' | 'Delete';
  destinations?: string[];
};

export type Service = {
  name: string;
  env: Env;
  type: ControllerServiceType;
  className: string;
  parameters?: ServiceParameters;
  deletionPolicy?: 'Retain' | 'Delete';
  destinations?: string[];
  createdAt: string;
};

export type LogEvent = {
  timestamp: string;
  deployment: string;
  instance?: string;
  level?: 'debug' | 'info' | 'warn' | 'error';
  message: string;
};

export type LogsQuery = {
  env: Env;
  deployment?: string;
  follow?: boolean;
  since?: string;
  tail?: number;
};

export type ConfigEntry = {
  name: string;
  value?: string;
  updatedAt: string;
};

export type ConfigList = {
  env: Env;
  items: ConfigEntry[];
};

export type SecretEntry = {
  name: string;
  updatedAt: string;
};

export type SecretList = {
  env: Env;
  items: SecretEntry[];
};

export type VarUnset = {
  warnings: {
    code: 'referenced';
    detail: string;
    deployments: string[];
  }[];
};

export type ProxyRequest = {
  env: Env;
  port?: number;
};

export type ProxySession = {
  url: string;
  port: number;
  expiresAt: string;
};
