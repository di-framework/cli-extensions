import {
  Alert,
  Button,
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
  HelperText,
  HelperTextItem,
  Label,
  LoginPage,
  Masthead,
  MastheadBrand,
  MastheadContent,
  MastheadLogo,
  MastheadMain,
  MastheadToggle,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Nav,
  NavItem,
  NavList,
  NumberInput,
  Page,
  PageSection,
  PageSidebar,
  PageSidebarBody,
  PageToggleButton,
  Spinner,
  Switch,
  TextArea,
  TextInput,
  Title,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
} from '@patternfly/react-core';
import { BarsIcon } from '@patternfly/react-icons';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import { type FormEvent, type JSX, useCallback, useEffect, useMemo, useState } from 'react';
import {
  ApiError,
  clearSession,
  createService,
  deleteService,
  apps as loadApps,
  services as loadServices,
  targets as loadTargets,
  login,
  logout,
  saveApp,
  serviceClasses,
  session,
  setCronSuspend,
} from './api';
import type { AppView, ServiceClassView, ServiceView, TargetGroup, TargetView } from './types';

type Section = 'apps' | 'services';

export function App(): JSX.Element {
  const [authenticated, setAuthenticated] = useState<boolean | undefined>(undefined);
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState<string | undefined>();
  const [signingIn, setSigningIn] = useState(false);

  useEffect(() => {
    void session()
      .then((result) => setAuthenticated(result.authenticated))
      .catch(() => setAuthenticated(false));
  }, []);

  async function submitLogin(event: FormEvent) {
    event.preventDefault();
    setSigningIn(true);
    setLoginError(undefined);
    try {
      await login(password);
      setPassword('');
      setAuthenticated(true);
    } catch (error) {
      setLoginError(error instanceof ApiError ? error.message : 'Sign-in failed.');
    } finally {
      setSigningIn(false);
    }
  }

  if (authenticated === undefined) {
    return (
      <Page>
        <PageSection>
          <Spinner aria-label="Checking session" />
        </PageSection>
      </Page>
    );
  }

  if (!authenticated) {
    return (
      <LoginPage
        loginTitle="Sign in to the console"
        loginSubtitle="Observe and configure deployed applications. Cluster credentials stay on this machine."
      >
        <Form onSubmit={(event) => void submitLogin(event)}>
          <input
            className="pf-v6-u-screen-reader"
            type="text"
            name="username"
            autoComplete="username"
            defaultValue="operator"
            tabIndex={-1}
            aria-label="Username"
          />
          <FormGroup label="Password" isRequired fieldId="console-password">
            <TextInput
              id="console-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(_event, value) => setPassword(value)}
              isRequired
            />
          </FormGroup>
          {loginError !== undefined ? (
            <HelperText>
              <HelperTextItem variant="error">{loginError}</HelperTextItem>
            </HelperText>
          ) : null}
          <Button type="submit" variant="primary" isLoading={signingIn} isDisabled={signingIn}>
            Sign in
          </Button>
        </Form>
      </LoginPage>
    );
  }

  return <Shell onSignedOut={() => setAuthenticated(false)} />;
}

