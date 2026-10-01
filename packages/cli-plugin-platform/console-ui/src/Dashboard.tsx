import {
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  CardTitle,
  Content,
  DescriptionList,
  DescriptionListDescription,
  DescriptionListGroup,
  DescriptionListTerm,
  Divider,
  EmptyState,
  EmptyStateBody,
  Flex,
  FlexItem,
  Grid,
  GridItem,
  Icon,
  Label,
  List,
  ListItem,
  Skeleton,
  Stack,
  StackItem,
} from '@patternfly/react-core';
import {
  CheckCircleIcon,
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
  InfoCircleIcon,
} from '@patternfly/react-icons';
import { observer } from 'mobx-react-lite';
import type { JSX } from 'react';
import { Sparkline } from './Sparkline';
import { useStore } from './StoreContext';
import { countPhrase, formatTime } from './shared';
import type {
  ActivityNode,
  ApplicationSignalsNode,
  ApplicationSummaryNode,
  BackingServiceNode,
  SessionNode,
} from './store';
import type { ActivityStatus, Section } from './types';

type DashboardProps = {
  session: SessionNode;
  apps: readonly ApplicationSummaryNode[];
  services: readonly BackingServiceNode[];
  signals: readonly ApplicationSignalsNode[] | undefined;
  activity: readonly ActivityNode[];
  onNavigate: (section: Section) => void;
  onOpenApplication: (name: string) => void;
  onClearActivity: () => void;
};

export const Dashboard = observer(function Dashboard(): JSX.Element | null {
  const store = useStore();
  if (store.session === undefined) return null;
  const props: DashboardProps = {
    session: store.session,
    apps: store.applications,
    services: store.services,
    signals: store.signals,
    activity: store.activity,
    onNavigate: (section) => store.navigate(section),
    onOpenApplication: (name) => void store.openApplication(name),
    onClearActivity: () => store.clearActivity(),
  };
  return (
    <Grid hasGutter>
      <GridItem span={12} lg={3}>
        <Stack hasGutter>
          <StackItem>
            <DetailsCard {...props} />
          </StackItem>
          <StackItem>
            <InventoryCard {...props} />
          </StackItem>
        </Stack>
      </GridItem>
      <GridItem span={12} lg={6}>
        <Stack hasGutter>
          <StackItem>
            <StatusCard {...props} />
          </StackItem>
          <StackItem>
            <SignalsCard {...props} />
          </StackItem>
        </Stack>
      </GridItem>
      <GridItem span={12} lg={3}>
        <ActivityCard {...props} />
      </GridItem>
    </Grid>
  );
});

function DetailsCard({ session, apps, services, onNavigate }: DashboardProps): JSX.Element {
  return (
    <Card isFullHeight>
      <CardTitle>Details</CardTitle>
      <CardBody>
        <DescriptionList isCompact>
          <DescriptionListGroup>
            <DescriptionListTerm>Tenant</DescriptionListTerm>
            <DescriptionListDescription>{session.tenant}</DescriptionListDescription>
          </DescriptionListGroup>
          {session.hostgroup ? (
            <DescriptionListGroup>
              <DescriptionListTerm>Host group</DescriptionListTerm>
              <DescriptionListDescription>{session.hostgroup}</DescriptionListDescription>
            </DescriptionListGroup>
          ) : null}
          <DescriptionListGroup>
            <DescriptionListTerm>Access</DescriptionListTerm>
            <DescriptionListDescription>
              {session.writable ? 'Read and write' : 'View only'}
            </DescriptionListDescription>
          </DescriptionListGroup>
          <DescriptionListGroup>
            <DescriptionListTerm>Applications</DescriptionListTerm>
            <DescriptionListDescription>{apps.length}</DescriptionListDescription>
          </DescriptionListGroup>
          <DescriptionListGroup>
            <DescriptionListTerm>Backing services</DescriptionListTerm>
            <DescriptionListDescription>{services.length}</DescriptionListDescription>
          </DescriptionListGroup>
        </DescriptionList>
      </CardBody>
      <CardFooter>
        <Button variant="link" isInline onClick={() => onNavigate('applications')}>
          View applications
        </Button>
      </CardFooter>
    </Card>
  );
}

