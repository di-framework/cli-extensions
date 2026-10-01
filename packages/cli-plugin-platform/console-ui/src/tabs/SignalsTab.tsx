import {
  Content,
  DescriptionList,
  DescriptionListDescription,
  DescriptionListGroup,
  DescriptionListTerm,
  Grid,
  GridItem,
  Title,
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
        <Title headingLevel="h3" size="md" className="pf-v6-u-mb-sm">
          Compute
        </Title>
        {signals.compute && signals.compute.length > 0 ? (
          <Sparkline values={[...signals.compute]} label={`${app.name} compute`} />
        ) : (
          <Content component="p">No compute samples yet.</Content>
        )}
      </GridItem>
    </Grid>
  );
});
