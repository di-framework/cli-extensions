import {
  ActionGroup,
  Button,
  Content,
  Form,
  FormGroup,
  FormSelect,
  FormSelectOption,
  Grid,
  GridItem,
  Label,
  TextInput,
  Title,
} from '@patternfly/react-core';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import { observer } from 'mobx-react-lite';
import { type FormEvent, type JSX, useState } from 'react';
import { useApplication, useStore } from '../StoreContext';
import { ReadyLabel } from '../shared';

export const BindingsTab = observer(function BindingsTab(): JSX.Element {
  const store = useStore();
  const app = useApplication();
  const { services, writable } = store;
  const [bindingName, setBindingName] = useState('');
  const [chosenService, setChosenService] = useState<string | undefined>();
  const bindingService = chosenService ?? services[0]?.name ?? '';

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (await store.bind(bindingName, bindingService)) setBindingName('');
  }

  return (
    <Grid hasGutter>
      <GridItem span={12} xl={8}>
        <Title headingLevel="h3" size="md" className="pf-v6-u-mb-sm">
          Backing services
        </Title>
        {app.backingServices.length === 0 ? (
          <Content component="p">No backing services are bound.</Content>
        ) : (
          <Table aria-label="Backing services bound to this application" variant="compact">
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
                    {binding.detail ? <div className="console-metric">{binding.detail}</div> : null}
                  </Td>
                  <Td dataLabel="Actions" isActionCell>
                    <Button
                      variant="secondary"
                      size="sm"
                      isDisabled={!writable}
                      onClick={() => void store.unbind(binding.name)}
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
        <Form onSubmit={(event) => void submit(event)}>
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
              onChange={(_event, value) => setChosenService(String(value))}
            >
              {services.map((service) => (
                <FormSelectOption key={service.name} value={service.name} label={service.name} />
              ))}
            </FormSelect>
          </FormGroup>
          <ActionGroup>
            <Button
              type="submit"
              isDisabled={!writable || bindingName.length === 0 || bindingService.length === 0}
            >
              Bind
            </Button>
          </ActionGroup>
        </Form>
      </GridItem>
    </Grid>
  );
});
