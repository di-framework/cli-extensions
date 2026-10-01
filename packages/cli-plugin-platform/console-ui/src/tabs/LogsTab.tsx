import { CodeBlock, CodeBlockCode, EmptyState, EmptyStateBody } from '@patternfly/react-core';
import { observer } from 'mobx-react-lite';
import type { JSX } from 'react';
import { useApplication } from '../StoreContext';

/** Refresh lives on the application header, beside the selected tab. */
export const LogsTab = observer(function LogsTab(): JSX.Element {
  const { logs } = useApplication();
  if (!logs.published) {
    return (
      <EmptyState
        variant="xs"
        titleText="Logs are not published"
        headingLevel="h2"
        className="console-empty"
      >
        <EmptyStateBody>Logs are not published for this app yet.</EmptyStateBody>
      </EmptyState>
    );
  }
  if (logs.lines.length === 0) return <p className="console-note">No log lines yet.</p>;
  return (
    <CodeBlock className="console-logs">
      <CodeBlockCode>{logs.lines.join('\n')}</CodeBlockCode>
    </CodeBlock>
  );
});
