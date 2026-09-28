/** @jsxImportSource react */
import {
  createContext,
  use,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import type { HarnessServerStore } from "./harness-server-store";

const HarnessServerContext = createContext<HarnessServerStore | null>(null);

export function HarnessServerProvider(props: {
  store: HarnessServerStore;
  children: ReactNode;
}) {
  return (
    <HarnessServerContext.Provider value={props.store}>
      {props.children}
    </HarnessServerContext.Provider>
  );
}

export function useHarnessServer() {
  const store = use(HarnessServerContext);
  if (!store) {
    throw new Error("useHarnessServer must be used within a HarnessServerProvider");
  }

  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  return store;
}
