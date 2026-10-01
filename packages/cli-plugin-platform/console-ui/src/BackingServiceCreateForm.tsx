import {
  ActionGroup,
  Button,
  Content,
  Form,
  FormGroup,
  FormSelect,
  FormSelectOption,
  TextInput,
} from '@patternfly/react-core';
import { observer } from 'mobx-react-lite';
import { type FormEvent, type JSX, useState } from 'react';
import { useStore } from './StoreContext';

export const BackingServiceCreateForm = observer(function BackingServiceCreateForm(): JSX.Element {
  const store = useStore();
  const { classes, writable } = store;
  const [name, setName] = useState('');
  const [chosenClass, setChosenClass] = useState<string | undefined>();
  const [memory, setMemory] = useState('');
  const [storage, setStorage] = useState('');
  const [cpu, setCpu] = useState('');
  const className = chosenClass ?? store.defaultServiceClass;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const selected = classes.find((entry) => entry.name === className);
    if (!selected) return;
    const created = await store.createService({
      type: selected.type,
      name,
      className: selected.name,
      ...(memory ? { memory } : {}),
      ...(storage ? { storage } : {}),
      ...(cpu ? { cpu } : {}),
    });
    if (created) setName('');
  }

  return (
    <>
      {classes.length === 0 ? (
        <Content component="p">No service classes are available on this host group.</Content>
      ) : null}
      <Form onSubmit={(event) => void submit(event)}>
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
            onChange={(_event, value) => setChosenClass(String(value))}
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
    </>
  );
});