function Shell({ onSignedOut }: { onSignedOut: () => void }): JSX.Element {
  const [section, setSection] = useState<Section>('apps');
  const [targets, setTargets] = useState<TargetView[]>([]);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    void loadTargets()
      .then((result) => setTargets(result.targets))
      .catch((reason: unknown) => setError(message(reason)));
  }, []);

  const tenant = targets[0];
  const target = tenant?.name ?? '';

  async function signOut() {
    try {
      await logout();
    } catch {
      clearSession();
    }
    onSignedOut();
  }

  const masthead = (
    <Masthead>
      <MastheadMain>
        <MastheadToggle>
          <PageToggleButton isHamburgerButton aria-label="Open navigation" id="console-nav-toggle">
            <BarsIcon />
          </PageToggleButton>
        </MastheadToggle>
        <MastheadBrand>
          <MastheadLogo component="span">DI Framework</MastheadLogo>
        </MastheadBrand>
      </MastheadMain>
      <MastheadContent>
        <Toolbar>
          <ToolbarContent>
            <ToolbarItem>
              <Label color="blue" id="console-tenant">
                {tenant?.namespace ?? 'Tenant'}
              </Label>
            </ToolbarItem>
            {tenant?.hostgroup !== undefined ? (
              <ToolbarItem>
                <Label id="console-hostgroup">{tenant.hostgroup}</Label>
              </ToolbarItem>
            ) : null}
            <ToolbarItem>
              <Button variant="secondary" onClick={() => void signOut()}>
                Sign out
              </Button>
            </ToolbarItem>
          </ToolbarContent>
        </Toolbar>
      </MastheadContent>
    </Masthead>
  );

  return (
    <Page
      masthead={masthead}
      isManagedSidebar
      defaultManagedSidebarIsOpen
      sidebar={
        <PageSidebar>
          <PageSidebarBody>
            <Nav aria-label="Console sections">
              <NavList>
                <NavItem
                  itemId="apps"
                  isActive={section === 'apps'}
                  preventDefault
                  onClick={() => setSection('apps')}
                >
                  Applications
                </NavItem>
                <NavItem
                  itemId="services"
                  isActive={section === 'services'}
                  preventDefault
                  onClick={() => setSection('services')}
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
        {error !== undefined ? (
          <Alert variant="danger" title="Could not load the tenant" isInline>
            {error}
          </Alert>
        ) : null}
        {target.length === 0 ? (
          <EmptyState titleText="No tenant credential" headingLevel="h2">
            <EmptyStateBody>
              Start the console with a tenant target. That target’s kubeconfig, namespace, and host
              group are the only credentials this console uses.
            </EmptyStateBody>
          </EmptyState>
        ) : section === 'apps' ? (
          <Applications target={target} targets={targets} />
        ) : (
          <Services target={target} />
        )}
      </PageSection>
    </Page>
  );
}

