import { Button, EmptyState, EmptyStateBody } from '@patternfly/react-core';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import { observer } from 'mobx-react-lite';
import type { JSX } from 'react';
import { useStore } from './StoreContext';
import { countPhrase, ReadyLabel } from './shared';

export const ApplicationList = observer(function ApplicationList(): JSX.Element {
  const store = useStore();
  if (store.applications.length === 0) {
    return (
      <EmptyState
        titleText="No applications"
        headingLevel="h2"
        variant="xs"
        className="console-empty"
      >
        <EmptyStateBody>No applications are deployed for this tenant yet.</EmptyStateBody>
      </EmptyState>
    );
  }
  return (
    <Table aria-label="Applications" variant="compact" className="console-table">
      <Thead>
        <Tr>
          <Th>Application</Th>
          <Th>Status</Th>
          <Th>Parts</Th>
          <Th>Routes</Th>
        </Tr>
      </Thead>
      <Tbody>
        {store.applications.map((app) => (
          <Tr key={app.name}>
            <Td dataLabel="Application">
              <Button variant="link" isInline onClick={() => void store.openApplication(app.name)}>
                {app.name}
              </Button>
            </Td>
            <Td dataLabel="Status">
              <ReadyLabel ready={app.ready} failed={app.failed} compact />
              {app.detail ? <div className="console-metric">{app.detail}</div> : null}
            </Td>
            <Td dataLabel="Parts">
              {countPhrase(app.services, 'service')} · {countPhrase(app.components, 'component')}
            </Td>
            <Td dataLabel="Routes">{app.routeCount}</Td>
          </Tr>
        ))}
      </Tbody>
    </Table>
  );
});
