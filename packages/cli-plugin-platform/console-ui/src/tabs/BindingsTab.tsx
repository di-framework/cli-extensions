import {
  ActionGroup,
  Button,
  Form,
  FormGroup,
  FormSelect,
  FormSelectOption,
  Label,
  TextInput,
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
    <>
      <section aria-labelledby="bindings-backing">
        <h2 id="bindings-backing" className="console-heading">
          Backing services
        </h2>
        {app.backingServices.length === 0 ? (
          <p className="console-note">No backing services are bound.</p>
        ) : (
          <Table
            aria-label="Backing services bound to this application"
            variant="compact"
            className="console-table"
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
                    {binding.detail ? <div className="console-metric">{binding.detail}</div> : null}
                  </Td>
                  <Td dataLabel="Actions" isActionCell>
                    <Button
                      variant="secondary"
                      size="sm"
                      isDisabled={!writable}
                      aria-label={`Unbind ${binding.name}`}
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
      </section>
      <section aria-labelledby="bindings-bind">
        <h2 id="bindings-bind" className="console-heading">
          Bind a backing service
        </h2>
        {services.length === 0 ? (
          <p className="console-note">Create a backing service first.</p>
        ) : null}
        <Form className="console-form" onSubmit={(event) => void submit(event)}>
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
          <ActionGroup className="console-form__actions">
            <Button
              type="submit"
              isDisabled={!writable || bindingName.length === 0 || bindingService.length === 0}
            >
              Bind
            </Button>
          </ActionGroup>
        </Form>
      </section>
      <section aria-labelledby="bindings-private">
        <h2 id="bindings-private" className="console-heading">
          Private bindings
        </h2>
        {app.privateBindings.length === 0 ? (
          <p className="console-note">This application declares no private bindings.</p>
        ) : (
          <Table aria-label="Private bindings" variant="compact" className="console-table">
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
      </section>
    </>
  );
});
