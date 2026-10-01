import { Button, EmptyState, EmptyStateBody } from '@patternfly/react-core';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import { observer } from 'mobx-react-lite';
import type { JSX } from 'react';
import { useStore } from './StoreContext';
import { ReadyLabel } from './shared';

export const BackingServiceList = observer(function BackingServiceList(): JSX.Element {
  const store = useStore();
  if (store.services.length === 0) {
    return (
      <EmptyState variant="sm" titleText="No backing services" headingLevel="h3">
        <EmptyStateBody>
          Create a backing service to bind databases and queues to applications.
        </EmptyStateBody>
      </EmptyState>
    );
  }
  return (
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
        {store.services.map((service) => (
          <Tr key={service.name}>
            <Td dataLabel="Name">{service.name}</Td>
            <Td dataLabel="Class">{service.className}</Td>
            <Td dataLabel="Status">
              <ReadyLabel ready={service.ready} compact />
              {service.detail ? <div className="console-metric">{service.detail}</div> : null}
            </Td>
            <Td dataLabel="Actions" isActionCell>
              <Button
                variant="secondary"
                isDanger
                size="sm"
                isDisabled={!store.writable}
                onClick={() => void store.deleteService(service.name)}
              >
                Delete
              </Button>
            </Td>
          </Tr>
        ))}
      </Tbody>
    </Table>
  );
});
