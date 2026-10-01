import { EmptyState, EmptyStateBody, Switch } from '@patternfly/react-core';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import { observer } from 'mobx-react-lite';
import type { JSX } from 'react';
import { useApplication, useStore } from '../StoreContext';

export const RoutesTab = observer(function RoutesTab(): JSX.Element {
  const store = useStore();
  const app = useApplication();
  if (app.routes.length === 0) {
    return (
      <EmptyState variant="sm" titleText="No HTTP routes" headingLevel="h3">
        <EmptyStateBody>This application has no HTTP routes.</EmptyStateBody>
      </EmptyState>
    );
  }
  return (
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
                isDisabled={!store.writable}
                onChange={(_event, enabled) =>
                  void store.setRoute(route.id, `${route.host}${route.path}`, enabled)
                }
              />
            </Td>
          </Tr>
        ))}
      </Tbody>
    </Table>
  );
});
