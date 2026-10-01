import { PageSection } from '@patternfly/react-core';
import type { JSX, ReactNode } from 'react';

/**
 * The one header every screen uses: optional breadcrumbs, the title with its status, a short
 * description, and an optional bar that holds the tabs with the selected tab's actions.
 */
export function PageHeader({
  crumbs,
  title,
  status,
  description,
  tabs,
  actions,
}: {
  crumbs?: ReactNode;
  title: string;
  status?: ReactNode;
  description?: ReactNode;
  tabs?: ReactNode;
  actions?: ReactNode;
}): JSX.Element {
  const hasBar = tabs !== undefined || actions !== undefined;
  return (
    <PageSection
      hasBodyWrapper={false}
      className={hasBar ? 'console-header' : 'console-header console-header--plain'}
    >
      {crumbs ? <div className="console-header__crumbs">{crumbs}</div> : null}
      <div className="console-header__title">
        <h1>{title}</h1>
        {status}
      </div>
      {description ? <p className="console-header__description">{description}</p> : null}
      {hasBar ? (
        <div className="console-header__bar">
          {tabs ?? <span />}
          {actions ? <div className="console-header__actions">{actions}</div> : null}
        </div>
      ) : null}
    </PageSection>
  );
}
