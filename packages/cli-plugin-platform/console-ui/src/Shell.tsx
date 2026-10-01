import {
  Alert,
  Bullseye,
  Button,
  Content,
  Label,
  Masthead,
  MastheadBrand,
  MastheadContent,
  MastheadLogo,
  MastheadMain,
  MastheadToggle,
  Nav,
  NavItem,
  NavList,
  Page,
  PageSection,
  PageSidebar,
  PageSidebarBody,
  PageToggleButton,
  Spinner,
  Title,
  Toolbar,
  ToolbarContent,
  ToolbarGroup,
  ToolbarItem,
} from '@patternfly/react-core';
import { BarsIcon, SyncAltIcon } from '@patternfly/react-icons';
import { observer } from 'mobx-react-lite';
import type { JSX } from 'react';
import { ApplicationList } from './ApplicationList';
import { ApplicationPage } from './ApplicationPage';
import { BackingServicesPage } from './BackingServicesPage';
import { Dashboard } from './Dashboard';
import { ErrorAlert } from './ErrorAlert';
import { useStore } from './StoreContext';

export const Shell = observer(function Shell(): JSX.Element {
  return (
    <Page
      masthead={<ConsoleMasthead />}
      sidebar={<ConsoleSidebar />}
      isManagedSidebar
      isContentFilled
    >
      <SectionContent />
    </Page>
  );
});

const ConsoleMasthead = observer(function ConsoleMasthead(): JSX.Element {
  const store = useStore();
  const { session } = store;
  return (
    <Masthead className="console-dark">
      <MastheadMain>
        <MastheadToggle>
          <PageToggleButton variant="plain" aria-label="Global navigation">
            <BarsIcon />
          </PageToggleButton>
        </MastheadToggle>
        <MastheadBrand>
          <MastheadLogo
            component="button"
            className="console-masthead-brand"
            onClick={() => store.navigate('dashboard')}
          >
            <BrandMark />
            <span>DI Framework</span>
          </MastheadLogo>
        </MastheadBrand>
      </MastheadMain>
      <MastheadContent>
        <Toolbar isFullHeight isStatic>
          <ToolbarContent>
            <ToolbarGroup align={{ default: 'alignEnd' }} gap={{ default: 'gapSm' }}>
              {session ? (
                <>
                  <ToolbarItem>
                    <Label id="console-tenant" color="blue">
                      {session.tenant}
                    </Label>
                  </ToolbarItem>
                  {session.hostgroup ? (
                    <ToolbarItem>
                      <Label id="console-hostgroup" color="purple">
                        {session.hostgroup}
                      </Label>
                    </ToolbarItem>
                  ) : null}
                  {store.writable ? null : (
                    <ToolbarItem>
                      <Label color="grey">View only</Label>
                    </ToolbarItem>
                  )}
                </>
              ) : null}
              <ToolbarItem>
                <Button
                  variant="plain"
                  aria-label="Refresh"
                  icon={<SyncAltIcon />}
                  isDisabled={session === undefined || store.ui.refreshing}
                  onClick={() => void store.refreshAll()}
                />
              </ToolbarItem>
            </ToolbarGroup>
          </ToolbarContent>
        </Toolbar>
      </MastheadContent>
    </Masthead>
  );
});

const ConsoleSidebar = observer(function ConsoleSidebar(): JSX.Element {
  const store = useStore();
  const { section } = store.ui;
  return (
    <PageSidebar className="console-dark">
      <PageSidebarBody>
        <Nav aria-label="Console navigation">
          <NavList>
            <NavItem
              itemId="dashboard"
              isActive={section === 'dashboard'}
              onClick={() => store.navigate('dashboard')}
            >
              Dashboard
            </NavItem>
            <NavItem
              itemId="applications"
              isActive={section === 'applications'}
              onClick={() => store.navigate('applications')}
            >
              Applications
            </NavItem>
            <NavItem
              itemId="backing-services"
              isActive={section === 'backing-services'}
              onClick={() => store.navigate('backing-services')}
            >
              Backing services
            </NavItem>
          </NavList>
        </Nav>
      </PageSidebarBody>
    </PageSidebar>
  );
});

const SectionContent = observer(function SectionContent(): JSX.Element {
  const store = useStore();
  const { ui } = store;
  if (store.session === undefined) {
    return (
      <PageSection isFilled>
        {ui.error ? (
          <Alert variant="danger" title={ui.error} isInline />
        ) : (
          <Bullseye>
            <Spinner aria-label="Opening the console session" />
          </Bullseye>
        )}
      </PageSection>
    );
  }
  if (ui.section === 'applications' && ui.selectedApplication) {
    return <ApplicationPage />;
  }
  const page =
    ui.section === 'dashboard'
      ? { title: 'Dashboard', body: <Dashboard /> }
      : ui.section === 'backing-services'
        ? {
            title: 'Backing services',
            description: 'Databases, queues, and other services applications bind to.',
            body: <BackingServicesPage />,
          }
        : {
            title: 'Applications',
            description: 'Applications deployed for this tenant and their readiness.',
            body: <ApplicationList />,
          };
  return (
    <>
      <PageSection hasBodyWrapper={false}>
        <Title headingLevel="h1">{page.title}</Title>
        {page.description ? <Content component="p">{page.description}</Content> : null}
      </PageSection>
      <PageSection hasBodyWrapper={false} isFilled>
        <ErrorAlert />
        {page.body}
      </PageSection>
    </>
  );
});

function BrandMark(): JSX.Element {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <path
        d="M16 2 29 9.5v13L16 30 3 22.5v-13Z"
        fill="none"
        stroke="var(--pf-t--global--color--brand--default)"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path
        d="M16 9 22.5 12.75v6.5L16 23l-6.5-3.75v-6.5Z"
        fill="var(--pf-t--global--color--brand--default)"
      />
    </svg>
  );
}
