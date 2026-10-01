import { createContext, useContext } from 'react';
import type { ApplicationNode, ConsoleStoreInstance } from './store';

export const StoreContext = createContext<ConsoleStoreInstance | undefined>(undefined);

export function useStore(): ConsoleStoreInstance {
  const store = useContext(StoreContext);
  if (store === undefined) throw new Error('The console store is not provided.');
  return store;
}

/** The open application. Tab views render only while one is loaded. */
export function useApplication(): ApplicationNode {
  const { application } = useStore();
  if (application === undefined) throw new Error('No application is open.');
  return application;
}
