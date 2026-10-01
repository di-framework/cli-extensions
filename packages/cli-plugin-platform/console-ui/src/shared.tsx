import { Label } from '@patternfly/react-core';
import type { JSX } from 'react';
import { ApiError } from './api';

export function messageOf(error: unknown): string {
  return error instanceof ApiError ? error.message : 'The console request failed.';
}

export function ReadyLabel({ ready, compact }: { ready: boolean; compact?: boolean }): JSX.Element {
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
