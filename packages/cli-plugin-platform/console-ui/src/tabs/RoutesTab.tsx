import {
  Button,
  EmptyState,
  EmptyStateBody,
  Flex,
  FlexItem,
  Switch,
  Tooltip,
} from '@patternfly/react-core';
import { CopyIcon, ExternalLinkAltIcon } from '@patternfly/react-icons';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import { observer } from 'mobx-react-lite';
import { type JSX, useState } from 'react';
import { useApplication, useStore } from '../StoreContext';

/** The route's gateway address as a link that opens in a new tab, with a copy button. */
function RouteAddress({ host, url }: { host: string; url: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  return (
    <Flex
      alignItems={{ default: 'alignItemsCenter' }}
      gap={{ default: 'gapXs' }}
      flexWrap={{ default: 'nowrap' }}
    >
      <FlexItem>
        <Button
          component="a"
          variant="link"
          isInline
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          icon={<ExternalLinkAltIcon />}
          iconPosition="end"
        >
          {host}
          <span className="pf-v6-screen-reader"> (opens in a new tab)</span>
        </Button>
      </FlexItem>
      <FlexItem>
        <Tooltip
          content={copied ? 'Copied' : 'Copy address'}
          onTooltipHidden={() => setCopied(false)}
        >
          <Button
            variant="plain"
            size="sm"
            aria-label={`Copy ${url}`}
            icon={<CopyIcon />}
            onClick={() => void copy()}
          />
        </Tooltip>
      </FlexItem>
    </Flex>
  );
}

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
            <Td dataLabel="Host">
              {route.url ? <RouteAddress host={route.host} url={route.url} /> : route.host}
            </Td>
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
