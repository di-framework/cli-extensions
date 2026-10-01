import {
  Button,
  CodeBlock,
  CodeBlockCode,
  Content,
  EmptyState,
  EmptyStateBody,
  Flex,
  FlexItem,
} from '@patternfly/react-core';
import { observer } from 'mobx-react-lite';
import type { JSX } from 'react';
import { useApplication, useStore } from '../StoreContext';

export const LogsTab = observer(function LogsTab(): JSX.Element {
  const store = useStore();
  const { logs } = useApplication();
  return (
    <>
      <Flex className="pf-v6-u-mb-md">
        <FlexItem>
          <Button variant="secondary" onClick={() => void store.refreshLogs()}>
            Refresh
          </Button>
        </FlexItem>
      </Flex>
      {!logs.published ? (
        <EmptyState variant="sm" titleText="Logs are not published" headingLevel="h3">
          <EmptyStateBody>Logs are not published for this app yet.</EmptyStateBody>
        </EmptyState>
      ) : logs.lines.length === 0 ? (
        <Content component="p">No log lines yet.</Content>
      ) : (
        <CodeBlock className="console-logs">
          <CodeBlockCode>{logs.lines.join('\n')}</CodeBlockCode>
        </CodeBlock>
      )}
    </>
  );
});
