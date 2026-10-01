import {
  Alert,
  Button,
  CodeBlock,
  CodeBlockCode,
  DescriptionList,
  DescriptionListDescription,
  DescriptionListGroup,
  DescriptionListTerm,
  EmptyState,
  EmptyStateBody,
  Form,
  FormGroup,
  FormSelect,
  FormSelectOption,
  Label,
  Masthead,
  MastheadMain,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Nav,
  NavItem,
  NavList,
  Page,
  PageSection,
  PageSidebar,
  PageSidebarBody,
  Switch,
  Tab,
  Tabs,
  TabTitleText,
  TextInput,
  Title,
} from '@patternfly/react-core';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import { type FormEvent, type JSX, useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  application,
  applicationLogs,
  applications,
  backingServices,
  bindBackingService,
  createBackingService,
  deleteBackingService,
  deleteEnvironment,
  reassignSecret,
  serviceClasses,
  session,
  setEnvironment,
  setRoute,
  unbindBackingService,
} from './api';
import type {
  ApplicationDetail,
  ApplicationSummary,
  BackingService,
  ServiceClass,
  SessionView,
} from './types';

type Section = 'applications' | 'backing-services';

export function App(): JSX.Element {
  const [consoleSession, setConsoleSession] = useState<SessionView | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  const [section, setSection] = useState<Section>('applications');
  const [apps, setApps] = useState<ApplicationSummary[]>([]);
  const [selected, setSelected] = useState<string | undefined>();
  const [detail, setDetail] = useState<ApplicationDetail | undefined>();
  const [services, setServices] = useState<BackingService[]>([]);
  const [classes, setClasses] = useState<ServiceClass[]>([]);

  const writable = consoleSession?.writable === true;

  const refreshApplications = useCallback(async () => {
    const listed = await applications();
    setApps(listed.applications);
    setLoadError(listed.error);
  }, []);

  const refreshServices = useCallback(async () => {
    const [listed, available] = await Promise.all([backingServices(), serviceClasses()]);
    setServices(listed.services);
    setClasses(available.classes);
  }, []);

  useEffect(() => {
    void session()
      .then(async (opened) => {
        setConsoleSession(opened);
        await refreshApplications();
        await refreshServices();
      })
      .catch((error: unknown) => setLoadError(messageOf(error)));
  }, [refreshApplications, refreshServices]);

  async function openApplication(name: string) {
    setSelected(name);
    setDetail(undefined);
    try {
      setDetail((await application(name)).application);
    } catch (error) {
      setLoadError(messageOf(error));
    }
  }

  return (
    <Page
      masthead={
        <Masthead>
          <MastheadMain>
            <Title headingLevel="h1" size="xl">
              Applications
            </Title>
            {consoleSession ? (
              <>
                <Label id="console-tenant" color="blue">
                  {consoleSession.tenant}
                </Label>
                {consoleSession.hostgroup ? (
                  <Label id="console-hostgroup" color="purple">
                    {consoleSession.hostgroup}
                  </Label>
                ) : null}
                {writable ? null : <Label color="grey">View only</Label>}
              </>
            ) : null}
          </MastheadMain>
        </Masthead>
      }
      sidebar={
        <PageSidebar>
          <PageSidebarBody>
            <Nav>
              <NavList>
                <NavItem
                  itemId="applications"
                  isActive={section === 'applications'}
                  onClick={() => {
                    setSection('applications');
                    setSelected(undefined);
                  }}
                >
                  Applications
                </NavItem>
                <NavItem
                  itemId="backing-services"
                  isActive={section === 'backing-services'}
                  onClick={() => {
                    setSection('backing-services');
                    void refreshServices().catch((error: unknown) =>
                      setLoadError(messageOf(error)),
                    );
                  }}
                >
                  Backing services
                </NavItem>
              </NavList>
            </Nav>
          </PageSidebarBody>
        </PageSidebar>
      }
    >
      <PageSection>
        {loadError ? <Alert variant="warning" title={loadError} isInline /> : null}
        {section === 'backing-services' ? (
          <BackingServicesPage
            services={services}
            classes={classes}
            writable={writable}
            onChange={async () => {
              await refreshServices();
            }}
            onError={setLoadError}
          />
        ) : selected && detail ? (
          <ApplicationPage
            application={detail}
            services={services}
            writable={writable}
            onChange={setDetail}
            onBack={() => {
              setSelected(undefined);
              setDetail(undefined);
              void refreshApplications();
            }}
            onError={setLoadError}
            onRefreshLogs={async () => {
              const logs = await applicationLogs(detail.name);
              setDetail({ ...detail, logs });
            }}
          />
        ) : (
          <ApplicationList apps={apps} onOpen={(name) => void openApplication(name)} />
        )}
      </PageSection>
    </Page>
  );
}

