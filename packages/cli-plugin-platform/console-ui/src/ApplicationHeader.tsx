import {
  Breadcrumb,
  BreadcrumbItem,
  Button,
  Content,
  Flex,
  FlexItem,
  PageSection,
  Tab,
  Tabs,
  TabTitleText,
  Title,
} from '@patternfly/react-core';
import { observer } from 'mobx-react-lite';
import type { JSX } from 'react';
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

export const ApplicationHeader = observer(function ApplicationHeader(): JSX.Element {
  const store = useStore();
  const { application: app, ui } = store;
  const name = ui.selectedApplication ?? '';
  const tabs = TABS.filter((tab) => tab.key !== 'signals' || app?.signals !== undefined);
  return (
    <>
      <PageSection hasBodyWrapper={false} type="breadcrumb">
        <Breadcrumb>
          <BreadcrumbItem>
            <Button variant="link" isInline onClick={() => store.navigate('applications')}>
              Applications
            </Button>
          </BreadcrumbItem>
          <BreadcrumbItem isActive>{name}</BreadcrumbItem>
        </Breadcrumb>
      </PageSection>
      <PageSection hasBodyWrapper={false}>
        <Flex alignItems={{ default: 'alignItemsCenter' }} gap={{ default: 'gapMd' }}>
          <FlexItem>
            <Title headingLevel="h1">{name}</Title>
          </FlexItem>
          {app ? (
            <FlexItem>
              <ReadyLabel ready={app.ready} />
            </FlexItem>
          ) : null}
        </Flex>
        {app?.detail ? <Content component="p">{app.detail}</Content> : null}
      </PageSection>
      {app ? (
        <PageSection hasBodyWrapper={false} type="tabs">
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
              />
            ))}
          </Tabs>
        </PageSection>
      ) : null}
    </>
  );
});
