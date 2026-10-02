import { type Instance, type SnapshotIn, types } from 'mobx-state-tree';
import type {
  ActivityStatus,
  ApplicationDetail,
  ApplicationTab,
  LogsView,
  Section,
} from '../types';

export const Session = types.model('Session', {
  tenant: types.string,
  hostgroup: types.maybe(types.string),
  writable: types.boolean,
  csrfToken: types.string,
});

const Part = types.model('Part', {
  name: types.string,
  kind: types.enumeration(['service', 'component']),
  lifetime: types.enumeration(['long-lived', 'on-demand']),
  failure: types.maybe(types.string),
});

const Route = types.model('Route', {
  id: types.string,
  host: types.string,
  path: types.string,
  enabled: types.boolean,
});

const EnvironmentEntry = types.model('EnvironmentEntry', {
  key: types.string,
  value: types.string,
  /** The part (service or component) that has the variable. */
  part: types.string,
});

const SecretEntry = types.model('SecretEntry', { name: types.string });

const BackingBinding = types.model('BackingBinding', {
  name: types.string,
  service: types.string,
  className: types.string,
  ready: types.boolean,
  detail: types.maybe(types.string),
});

const PrivateBinding = types.model('PrivateBinding', {
  name: types.string,
  contract: types.string,
  bound: types.boolean,
});

export const Signals = types.model('Signals', {
  success: types.number,
  error: types.number,
  compute: types.maybe(types.array(types.number)),
});

/** Logs as the console reads them: either an unpublished projection or its lines. */
export const Logs = types.model('Logs', {
  published: types.boolean,
  lines: types.array(types.string),
});

const summaryFields = {
  name: types.string,
  ready: types.boolean,
  /** A part failed to start on the host; `detail` names it. */
  failed: types.optional(types.boolean, false),
  detail: types.maybe(types.string),
  services: types.number,
  components: types.number,
  routeCount: types.number,
};

export const ApplicationSummary = types.model('ApplicationSummary', {
  ...summaryFields,
  name: types.identifier,
});

export const Application = types.model('Application', {
  ...summaryFields,
  parts: types.array(Part),
  routes: types.array(Route),
  environment: types.array(EnvironmentEntry),
  secrets: types.array(SecretEntry),
  backingServices: types.array(BackingBinding),
  privateBindings: types.array(PrivateBinding),
  logs: Logs,
  signals: types.maybe(Signals),
});

export const BackingService = types.model('BackingService', {
  name: types.identifier,
  className: types.string,
  type: types.string,
  ready: types.boolean,
  detail: types.maybe(types.string),
});

export const ServiceClass = types.model('ServiceClass', {
  name: types.identifier,
  type: types.string,
  default: types.boolean,
});

export const ApplicationSignals = types.model('ApplicationSignals', {
  application: types.identifier,
  success: types.number,
  error: types.number,
  compute: types.maybe(types.array(types.number)),
});

export const Activity = types.model('Activity', {
  id: types.identifier,
  at: types.Date,
  status: types.enumeration<ActivityStatus>('ActivityStatus', [
    'success',
    'info',
    'warning',
    'danger',
  ]),
  text: types.string,
});

export const Ui = types
  .model('Ui', {
    section: types.optional(
      types.enumeration<Section>('Section', ['dashboard', 'applications', 'backing-services']),
      'dashboard',
    ),
    selectedApplication: types.maybe(types.string),
    selectedTab: types.optional(
      types.enumeration<ApplicationTab>('ApplicationTab', [
        'overview',
        'routes',
        'environment',
        'secrets',
        'bindings',
        'logs',
        'signals',
      ]),
      'overview',
    ),
    error: types.maybe(types.string),
    refreshing: false,
  })
  .actions((self) => ({
    setError(message: string | undefined) {
      self.error = message;
    },
  }));

export function logsSnapshot(logs: LogsView): SnapshotIn<typeof Logs> {
  return 'lines' in logs ? { published: true, lines: logs.lines } : { published: false, lines: [] };
}

export function applicationSnapshot(app: ApplicationDetail): SnapshotIn<typeof Application> {
  return { ...app, logs: logsSnapshot(app.logs) };
}

export type SessionNode = Instance<typeof Session>;
export type ApplicationNode = Instance<typeof Application>;
export type ApplicationSummaryNode = Instance<typeof ApplicationSummary>;
export type BackingServiceNode = Instance<typeof BackingService>;
export type ServiceClassNode = Instance<typeof ServiceClass>;
export type ApplicationSignalsNode = Instance<typeof ApplicationSignals>;
export type ActivityNode = Instance<typeof Activity>;
export type SignalsNode = Instance<typeof Signals>;
