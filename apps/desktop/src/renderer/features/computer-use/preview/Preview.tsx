/**
 * `#computer-use/states`: the host page's card on every kind of Host (Paper CU1, CU2), the
 * first-run card and the inline prompts (CU3), on fixtures. `#computer-use/onboarding`: this
 * Mac from blank to ready through the first-run card, each step granted after a moment.
 */
import { ComputerUseState } from "@polaris/protocol";
import { Kicker } from "@polaris/ui";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { standInBridge } from "../../bridge.ts";
import { ComputerUsePrompt, HostComputerUseCard } from "../ui/connected.tsx";
import { InlinePrompt } from "../ui/InlinePrompt.tsx";
import { OnboardingCard } from "../ui/OnboardingCard.tsx";
import { BLANK, type FixtureHost, fixtureBridge, HOSTS } from "./fixtures.ts";

const Labelled = ({
  kicker,
  children,
}: {
  readonly kicker: string;
  readonly children: ReactNode;
}) => (
  <div className="flex min-w-0 flex-col gap-2">
    <Kicker className="font-normal tracking-[0.06em]">{kicker}</Kicker>
    {children}
  </div>
);

// SAFETY: the card reads only key, label, kind, the state, capabilities and platform.
const machineOf = (host: FixtureHost) =>
  ({
    key: host.key,
    label: host.facts.name,
    kind: host.facts.local ? "local" : "ssh",
    status: {
      state: "connected",
      capabilities: ["computer-use"],
      host: { platform: host.facts.platform ?? "linux" },
    },
  }) as never;

const ask = { harness: "Claude Code", app: "Simulator" };

const States = () => (
  <div className="flex flex-col gap-10 p-10" data-testid="computer-use-preview">
    <div className="grid grid-cols-[repeat(auto-fit,minmax(600px,1fr))] gap-8">
      {HOSTS.map((host) => (
        <Labelled key={host.key} kicker={host.kicker}>
          <HostComputerUseCard machine={machineOf(host)} />
        </Labelled>
      ))}
    </div>
    <div className="flex flex-wrap items-start gap-8">
      <Labelled kicker="First run · this Mac, half granted">
        <OnboardingCard hostKey="studio" host={HOSTS[0]?.facts ?? BLANK.facts} />
      </Labelled>
    </div>
    <div className="grid grid-cols-[repeat(auto-fit,minmax(360px,1fr))] gap-8">
      <Labelled kicker="Inline prompt · off on this Mac">
        <InlinePrompt
          host={BLANK.facts}
          state={ComputerUseState.cases.Off.make({})}
          ask={ask}
          busy={false}
          onFix={() => undefined}
          onNotNow={() => undefined}
        />
      </Labelled>
      {HOSTS.slice(0, 2).map((host) => (
        <Labelled key={host.key} kicker={`Inline prompt · ${host.kicker}`}>
          <ComputerUsePrompt
            hostKey={host.key}
            host={host.facts}
            ask={ask}
            onNotNow={() => undefined}
          />
        </Labelled>
      ))}
    </div>
  </div>
);

const Onboarding = () => (
  <div className="flex flex-col items-center gap-8 p-16" data-testid="computer-use-preview">
    <OnboardingCard hostKey="local" host={BLANK.facts} />
    <div className="w-[860px] max-w-full">
      <HostComputerUseCard machine={machineOf(BLANK)} />
    </div>
  </div>
);

export const mountComputerUsePreview = (root: HTMLElement, hash: string) => {
  const scene = hash.replace(/^#computer-use\//, "");

  // The first-run card is kept closed once skipped; a preview always starts fresh.
  localStorage.removeItem("polaris.computerUse.onboarding");
  standInBridge(fixtureBridge([...HOSTS, BLANK]));
  createRoot(root).render(
    <div className="bg-bg min-h-screen">{scene === "onboarding" ? <Onboarding /> : <States />}</div>
  );

  return () => undefined;
};
