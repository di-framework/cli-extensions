import { type JSX, useEffect, useState } from 'react';
import { Shell } from './Shell';
import { StoreContext } from './StoreContext';
import { ConsoleStore } from './store';

export function App(): JSX.Element {
  const [store] = useState(() => ConsoleStore.create());

  useEffect(() => {
    void store.start();
  }, [store]);

  return (
    <StoreContext.Provider value={store}>
      <Shell />
    </StoreContext.Provider>
  );
}
