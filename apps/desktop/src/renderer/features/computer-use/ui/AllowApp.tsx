/**
 * "Allow an app…" beside the always-allowed list (Paper CU1b): this Mac picks an app in the
 * native picker, another Host takes its id (until ENG-883 lists a Host's apps); a refused app
 * shows the warning first. The only way a refused app is ever allowed.
 */
import { cn, Input, SettingsButton } from "@polaris/ui";
import { Match } from "effect";
import { useState } from "react";
import {
  appIdProblem,
  type Candidate,
  confirmLabel,
  idHint,
  refusedWarning,
  typedCandidate,
} from "../allowApp.ts";
import type { ComputerUseActions } from "../hooks.ts";
import type { HostFacts } from "../model.ts";
import { AppIcon } from "./parts.tsx";

type Step =
  | { readonly kind: "idle" }
  | { readonly kind: "typing"; readonly draft: string; readonly tried: boolean }
  | { readonly kind: "confirm"; readonly app: Candidate };

const Warning = ({ title, line }: { readonly title: string; readonly line: string }) => (
  <div className="flex items-start gap-2.5 pl-9" role="alert">
    <svg aria-hidden width="14" height="14" viewBox="0 0 14 14" className="mt-0.5 shrink-0">
      <path
        d="M7 1 L13 12.5 L1 12.5 Z"
        fill="none"
        strokeWidth="1.5"
        strokeLinejoin="round"
        className="stroke-severity-high"
      />
      <rect x="6.25" y="5" width="1.5" height="4" className="fill-severity-high" />
      <rect x="6.25" y="10" width="1.5" height="1.5" className="fill-severity-high" />
    </svg>
    <div className="flex flex-col gap-0.5">
      <p className="text-body text-severity-high-text font-medium">{title}</p>
      <p className="text-caption text-text-subtle">{line}</p>
    </div>
  </div>
);

const Confirm = ({
  app,
  host,
  busy,
  onCancel,
  onConfirm,
}: {
  readonly app: Candidate;
  readonly host: HostFacts;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) => {
  const warning = refusedWarning(app, host.name);

  return (
    <div
      data-testid="computer-use-allow-app"
      data-refused={warning !== null}
      className={cn(
        "bg-well flex flex-col gap-3 rounded-[12px] border px-4 py-3.5",
        warning === null ? "border-hairline" : "border-severity-high/40"
      )}
    >
      <div className="flex items-center gap-3">
        <AppIcon app={{ ...app, icon: null }} />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-body text-text-default truncate">{app.name}</span>
          <span className="text-code-inline text-text-subtle truncate font-mono">{app.id}</span>
        </div>
      </div>
      {warning === null ? null : <Warning {...warning} />}
      <div className="flex items-center justify-end gap-2">
        <SettingsButton variant="quiet" onClick={onCancel}>
          Cancel
        </SettingsButton>
        <SettingsButton variant="primary" disabled={busy} onClick={onConfirm}>
          {confirmLabel(app, warning !== null)}
        </SettingsButton>
      </div>
    </div>
  );
};

const Typing = ({
  host,
  draft,
  tried,
  onDraft,
  onNext,
  onCancel,
}: {
  readonly host: HostFacts;
  readonly draft: string;
  readonly tried: boolean;
  readonly onDraft: (draft: string) => void;
  readonly onNext: () => void;
  readonly onCancel: () => void;
}) => {
  const problem = appIdProblem(host.platform, draft);

  return (
    <div className="bg-well border-hairline flex flex-col gap-2 rounded-[12px] border px-4 py-3.5">
      <div className="flex items-center gap-2">
        <Input
          autoFocus
          aria-label="App id"
          className="text-code-inline min-w-0 flex-1 font-mono"
          value={draft}
          onChange={(event) => onDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") onNext();

            if (event.key === "Escape") onCancel();
          }}
        />
        <SettingsButton variant="quiet" onClick={onCancel}>
          Cancel
        </SettingsButton>
        <SettingsButton onClick={onNext}>Next</SettingsButton>
      </div>
      <p className="text-caption text-text-subtle">
        {tried && problem !== null ? problem : idHint(host.platform)}
      </p>
    </div>
  );
};

/** The header's button and, once an app is chosen, its confirm panel under the list. */
export const useAllowApp = (host: HostFacts, actions: ComputerUseActions) => {
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const idle = () => setStep({ kind: "idle" });

  const start = () => {
    if (!host.local) return setStep({ kind: "typing", draft: "", tried: false });
    void actions.pickApp().then((app) => {
      if (app !== null) setStep({ kind: "confirm", app });
    });
  };

  const next = (draft: string) =>
    setStep(
      appIdProblem(host.platform, draft) === null
        ? { kind: "confirm", app: typedCandidate(draft) }
        : { kind: "typing", draft, tried: true }
    );

  const button = (
    <SettingsButton disabled={step.kind !== "idle" || actions.busy} onClick={start}>
      Allow an app…
    </SettingsButton>
  );

  const panel = Match.value(step).pipe(
    Match.discriminatorsExhaustive("kind")({
      idle: () => null,
      typing: (typing) => (
        <Typing
          host={host}
          draft={typing.draft}
          tried={typing.tried}
          onDraft={(draft) => setStep({ ...typing, draft })}
          onNext={() => next(typing.draft)}
          onCancel={idle}
        />
      ),
      confirm: ({ app }) => (
        <Confirm
          app={app}
          host={host}
          busy={actions.busy}
          onCancel={idle}
          onConfirm={() =>
            void actions.add(app.id).then((added) => {
              if (added) idle();
            })
          }
        />
      ),
    })
  );

  return { button, panel };
};
