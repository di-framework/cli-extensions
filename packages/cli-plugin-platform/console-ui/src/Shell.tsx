import {
  Alert,
  Bullseye,
  Button,
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
  PageContext,
  PageSection,
  PageSidebar,
  PageSidebarBody,
  PageToggleButton,
  Spinner,
  Toolbar,
  ToolbarContent,
  ToolbarGroup,
  ToolbarItem,
} from '@patternfly/react-core';
import { BarsIcon, SyncAltIcon } from '@patternfly/react-icons';
import { observer } from 'mobx-react-lite';
import { type JSX, useContext } from 'react';
import { ApplicationList } from './ApplicationList';
import { ApplicationPage } from './ApplicationPage';
import { BackingServicesPage } from './BackingServicesPage';
import { Dashboard } from './Dashboard';
import markUrl from './di-framework-mark.png';
import { ErrorAlert } from './ErrorAlert';
import { PageHeader } from './PageHeader';
import { useStore } from './StoreContext';
import type { Section } from './types';

export const Shell = observer(function Shell(): JSX.Element {
  return (
    <Page
      className="console-page"
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
            <span className="console-masthead-title">
              <span className="console-masthead-title__product">DI Framework console</span>
              {session ? (
                <span className="console-masthead-title__context">
                  {session.hostgroup ? `${session.tenant} · ${session.hostgroup}` : session.tenant}
                </span>
              ) : null}
            </span>
          </MastheadLogo>
        </MastheadBrand>
      </MastheadMain>
      <MastheadContent>
        <Toolbar isFullHeight isStatic>
          <ToolbarContent>
            <ToolbarGroup align={{ default: 'alignEnd' }} gap={{ default: 'gapSm' }}>
              {session && !store.writable ? (
                <ToolbarItem>
                  <Label color="grey" isCompact>
                    View only
                  </Label>
                </ToolbarItem>
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
  const page = useContext(PageContext);
  // On a narrow window the sidebar overlays the page; choosing a section closes it.
  const choose = (next: Section) => {
    store.navigate(next);
    if (page.isMobile && page.isSidebarOpen) page.onSidebarToggle();
  };
  return (
    <PageSidebar className="console-dark">
      <PageSidebarBody>
        <Nav aria-label="Console navigation">
          <NavList>
            <NavItem
              component="button"
              itemId="dashboard"
              isActive={section === 'dashboard'}
              onClick={() => choose('dashboard')}
            >
              Dashboard
            </NavItem>
            <NavItem
              component="button"
              itemId="applications"
              isActive={section === 'applications'}
              onClick={() => choose('applications')}
            >
              Applications
            </NavItem>
            <NavItem
              component="button"
              itemId="backing-services"
              isActive={section === 'backing-services'}
              onClick={() => choose('backing-services')}
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
      ? {
          title: 'Dashboard',
          description: 'Readiness, signals, and recent activity for this tenant.',
          body: <Dashboard />,
        }
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
      <PageHeader title={page.title} description={page.description} />
      <PageSection hasBodyWrapper={false} isFilled className="console-body">
        <ErrorAlert />
        {page.body}
      </PageSection>
    </>
  );
});

function BrandMark(): JSX.Element {
  return <img className="console-brand-mark" src={markUrl} alt="" />;
}
