import { Card, CardBody, CardTitle, Grid, GridItem } from '@patternfly/react-core';
import type { JSX } from 'react';
import { BackingServiceCreateForm } from './BackingServiceCreateForm';
import { BackingServiceList } from './BackingServiceList';

export function BackingServicesPage(): JSX.Element {
  return (
    <Grid hasGutter>
      <GridItem span={12} xl={8}>
        <Card>
          <CardTitle>Provisioned services</CardTitle>
          <CardBody>
            <BackingServiceList />
          </CardBody>
        </Card>
      </GridItem>
      <GridItem span={12} xl={4}>
        <Card>
          <CardTitle>Create a backing service</CardTitle>
          <CardBody>
            <BackingServiceCreateForm />
          </CardBody>
        </Card>
      </GridItem>
    </Grid>
  );
}