function Applications({ target, targets }: { target: string; targets: TargetView[] }): JSX.Element {
  const [groups, setGroups] = useState<TargetGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<AppView | undefined>();

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const result = await loadApps(target);
      setGroups(result.results);
      setSelected((current) => {
        if (current === undefined) return undefined;
        for (const group of result.results) {
          const match = group.apps.find(
            (app) => app.name === current.name && app.target === current.target,
          );
          if (match !== undefined) return match;
        }
        return undefined;
      });
    } catch (reason: unknown) {
      setError(message(reason));
    } finally {
      setLoading(false);
    }
  }, [target]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return groups.map((group) => ({
      ...group,
      apps: group.apps.filter((app) => {
        if (needle.length === 0) return true;
        return [app.name, app.application, app.workload, app.image]
          .filter((value): value is string => typeof value === 'string')
          .some((value) => value.toLowerCase().includes(needle));
      }),
    }));
  }, [groups, query]);

  if (selected !== undefined) {
    return (
      <ApplicationDetail
        app={selected}
        onBack={() => setSelected(undefined)}
        onChanged={(app) => {
          setSelected(app);
          void refresh();
        }}
      />
    );
  }

  return (
    <>
      <Toolbar>
        <ToolbarContent>
          <ToolbarItem>
            <Title headingLevel="h1" size="2xl">
              Applications
            </Title>
          </ToolbarItem>
          <ToolbarItem>
            <TextInput
              aria-label="Filter applications"
              type="search"
              placeholder="Filter by name"
              value={query}
              onChange={(_event, value) => setQuery(value)}
            />
          </ToolbarItem>
          <ToolbarItem>
            <Button variant="secondary" onClick={() => void refresh()} isDisabled={loading}>
              Refresh
            </Button>
          </ToolbarItem>
        </ToolbarContent>
      </Toolbar>
      {error !== undefined ? (
        <Alert variant="danger" title="Could not load applications" isInline>
          {error}
        </Alert>
      ) : null}
      {loading ? <Spinner aria-label="Loading applications" /> : null}
      {!loading &&
      visible.every((group) => group.apps.length === 0 && group.error === undefined) ? (
        <EmptyState titleText="No deployed applications" headingLevel="h2">
          <EmptyStateBody>
            Deploy an application with <code>di-framework platform deploy</code>. The console lists
            workloads in{' '}
            {targets.find((entry) => entry.name === target)?.namespace ?? 'this tenant'}.
          </EmptyStateBody>
        </EmptyState>
      ) : null}
      {visible.map((group) => (
        <section key={group.target}>
          {group.error !== undefined ? (
            <Alert variant="warning" title={`${group.target} is unavailable`} isInline>
              {group.error}
            </Alert>
          ) : null}
          {group.apps.length > 0 ? (
            <Table aria-label={`Applications on ${group.target}`} variant="compact">
              <Thead>
                <Tr>
                  <Th>Name</Th>
                  <Th>Status</Th>
                  <Th>Replicas</Th>
                  <Th>Workload</Th>
                  <Th>Image</Th>
                </Tr>
              </Thead>
              <Tbody>
                {group.apps.map((app) => (
                  <Tr key={`${app.target}/${app.name}`}>
                    <Td>
                      <Button variant="link" onClick={() => setSelected(app)}>
                        {app.application ?? app.name}
                      </Button>
                    </Td>
                    <Td>
                      <Label status={app.ready ? 'success' : 'warning'} isCompact>
                        {app.ready ? 'Ready' : 'Not ready'}
                      </Label>
                    </Td>
                    <Td>
                      {app.readyReplicas}/{app.desiredReplicas}
                    </Td>
                    <Td>{app.workload ?? '—'}</Td>
                    <Td>{app.image ?? '—'}</Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          ) : null}
        </section>
      ))}
    </>
  );
}

function ApplicationDetail({
  app,
  onBack,
  onChanged,
}: {
  app: AppView;
  onBack: () => void;
  onChanged: (app: AppView) => void;
}): JSX.Element {
  const [replicas, setReplicas] = useState(app.desiredReplicas);
  const [lookups, setLookups] = useState(app.allowedIpNameLookups.join('\n'));
  const [queues, setQueues] = useState(app.queueSettings.map((setting) => ({ ...setting })));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setReplicas(app.desiredReplicas);
    setLookups(app.allowedIpNameLookups.join('\n'));
    setQueues(app.queueSettings.map((setting) => ({ ...setting })));
  }, [app]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    setSaved(false);
    const lookupList = lookups
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    try {
      const result = await saveApp(app.name, {
        target: app.target,
        ...(app.pinnedReplicas ? {} : { replicas }),
        allowedIpNameLookups: lookupList,
        queueSettings: queues.map((setting) => ({ key: setting.key, value: setting.value })),
      });
      setSaved(true);
      onChanged(result.app);
    } catch (reason: unknown) {
      setError(message(reason));
    } finally {
      setSaving(false);
    }
  }

  async function toggleCron(name: string, suspend: boolean) {
    setError(undefined);
    try {
      await setCronSuspend(name, app.target, suspend);
      onChanged({
        ...app,
        cronJobs: app.cronJobs.map((job) => (job.name === name ? { ...job, suspend } : job)),
      });
    } catch (reason: unknown) {
      setError(message(reason));
    }
  }

  return (
    <>
      <Button variant="link" onClick={onBack}>
        Back to applications
      </Button>
      <Title headingLevel="h1" size="2xl">
        {app.application ?? app.name}
      </Title>
      <Label status={app.ready ? 'success' : 'warning'} isCompact>
        {app.ready ? 'Ready' : 'Not ready'}
      </Label>
      {app.reason !== undefined ? <p>{app.reason}</p> : null}
      {app.message !== undefined ? <p>{app.message}</p> : null}
      <DescriptionList isHorizontal>
        <Item term="Target" value={app.target} />
        <Item term="Namespace" value={app.namespace || '—'} />
        <Item term="Resource" value={app.name} />
        <Item term="Workload" value={app.workload ?? '—'} />
        <Item term="Image" value={app.image ?? '—'} />
        <Item term="HTTP host" value={app.httpHost ?? '—'} />
        <Item term="Host group" value={app.hostgroup ?? '—'} />
        <Item term="Environment" value={app.environmentName ?? '—'} />
        <Item term="Deploy policy" value={app.deployPolicy ?? 'Rolling'} />
        <Item
          term="Control plane"
          value={app.controlPlane ? 'Cluster-private routes enabled' : 'Not configured'}
        />
        <Item
          term="Credentials"
          value={
            app.credentialsConfigured ? 'Referenced from a cluster secret' : 'No workload secret'
          }
        />
      </DescriptionList>
      {app.hostInterfaces.length > 0 ? (
        <>
          <Title headingLevel="h2" size="lg">
            Host interfaces
          </Title>
          <Table aria-label="Host interfaces" variant="compact">
            <Thead>
              <Tr>
                <Th>Name</Th>
                <Th>Interface</Th>
                <Th>Config</Th>
              </Tr>
            </Thead>
            <Tbody>
              {app.hostInterfaces.map((entry) => (
                <Tr key={`${entry.name ?? ''}${entry.reference}`}>
                  <Td>{entry.name ?? '—'}</Td>
                  <Td>
                    {entry.reference} ({entry.interfaces.join(', ')})
                  </Td>
                  <Td>{formatConfig(entry.config)}</Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        </>
      ) : null}
      {app.volumes.length > 0 ? (
        <>
          <Title headingLevel="h2" size="lg">
            Storage
          </Title>
          <Table aria-label="Volumes" variant="compact">
            <Thead>
              <Tr>
                <Th>Name</Th>
                <Th>Host path</Th>
                <Th>Mount</Th>
              </Tr>
            </Thead>
            <Tbody>
              {app.volumes.map((volume) => (
                <Tr key={volume.name}>
                  <Td>{volume.name}</Td>
                  <Td>{volume.hostPath ?? '—'}</Td>
                  <Td>{volume.mountPath ?? '—'}</Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        </>
      ) : null}
      {app.cronJobs.length > 0 ? (
        <>
          <Title headingLevel="h2" size="lg">
            Schedules
          </Title>
          <Table aria-label="Cron jobs" variant="compact">
            <Thead>
              <Tr>
                <Th>Job</Th>
                <Th>Schedule</Th>
                <Th>Policy</Th>
                <Th>Suspended</Th>
              </Tr>
            </Thead>
            <Tbody>
              {app.cronJobs.map((job) => (
                <Tr key={job.name}>
                  <Td>{job.jobId ?? job.name}</Td>
                  <Td>{job.schedule}</Td>
                  <Td>{job.concurrencyPolicy ?? '—'}</Td>
                  <Td>
                    <Switch
                      aria-label={`Suspend ${job.jobId ?? job.name}`}
                      isChecked={job.suspend}
                      onChange={(_event, checked) => void toggleCron(job.name, checked)}
                    />
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        </>
      ) : null}
      <Title headingLevel="h2" size="lg">
        Configuration
      </Title>
      {error !== undefined ? (
        <Alert variant="danger" title="Could not save configuration" isInline>
          {error}
        </Alert>
      ) : null}
      {saved ? (
        <Alert variant="success" title="Configuration saved" isInline>
          The workload was updated on {app.target}.
        </Alert>
      ) : null}
      <Form onSubmit={(event) => void save(event)}>
        <FormGroup label="Replicas" fieldId="replicas">
          <NumberInput
            inputAriaLabel="Replicas"
            minusBtnAriaLabel="Decrease replicas"
            plusBtnAriaLabel="Increase replicas"
            value={replicas}
            min={app.pinnedReplicas ? 1 : 0}
            max={app.pinnedReplicas ? 1 : 10}
            isDisabled={app.pinnedReplicas}
            onMinus={() =>
              setReplicas((current) => Math.max(app.pinnedReplicas ? 1 : 0, current - 1))
            }
            onPlus={() =>
              setReplicas((current) => Math.min(app.pinnedReplicas ? 1 : 10, current + 1))
            }
            onChange={(event) => {
              const parsed = Number(event.currentTarget.value);
              if (Number.isInteger(parsed)) setReplicas(parsed);
            }}
          />
          {app.pinnedReplicas ? (
            <HelperText>
              <HelperTextItem>
                This workload uses local SQLite storage, so it stays at one replica.
              </HelperTextItem>
            </HelperText>
          ) : null}
        </FormGroup>
        {queues.map((setting, index) => (
          <FormGroup key={setting.key} label={setting.label} fieldId={setting.key}>
            <NumberInput
              inputAriaLabel={setting.label}
              minusBtnAriaLabel={`Decrease ${setting.label}`}
              plusBtnAriaLabel={`Increase ${setting.label}`}
              value={setting.value}
              min={setting.min}
              max={setting.max}
              onMinus={() =>
                setQueues((current) =>
                  current.map((entry, entryIndex) =>
                    entryIndex === index
                      ? { ...entry, value: Math.max(entry.min, entry.value - 1) }
                      : entry,
                  ),
                )
              }
              onPlus={() =>
                setQueues((current) =>
                  current.map((entry, entryIndex) =>
                    entryIndex === index
                      ? { ...entry, value: Math.min(entry.max, entry.value + 1) }
                      : entry,
                  ),
                )
              }
              onChange={(event) => {
                const parsed = Number(event.currentTarget.value);
                if (!Number.isInteger(parsed)) return;
                setQueues((current) =>
                  current.map((entry, entryIndex) =>
                    entryIndex === index ? { ...entry, value: parsed } : entry,
                  ),
                );
              }}
            />
          </FormGroup>
        ))}
        <FormGroup label="Allowed DNS lookups" fieldId="lookups">
          <TextArea
            id="lookups"
            aria-label="Allowed DNS lookups"
            value={lookups}
            onChange={(_event, value) => setLookups(value)}
            resizeOrientation="vertical"
          />
          <HelperText>
            <HelperTextItem>
              One hostname or wildcard suffix per line, for example *.svc.cluster.local.
            </HelperTextItem>
          </HelperText>
        </FormGroup>
        {app.config.length > 0 ? (
          <DescriptionList isCompact>
            {app.config.map((entry) => (
              <DescriptionListGroup key={entry.key}>
                <DescriptionListTerm>{entry.key}</DescriptionListTerm>
                <DescriptionListDescription>
                  {entry.sensitive ? 'Hidden' : (entry.value ?? '—')}
                </DescriptionListDescription>
              </DescriptionListGroup>
            ))}
          </DescriptionList>
        ) : null}
        <Button type="submit" variant="primary" isLoading={saving} isDisabled={saving}>
          Save configuration
        </Button>
      </Form>
    </>
  );
}

function Services({ target }: { target: string }): JSX.Element {
  const [rows, setRows] = useState<ServiceView[]>([]);
  const [classes, setClasses] = useState<ServiceClassView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [creating, setCreating] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ServiceView | undefined>();
  const [type, setType] = useState('keyvalue');
  const [name, setName] = useState('');
  const [className, setClassName] = useState('');
  const [deletionPolicy, setDeletionPolicy] = useState('Retain');
  const [memory, setMemory] = useState('');
  const [storage, setStorage] = useState('');
  const [cpu, setCpu] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [listed, discovered] = await Promise.all([
        loadServices(target),
        serviceClasses(target),
      ]);
      setRows(listed.services);
      setClasses(discovered.classes);
      const match = discovered.classes.find((entry) => entry.type === type);
      setClassName((current) => current || match?.name || '');
    } catch (reason: unknown) {
      setError(message(reason));
    } finally {
      setLoading(false);
    }
  }, [target, type]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const classOptions = classes.filter((entry) => entry.type === type);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setCreating(true);
    setError(undefined);
    try {
      await createService({
        target,
        type,
        name,
        ...(className.length > 0 ? { className } : {}),
        deletionPolicy,
        ...(memory.trim().length > 0 ? { memory: memory.trim() } : {}),
        ...(storage.trim().length > 0 ? { storage: storage.trim() } : {}),
        ...(cpu.trim().length > 0 ? { cpu: cpu.trim() } : {}),
      });
      setName('');
      await refresh();
    } catch (reason: unknown) {
      setError(message(reason));
    } finally {
      setCreating(false);
    }
  }

  async function confirmDelete() {
    if (pendingDelete === undefined) return;
    setError(undefined);
    try {
      await deleteService(target, pendingDelete.name);
      setPendingDelete(undefined);
      await refresh();
    } catch (reason: unknown) {
      setError(message(reason));
      setPendingDelete(undefined);
    }
  }

  return (
    <>
      <Title headingLevel="h1" size="2xl">
        Backing services
      </Title>
      {error !== undefined ? (
        <Alert variant="danger" title="Backing service request failed" isInline>
          {error}
        </Alert>
      ) : null}
      <Form onSubmit={(event) => void submit(event)}>
        <FormGroup label="Type" isRequired fieldId="service-type">
          <FormSelect
            id="service-type"
            aria-label="Service type"
            value={type}
            onChange={(_event, value) => {
              setType(value);
              const match = classes.find((entry) => entry.type === value);
              setClassName(match?.name ?? '');
            }}
          >
            <FormSelectOption value="keyvalue" label="keyvalue" />
            <FormSelectOption value="messaging" label="messaging" />
            <FormSelectOption value="postgres" label="postgres" />
          </FormSelect>
        </FormGroup>
        <FormGroup label="Name" isRequired fieldId="service-name">
          <TextInput
            id="service-name"
            value={name}
            onChange={(_event, value) => setName(value)}
            isRequired
          />
        </FormGroup>
        <FormGroup label="Class" fieldId="service-class">
          <FormSelect
            id="service-class"
            aria-label="Service class"
            value={className}
            onChange={(_event, value) => setClassName(value)}
          >
            {classOptions.map((entry) => (
              <FormSelectOption key={entry.name} value={entry.name} label={entry.name} />
            ))}
          </FormSelect>
        </FormGroup>
        <FormGroup label="Deletion policy" fieldId="service-policy">
          <FormSelect
            id="service-policy"
            aria-label="Deletion policy"
            value={deletionPolicy}
            onChange={(_event, value) => setDeletionPolicy(value)}
          >
            <FormSelectOption value="Retain" label="Retain" />
            <FormSelectOption value="Delete" label="Delete" />
          </FormSelect>
        </FormGroup>
        <FormGroup label="Memory" fieldId="service-memory">
          <TextInput
            id="service-memory"
            value={memory}
            onChange={(_event, value) => setMemory(value)}
          />
        </FormGroup>
        <FormGroup label="Storage" fieldId="service-storage">
          <TextInput
            id="service-storage"
            value={storage}
            onChange={(_event, value) => setStorage(value)}
          />
        </FormGroup>
        <FormGroup label="CPU" fieldId="service-cpu">
          <TextInput id="service-cpu" value={cpu} onChange={(_event, value) => setCpu(value)} />
        </FormGroup>
        <Button
          type="submit"
          variant="primary"
          isLoading={creating}
          isDisabled={creating || name.length === 0}
        >
          Create service
        </Button>
      </Form>
      {loading ? <Spinner aria-label="Loading backing services" /> : null}
      {!loading && rows.length === 0 ? (
        <EmptyState titleText="No backing services" headingLevel="h2">
          <EmptyStateBody>
            Create a key-value, messaging, or PostgreSQL service for this target.
          </EmptyStateBody>
        </EmptyState>
      ) : null}
      {rows.length > 0 ? (
        <Table aria-label="Backing services" variant="compact">
          <Thead>
            <Tr>
              <Th>Name</Th>
              <Th>Type</Th>
              <Th>Class</Th>
              <Th>Ready</Th>
              <Th>Endpoint</Th>
              <Th>Policy</Th>
              <Th>Action</Th>
            </Tr>
          </Thead>
          <Tbody>
            {rows.map((service) => (
              <Tr key={service.name}>
                <Td>{service.name}</Td>
                <Td>{service.type}</Td>
                <Td>{service.className || '—'}</Td>
                <Td>
                  <Label status={service.ready === 'True' ? 'success' : 'warning'} isCompact>
                    {service.ready}
                  </Label>
                </Td>
                <Td>
                  {service.endpoint ? `${service.endpoint.host}:${service.endpoint.port}` : '—'}
                </Td>
                <Td>{service.deletionPolicy ?? '—'}</Td>
                <Td>
                  <Button variant="danger" onClick={() => setPendingDelete(service)}>
                    Delete
                  </Button>
                </Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      ) : null}
      <Modal
        isOpen={pendingDelete !== undefined}
        onClose={() => setPendingDelete(undefined)}
        variant="small"
        aria-labelledby="delete-service-title"
      >
        <ModalHeader title="Delete backing service" labelId="delete-service-title" />
        <ModalBody>
          Delete {pendingDelete?.name}? Controller retention rules still apply. A Retain policy may
          keep the provisioned infrastructure.
        </ModalBody>
        <ModalFooter>
          <Button variant="danger" onClick={() => void confirmDelete()}>
            Delete
          </Button>
          <Button variant="link" onClick={() => setPendingDelete(undefined)}>
            Cancel
          </Button>
        </ModalFooter>
      </Modal>
    </>
  );
}

function Item({ term, value }: { term: string; value: string }): JSX.Element {
  return (
    <DescriptionListGroup>
      <DescriptionListTerm>{term}</DescriptionListTerm>
      <DescriptionListDescription>{value}</DescriptionListDescription>
    </DescriptionListGroup>
  );
}

function formatConfig(entries: Array<{ key: string; sensitive: boolean; value?: string }>): string {
  if (entries.length === 0) return '—';
  return entries
    .map((entry) => (entry.sensitive ? `${entry.key}=hidden` : `${entry.key}=${entry.value ?? ''}`))
    .join(', ');
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'The request failed.';
}