function ApplicationList({
  apps,
  onOpen,
}: {
  apps: ApplicationSummary[];
  onOpen: (name: string) => void;
}): JSX.Element {
  if (apps.length === 0) {
    return (
      <EmptyState>
        <Title headingLevel="h2">No applications</Title>
        <EmptyStateBody>No applications are deployed for this tenant yet.</EmptyStateBody>
      </EmptyState>
    );
  }
  return (
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
            <Td>
              <Button variant="link" onClick={() => onOpen(app.name)}>
                {app.name}
              </Button>
            </Td>
            <Td>
              <Label color={app.ready ? 'green' : 'orange'}>
                {app.ready ? 'Ready' : 'Not ready'}
              </Label>
              {app.detail ? <div>{app.detail}</div> : null}
            </Td>
            <Td>{partsSummary(app)}</Td>
            <Td>{app.routeCount}</Td>
          </Tr>
        ))}
      </Tbody>
    </Table>
  );
}

function partsSummary(app: ApplicationSummary): string {
  return `${countPhrase(app.services, 'service')} · ${countPhrase(app.components, 'component')}`;
}

function countPhrase(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function ApplicationPage({
  application: app,
  services,
  writable,
  onChange,
  onBack,
  onError,
  onRefreshLogs,
}: {
  application: ApplicationDetail;
  services: BackingService[];
  writable: boolean;
  onChange: (next: ApplicationDetail) => void;
  onBack: () => void;
  onError: (message: string | undefined) => void;
  onRefreshLogs: () => Promise<void>;
}): JSX.Element {
  const [tab, setTab] = useState('overview');
  const [envKey, setEnvKey] = useState('');
  const [envValue, setEnvValue] = useState('');
  const [secretName, setSecretName] = useState<string | undefined>();
  const [secretValue, setSecretValue] = useState('');
  const [bindingName, setBindingName] = useState('');
  const [bindingService, setBindingService] = useState(services[0]?.name ?? '');

  async function run(action: () => Promise<{ application: ApplicationDetail } | undefined>) {
    try {
      const result = await action();
      if (result && 'application' in result) onChange(result.application);
      onError(undefined);
    } catch (error) {
      onError(messageOf(error));
    }
  }

  return (
    <>
      <Button variant="link" onClick={onBack}>
        All applications
      </Button>
      <Title headingLevel="h2">{app.name}</Title>
      <Label color={app.ready ? 'green' : 'orange'}>{app.ready ? 'Ready' : 'Not ready'}</Label>
      {app.detail ? <p>{app.detail}</p> : null}
      <Tabs activeKey={tab} onSelect={(_event, key) => setTab(String(key))}>
        <Tab eventKey="overview" title={<TabTitleText>Overview</TabTitleText>}>
          {app.parts.length === 0 ? (
            <EmptyStateBody>This application has no parts yet.</EmptyStateBody>
          ) : (
            <DescriptionList isHorizontal>
              {app.parts.map((part) => (
                <DescriptionListGroup key={`${part.kind}-${part.name}`}>
                  <DescriptionListTerm>
                    <Label color={part.kind === 'service' ? 'blue' : 'green'}>
                      {part.kind === 'service' ? 'Service' : 'Component'}
                    </Label>{' '}
                    {part.name}
                  </DescriptionListTerm>
                  <DescriptionListDescription>
                    {part.lifetime === 'long-lived' ? 'Long-lived' : 'On-demand'}
                  </DescriptionListDescription>
                </DescriptionListGroup>
              ))}
            </DescriptionList>
          )}
          <p>
            A service is long-lived for the life of the application. A component runs on demand,
            once per request.
          </p>
        </Tab>
        <Tab eventKey="routes" title={<TabTitleText>Routes</TabTitleText>}>
          {app.routes.length === 0 ? (
            <EmptyStateBody>This application has no HTTP routes.</EmptyStateBody>
          ) : (
            <Table aria-label="Routes">
              <Thead>
                <Tr>
                  <Th>Host</Th>
                  <Th>Path</Th>
                  <Th>Enabled</Th>
                </Tr>
              </Thead>
              <Tbody>
                {app.routes.map((route) => (
                  <Tr key={route.id}>
                    <Td>{route.host}</Td>
                    <Td>{route.path}</Td>
                    <Td>
                      <Switch
                        aria-label={`${route.host} ${route.path}`}
                        isChecked={route.enabled}
                        isDisabled={!writable}
                        onChange={(_event, enabled) =>
                          void run(() => setRoute(app.name, route.id, enabled))
                        }
                      />
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          )}
        </Tab>
        <Tab eventKey="environment" title={<TabTitleText>Environment</TabTitleText>}>
          <Table aria-label="Environment">
            <Thead>
              <Tr>
                <Th>Name</Th>
                <Th>Value</Th>
                <Th />
              </Tr>
            </Thead>
            <Tbody>
              {app.environment.map((entry) => (
                <Tr key={entry.key}>
                  <Td>{entry.key}</Td>
                  <Td>{entry.value}</Td>
                  <Td>
                    <Button
                      variant="secondary"
                      isDisabled={!writable}
                      onClick={() => void run(() => deleteEnvironment(app.name, entry.key))}
                    >
                      Remove
                    </Button>
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
          <Form
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              void run(async () => {
                const result = await setEnvironment(app.name, envKey, envValue);
                setEnvKey('');
                setEnvValue('');
                return result;
              });
            }}
          >
            <FormGroup label="Name">
              <TextInput
                value={envKey}
                onChange={(_event, value) => setEnvKey(value)}
                isDisabled={!writable}
              />
            </FormGroup>
            <FormGroup label="Value">
              <TextInput
                value={envValue}
                onChange={(_event, value) => setEnvValue(value)}
                isDisabled={!writable}
              />
            </FormGroup>
            <Button
              type="submit"
              isDisabled={!writable || envKey.length === 0 || envValue.length === 0}
            >
              Set variable
            </Button>
          </Form>
        </Tab>
        <Tab eventKey="secrets" title={<TabTitleText>Secrets</TabTitleText>}>
          <Table aria-label="Secrets">
            <Thead>
              <Tr>
                <Th>Name</Th>
                <Th>Value</Th>
                <Th />
              </Tr>
            </Thead>
            <Tbody>
              {app.secrets.map((secret) => (
                <Tr key={secret.name}>
                  <Td>{secret.name}</Td>
                  <Td>••••</Td>
                  <Td>
                    <Button
                      variant="secondary"
                      isDisabled={!writable}
                      onClick={() => setSecretName(secret.name)}
                    >
                      Reassign
                    </Button>
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        </Tab>
        <Tab eventKey="bindings" title={<TabTitleText>Bindings</TabTitleText>}>
          <Title headingLevel="h3">Backing services</Title>
          <Table aria-label="Backing services bound to this application">
            <Thead>
              <Tr>
                <Th>Class</Th>
                <Th>Service</Th>
                <Th>Binding</Th>
                <Th>Status</Th>
                <Th />
              </Tr>
            </Thead>
            <Tbody>
              {app.backingServices.map((binding) => (
                <Tr key={binding.name}>
                  <Td>{binding.className}</Td>
                  <Td>{binding.service}</Td>
                  <Td>{binding.name}</Td>
                  <Td>
                    {binding.ready ? 'Ready' : 'Not ready'}
                    {binding.detail ? ` — ${binding.detail}` : ''}
                  </Td>
                  <Td>
                    <Button
                      variant="secondary"
                      isDisabled={!writable}
                      onClick={() => void run(() => unbindBackingService(app.name, binding.name))}
                    >
                      Unbind
                    </Button>
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
          <Form
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              const selectedService = services.find((entry) => entry.name === bindingService);
              if (!selectedService) return;
              void run(async () => {
                const result = await bindBackingService(
                  app.name,
                  bindingName,
                  selectedService.name,
                  selectedService.type,
                );
                setBindingName('');
                return result;
              });
            }}
          >
            <FormGroup label="Binding name">
              <TextInput
                value={bindingName}
                onChange={(_event, value) => setBindingName(value)}
                isDisabled={!writable}
              />
            </FormGroup>
            <FormGroup label="Backing service">
              <FormSelect
                value={bindingService}
                isDisabled={!writable}
                onChange={(_event, value) => setBindingService(String(value))}
              >
                {services.map((service) => (
                  <FormSelectOption key={service.name} value={service.name} label={service.name} />
                ))}
              </FormSelect>
            </FormGroup>
            <Button
              type="submit"
              isDisabled={!writable || bindingName.length === 0 || bindingService.length === 0}
            >
              Bind
            </Button>
          </Form>
          <Title headingLevel="h3">Private bindings</Title>
          <Table aria-label="Private bindings">
            <Thead>
              <Tr>
                <Th>Name</Th>
                <Th>Contract</Th>
                <Th>Status</Th>
              </Tr>
            </Thead>
            <Tbody>
              {app.privateBindings.map((binding) => (
                <Tr key={`${binding.name}-${binding.contract}`}>
                  <Td>{binding.name}</Td>
                  <Td>{binding.contract}</Td>
                  <Td>{binding.bound ? 'Bound' : 'Unbound'}</Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        </Tab>
        <Tab eventKey="logs" title={<TabTitleText>Logs</TabTitleText>}>
          <Button
            variant="secondary"
            onClick={() =>
              void onRefreshLogs().catch((error: unknown) => onError(messageOf(error)))
            }
          >
            Refresh
          </Button>
          {'unpublished' in app.logs ? (
            <EmptyState>
              <EmptyStateBody>Logs are not published for this app yet.</EmptyStateBody>
            </EmptyState>
          ) : (
            <CodeBlock>
              <CodeBlockCode>{app.logs.lines.join('\n')}</CodeBlockCode>
            </CodeBlock>
          )}
        </Tab>
        {app.signals ? (
          <Tab eventKey="signals" title={<TabTitleText>Signals</TabTitleText>}>
            <DescriptionList isHorizontal>
              <DescriptionListGroup>
                <DescriptionListTerm>Success</DescriptionListTerm>
                <DescriptionListDescription>{app.signals.success}</DescriptionListDescription>
              </DescriptionListGroup>
              <DescriptionListGroup>
                <DescriptionListTerm>Error</DescriptionListTerm>
                <DescriptionListDescription>{app.signals.error}</DescriptionListDescription>
              </DescriptionListGroup>
            </DescriptionList>
            {app.signals.compute ? <ComputeSparkline values={app.signals.compute} /> : null}
          </Tab>
        ) : null}
      </Tabs>
      <Modal
        isOpen={secretName !== undefined}
        variant="small"
        onClose={() => {
          setSecretName(undefined);
          setSecretValue('');
        }}
        aria-labelledby="reassign-secret"
      >
        <ModalHeader title="Reassign secret" labelId="reassign-secret" />
        <ModalBody>
          <p>{secretName}</p>
          <FormGroup label="New value">
            <TextInput
              type="password"
              value={secretValue}
              onChange={(_event, value) => setSecretValue(value)}
              autoComplete="off"
            />
          </FormGroup>
        </ModalBody>
        <ModalFooter>
          <Button
            isDisabled={secretValue.length === 0 || secretName === undefined}
            onClick={() => {
              if (secretName === undefined) return;
              const current = secretName;
              const value = secretValue;
              setSecretName(undefined);
              setSecretValue('');
              void run(async () => {
                await reassignSecret(app.name, current, value);
                return undefined;
              });
            }}
          >
            Reassign
          </Button>
        </ModalFooter>
      </Modal>
    </>
  );
}

function ComputeSparkline({ values }: { values: number[] }): JSX.Element {
  const max = Math.max(...values, 1);
  const width = 240;
  const height = 48;
  const step = values.length <= 1 ? width : width / (values.length - 1);
  const points = values
    .map((value, index) => `${index * step},${height - (value / max) * height}`)
    .join(' ');
  return (
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Compute">
      <title>Compute</title>
      <polyline fill="none" stroke="currentColor" strokeWidth="2" points={points} />
    </svg>
  );
}

function BackingServicesPage({
  services,
  classes,
  writable,
  onChange,
  onError,
}: {
  services: BackingService[];
  classes: ServiceClass[];
  writable: boolean;
  onChange: () => Promise<void>;
  onError: (message: string | undefined) => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [className, setClassName] = useState(
    classes.find((entry) => entry.default)?.name ?? classes[0]?.name ?? '',
  );
  const [memory, setMemory] = useState('');
  const [storage, setStorage] = useState('');
  const [cpu, setCpu] = useState('');

  return (
    <>
      <Title headingLevel="h2">Backing services</Title>
      <Table aria-label="Backing services">
        <Thead>
          <Tr>
            <Th>Name</Th>
            <Th>Class</Th>
            <Th>Status</Th>
            <Th />
          </Tr>
        </Thead>
        <Tbody>
          {services.map((service) => (
            <Tr key={service.name}>
              <Td>{service.name}</Td>
              <Td>{service.className}</Td>
              <Td>
                {service.ready ? 'Ready' : 'Not ready'}
                {service.detail ? ` — ${service.detail}` : ''}
              </Td>
              <Td>
                <Button
                  variant="secondary"
                  isDisabled={!writable}
                  onClick={() => {
                    void deleteBackingService(service.name)
                      .then(() => onChange())
                      .then(() => onError(undefined))
                      .catch((error: unknown) => onError(messageOf(error)));
                  }}
                >
                  Delete
                </Button>
              </Td>
            </Tr>
          ))}
        </Tbody>
      </Table>
      <Form
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          const selected = classes.find((entry) => entry.name === className);
          if (!selected) return;
          void createBackingService({
            type: selected.type,
            name,
            className: selected.name,
            ...(memory ? { memory } : {}),
            ...(storage ? { storage } : {}),
            ...(cpu ? { cpu } : {}),
          })
            .then(() => onChange())
            .then(() => {
              setName('');
              onError(undefined);
            })
            .catch((error: unknown) => onError(messageOf(error)));
        }}
      >
        <FormGroup label="Name">
          <TextInput
            value={name}
            onChange={(_event, value) => setName(value)}
            isDisabled={!writable}
          />
        </FormGroup>
        <FormGroup label="Class">
          <FormSelect
            value={className}
            isDisabled={!writable}
            onChange={(_event, value) => setClassName(String(value))}
          >
            {classes.map((entry) => (
              <FormSelectOption key={entry.name} value={entry.name} label={entry.name} />
            ))}
          </FormSelect>
        </FormGroup>
        <FormGroup label="Memory">
          <TextInput
            value={memory}
            onChange={(_event, value) => setMemory(value)}
            isDisabled={!writable}
          />
        </FormGroup>
        <FormGroup label="Storage">
          <TextInput
            value={storage}
            onChange={(_event, value) => setStorage(value)}
            isDisabled={!writable}
          />
        </FormGroup>
        <FormGroup label="CPU">
          <TextInput
            value={cpu}
            onChange={(_event, value) => setCpu(value)}
            isDisabled={!writable}
          />
        </FormGroup>
        <Button type="submit" isDisabled={!writable || name.length === 0 || className.length === 0}>
          Create
        </Button>
      </Form>
    </>
  );
}

function messageOf(error: unknown): string {
  return error instanceof ApiError ? error.message : 'The console request failed.';
}