function InventoryCard({ apps, services, onNavigate }: DashboardProps): JSX.Element {
  const notReadyApps = apps.filter((app) => !app.ready).length;
  const notReadyServices = services.filter((service) => !service.ready).length;
  const serviceParts = apps.reduce((sum, app) => sum + app.services, 0);
  const componentParts = apps.reduce((sum, app) => sum + app.components, 0);
  const routes = apps.reduce((sum, app) => sum + app.routeCount, 0);
  return (
    <Card>
      <CardTitle>Tenant inventory</CardTitle>
      <CardBody>
        <List isPlain>
          <InventoryRow
            text={countPhrase(apps.length, 'Application')}
            warning={notReadyApps}
            onClick={() => onNavigate('applications')}
          />
          <InventoryRow
            text={countPhrase(serviceParts, 'Service part')}
            onClick={() => onNavigate('applications')}
          />
          <InventoryRow
            text={countPhrase(componentParts, 'Component part')}
            onClick={() => onNavigate('applications')}
          />
          <InventoryRow
            text={countPhrase(routes, 'Route')}
            onClick={() => onNavigate('applications')}
          />
          <InventoryRow
            text={countPhrase(services.length, 'Backing service')}
            warning={notReadyServices}
            onClick={() => onNavigate('backing-services')}
          />
        </List>
      </CardBody>
    </Card>
  );
}

function InventoryRow({
  text,
  warning,
  onClick,
}: {
  text: string;
  warning?: number;
  onClick: () => void;
}): JSX.Element {
  return (
    <ListItem>
      <Flex justifyContent={{ default: 'justifyContentSpaceBetween' }}>
        <FlexItem>
          <Button variant="link" isInline onClick={onClick}>
            {text}
          </Button>
        </FlexItem>
        {warning ? (
          <FlexItem>
            <Label status="warning" isCompact>
              {warning} not ready
            </Label>
          </FlexItem>
        ) : null}
      </Flex>
    </ListItem>
  );
}

function StatusCard({ session, apps, services, onNavigate }: DashboardProps): JSX.Element {
  const notReadyApps = apps.filter((app) => !app.ready).length;
  const notReadyServices = services.filter((service) => !service.ready).length;
  const routes = apps.reduce((sum, app) => sum + app.routeCount, 0);
  return (
    <Card>
      <CardTitle>Status</CardTitle>
      <CardBody>
        <Flex gap={{ default: 'gapLg' }} flexWrap={{ default: 'wrap' }}>
          <StatusItem
            status={statusFor(apps.length, notReadyApps)}
            label="Applications"
            detail={
              apps.length === 0
                ? 'None deployed'
                : notReadyApps === 0
                  ? 'All ready'
                  : `${notReadyApps} not ready`
            }
            onClick={() => onNavigate('applications')}
          />
          <StatusItem
            status={statusFor(services.length, notReadyServices)}
            label="Backing services"
            detail={
              services.length === 0
                ? 'None provisioned'
                : notReadyServices === 0
                  ? 'All ready'
                  : `${notReadyServices} not ready`
            }
            onClick={() => onNavigate('backing-services')}
          />
          <StatusItem
            status={routes === 0 ? 'info' : 'success'}
            label="Routes"
            detail={routes === 0 ? 'No HTTP routes' : countPhrase(routes, 'route')}
            onClick={() => onNavigate('applications')}
          />
          <StatusItem
            status={session.writable ? 'success' : 'info'}
            label="Access"
            detail={session.writable ? 'Read and write' : 'View only'}
          />
        </Flex>
      </CardBody>
      <Divider />
      <CardBody>
        <Flex alignItems={{ default: 'alignItemsCenter' }} gap={{ default: 'gapSm' }}>
          <FlexItem>Attention</FlexItem>
          {notReadyApps === 0 && notReadyServices === 0 ? (
            <Label status="success" isCompact>
              Nothing needs attention
            </Label>
          ) : (
            <>
              {notReadyApps > 0 ? (
                <Label status="warning" isCompact>
                  {countPhrase(notReadyApps, 'application')}
                </Label>
              ) : null}
              {notReadyServices > 0 ? (
                <Label status="warning" isCompact>
                  {countPhrase(notReadyServices, 'backing service')}
                </Label>
              ) : null}
            </>
          )}
        </Flex>
      </CardBody>
    </Card>
  );
}

function statusFor(total: number, notReady: number): ActivityStatus {
  if (total === 0) return 'info';
  return notReady === 0 ? 'success' : 'warning';
}

