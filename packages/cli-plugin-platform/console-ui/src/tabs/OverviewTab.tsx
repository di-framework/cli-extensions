import {
  DescriptionList,
  DescriptionListDescription,
  DescriptionListGroup,
  DescriptionListTerm,
  Label,
} from '@patternfly/react-core';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import { observer } from 'mobx-react-lite';
import type { JSX } from 'react';
import { useApplication } from '../StoreContext';
import { countPhrase } from '../shared';

export const OverviewTab = observer(function OverviewTab(): JSX.Element {
  const app = useApplication();
  // The status column appears only when the host reported a failed start.
  const anyFailed = app.parts.some((part) => part.failure !== undefined);
  return (
    <div className="console-split">
      <section aria-labelledby="overview-parts">
        <h2 id="overview-parts" className="console-heading">
          Parts
        </h2>
        {app.parts.length === 0 ? (
          <p className="console-note">This application has no parts yet.</p>
        ) : (
          <Table aria-label="Parts" variant="compact" className="console-table">
            <Thead>
              <Tr>
                <Th>Name</Th>
                <Th>Kind</Th>
                <Th>Lifetime</Th>
                {anyFailed ? <Th>Status</Th> : null}
              </Tr>
            </Thead>
            <Tbody>
              {app.parts.map((part) => (
                <Tr key={`${part.kind}-${part.name}`}>
                  <Td dataLabel="Name">{part.name}</Td>
                  <Td dataLabel="Kind">
                    <Label color={part.kind === 'service' ? 'blue' : 'green'} isCompact>
                      {part.kind === 'service' ? 'Service' : 'Component'}
                    </Label>
                  </Td>
                  <Td dataLabel="Lifetime">
                    {part.lifetime === 'long-lived' ? 'Long-lived' : 'On-demand'}
                  </Td>
                  {anyFailed ? (
                    <Td dataLabel="Status">
                      {part.failure ? (
                        <>
                          <Label status="danger" isCompact>
                            Failed
                          </Label>
                          <div className="console-metric">{part.failure}</div>
                        </>
                      ) : (
                        '—'
                      )}
                    </Td>
                  ) : null}
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
        <p className="console-note">
          A service is long-lived for the life of the application. A component runs on demand, once
          per request.
        </p>
      </section>
      <section aria-labelledby="overview-summary">
        <h2 id="overview-summary" className="console-heading">
          Summary
        </h2>
        <DescriptionList isHorizontal isCompact horizontalTermWidthModifier={{ default: '10rem' }}>
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
      </section>
    </div>
  );
});
