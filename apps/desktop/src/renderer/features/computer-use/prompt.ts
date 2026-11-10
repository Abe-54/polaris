/**
 * The transcript's inline prompt (Paper CU3): a Turn needs computer use and its Host isn't
 * ready, so the session needs you. One fix and "Not now"; it goes once the Host is ready.
 */
import type { ComputerUsePermission, ComputerUseState } from "@polaris/protocol";
import { Match } from "effect";
import { HELPER_APP, type HostFacts, servicesOf } from "./model.ts";

/** What the session asked for: the Harness's name and the app it wants. */
export interface PromptAsk {
  readonly harness: string;
  readonly app: string;
}

export type PromptFix =
  | { readonly kind: "enable"; readonly label: "Turn on computer use" }
  | {
      readonly kind: "open-setup";
      readonly label: string;
      readonly permission: ComputerUsePermission | null;
    }
  | { readonly kind: "copy"; readonly label: "Copy command"; readonly command: string }
  | { readonly kind: "check"; readonly label: "Check again" };

export interface PromptView {
  readonly title: string;
  readonly line: string;
  readonly fix: PromptFix;
  /** "ACCESSIBILITY ON": the half that is already granted. */
  readonly note: string | null;
}

const check: PromptFix = { kind: "check", label: "Check again" };

const macPrompt = (
  host: HostFacts,
  ask: PromptAsk,
  accessibility: boolean,
  screenRecording: boolean
): PromptView => {
  const services = servicesOf({ accessibility, screenRecording });
  const missing = services.filter((s) => !s.on).map((s) => s.name);
  const granted = services.filter((s) => s.on).map((s) => `${s.name} on`);
  const permission = accessibility && !screenRecording ? "screen-recording" : null;

  if (!host.local)
    return {
      title: `On ${host.name}, approve the prompt`,
      line: `${ask.harness} wants to use ${ask.app} there, but ${host.name} hasn't allowed ${HELPER_APP}. Someone at that Mac turns it on.`,
      fix: { kind: "open-setup", label: `Open System Settings on ${host.name}`, permission },
      note: null,
    };

  return {
    title:
      missing.length === 1
        ? `${missing[0]} is off on ${host.name}`
        : `Computer use isn't allowed on ${host.name} yet`,
    line: `${ask.harness} can't use ${ask.app} without it. This card notices when it's on.`,
    fix: { kind: "open-setup", label: "Open System Settings", permission },
    note: granted.length === 0 ? null : granted.join(" · "),
  };
};

/** Null when there's nothing to fix: the Host is ready, or has no desktop to set up. */
export const promptView = (
  host: HostFacts,
  state: ComputerUseState,
  ask: PromptAsk
): PromptView | null =>
  Match.value(state).pipe(
    Match.tagsExhaustive({
      NoDesktop: () => null,
      Ready: () => null,
      Off: (): PromptView => ({
        title: `${ask.harness} wants to use ${ask.app}`,
        line: `Computer use is off on ${host.name}. Turn it on and the turn carries on; you'll still approve ${ask.app}.`,
        fix: { kind: "enable", label: "Turn on computer use" },
        note: null,
      }),
      NeedsSetup: ({ setup }): PromptView =>
        Match.value(setup).pipe(
          Match.tagsExhaustive({
            MacPermissions: ({ accessibility, screenRecording }) =>
              macPrompt(host, ask, accessibility, screenRecording),
            LinuxPackages: ({ packages, command }): PromptView => ({
              title: `${packages.join(" and ")} isn't installed on ${host.name}`,
              line: `${ask.harness} can't use ${ask.app} until it is. ${command === null ? `Install it with ${host.name}'s package manager` : `Run the command on ${host.name}`}, then check again.`,
              fix: command === null ? check : { kind: "copy", label: "Copy command", command },
              note: null,
            }),
            AccessibilityBus: (): PromptView => ({
              title: `The accessibility bus is off on ${host.name}`,
              line: `${ask.harness} can't use ${ask.app} until it runs. Turn on assistive technologies in the desktop's settings, then check again.`,
              fix: check,
              note: null,
            }),
          })
        ),
    })
  );
