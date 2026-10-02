export type PartView = {
  name: string;
  kind: 'service' | 'component';
  lifetime: 'long-lived' | 'on-demand';
  /** The host failed to start this part's current revision. */
  failure?: string;
};

export type RouteView = {
  id: string;
  host: string;
  path: string;
  enabled: boolean;
};

export type ApplicationSummary = {
  name: string;
  ready: boolean;
  failed?: boolean;
  detail?: string;
  services: number;
  components: number;
  routeCount: number;
};

export type BackingBinding = {
  name: string;
  service: string;
  className: string;
  ready: boolean;
  detail?: string;
};

export type PrivateBinding = {
  name: string;
  contract: string;
  bound: boolean;
};

export type SignalView = {
  success: number;
  error: number;
  compute?: number[];
};

export type ApplicationDetail = ApplicationSummary & {
  parts: PartView[];
  routes: RouteView[];
  environment: Array<{ key: string; value: string; part: string }>;
  secrets: Array<{ name: string }>;
  backingServices: BackingBinding[];
  privateBindings: PrivateBinding[];
  logs: LogsView;
  signals?: SignalView;
};

export type LogsView = { unpublished: true } | { lines: string[] };

export type SessionView = {
  csrfToken: string;
  writable: boolean;
  tenant: string;
  hostgroup?: string;
};

export type BackingService = {
  name: string;
  className: string;
  type: string;
  ready: boolean;
  detail?: string;
};

export type ServiceClass = {
  name: string;
  type: string;
  default: boolean;
};

export type ApplicationSignals = SignalView & { application: string };

export type ActivityStatus = 'success' | 'info' | 'warning' | 'danger';

export type Section = 'dashboard' | 'applications' | 'backing-services';

export type ApplicationTab =
  | 'overview'
  | 'routes'
  | 'environment'
  | 'secrets'
  | 'bindings'
  | 'logs'
  | 'signals';
