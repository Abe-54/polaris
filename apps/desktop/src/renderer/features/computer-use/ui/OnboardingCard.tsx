/**
 * The first-run card (Paper CU3), only for this Mac's own Host, in the Orchestrator's empty
 * panel: "Let agents use apps on this Mac", the one setup step, "Skip for now", then ready
 * and Done. Skipped or done is kept on this Mac; remote Hosts are set up from their page.
 */
import { Predicate } from "effect";
import { SettingsButton, SettingsWell } from "@polaris/ui";
import { type ReactNode, useEffect, useState } from "react";
import { useComputerUseActions, useComputerUseFeed } from "../hooks.ts";
import { allowStep, cardView, type HostFacts, servicesOf } from "../model.ts";
import { AllowStepView, ServiceMark, WindowGlyph } from "./parts.tsx";

const KEY = "polaris.computerUse.onboarding";

const settled = () => {
  try {
    return localStorage.getItem(KEY) !== null;
  } catch {
    return false;
  }
};

const settle = (how: "skipped" | "done") => {
  try {
    localStorage.setItem(KEY, how);
  } catch {
    // Storage can be unavailable; the card stays closed for this run.
  }
};

/** Off has no permissions to read yet: the step turns it on first, then opens setup. */
const OFF_STEP = {
  ...allowStep(
    { name: "", platform: "macos", local: true },
    { accessibility: false, screenRecording: false }
  ),
  services: [],
};

const Frame = ({ children }: { readonly children: ReactNode }) => (
  <section
    data-testid="computer-use-onboarding"
    data-surface="raised"
    className="bg-raised shadow-float flex w-[520px] max-w-full flex-col gap-3 rounded-[16px] p-2 pt-5"
  >
    {children}
  </section>
);

const Heading = ({ title, line }: { readonly title: string; readonly line: string }) => (
  <div className="flex flex-col gap-2 px-3">
    <WindowGlyph size={56} />
    <h2 className="text-title text-text-strong pt-1">{title}</h2>
    <p className="text-body text-text-subtle">{line}</p>
  </div>
);

const Ready = ({ host, onDone }: { readonly host: HostFacts; readonly onDone: () => void }) => (
  <Frame>
    <Heading
      title={`Computer use is ready on ${host.name}`}
      line="The first time an agent wants an app, you'll get an approval card for it."
    />
    <SettingsWell>
      {servicesOf({ accessibility: true, screenRecording: true }).map((service) => (
        <div key={service.name} className="flex items-center gap-3 px-4 py-2.5">
          <ServiceMark on />
          <span className="text-body text-text-default flex-1">{service.name}</span>
          <span className="text-caption text-text-subtle">On</span>
        </div>
      ))}
    </SettingsWell>
    <div className="flex justify-end px-2 pb-1">
      <SettingsButton variant="primary" onClick={onDone} data-testid="computer-use-done">
        Done
      </SettingsButton>
    </div>
  </Frame>
);

export interface OnboardingCardProps {
  readonly hostKey: string;
  readonly host: HostFacts;
}

const Live = ({
  hostKey,
  host,
  onClose,
}: OnboardingCardProps & { readonly onClose: (how: "skipped" | "done") => void }) => {
  const feed = useComputerUseFeed(hostKey);
  const actions = useComputerUseActions(hostKey);
  const [started, setStarted] = useState(false);
  const state = feed.status?.state;
  const pending = Predicate.isTagged(state, "Off") || Predicate.isTagged(state, "NeedsSetup");

  // A Mac that's already ready never sees the card; one set up here gets the ready view.
  useEffect(() => {
    if (pending) setStarted(true);
  }, [pending]);

  if (state === undefined || Predicate.isTagged(state, "NoDesktop")) return null;

  if (Predicate.isTagged(state, "Ready"))
    return started ? <Ready host={host} onDone={() => onClose("done")} /> : null;

  const view = cardView(host, state, actions.opened);
  const step = view.kind === "mac-setup" ? view.step : OFF_STEP;

  return (
    <Frame>
      <Heading
        title="Let agents use apps on this Mac"
        line={`With computer use, an agent can open an app on ${host.name}, see it and click through it. It asks before each new app, and you watch it live in the transcript.`}
      />
      <SettingsWell>
        <AllowStepView
          step={step}
          busy={actions.busy}
          onOpen={() => actions.openSetup(step.permission)}
        />
      </SettingsWell>
      <div className="flex items-center justify-between gap-3 px-2 pb-1">
        <span className="text-caption text-text-subtle">
          {view.kind === "mac-setup" ? view.well.line : `Later: Settings › Hosts › ${host.name}`}
        </span>
        <SettingsButton variant="quiet" onClick={() => onClose("skipped")}>
          Skip for now
        </SettingsButton>
      </div>
    </Frame>
  );
};

/** Shown while this Mac's computer use is off or needs setup, until skipped or done. */
export const OnboardingCard = ({ hostKey, host }: OnboardingCardProps) => {
  const [closed, setClosed] = useState(settled);

  if (closed) return null;

  return (
    <Live
      hostKey={hostKey}
      host={host}
      onClose={(how) => {
        settle(how);
        setClosed(true);
      }}
    />
  );
};
