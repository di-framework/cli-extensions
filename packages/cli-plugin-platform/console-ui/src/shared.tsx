import { Label } from '@patternfly/react-core';
import type { JSX } from 'react';

export { messageOf } from './api';

export function ReadyLabel({
  ready,
  failed,
  compact,
}: {
  ready: boolean;
  failed?: boolean;
  compact?: boolean;
}): JSX.Element {
  if (failed) {
    return (
      <Label status="danger" isCompact={compact}>
        Failed
      </Label>
    );
  }
  return (
    <Label status={ready ? 'success' : 'warning'} isCompact={compact}>
      {ready ? 'Ready' : 'Not ready'}
    </Label>
  );
}

export function countPhrase(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function formatTime(at: Date): string {
  return at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
