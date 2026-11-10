/**
 * What another feature can put around a session's conversation: Constellations swap in a
 * worker's header, Polaris-authored cards for briefs and digests, the Claim, a steer route.
 */
import { createContext, type ReactNode, useContext } from "react";

export interface PolarisCardArgs {
  readonly turnId: string;
  /** The Turn is folded to its one-line summary; a folded card shows the agent's reply itself. */
  readonly folded: boolean;
  /** The user can fold this Turn. Every Turn folds now, the latest included (C2). */
  readonly canFold: boolean;
  readonly onToggle: () => void;
}

export interface SteerCardArgs {
  /** The Turn the steer landed in. */
  readonly turnId: string;
  /** The landed steer's item (`steer:…`). */
  readonly itemId: string;
  readonly text: string;
}

export interface SessionChrome {
  /** Replaces the session header. */
  readonly header?: ReactNode;
  /** A Polaris-authored Turn's card in place of the prompt bubble; null keeps the bubble. */
  readonly promptCard?: (args: PolarisCardArgs) => ReactNode | null;
  /** A Polaris-authored steer's card (a steered digest) in place of the steer bubble; null keeps it. */
  readonly steerCard?: (args: SteerCardArgs) => ReactNode | null;
  /** Replaces the conversation (a handover summary); the composer stays. */
  readonly body?: ReactNode;
  /** Pinned above the composer: a Lead's open questions to the user (ENG-345). */
  readonly dock?: ReactNode;
  /** Closes the conversation, after the last row. */
  readonly trailer?: ReactNode;
  /** Opens a Task's worker where the Lead reads it: a Polaris tool row's "Open B2". */
  readonly openTask?: (taskId: string) => void;
  /** Sends the composer's text somewhere other than the session (a journaled steer). */
  readonly composer?: {
    readonly placeholder: string;
    readonly onSubmit: (text: string) => Promise<boolean>;
  };
}

const NONE: SessionChrome = {};

/**
 * Whether Polaris wrote a Turn's prompt (`itemId` null) or a steer, not the user: the chrome
 * shows a card for it. The composer's ↑/↓ history skips what this marks.
 */
export const polarisAuthored = (
  chrome: SessionChrome,
  turnId: string,
  itemId: string | null
): boolean =>
  (itemId === null
    ? chrome.promptCard?.({ turnId, folded: true, canFold: false, onToggle: () => undefined })
    : chrome.steerCard?.({ turnId, itemId, text: "" })) != null;

export const SessionChromeContext = createContext<SessionChrome>(NONE);

export const useSessionChrome = (): SessionChrome => useContext(SessionChromeContext);
