/**
 * What a lazy mode draws while its chunk loads (ENG-905): the Workspace bar, then the mode's
 * frames at their real sizes and surfaces, empty, so its content fills in without a shift.
 * Layout only: it lives in the main chunk, so it imports nothing of a mode's own.
 */
import { Horizon, Panel } from "@polaris/ui";
import type { ReactNode } from "react";
import { TopBar } from "./TopBar.tsx";

/** The Workspace bar over the mode's `main`, which says it is still loading. */
export const ModeShell = ({ mode, children }: { mode: string; children?: ReactNode }) => (
  <>
    <TopBar />
    <main className="flex min-h-0 flex-1 flex-col" aria-busy="true" data-mode-shell={mode}>
      {children}
    </main>
  </>
);

/** A mode's sidebar (270px, on the ground over the horizon) beside its panels. */
export const SidebarFrame = ({
  label,
  moon = false,
  children,
}: {
  label: string;
  moon?: boolean;
  children: ReactNode;
}) => (
  <div className="flex min-h-0 flex-1 gap-1.5 pr-1.5 pb-1.5">
    <div className="relative isolate flex min-h-0 shrink-0 flex-col">
      <aside aria-label={label} className="flex min-h-0 w-[270px] flex-1 flex-col" />
      <Horizon moon={moon} />
    </div>
    {children}
  </div>
);

/** Data's, Traces' and Requests' one panel: an empty body over the status bar. */
export const WorkbenchPanel = ({ label, status }: { label: string; status: string }) => (
  <section
    aria-label={label}
    className="border-hairline bg-panel shadow-panel flex min-w-0 flex-1 flex-col overflow-hidden rounded-[12px] border"
  >
    <div className="flex-1" />
    <div className={`border-hairline shrink-0 border-t ${status}`} />
  </section>
);

/** Edit's editor card with the status row at its foot, as the terminal dock lays it out. */
export const EditorPanel = () => (
  <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-1.5">
    <Panel asChild className="min-w-0 flex-1">
      <section aria-label="Editor">
        <div className="flex-1" />
        <div className="border-hairline h-7 shrink-0 border-t" />
      </section>
    </Panel>
  </div>
);
