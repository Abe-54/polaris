/**
 * The needs you inbox at the app root: one model over every followed Host, and the sheet (Paper
 * MX-H) any screen opens from its header badge through `useInbox`.
 */
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { useNavigation } from "../app/navigation.tsx";
import { useHomeHosts } from "../home/feed/useHomeHosts.ts";
import { InboxSheet } from "./InboxSheet.tsx";
import { inboxOf } from "./model.ts";

export interface InboxControls {
  readonly open: () => void;
  readonly close: () => void;
  /** Needs you requests across every Host, the badge's number. */
  readonly count: number;
}

const InboxContext = createContext<InboxControls | null>(null);

/** Under the NavigationProvider: opening an agent session from the sheet closes it. */
export const InboxProvider = ({ children }: { readonly children: ReactNode }) => {
  const shown = useHomeHosts();
  const inbox = useMemo(() => inboxOf(shown), [shown]);
  const [isOpen, setOpen] = useState(false);
  const top = useNavigation().top;

  useEffect(() => {
    setOpen(false);
  }, [top]);

  const controls = useMemo<InboxControls>(
    () => ({ open: () => setOpen(true), close: () => setOpen(false), count: inbox.count }),
    [inbox.count]
  );

  return (
    <InboxContext.Provider value={controls}>
      {children}
      <InboxSheet open={isOpen} inbox={inbox} onClose={controls.close} />
    </InboxContext.Provider>
  );
};

export const useInbox = (): InboxControls => {
  const inbox = useContext(InboxContext);

  if (inbox === null) throw new Error("useInbox needs an InboxProvider above it");

  return inbox;
};
