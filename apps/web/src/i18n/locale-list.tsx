'use client';

import { createContext, useContext, type ReactNode } from 'react';

const LocaleListContext = createContext<readonly string[]>([]);

/**
 * Carries the build-time locale list to client components. It comes down from
 * the server because deriving it in the browser would mean bundling every
 * message file into the client — next-intl ships only the active one today.
 */
export function LocaleListProvider({
  locales,
  children,
}: {
  locales: readonly string[];
  children: ReactNode;
}) {
  return (
    <LocaleListContext.Provider value={locales}>
      {children}
    </LocaleListContext.Provider>
  );
}

export function useLocaleList(): readonly string[] {
  return useContext(LocaleListContext);
}
