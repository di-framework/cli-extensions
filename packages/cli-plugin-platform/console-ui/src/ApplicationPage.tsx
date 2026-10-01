import {
  ActionGroup,
  Button,
  Card,
  CardBody,
  CodeBlock,
  CodeBlockCode,
  Content,
  DescriptionList,
  DescriptionListDescription,
  DescriptionListGroup,
  DescriptionListTerm,
  EmptyState,
  EmptyStateBody,
  Flex,
  FlexItem,
  Form,
  FormGroup,
  FormSelect,
  FormSelectOption,
  Grid,
  GridItem,
  Label,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Switch,
  Tab,
  TabContentBody,
  Tabs,
  TabTitleText,
  TextInput,
  Title,
} from '@patternfly/react-core';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import { type FormEvent, type JSX, useState } from 'react';
import {
  bindBackingService,
  deleteEnvironment,
  reassignSecret,
  setEnvironment,
  setRoute,
  unbindBackingService,
} from './api';
import { Sparkline } from './Sparkline';
import { countPhrase, messageOf, ReadyLabel } from './shared';
import type { ActivityStatus, ApplicationDetail, BackingService } from './types';

export function ApplicationPage({
  application: app,
  services,
  writable,
  onChange,
  onError,
  onActivity,
  onRefreshLogs,
}: {
  application: ApplicationDetail;
  services: BackingService[];
  writable: boolean;
  onChange: (next: ApplicationDetail) => void;
  onError: (message: string | undefined) => void;
  onActivity: (status: ActivityStatus, text: string) => void;
  onRefreshLogs: () => Promise<void>;
}): JSX.Element {
  const [tab, setTab] = useState('overview');
  const [envKey, setEnvKey] = useState('');
  const [envValue, setEnvValue] = useState('');
  const [secretName, setSecretName] = useState<string | undefined>();
  const [secretValue, setSecretValue] = useState('');
  const [bindingName, setBindingName] = useState('');
  const [bindingService, setBindingService] = useState(services[0]?.name ?? '');

  async function run(
    action: () => Promise<{ application: ApplicationDetail } | undefined>,
    done?: string,
  ) {
    try {
      const result = await action();
      if (result && 'application' in result) onChange(result.application);
      onError(undefined);
      if (done) onActivity('success', done);
    } catch (error) {
      onError(messageOf(error));
    }
  }

  return (
    <Card>
      <CardBody>
        <Tabs activeKey={tab} onSelect={(_event, key) => setTab(String(key))} isBox={false}>
          <Tab eventKey="overview" title={<TabTitleText>Overview</TabTitleText>}>
            <TabContentBody hasPadding>
              <Grid hasGutter>
                <GridItem span={12} lg={6}>
                  <Title headingLevel="h3" size="md" className="pf-v6-u-mb-sm">
                    Parts
                  </Title>
                  {app.parts.length === 0 ? (
                    <Content component="p">This application has no parts yet.</Content>
                  ) : (
                    <DescriptionList isHorizontal isCompact>
                      {app.parts.map((part) => (
                        <DescriptionListGroup key={`${part.kind}-${part.name}`}>
                          <DescriptionListTerm>
                            <Label color={part.kind === 'service' ? 'blue' : 'green'} isCompact>
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
                  <Content component="small">
                    A service is long-lived for the life of the application. A component runs on
                    demand, once per request.
                  </Content>
                </GridItem>
                <GridItem span={12} lg={6}>
                  <Title headingLevel="h3" size="md" className="pf-v6-u-mb-sm">
                    Summary
                  </Title>
                  <DescriptionList isHorizontal isCompact>
                    <DescriptionListGroup>
                      <DescriptionListTerm>Routes</DescriptionListTerm>
                      <DescriptionListDescription>
                        {app.routes.filter((route) => route.enabled).length} of {app.routes.length}{' '}
                        enabled
                      </DescriptionListDescription>
                    </DescriptionListGroup>
                    <DescriptionListGroup>
                      <DescriptionListTerm>Environment</DescriptionListTerm>
                      <DescriptionListDescription>
                        {countPhrase(app.environment.length, 'variable')}
                      </DescriptionListDescription>
                    </DescriptionListGroup>
                    <DescriptionListGroup>
                      <DescriptionListTerm>Secrets</DescriptionListTerm>
                      <DescriptionListDescription>{app.secrets.length}</DescriptionListDescription>
                    </DescriptionListGroup>
                    <DescriptionListGroup>
                      <DescriptionListTerm>Backing services</DescriptionListTerm>
                      <DescriptionListDescription>
                        {countPhrase(app.backingServices.length, 'binding')}
                      </DescriptionListDescription>
                    </DescriptionListGroup>
                    {app.signals ? (
                      <DescriptionListGroup>
                        <DescriptionListTerm>Requests</DescriptionListTerm>
                        <DescriptionListDescription>
                          {app.signals.success} successful · {app.signals.error} errors
                        </DescriptionListDescription>
                      </DescriptionListGroup>
                    ) : null}
                  </DescriptionList>
                </GridItem>
              </Grid>
            </TabContentBody>
          </Tab>
          <Tab eventKey="routes" title={<TabTitleText>Routes</TabTitleText>}>
            <TabContentBody hasPadding>
              {app.routes.length === 0 ? (
                <EmptyState variant="sm" titleText="No HTTP routes" headingLevel="h3">
                  <EmptyStateBody>This application has no HTTP routes.</EmptyStateBody>
                </EmptyState>
              ) : (
                <Table aria-label="Routes" variant="compact">
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
                        <Td dataLabel="Host">{route.host}</Td>
                        <Td dataLabel="Path">{route.path}</Td>
                        <Td dataLabel="Enabled">
                          <Switch
                            aria-label={`${route.host} ${route.path}`}
                            isChecked={route.enabled}
                            isDisabled={!writable}
                            onChange={(_event, enabled) =>
                              void run(
                                () => setRoute(app.name, route.id, enabled),
                                `${enabled ? 'Enabled' : 'Disabled'} route ${route.host}${route.path} on ${app.name}.`,
                              )
                            }
                          />
                        </Td>
                      </Tr>
                    ))}
                  </Tbody>
                </Table>
              )}
            </TabContentBody>
          </Tab>
          <Tab eventKey="environment" title={<TabTitleText>Environment</TabTitleText>}>
            <TabContentBody hasPadding>
              <Grid hasGutter>
                <GridItem span={12} xl={8}>
                  {app.environment.length === 0 ? (
                    <Content component="p">No environment variables are set.</Content>
                  ) : (
                    <Table aria-label="Environment" variant="compact">
                      <Thead>
                        <Tr>
                          <Th>Name</Th>
                          <Th>Value</Th>
                          <Th screenReaderText="Actions" />
                        </Tr>
                      </Thead>
                      <Tbody>
                        {app.environment.map((entry) => (
                          <Tr key={entry.key}>
                            <Td dataLabel="Name">{entry.key}</Td>
                            <Td dataLabel="Value">{entry.value}</Td>
                            <Td dataLabel="Actions" isActionCell>
                              <Button
                                variant="secondary"
                                size="sm"
                                isDisabled={!writable}
                                onClick={() =>
                                  void run(
                                    () => deleteEnvironment(app.name, entry.key),
                                    `Removed ${entry.key} from ${app.name}.`,
                                  )
                                }
                              >
                                Remove
                              </Button>
                            </Td>
                          </Tr>
                        ))}
                      </Tbody>
                    </Table>
                  )}
                </GridItem>
                <GridItem span={12} xl={4}>
                  <Title headingLevel="h3" size="md" className="pf-v6-u-mb-sm">
                    Set a variable
                  </Title>
                  <Form
                    onSubmit={(event: FormEvent) => {
                      event.preventDefault();
                      const key = envKey;
                      void run(async () => {
                        const result = await setEnvironment(app.name, envKey, envValue);
                        setEnvKey('');
                        setEnvValue('');
                        return result;
                      }, `Set ${key} on ${app.name}.`);
                    }}
                  >
                    <FormGroup label="Name" isRequired fieldId="env-name">
                      <TextInput
                        id="env-name"
                        value={envKey}
                        onChange={(_event, value) => setEnvKey(value)}
                        isDisabled={!writable}
                      />
                    </FormGroup>
                    <FormGroup label="Value" isRequired fieldId="env-value">
                      <TextInput
                        id="env-value"
                        value={envValue}
                        onChange={(_event, value) => setEnvValue(value)}
                        isDisabled={!writable}
                      />
                    </FormGroup>
                    <ActionGroup>
                      <Button
                        type="submit"
                        isDisabled={!writable || envKey.length === 0 || envValue.length === 0}
                      >
                        Set variable
                      </Button>
                    </ActionGroup>
                  </Form>
                </GridItem>
              </Grid>
            </TabContentBody>
          </Tab>
          <Tab eventKey="secrets" title={<TabTitleText>Secrets</TabTitleText>}>
            <TabContentBody hasPadding>
              {app.secrets.length === 0 ? (
                <Content component="p">No secrets are attached to this application.</Content>
              ) : (
                <Table aria-label="Secrets" variant="compact">
                  <Thead>
                    <Tr>
                      <Th>Name</Th>
                      <Th>Value</Th>
                      <Th screenReaderText="Actions" />
                    </Tr>
                  </Thead>
                  <Tbody>
                    {app.secrets.map((secret) => (
                      <Tr key={secret.name}>
                        <Td dataLabel="Name">{secret.name}</Td>
                        <Td dataLabel="Value">••••</Td>
                        <Td dataLabel="Actions" isActionCell>
                          <Button
                            variant="secondary"
                            size="sm"
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
              )}
            </TabContentBody>
          </Tab>
          <Tab eventKey="bindings" title={<TabTitleText>Bindings</TabTitleText>}>
            <TabContentBody hasPadding>
              <Grid hasGutter>
                <GridItem span={12} xl={8}>
                  <Title headingLevel="h3" size="md" className="pf-v6-u-mb-sm">
                    Backing services
                  </Title>
                  {app.backingServices.length === 0 ? (
                    <Content component="p">No backing services are bound.</Content>
                  ) : (
                    <Table
                      aria-label="Backing services bound to this application"
                      variant="compact"
                    >
                      <Thead>
                        <Tr>
                          <Th>Class</Th>
                          <Th>Service</Th>
                          <Th>Binding</Th>
                          <Th>Status</Th>
                          <Th screenReaderText="Actions" />
                        </Tr>
                      </Thead>
                      <Tbody>
                        {app.backingServices.map((binding) => (
                          <Tr key={binding.name}>
                            <Td dataLabel="Class">{binding.className}</Td>
                            <Td dataLabel="Service">{binding.service}</Td>
                            <Td dataLabel="Binding">{binding.name}</Td>
                            <Td dataLabel="Status">
                              <ReadyLabel ready={binding.ready} compact />
                              {binding.detail ? (
                                <div className="console-metric">{binding.detail}</div>
                              ) : null}
                            </Td>
                            <Td dataLabel="Actions" isActionCell>
                              <Button
                                variant="secondary"
                                size="sm"
                                isDisabled={!writable}
                                onClick={() =>
                                  void run(
                                    () => unbindBackingService(app.name, binding.name),
                                    `Unbound ${binding.name} from ${app.name}.`,
                                  )
                                }
                              >
                                Unbind
                              </Button>
                            </Td>
                          </Tr>
                        ))}
                      </Tbody>
                    </Table>
                  )}
                  <Title headingLevel="h3" size="md" className="pf-v6-u-mt-lg pf-v6-u-mb-sm">
                    Private bindings
                  </Title>
                  {app.privateBindings.length === 0 ? (
                    <Content component="p">This application declares no private bindings.</Content>
                  ) : (
                    <Table aria-label="Private bindings" variant="compact">
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
                            <Td dataLabel="Name">{binding.name}</Td>
                            <Td dataLabel="Contract">{binding.contract}</Td>
                            <Td dataLabel="Status">
                              <Label status={binding.bound ? 'success' : 'info'} isCompact>
                                {binding.bound ? 'Bound' : 'Unbound'}
                              </Label>
                            </Td>
                          </Tr>
                        ))}
                      </Tbody>
                    </Table>
                  )}
                </GridItem>
                <GridItem span={12} xl={4}>
                  <Title headingLevel="h3" size="md" className="pf-v6-u-mb-sm">
                    Bind a backing service
                  </Title>
                  {services.length === 0 ? (
                    <Content component="p">Create a backing service first.</Content>
                  ) : null}
                  <Form
                    onSubmit={(event: FormEvent) => {
                      event.preventDefault();
                      const selectedService = services.find(
                        (entry) => entry.name === bindingService,
                      );
                      if (!selectedService) return;
                      const binding = bindingName;
                      void run(async () => {
                        const result = await bindBackingService(
                          app.name,
                          bindingName,
                          selectedService.name,
                          selectedService.type,
                        );
                        setBindingName('');
                        return result;
                      }, `Bound ${selectedService.name} to ${app.name} as ${binding}.`);
                    }}
                  >
                    <FormGroup label="Binding name" isRequired fieldId="binding-name">
                      <TextInput
                        id="binding-name"
                        value={bindingName}
                        onChange={(_event, value) => setBindingName(value)}
                        isDisabled={!writable}
                      />
                    </FormGroup>
                    <FormGroup label="Backing service" isRequired fieldId="binding-service">
                      <FormSelect
                        id="binding-service"
                        value={bindingService}
                        isDisabled={!writable || services.length === 0}
                        onChange={(_event, value) => setBindingService(String(value))}
                      >
                        {services.map((service) => (
                          <FormSelectOption
                            key={service.name}
                            value={service.name}
                            label={service.name}
                          />
                        ))}
                      </FormSelect>
                    </FormGroup>
                    <ActionGroup>
                      <Button
                        type="submit"
                        isDisabled={
                          !writable || bindingName.length === 0 || bindingService.length === 0
                        }
                      >
                        Bind
                      </Button>
                    </ActionGroup>
                  </Form>
                </GridItem>
              </Grid>
            </TabContentBody>
          </Tab>
          <Tab eventKey="logs" title={<TabTitleText>Logs</TabTitleText>}>
            <TabContentBody hasPadding>
              <Flex className="pf-v6-u-mb-md">
                <FlexItem>
                  <Button
                    variant="secondary"
                    onClick={() =>
                      void onRefreshLogs().catch((error: unknown) => onError(messageOf(error)))
                    }
                  >
                    Refresh
                  </Button>
                </FlexItem>
              </Flex>
              {'unpublished' in app.logs ? (
                <EmptyState variant="sm" titleText="Logs are not published" headingLevel="h3">
                  <EmptyStateBody>Logs are not published for this app yet.</EmptyStateBody>
                </EmptyState>
              ) : app.logs.lines.length === 0 ? (
                <Content component="p">No log lines yet.</Content>
              ) : (
                <CodeBlock className="console-logs">
                  <CodeBlockCode>{app.logs.lines.join('\n')}</CodeBlockCode>
                </CodeBlock>
              )}
            </TabContentBody>
          </Tab>
          {app.signals ? (
            <Tab eventKey="signals" title={<TabTitleText>Signals</TabTitleText>}>
              <TabContentBody hasPadding>
                <Grid hasGutter>
                  <GridItem span={12} md={4}>
                    <DescriptionList isCompact>
                      <DescriptionListGroup>
                        <DescriptionListTerm>Successful requests</DescriptionListTerm>
                        <DescriptionListDescription>
                          {app.signals.success}
                        </DescriptionListDescription>
                      </DescriptionListGroup>
                      <DescriptionListGroup>
                        <DescriptionListTerm>Errors</DescriptionListTerm>
                        <DescriptionListDescription>{app.signals.error}</DescriptionListDescription>
                      </DescriptionListGroup>
                    </DescriptionList>
                  </GridItem>
                  <GridItem span={12} md={8}>
                    <Title headingLevel="h3" size="md" className="pf-v6-u-mb-sm">
                      Compute
                    </Title>
                    {app.signals.compute && app.signals.compute.length > 0 ? (
                      <Sparkline values={app.signals.compute} label={`${app.name} compute`} />
                    ) : (
                      <Content component="p">No compute samples yet.</Content>
                    )}
                  </GridItem>
                </Grid>
              </TabContentBody>
            </Tab>
          ) : null}
        </Tabs>
      </CardBody>
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
          <Content component="p">{secretName}</Content>
          <FormGroup label="New value" fieldId="secret-value">
            <TextInput
              id="secret-value"
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
              }, `Reassigned secret ${current} on ${app.name}.`);
            }}
          >
            Reassign
          </Button>
          <Button
            variant="link"
            onClick={() => {
              setSecretName(undefined);
              setSecretValue('');
            }}
          >
            Cancel
          </Button>
        </ModalFooter>
      </Modal>
    </Card>
  );
}
