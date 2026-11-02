/**
 * An error boundary per pane (ENG-757): a render or commit error shows a small error state in
 * that pane, recorded in main's crash log, while the rest of the shell keeps working.
 */
import { Button, CopyButton, CopyProvider, EmptyState, PixelAlertIcon } from "@polaris/ui";
import { Component, type ErrorInfo, Fragment, type ReactNode } from "react";
import type { RendererCrash } from "../../../shared/crash.ts";
import { writeClipboard } from "../clipboard.ts";
import { type CrashReporter, crashDetails, crashReport, reportCrash } from "./report.ts";

/** Each pane's title when it fails; "agent session" stays the glossary's word. */
export const PANE_TITLES = {
  shell: "Polaris hit an error",
  review: "Review hit an error",
  session: "Couldn't show this agent session",
  edit: "The editor hit an error",
  data: "Data hit an error",
  traces: "Traces hit an error",
  settings: "Settings hit an error",
} as const;

export type PaneName = keyof typeof PANE_TITLES;

export interface PaneBoundaryProps {
  readonly pane: PaneName;
  readonly children: ReactNode;
  /** A change (another session, another pull request) clears the error and remounts. */
  readonly resetOn?: unknown;
  readonly report?: CrashReporter;
}

interface PaneBoundaryState {
  readonly crash: RendererCrash | null;
  /** Bumped by Reload, so the pane mounts fresh. */
  readonly attempt: number;
}

export class PaneBoundary extends Component<PaneBoundaryProps, PaneBoundaryState> {
  override state: PaneBoundaryState = { crash: null, attempt: 0 };

  static getDerivedStateFromError(cause: unknown): Partial<PaneBoundaryState> {
    return { crash: crashReport("boundary", cause) };
  }

  override componentDidCatch(cause: unknown, info: ErrorInfo) {
    const { pane, report = reportCrash } = this.props;

    const crash = crashReport("boundary", cause, {
      pane,
      componentStack: info.componentStack ?? "",
    });

    this.setState({ crash });
    report(crash);
  }

  override componentDidUpdate(previous: PaneBoundaryProps) {
    if (this.state.crash !== null && previous.resetOn !== this.props.resetOn) this.reload();
  }

  reload = () => this.setState((s) => ({ crash: null, attempt: s.attempt + 1 }));

  override render() {
    const { crash, attempt } = this.state;

    if (crash === null) return <Fragment key={attempt}>{this.props.children}</Fragment>;

    const crashed = (
      <PaneCrashed title={PANE_TITLES[this.props.pane]} crash={crash} onReload={this.reload} />
    );

    // The shell's boundary sits outside App's CopyProvider; every pane's sits inside it.
    return this.props.pane === "shell" ? (
      <CopyProvider write={writeClipboard}>{crashed}</CopyProvider>
    ) : (
      crashed
    );
  }
}

interface PaneCrashedProps {
  readonly title: string;
  readonly crash: RendererCrash;
  readonly onReload: () => void;
}

/** DESIGN.md's pane-tier empty state: what failed, the error's message, Reload and Copy details. */
export const PaneCrashed = ({ title, crash, onReload }: PaneCrashedProps) => (
  <div
    role="alert"
    data-testid="pane-crashed"
    className="bg-ground flex h-full min-h-0 min-w-0 flex-1 items-center justify-center overflow-auto"
  >
    <EmptyState
      className="max-w-[480px]"
      icon={<PixelAlertIcon size={24} className="text-text-strong" />}
      title={title}
      fact={<span className="line-clamp-3 break-words">{crash.message}</span>}
      action={
        <div className="flex items-center gap-2">
          <Button onClick={onReload}>Reload</Button>
          <CopyButton
            variant="button"
            buttonVariant="ghost"
            label="Copy details"
            text={() => crashDetails(title, crash)}
          />
        </div>
      }
    />
  </div>
);
