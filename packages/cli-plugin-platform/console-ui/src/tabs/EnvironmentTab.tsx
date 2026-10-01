import { ActionGroup, Button, Form, FormGroup, TextInput } from '@patternfly/react-core';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import { observer } from 'mobx-react-lite';
import { type FormEvent, type JSX, useState } from 'react';
import { useApplication, useStore } from '../StoreContext';

export const EnvironmentTab = observer(function EnvironmentTab(): JSX.Element {
  const store = useStore();
  const app = useApplication();
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const { writable } = store;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (await store.setEnvironment(key, value)) {
      setKey('');
      setValue('');
    }
  }

  return (
    <>
      <section aria-labelledby="environment-variables">
        <h2 id="environment-variables" className="console-heading">
          Variables
        </h2>
        {app.environment.length === 0 ? (
          <p className="console-note">No environment variables are set.</p>
        ) : (
          <Table aria-label="Environment" variant="compact" className="console-table">
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
                      aria-label={`Remove ${entry.key}`}
                      onClick={() => void store.deleteEnvironment(entry.key)}
                    >
                      Remove
                    </Button>
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </section>
      <section aria-labelledby="environment-set">
        <h2 id="environment-set" className="console-heading">
          Set a variable
        </h2>
        <Form className="console-form" onSubmit={(event) => void submit(event)}>
          <FormGroup label="Name" isRequired fieldId="env-name">
            <TextInput
              id="env-name"
              value={key}
              onChange={(_event, next) => setKey(next)}
              isDisabled={!writable}
            />
          </FormGroup>
          <FormGroup label="Value" isRequired fieldId="env-value">
            <TextInput
              id="env-value"
              value={value}
              onChange={(_event, next) => setValue(next)}
              isDisabled={!writable}
            />
          </FormGroup>
          <ActionGroup className="console-form__actions">
            <Button type="submit" isDisabled={!writable || key.length === 0 || value.length === 0}>
              Set variable
            </Button>
          </ActionGroup>
        </Form>
      </section>
    </>
  );
});
