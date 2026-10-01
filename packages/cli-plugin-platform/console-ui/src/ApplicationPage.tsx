import { Bullseye, PageSection, Spinner } from '@patternfly/react-core';
import { observer } from 'mobx-react-lite';
import type { JSX } from 'react';
import { ApplicationHeader } from './ApplicationHeader';
import { ErrorAlert } from './ErrorAlert';
import { useStore } from './StoreContext';
import { BindingsTab } from './tabs/BindingsTab';
import { EnvironmentTab } from './tabs/EnvironmentTab';
import { LogsTab } from './tabs/LogsTab';
import { OverviewTab } from './tabs/OverviewTab';
import { RoutesTab } from './tabs/RoutesTab';
import { SecretsTab } from './tabs/SecretsTab';
import { SignalsTab } from './tabs/SignalsTab';
import type { ApplicationTab } from './types';

const TAB_VIEWS: Record<ApplicationTab, () => JSX.Element | null> = {
  overview: OverviewTab,
  routes: RoutesTab,
  environment: EnvironmentTab,
  secrets: SecretsTab,
  bindings: BindingsTab,
  logs: LogsTab,
  signals: SignalsTab,
};

export const ApplicationPage = observer(function ApplicationPage(): JSX.Element {
  const store = useStore();
  const tab = store.ui.selectedTab;
  const SelectedTab = TAB_VIEWS[tab];
  return (
    <>
      <ApplicationHeader />
      <PageSection
        hasBodyWrapper={false}
        isFilled
        className="console-body"
        id={`console-tab-${tab}`}
        role="tabpanel"
        aria-label={tab}
      >
        <ErrorAlert />
        {store.application ? (
          <SelectedTab />
        ) : (
          <Bullseye>
            <Spinner aria-label={`Loading ${store.ui.selectedApplication ?? 'application'}`} />
          </Bullseye>
        )}
      </PageSection>
    </>
  );
});
