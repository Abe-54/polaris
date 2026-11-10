/**
 * The cards on a live Host: the host page's card for a machine, and the inline prompt for a
 * session, each on the Host feed. A Daemon without `computer-use` shows neither.
 */
import type { ApprovalDecision, ApprovalRequest, HarnessKind } from "@polaris/protocol";
import { harnessHue } from "@polaris/ui";
import { Match } from "effect";
import type { ConnectionStatusView, MachineView } from "../../../../shared/api.ts";
import { Decisions } from "../../../commands.ts";
import { useApp } from "../../../shell/hooks.ts";
import { writeClipboard } from "../../clipboard.ts";
import { platformOf } from "../../machines/restart/model.ts";
import { useComputerUseActions, useComputerUseFeed } from "../hooks.ts";
import type { HostFacts } from "../model.ts";
import type { PromptAsk, PromptFix } from "../prompt.ts";
import { AppApprovalCard } from "./AppApprovalCard.tsx";
import { ComputerUseCard } from "./ComputerUseCard.tsx";
import { InlinePrompt } from "./InlinePrompt.tsx";
import { OnboardingCard } from "./OnboardingCard.tsx";

/** What both a machine and a Host view give: its key, label, kind and Connection State. */
interface HostLike {
  readonly key: string;
  readonly label: string;
  readonly kind: string;
  readonly status: ConnectionStatusView | null;
}

export const hostFactsOf = (machine: HostLike): HostFacts => ({
  name: machine.label,
  platform: platformOf(machine.status?.host?.platform),
  local: machine.kind === "local",
});

/** Whether a connected Host's Daemon serves computer use. */
export const servesComputerUse = (machine: Pick<HostLike, "status">): boolean =>
  machine.status?.state === "connected" && machine.status.capabilities.includes("computer-use");

export const HostComputerUseCard = ({ machine }: { readonly machine: MachineView }) => {
  const feed = useComputerUseFeed(machine.key);
  const actions = useComputerUseActions(machine.key);

  return <ComputerUseCard host={hostFactsOf(machine)} feed={feed} actions={actions} />;
};

export interface ComputerUsePromptProps {
  readonly hostKey: string;
  readonly host: HostFacts;
  readonly ask: PromptAsk;
  readonly onNotNow: () => void;
}

export const ComputerUsePrompt = ({ hostKey, host, ask, onNotNow }: ComputerUsePromptProps) => {
  const feed = useComputerUseFeed(hostKey);
  const actions = useComputerUseActions(hostKey);

  if (feed.status === null) return null;

  const fix = (chosen: PromptFix) =>
    Match.value(chosen).pipe(
      Match.discriminatorsExhaustive("kind")({
        enable: () => actions.setOn(true),
        "open-setup": ({ permission }) => actions.openSetup(permission),
        copy: ({ command }) => void writeClipboard(command),
        check: () => actions.checkAgain(),
      })
    );

  return (
    <InlinePrompt
      host={host}
      state={feed.status.state}
      ask={ask}
      busy={actions.busy}
      onFix={fix}
      onNotNow={onNotNow}
    />
  );
};

/** The first-run card, only on this Mac's own Host when its Daemon serves computer use. */
export const LocalMacOnboarding = ({ host }: { readonly host: HostLike }) => {
  const facts = hostFactsOf(host);

  if (!facts.local || facts.platform !== "macos" || !servesComputerUse(host)) return null;

  return <OnboardingCard hostKey={host.key} host={facts} />;
};

export interface ComputerUseApprovalProps {
  readonly request: ApprovalRequest;
  readonly hostKey: string;
  readonly harness: HarnessKind | null;
  readonly onRespond: (decision: ApprovalDecision) => void;
}

/** An app or headed-input approval in the transcript, on its Host's name (Paper CU4). */
export const ComputerUseApproval = ({
  request,
  hostKey,
  harness,
  onRespond,
}: ComputerUseApprovalProps) => {
  const host = useApp((s) => s.hosts.find((h) => h.key === hostKey)?.label ?? "this Host");

  return (
    <AppApprovalCard
      request={request}
      who={harness === null ? "The agent" : harnessHue(harness).name}
      host={host}
      onAllow={() => onRespond(Decisions.Allow({ remember: false }))}
      onAlwaysAllow={() => onRespond(Decisions.Allow({ remember: true }))}
      onDeny={() => onRespond(Decisions.Deny({ reason: null }))}
    />
  );
};
