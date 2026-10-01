import {
  Alert,
  Breadcrumb,
  BreadcrumbItem,
  Bullseye,
  Button,
  Card,
  CardBody,
  Content,
  EmptyState,
  EmptyStateBody,
  Flex,
  FlexItem,
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
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import { type JSX, useCallback, useEffect, useRef, useState } from 'react';
import { ApplicationPage } from './ApplicationPage';
import {
  application,
  applicationLogs,
  applications,
  backingServices,
  signals as readSignals,
  serviceClasses,
  session,
} from './api';
import { BackingServicesPage } from './BackingServicesPage';
import { Dashboard } from './Dashboard';
import { countPhrase, messageOf, ReadyLabel } from './shared';
import type {
  ActivityEntry,
  ActivityStatus,
  ApplicationDetail,
  ApplicationSignals,
  ApplicationSummary,
  BackingService,
  Section,
  ServiceClass,
  SessionView,
} from './types';

const ACTIVITY_LIMIT = 50;

export function App(): JSX.Element {
  const [consoleSession, setConsoleSession] = useState<SessionView | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  const [section, setSection] = useState<Section>('dashboard');
  const [apps, setApps] = useState<ApplicationSummary[]>([]);
  const [selected, setSelected] = useState<string | undefined>();
  const [detail, setDetail] = useState<ApplicationDetail | undefined>();
  const [services, setServices] = useState<BackingService[]>([]);
  const [classes, setClasses] = useState<ServiceClass[]>([]);
  const [signals, setSignals] = useState<ApplicationSignals[] | undefined>();
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const nextActivityId = useRef(1);

  const writable = consoleSession?.writable === true;

  const record = useCallback((status: ActivityStatus, text: string) => {
    setActivity((current) =>
      [{ id: nextActivityId.current++, at: new Date(), status, text }, ...current].slice(
        0,
        ACTIVITY_LIMIT,
      ),
    );
  }, []);

  const refreshApplications = useCallback(async () => {
    const listed = await applications();
    setApps(listed.applications);
    setLoadError(listed.error);
    if (listed.error) record('danger', listed.error);
    for (const app of listed.applications) {
      if (!app.ready) record('warning', `${app.name}: ${app.detail ?? 'not ready'}`);
    }
  }, [record]);

  const refreshServices = useCallback(async () => {
    const [listed, available] = await Promise.all([backingServices(), serviceClasses()]);
    setServices(listed.services);
    setClasses(available.classes);
    for (const service of listed.services) {
      if (!service.ready) record('warning', `${service.name}: ${service.detail ?? 'not ready'}`);
    }
  }, [record]);

  const refreshSignals = useCallback(async () => {
    try {
      setSignals((await readSignals()).signals);
    } catch (error) {
      setSignals([]);
      record('warning', messageOf(error));
    }
  }, [record]);

  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    try {
      await refreshApplications();
      await refreshServices();
      await refreshSignals();
      setLoadError(undefined);
    } catch (error) {
      setLoadError(messageOf(error));
    } finally {
      setRefreshing(false);
    }
  }, [refreshApplications, refreshServices, refreshSignals]);

  useEffect(() => {
    void session()
      .then(async (opened) => {
        setConsoleSession(opened);
        record('info', `Connected to tenant ${opened.tenant}.`);
        await refreshAll();
      })
      .catch((error: unknown) => setLoadError(messageOf(error)));
  }, [refreshAll, record]);

  async function openApplication(name: string) {
    setSection('applications');
    setSelected(name);
    setDetail(undefined);
    try {
      setDetail((await application(name)).application);
    } catch (error) {
      setLoadError(messageOf(error));
    }
  }

  function navigate(next: Section) {
    setSection(next);
    setSelected(undefined);
    setDetail(undefined);
  }

  const masthead = (
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
            onClick={() => navigate('dashboard')}
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
              {consoleSession ? (
                <>
                  <ToolbarItem>
                    <Label id="console-tenant" color="blue">
                      {consoleSession.tenant}
                    </Label>
                  </ToolbarItem>
                  {consoleSession.hostgroup ? (
                    <ToolbarItem>
                      <Label id="console-hostgroup" color="purple">
                        {consoleSession.hostgroup}
                      </Label>
                    </ToolbarItem>
                  ) : null}
                  {writable ? null : (
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
                  isDisabled={consoleSession === undefined || refreshing}
                  onClick={() => void refreshAll()}
                />
              </ToolbarItem>
            </ToolbarGroup>
          </ToolbarContent>
        </Toolbar>
      </MastheadContent>
    </Masthead>
  );

  const sidebar = (
    <PageSidebar className="console-dark">
      <PageSidebarBody>
        <Nav aria-label="Console navigation">
          <NavList>
            <NavItem
              itemId="dashboard"
              isActive={section === 'dashboard'}
              onClick={() => navigate('dashboard')}
            >
              Dashboard
            </NavItem>
            <NavItem
              itemId="applications"
              isActive={section === 'applications'}
              onClick={() => navigate('applications')}
            >
              Applications
            </NavItem>
            <NavItem
              itemId="backing-services"
              isActive={section === 'backing-services'}
              onClick={() => {
                navigate('backing-services');
                void refreshServices().catch((error: unknown) => setLoadError(messageOf(error)));
              }}
            >
              Backing services
            </NavItem>
          </NavList>
        </Nav>
      </PageSidebarBody>
    </PageSidebar>
  );

  return (
    <Page masthead={masthead} sidebar={sidebar} isManagedSidebar isContentFilled>
      {consoleSession === undefined ? (
        <PageSection isFilled>
          {loadError ? (
            <Alert variant="danger" title={loadError} isInline />
          ) : (
            <Bullseye>
              <Spinner aria-label="Opening the console session" />
            </Bullseye>
          )}
        </PageSection>
      ) : section === 'dashboard' ? (
        <>
          <PageHeader title="Dashboard" />
          <PageSection hasBodyWrapper={false} isFilled>
            {loadError ? (
              <Alert variant="warning" title={loadError} isInline className="pf-v6-u-mb-md" />
            ) : null}
            <Dashboard
              session={consoleSession}
              apps={apps}
              services={services}
              signals={signals}
              activity={activity}
              onNavigate={navigate}
              onOpenApplication={(name) => void openApplication(name)}
              onClearActivity={() => setActivity([])}
            />
          </PageSection>
        </>
      ) : section === 'backing-services' ? (
        <>
          <PageHeader
            title="Backing services"
            description="Databases, queues, and other services applications bind to."
          />
          <PageSection hasBodyWrapper={false} isFilled>
            {loadError ? (
              <Alert variant="warning" title={loadError} isInline className="pf-v6-u-mb-md" />
            ) : null}
            <BackingServicesPage
              services={services}
              classes={classes}
              writable={writable}
              onChange={async () => {
                await refreshServices();
              }}
              onError={setLoadError}
              onActivity={record}
            />
          </PageSection>
        </>
      ) : selected ? (
        <>
          <PageSection hasBodyWrapper={false} type="breadcrumb">
            <Breadcrumb>
              <BreadcrumbItem>
                <Button variant="link" isInline onClick={() => navigate('applications')}>
                  Applications
                </Button>
              </BreadcrumbItem>
              <BreadcrumbItem isActive>{selected}</BreadcrumbItem>
            </Breadcrumb>
          </PageSection>
          <PageSection hasBodyWrapper={false}>
            <Flex alignItems={{ default: 'alignItemsCenter' }} gap={{ default: 'gapMd' }}>
              <FlexItem>
                <Title headingLevel="h1">{selected}</Title>
              </FlexItem>
              {detail ? (
                <FlexItem>
                  <ReadyLabel ready={detail.ready} />
                </FlexItem>
              ) : null}
            </Flex>
            {detail?.detail ? <Content component="p">{detail.detail}</Content> : null}
          </PageSection>
          <PageSection hasBodyWrapper={false} isFilled>
            {loadError ? (
              <Alert variant="warning" title={loadError} isInline className="pf-v6-u-mb-md" />
            ) : null}
            {detail ? (
              <ApplicationPage
                application={detail}
                services={services}
                writable={writable}
                onChange={setDetail}
                onError={setLoadError}
                onActivity={record}
                onRefreshLogs={async () => {
                  const logs = await applicationLogs(detail.name);
                  setDetail({ ...detail, logs });
                }}
              />
            ) : (
              <Bullseye>
                <Spinner aria-label={`Loading ${selected}`} />
              </Bullseye>
            )}
          </PageSection>
        </>
      ) : (
        <>
          <PageHeader
            title="Applications"
            description="Applications deployed for this tenant and their readiness."
          />
          <PageSection hasBodyWrapper={false} isFilled>
            {loadError ? (
              <Alert variant="warning" title={loadError} isInline className="pf-v6-u-mb-md" />
            ) : null}
            <ApplicationList apps={apps} onOpen={(name) => void openApplication(name)} />
          </PageSection>
        </>
      )}
    </Page>
  );
}

function PageHeader({ title, description }: { title: string; description?: string }): JSX.Element {
  return (
    <PageSection hasBodyWrapper={false}>
      <Title headingLevel="h1">{title}</Title>
      {description ? <Content component="p">{description}</Content> : null}
    </PageSection>
  );
}

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

function ApplicationList({
  apps,
  onOpen,
}: {
  apps: ApplicationSummary[];
  onOpen: (name: string) => void;
}): JSX.Element {
  return (
    <Card>
      <CardBody>
        {apps.length === 0 ? (
          <EmptyState titleText="No applications" headingLevel="h2" variant="sm">
            <EmptyStateBody>No applications are deployed for this tenant yet.</EmptyStateBody>
          </EmptyState>
        ) : (
          <Table aria-label="Applications">
            <Thead>
              <Tr>
                <Th>Application</Th>
                <Th>Status</Th>
                <Th>Parts</Th>
                <Th>Routes</Th>
              </Tr>
            </Thead>
            <Tbody>
              {apps.map((app) => (
                <Tr key={app.name}>
                  <Td dataLabel="Application">
                    <Button variant="link" isInline onClick={() => onOpen(app.name)}>
                      {app.name}
                    </Button>
                  </Td>
                  <Td dataLabel="Status">
                    <ReadyLabel ready={app.ready} compact />
                    {app.detail ? <div className="console-metric">{app.detail}</div> : null}
                  </Td>
                  <Td dataLabel="Parts">
                    {countPhrase(app.services, 'service')} ·{' '}
                    {countPhrase(app.components, 'component')}
                  </Td>
                  <Td dataLabel="Routes">{app.routeCount}</Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </CardBody>
    </Card>
  );
}
