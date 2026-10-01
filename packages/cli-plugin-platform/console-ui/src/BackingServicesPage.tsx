import { type JSX, useEffect } from 'react';
import { BackingServiceCreateForm } from './BackingServiceCreateForm';
import { BackingServiceList } from './BackingServiceList';
import { useStore } from './StoreContext';

/**
 * The provisioned services, with the create form grouped in a panel beside them. While the page is
 * open the list re-reads itself until every service is ready.
 */
export function BackingServicesPage(): JSX.Element {
  const store = useStore();
  useEffect(() => {
    store.startServicePolling();
    return () => store.stopServicePolling();
  }, [store]);
  return (
    <div className="console-split">
      <section aria-labelledby="services-provisioned">
        <h2 id="services-provisioned" className="console-heading">
          Provisioned services
        </h2>
        <BackingServiceList />
      </section>
      <section aria-labelledby="services-create" className="console-panel">
        <h2 id="services-create" className="console-heading">
          Create a backing service
        </h2>
        <BackingServiceCreateForm />
      </section>
    </div>
  );
}
