import { Alert } from '@patternfly/react-core';
import { observer } from 'mobx-react-lite';
import type { JSX } from 'react';
import { useStore } from './StoreContext';

export const ErrorAlert = observer(function ErrorAlert(): JSX.Element | null {
  const { ui } = useStore();
  return ui.error ? (
    <Alert variant="warning" title={ui.error} isInline className="pf-v6-u-mb-md" />
  ) : null;
});
