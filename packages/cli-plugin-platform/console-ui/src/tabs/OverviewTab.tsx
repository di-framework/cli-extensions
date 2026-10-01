import {
  Content,
  DescriptionList,
  DescriptionListDescription,
  DescriptionListGroup,
  DescriptionListTerm,
  Grid,
  GridItem,
  Label,
  Title,
} from '@patternfly/react-core';
import { observer } from 'mobx-react-lite';
import type { JSX } from 'react';
import { useApplication } from '../StoreContext';
import { countPhrase } from '../shared';

export const OverviewTab = observer(function OverviewTab(): JSX.Element {
  const app = useApplication();
  return (
    <Grid hasGutter>
      <GridItem span={12} lg={6}>
        <Title headingLevel="h3" size="md" className="pf-v6-u-mb-sm">
          Parts
        </Title>
        {app.parts.length === 0 ? (
          <Content component="p">This application has no parts yet.</Content>
        ) : (
          <DescriptionList isHorizontal isCompact>
            {app.parts.map((part) => (
              <DescriptionListGroup key={`${part.kind}-${part.name}`}>
                <DescriptionListTerm>
                  <Label color={part.kind === 'service' ? 'blue' : 'green'} isCompact>
                    {part.kind === 'service' ? 'Service' : 'Component'}
                  </Label>{' '}
                  {part.name}
                </DescriptionListTerm>
                <DescriptionListDescription>
                  {part.lifetime === 'long-lived' ? 'Long-lived' : 'On-demand'}
                </DescriptionListDescription>
              </DescriptionListGroup>
            ))}
          </DescriptionList>
        )}
        <Content component="small">
          A service is long-lived for the life of the application. A component runs on demand, once
          per request.
        </Content>
      </GridItem>
      <GridItem span={12} lg={6}>
        <Title headingLevel="h3" size="md" className="pf-v6-u-mb-sm">
          Summary
        </Title>
        <DescriptionList isHorizontal isCompact>
          <DescriptionListGroup>
            <DescriptionListTerm>Routes</DescriptionListTerm>
            <DescriptionListDescription>
              {app.routes.filter((route) => route.enabled).length} of {app.routes.length} enabled
            </DescriptionListDescription>
          </DescriptionListGroup>
          <DescriptionListGroup>
            <DescriptionListTerm>Environment</DescriptionListTerm>
            <DescriptionListDescription>
              {countPhrase(app.environment.length, 'variable')}
            </DescriptionListDescription>
          </DescriptionListGroup>
          <DescriptionListGroup>
            <DescriptionListTerm>Secrets</DescriptionListTerm>
            <DescriptionListDescription>{app.secrets.length}</DescriptionListDescription>
          </DescriptionListGroup>
          <DescriptionListGroup>
            <DescriptionListTerm>Backing services</DescriptionListTerm>
            <DescriptionListDescription>
              {countPhrase(app.backingServices.length, 'binding')}
            </DescriptionListDescription>
          </DescriptionListGroup>
          {app.signals ? (
            <DescriptionListGroup>
              <DescriptionListTerm>Requests</DescriptionListTerm>
              <DescriptionListDescription>
                {app.signals.success} successful · {app.signals.error} errors
              </DescriptionListDescription>
            </DescriptionListGroup>
          ) : null}
        </DescriptionList>
      </GridItem>
    </Grid>
  );
});
