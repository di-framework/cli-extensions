import {
  DescriptionList,
  DescriptionListDescription,
  DescriptionListGroup,
  DescriptionListTerm,
  Grid,
  GridItem,
} from '@patternfly/react-core';
import { observer } from 'mobx-react-lite';
import type { JSX } from 'react';
import { Sparkline } from '../Sparkline';
import { useApplication } from '../StoreContext';

export const SignalsTab = observer(function SignalsTab(): JSX.Element | null {
  const app = useApplication();
  const { signals } = app;
  if (!signals) return null;
  return (
    <Grid hasGutter>
      <GridItem span={12} md={4}>
        <DescriptionList isCompact>
          <DescriptionListGroup>
            <DescriptionListTerm>Successful requests</DescriptionListTerm>
            <DescriptionListDescription>{signals.success}</DescriptionListDescription>
          </DescriptionListGroup>
          <DescriptionListGroup>
            <DescriptionListTerm>Errors</DescriptionListTerm>
            <DescriptionListDescription>{signals.error}</DescriptionListDescription>
          </DescriptionListGroup>
        </DescriptionList>
      </GridItem>
      <GridItem span={12} md={8}>
        <h2 className="console-heading">Compute</h2>
        {signals.compute && signals.compute.length > 0 ? (
          <Sparkline values={[...signals.compute]} label={`${app.name} compute`} />
        ) : (
          <p className="console-note">No compute samples yet.</p>
        )}
      </GridItem>
    </Grid>
  );
});
