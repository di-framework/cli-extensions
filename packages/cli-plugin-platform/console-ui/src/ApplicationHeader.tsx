import {
  Breadcrumb,
  BreadcrumbItem,
  Button,
  Tab,
  Tabs,
  TabTitleText,
} from '@patternfly/react-core';
import { SyncAltIcon } from '@patternfly/react-icons';
import { observer } from 'mobx-react-lite';
import type { JSX } from 'react';
import { PageHeader } from './PageHeader';
import { useStore } from './StoreContext';
import { ReadyLabel } from './shared';
import type { ApplicationTab } from './types';

const TABS: Array<{ key: ApplicationTab; title: string }> = [
  { key: 'overview', title: 'Overview' },
  { key: 'routes', title: 'Routes' },
  { key: 'environment', title: 'Environment' },
  { key: 'secrets', title: 'Secrets' },
  { key: 'bindings', title: 'Bindings' },
  { key: 'logs', title: 'Logs' },
  { key: 'signals', title: 'Signals' },
];

/** The application name, status, and tabs, with the selected tab's actions on the same bar. */
export const ApplicationHeader = observer(function ApplicationHeader(): JSX.Element {
  const store = useStore();
  const { application: app, ui } = store;
  const name = ui.selectedApplication ?? '';
  const tabs = TABS.filter((tab) => tab.key !== 'signals' || app?.signals !== undefined);
  return (
    <PageHeader
      crumbs={
        <Breadcrumb>
          <BreadcrumbItem>
            <Button variant="link" isInline onClick={() => store.navigate('applications')}>
              Applications
            </Button>
          </BreadcrumbItem>
          <BreadcrumbItem isActive>{name}</BreadcrumbItem>
        </Breadcrumb>
      }
      title={name}
      status={app ? <ReadyLabel ready={app.ready} /> : undefined}
      description={app?.detail}
      tabs={
        app ? (
          <Tabs
            activeKey={ui.selectedTab}
            onSelect={(_event, key) => store.selectTab(key as ApplicationTab)}
            aria-label={`${name} sections`}
          >
            {tabs.map((tab) => (
              <Tab
                key={tab.key}
                eventKey={tab.key}
                title={<TabTitleText>{tab.title}</TabTitleText>}
                tabContentId={`console-tab-${tab.key}`}
              />
            ))}
          </Tabs>
        ) : undefined
      }
      actions={
        app && ui.selectedTab === 'logs' ? (
          <Button
            variant="secondary"
            icon={<SyncAltIcon />}
            onClick={() => void store.refreshLogs()}
          >
            Refresh
          </Button>
        ) : undefined
      }
    />
  );
});
