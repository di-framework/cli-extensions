export type TargetView = {
  name: string;
  kind: 'managed' | 'external';
  default: boolean;
  namespace?: string;
  context?: string;
  hostgroup?: string;
  stack?: string;
  platform?: string;
  registryHost?: string;
};

export type ConfigEntry = {
  key: string;
  sensitive: boolean;
  value?: string;
};

export type QueueSetting = {
  key: string;
  label: string;
  value: number;
  min: number;
  max: number;
};

export type HostInterfaceView = {
  name?: string;
  reference: string;
  interfaces: string[];
  config: ConfigEntry[];
};

export type CronView = {
  name: string;
  schedule: string;
  suspend: boolean;
  jobId?: string;
  application?: string;
  concurrencyPolicy?: string;
};

export type AppView = {
  target: string;
  namespace: string;
  name: string;
  application?: string;
  workload?: string;
  ready: boolean;
  reason?: string;
  message?: string;
  desiredReplicas: number;
  readyReplicas: number;
  pinnedReplicas: boolean;
  deployPolicy?: string;
  environmentName?: string;
  hostgroup?: string;
  httpHost?: string;
  image?: string;
  credentialsConfigured: boolean;
  controlPlane: boolean;
  allowedIpNameLookups: string[];
  config: ConfigEntry[];
  queueSettings: QueueSetting[];
  hostInterfaces: HostInterfaceView[];
  volumes: Array<{ name: string; hostPath?: string; mountPath?: string }>;
  cronJobs: CronView[];
};

export type TargetGroup = {
  target: string;
  namespace?: string;
  apps: AppView[];
  error?: string;
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

export type ServiceClassView = {
  name: string;
  type: string;
  provider: string;
  default: boolean;
};
