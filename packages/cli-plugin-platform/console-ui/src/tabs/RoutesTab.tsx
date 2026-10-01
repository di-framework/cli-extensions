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
      <EmptyState
        variant="xs"
        titleText="No HTTP routes"
        headingLevel="h2"
        className="console-empty"
      >
        <EmptyStateBody>This application has no HTTP routes.</EmptyStateBody>
      </EmptyState>
    );
  }
  return (
    <Table aria-label="Routes" variant="compact" className="console-table">
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
                id={`route-${route.id}`}
                aria-label={`Route ${route.host}${route.path} enabled`}
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