export function StatusIcon({ status }: { status: ActivityStatus }): JSX.Element {
  switch (status) {
    case 'success':
      return (
        <Icon status="success">
          <CheckCircleIcon />
        </Icon>
      );
    case 'warning':
      return (
        <Icon status="warning">
          <ExclamationTriangleIcon />
        </Icon>
      );
    case 'danger':
      return (
        <Icon status="danger">
          <ExclamationCircleIcon />
        </Icon>
      );
    default:
      return (
        <Icon status="info">
          <InfoCircleIcon />
        </Icon>
      );
  }
}

function StatusItem({
  status,
  label,
  detail,
  onClick,
}: {
  status: ActivityStatus;
  label: string;
  detail: string;
  onClick?: () => void;
}): JSX.Element {
  return (
    <FlexItem className="console-status-item">
      <Flex alignItems={{ default: 'alignItemsCenter' }} gap={{ default: 'gapSm' }}>
        <FlexItem>
          <StatusIcon status={status} />
        </FlexItem>
        <FlexItem>
          {onClick ? (
            <Button variant="link" isInline onClick={onClick}>
              {label}
            </Button>
          ) : (
            label
          )}
        </FlexItem>
      </Flex>
      <div className="console-status-item__detail">{detail}</div>
    </FlexItem>
  );
}

function SignalsCard({ apps, signals, onOpenApplication }: DashboardProps): JSX.Element {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Application signals</CardTitle>
      </CardHeader>
      <CardBody>
        {signals === undefined ? (
          <Stack hasGutter>
            <Skeleton screenreaderText="Loading signals" />
            <Skeleton width="60%" />
          </Stack>
        ) : signals.length === 0 ? (
          <EmptyState variant="xs" titleText="No signals published" headingLevel="h3">
            <EmptyStateBody>
              {apps.length === 0
                ? 'Deploy an application to see request counts and compute here.'
                : 'Applications publish signals once they have served requests.'}
            </EmptyStateBody>
          </EmptyState>
        ) : (
          <Stack hasGutter>
            {signals.map((entry, index) => (
              <StackItem key={entry.application}>
                {index > 0 ? <Divider /> : null}
                <Grid hasGutter>
                  <GridItem span={12} md={5}>
                    <Content component="h4">
                      <Button
                        variant="link"
                        isInline
                        onClick={() => onOpenApplication(entry.application)}
                      >
                        {entry.application}
                      </Button>
                    </Content>
                    <Flex gap={{ default: 'gapMd' }}>
                      <FlexItem>
                        <strong>{entry.success}</strong>
                        <div className="console-metric">successful</div>
                      </FlexItem>
                      <FlexItem>
                        <strong>{entry.error}</strong>
                        <div className="console-metric">errors</div>
                      </FlexItem>
                    </Flex>
                  </GridItem>
                  <GridItem span={12} md={7}>
                    {entry.compute && entry.compute.length > 0 ? (
                      <Sparkline
                        values={[...entry.compute]}
                        label={`${entry.application} compute`}
                      />
                    ) : (
                      <div className="console-metric">No compute samples yet.</div>
                    )}
                  </GridItem>
                </Grid>
              </StackItem>
            ))}
          </Stack>
        )}
      </CardBody>
    </Card>
  );
}

function ActivityCard({ activity, onClearActivity }: DashboardProps): JSX.Element {
  return (
    <Card isFullHeight>
      <CardHeader
        actions={{
          actions: (
            <Button
              variant="link"
              isInline
              onClick={onClearActivity}
              isDisabled={activity.length === 0}
            >
              Clear
            </Button>
          ),
          hasNoOffset: true,
        }}
      >
        <CardTitle>Activity</CardTitle>
      </CardHeader>
      <CardBody className="console-activity">
        {activity.length === 0 ? (
          <EmptyState variant="xs" titleText="No activity yet" headingLevel="h3">
            <EmptyStateBody>
              Console actions and status changes from this session appear here.
            </EmptyStateBody>
          </EmptyState>
        ) : (
          <List isPlain isBordered>
            {activity.map((entry) => (
              <ListItem key={entry.id}>
                <Flex gap={{ default: 'gapSm' }} flexWrap={{ default: 'nowrap' }}>
                  <FlexItem className="console-activity__time">{formatTime(entry.at)}</FlexItem>
                  <FlexItem>
                    <StatusIcon status={entry.status} />
                  </FlexItem>
                  <FlexItem>{entry.text}</FlexItem>
                </Flex>
              </ListItem>
            ))}
          </List>
        )}
      </CardBody>
    </Card>
  );
}
