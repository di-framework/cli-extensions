import { applySnapshot, cast, flow, type Instance, isAlive, types } from 'mobx-state-tree';
import { type ConsoleClient, createClient, messageOf, type ServiceInput } from '../api';
import type { ActivityStatus, ApplicationDetail, ApplicationTab, Section } from '../types';
import {
  Activity,
  Application,
  ApplicationSignals,
  ApplicationSummary,
  applicationSnapshot,
  BackingService,
  logsSnapshot,
  ServiceClass,
  Session,
  Ui,
} from './models';

export const ACTIVITY_LIMIT = 50;

/**
 * The console's server state and navigation. Views read this tree and call its actions; only these
 * actions talk to the console API.
 */
export const ConsoleStore = types
  .model('ConsoleStore', {
    session: types.maybe(Session),
    applications: types.array(ApplicationSummary),
    application: types.maybe(Application),
    services: types.array(BackingService),
    classes: types.array(ServiceClass),
    signals: types.maybe(types.array(ApplicationSignals)),
    activity: types.array(Activity),
    ui: types.optional(Ui, {}),
  })
  .volatile(() => ({ nextActivityId: 1 }))
  .views((self) => ({
    get writable(): boolean {
      return self.session?.writable === true;
    },
    get defaultServiceClass(): string {
      return (self.classes.find((entry) => entry.default) ?? self.classes[0])?.name ?? '';
    },
  }))
  .actions((self) => ({
    /** The server rotates the token on its responses; the session keeps the latest one. */
    receiveCsrfToken(token: string) {
      if (self.session) self.session.csrfToken = token;
    },
  }))
  .actions((self) => {
    const client: ConsoleClient = createClient({
      csrfToken: () => self.session?.csrfToken ?? '',
      receiveCsrfToken: (token) => self.receiveCsrfToken(token),
    });

    function record(status: ActivityStatus, text: string) {
      const id = String(self.nextActivityId++);
      self.activity.unshift({ id, at: new Date(), status, text });
      if (self.activity.length > ACTIVITY_LIMIT) self.activity.splice(ACTIVITY_LIMIT);
    }

    function fail(error: unknown) {
      self.ui.setError(messageOf(error));
    }

    function showApplication(app: ApplicationDetail) {
      if (self.application?.name === app.name) {
        applySnapshot(self.application, applicationSnapshot(app));
      } else {
        self.application = Application.create(applicationSnapshot(app));
      }
    }

    const refreshApplications = flow(function* () {
      const listed: Awaited<ReturnType<ConsoleClient['applications']>> =
        yield client.applications();
      applySnapshot(self.applications, listed.applications);
      self.ui.setError(listed.error);
      if (listed.error) record('danger', listed.error);
      for (const app of listed.applications) {
        if (!app.ready) record('warning', `${app.name}: ${app.detail ?? 'not ready'}`);
      }
    });

    const refreshServices = flow(function* () {
      const [listed, available]: [
        Awaited<ReturnType<ConsoleClient['backingServices']>>,
        Awaited<ReturnType<ConsoleClient['serviceClasses']>>,
      ] = yield Promise.all([client.backingServices(), client.serviceClasses()]);
      applySnapshot(self.services, listed.services);
      applySnapshot(self.classes, available.classes);
      for (const service of listed.services) {
        if (!service.ready) record('warning', `${service.name}: ${service.detail ?? 'not ready'}`);
      }
    });

    const refreshSignals = flow(function* () {
      try {
        const listed: Awaited<ReturnType<ConsoleClient['signals']>> = yield client.signals();
        self.signals = cast(listed.signals);
      } catch (error) {
        self.signals = cast([]);
        record('warning', messageOf(error));
      }
    });

    const refreshAll = flow(function* () {
      self.ui.refreshing = true;
      try {
        yield refreshApplications();
        yield refreshServices();
        yield refreshSignals();
        self.ui.setError(undefined);
      } catch (error) {
        fail(error);
      } finally {
        self.ui.refreshing = false;
      }
    });

    const start = flow(function* () {
      try {
        const opened: Awaited<ReturnType<ConsoleClient['session']>> = yield client.session();
        self.session = Session.create(opened);
        record('info', `Connected to tenant ${opened.tenant}.`);
      } catch (error) {
        fail(error);
        return;
      }
      yield refreshAll();
    });

    function navigate(section: Section) {
      self.ui.section = section;
      self.ui.selectedApplication = undefined;
      self.application = undefined;
      if (section === 'backing-services') void refreshServicesSafely();
    }

    const refreshServicesSafely = flow(function* () {
      try {
        yield refreshServices();
      } catch (error) {
        fail(error);
      }
    });

    const openApplication = flow(function* (name: string) {
      self.ui.section = 'applications';
      self.ui.selectedApplication = name;
      self.ui.selectedTab = 'overview';
      self.application = undefined;
      try {
        const opened: Awaited<ReturnType<ConsoleClient['application']>> =
          yield client.application(name);
        if (self.ui.selectedApplication === name) showApplication(opened.application);
      } catch (error) {
        fail(error);
      }
    });

    function selectTab(tab: ApplicationTab) {
      self.ui.selectedTab = tab;
    }

    const refreshLogs = flow(function* () {
      const app = self.application;
      if (!app) return;
      try {
        const logs: Awaited<ReturnType<ConsoleClient['applicationLogs']>> =
          yield client.applicationLogs(app.name);
        if (isAlive(app)) applySnapshot(app.logs, logsSnapshot(logs));
      } catch (error) {
        fail(error);
      }
    });

    /**
     * Runs one change, applies its response to the tree, records it, and reports whether it
     * succeeded so a form can clear its draft.
     */
    const change = flow(function* <T>(
      request: () => Promise<T>,
      apply: (result: T) => void,
      done: string,
    ) {
      try {
        const result: T = yield request();
        apply(result);
        self.ui.setError(undefined);
        record('success', done);
        return true;
      } catch (error) {
        fail(error);
        return false;
      }
    });

    function changeApplication(
      request: (name: string) => Promise<{ application: ApplicationDetail }>,
      done: (name: string) => string,
    ): Promise<boolean> {
      const name = self.application?.name;
      if (name === undefined) return Promise.resolve(false);
      return change(
        () => request(name),
        (result) => showApplication(result.application),
        done(name),
      );
    }

    return {
      start,
      refreshAll,
      refreshSignals,
      navigate,
      openApplication,
      selectTab,
      refreshLogs,
      clearActivity() {
        self.activity.clear();
      },
      setRoute(routeId: string, label: string, enabled: boolean) {
        return changeApplication(
          (name) => client.setRoute(name, routeId, enabled),
          (name) => `${enabled ? 'Enabled' : 'Disabled'} route ${label} on ${name}.`,
        );
      },
      setEnvironment(key: string, value: string) {
        return changeApplication(
          (name) => client.setEnvironment(name, key, value),
          (name) => `Set ${key} on ${name}.`,
        );
      },
      deleteEnvironment(key: string) {
        return changeApplication(
          (name) => client.deleteEnvironment(name, key),
          (name) => `Removed ${key} from ${name}.`,
        );
      },
      reassignSecret(secret: string, value: string) {
        const name = self.application?.name;
        if (name === undefined) return Promise.resolve(false);
        return change(
          () => client.reassignSecret(name, secret, value),
          () => {},
          `Reassigned secret ${secret} on ${name}.`,
        );
      },
      bind(binding: string, serviceName: string) {
        const service = self.services.find((entry) => entry.name === serviceName);
        if (!service) return Promise.resolve(false);
        const { type } = service;
        return changeApplication(
          (name) => client.bindBackingService(name, binding, serviceName, type),
          (name) => `Bound ${serviceName} to ${name} as ${binding}.`,
        );
      },
      unbind(binding: string) {
        return changeApplication(
          (name) => client.unbindBackingService(name, binding),
          (name) => `Unbound ${binding} from ${name}.`,
        );
      },
      createService(input: ServiceInput) {
        return change(
          () => client.createBackingService(input),
          ({ service }) => {
            const existing = self.services.find((entry) => entry.name === service.name);
            if (existing) applySnapshot(existing, service);
            else self.services.push(service);
          },
          `Created backing service ${input.name}.`,
        );
      },
      deleteService(name: string) {
        return change(
          () => client.deleteBackingService(name),
          () => {
            const index = self.services.findIndex((entry) => entry.name === name);
            if (index >= 0) self.services.splice(index, 1);
          },
          `Deleted backing service ${name}.`,
        );
      },
    };
  });

export type ConsoleStoreInstance = Instance<typeof ConsoleStore>;
