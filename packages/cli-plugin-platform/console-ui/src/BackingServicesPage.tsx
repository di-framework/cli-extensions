import {
  ActionGroup,
  Button,
  Card,
  CardBody,
  CardTitle,
  Content,
  EmptyState,
  EmptyStateBody,
  Form,
  FormGroup,
  FormSelect,
  FormSelectOption,
  Grid,
  GridItem,
  TextInput,
} from '@patternfly/react-core';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import { type FormEvent, type JSX, useState } from 'react';
import { createBackingService, deleteBackingService } from './api';
import { messageOf, ReadyLabel } from './shared';
import type { ActivityStatus, BackingService, ServiceClass } from './types';

export function BackingServicesPage({
  services,
  classes,
  writable,
  onChange,
  onError,
  onActivity,
}: {
  services: BackingService[];
  classes: ServiceClass[];
  writable: boolean;
  onChange: () => Promise<void>;
  onError: (message: string | undefined) => void;
  onActivity: (status: ActivityStatus, text: string) => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [className, setClassName] = useState(
    classes.find((entry) => entry.default)?.name ?? classes[0]?.name ?? '',
  );
  const [memory, setMemory] = useState('');
  const [storage, setStorage] = useState('');
  const [cpu, setCpu] = useState('');

  return (
    <Grid hasGutter>
      <GridItem span={12} xl={8}>
        <Card>
          <CardTitle>Provisioned services</CardTitle>
          <CardBody>
            {services.length === 0 ? (
              <EmptyState variant="sm" titleText="No backing services" headingLevel="h3">
                <EmptyStateBody>
                  Create a backing service to bind databases and queues to applications.
                </EmptyStateBody>
              </EmptyState>
            ) : (
              <Table aria-label="Backing services" variant="compact">
                <Thead>
                  <Tr>
                    <Th>Name</Th>
                    <Th>Class</Th>
                    <Th>Status</Th>
                    <Th screenReaderText="Actions" />
                  </Tr>
                </Thead>
                <Tbody>
                  {services.map((service) => (
                    <Tr key={service.name}>
                      <Td dataLabel="Name">{service.name}</Td>
                      <Td dataLabel="Class">{service.className}</Td>
                      <Td dataLabel="Status">
                        <ReadyLabel ready={service.ready} compact />
                        {service.detail ? (
                          <div className="console-metric">{service.detail}</div>
                        ) : null}
                      </Td>
                      <Td dataLabel="Actions" isActionCell>
                        <Button
                          variant="secondary"
                          isDanger
                          size="sm"
                          isDisabled={!writable}
                          onClick={() => {
                            void deleteBackingService(service.name)
                              .then(() => onChange())
                              .then(() => {
                                onError(undefined);
                                onActivity('info', `Deleted backing service ${service.name}.`);
                              })
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
            )}
          </CardBody>
        </Card>
      </GridItem>
      <GridItem span={12} xl={4}>
        <Card>
          <CardTitle>Create a backing service</CardTitle>
          <CardBody>
            {classes.length === 0 ? (
              <Content component="p">No service classes are available on this host group.</Content>
            ) : null}
            <Form
              onSubmit={(event: FormEvent) => {
                event.preventDefault();
                const selected = classes.find((entry) => entry.name === className);
                if (!selected) return;
                const created = name;
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
                    onActivity('success', `Created backing service ${created}.`);
                  })
                  .catch((error: unknown) => onError(messageOf(error)));
              }}
            >
              <FormGroup label="Name" isRequired fieldId="service-name">
                <TextInput
                  id="service-name"
                  value={name}
                  onChange={(_event, value) => setName(value)}
                  isDisabled={!writable}
                />
              </FormGroup>
              <FormGroup label="Class" isRequired fieldId="service-class">
                <FormSelect
                  id="service-class"
                  value={className}
                  isDisabled={!writable}
                  onChange={(_event, value) => setClassName(String(value))}
                >
                  {classes.map((entry) => (
                    <FormSelectOption key={entry.name} value={entry.name} label={entry.name} />
                  ))}
                </FormSelect>
              </FormGroup>
              <FormGroup label="Memory" fieldId="service-memory">
                <TextInput
                  id="service-memory"
                  value={memory}
                  placeholder="e.g. 512Mi"
                  onChange={(_event, value) => setMemory(value)}
                  isDisabled={!writable}
                />
              </FormGroup>
              <FormGroup label="Storage" fieldId="service-storage">
                <TextInput
                  id="service-storage"
                  value={storage}
                  placeholder="e.g. 10Gi"
                  onChange={(_event, value) => setStorage(value)}
                  isDisabled={!writable}
                />
              </FormGroup>
              <FormGroup label="CPU" fieldId="service-cpu">
                <TextInput
                  id="service-cpu"
                  value={cpu}
                  placeholder="e.g. 500m"
                  onChange={(_event, value) => setCpu(value)}
                  isDisabled={!writable}
                />
              </FormGroup>
              <ActionGroup>
                <Button
                  type="submit"
                  isDisabled={!writable || name.length === 0 || className.length === 0}
                >
                  Create
                </Button>
              </ActionGroup>
            </Form>
          </CardBody>
        </Card>
      </GridItem>
    </Grid>
  );
}
