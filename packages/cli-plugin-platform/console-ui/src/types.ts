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

export type ApplicationSummary = {
  name: string;
  ready: boolean;
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
  environment: Array<{ key: string; value: string }>;
  secrets: Array<{ name: string }>;
  backingServices: BackingBinding[];
  privateBindings: PrivateBinding[];
  logs: { unpublished: true } | { lines: string[] };
  signals?: SignalView;
};

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

export type ActivityEntry = {
  id: number;
  at: Date;
  status: ActivityStatus;
  text: string;
};

export type Section = 'dashboard' | 'applications' | 'backing-services';
