import {
  Button,
  FormGroup,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  TextInput,
} from '@patternfly/react-core';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import { observer } from 'mobx-react-lite';
import { type JSX, useState } from 'react';
import { useApplication, useStore } from '../StoreContext';

export const SecretsTab = observer(function SecretsTab(): JSX.Element {
  const store = useStore();
  const app = useApplication();
  const [secretName, setSecretName] = useState<string | undefined>();
  const [secretValue, setSecretValue] = useState('');

  function close() {
    setSecretName(undefined);
    setSecretValue('');
  }

  return (
    <>
      {app.secrets.length === 0 ? (
        <p className="console-note">No secrets are attached to this application.</p>
      ) : (
        <Table aria-label="Secrets" variant="compact" className="console-table">
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
                    isDisabled={!store.writable}
                    aria-label={`Reassign ${secret.name}`}
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
      <Modal
        isOpen={secretName !== undefined}
        variant="small"
        onClose={close}
        aria-labelledby="reassign-secret"
      >
        <ModalHeader title="Reassign secret" labelId="reassign-secret" />
        <ModalBody>
          <FormGroup label={`New value for ${secretName ?? ''}`} fieldId="secret-value">
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
              const name = secretName;
              const value = secretValue;
              close();
              void store.reassignSecret(name, value);
            }}
          >
            Reassign
          </Button>
          <Button variant="link" onClick={close}>
            Cancel
          </Button>
        </ModalFooter>
      </Modal>
    </>
  );
});
