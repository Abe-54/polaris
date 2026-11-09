/**
 * The extension's words for Session States, Grants and the SDK's errors, so a
 * refusal says what the pairing lacks and where to fix it.
 */
import {
  type Capability,
  CommandRejected,
  ExtensionTokenRejected,
  type GrantKind,
  HostUnreachable,
  type HostView,
  type PermissionMode,
  InvalidPairing,
  NotFound,
  NotGranted,
  ProtocolMismatch,
  type SessionState,
  UnknownHost,
} from "@polaris/sdk";
import { plain } from "./markdown.ts";

export const STATE_LABEL: Readonly<Record<SessionState, string>> = {
  starting: "Starting",
  working: "Working",
  "needs-you": "Needs you",
  idle: "Idle",
  "in-terminal": "In terminal",
  dormant: "Dormant",
  failed: "Failed",
  limited: "Limited",
  archived: "Archived",
};

/** Permission modes in the Desktop App's picker order and words, least trust first. */
export const PERMISSION_MODES: ReadonlyArray<{
  readonly mode: PermissionMode;
  readonly label: string;
  readonly detail: string;
}> = [
  { mode: "plan", label: "Plan", detail: "Reads and plans, asks before editing" },
  { mode: "supervised", label: "Supervised", detail: "Asks before edits and commands" },
  { mode: "auto-edits", label: "Auto-edits", detail: "Edits freely, asks before commands" },
  { mode: "auto", label: "Auto", detail: "Runs freely, asks for risky actions" },
  { mode: "full-access", label: "Full access", detail: "Never asks" },
];

/** The modes a Host offers: Plan needs its Daemon's `session.plan-mode`. */
export const permissionModesOn = (capabilities: ReadonlyArray<Capability>) =>
  capabilities.includes("session.plan-mode")
    ? PERMISSION_MODES
    : PERMISSION_MODES.filter((m) => m.mode !== "plan");

export const permissionModeLabel = (mode: PermissionMode): string =>
  PERMISSION_MODES.find((m) => m.mode === mode)?.label ?? mode;

/** A Grant as Settings → Extensions labels it, and what it lets Raycast do. */
export const GRANT_COPY: Readonly<
  Record<GrantKind, { readonly label: string; readonly can: string }>
> = {
  read: { label: "Read", can: "see agent sessions" },
  approve: { label: "Approve", can: "answer approvals" },
  turn: { label: "Send turns", can: "send turns" },
  start: { label: "Start agent sessions", can: "start agent sessions" },
  voice: { label: "Voice", can: "use voice" },
};

const PAIR_AGAIN = "In Polaris, open Settings → Extensions, pair Raycast again";

export interface Failure {
  readonly title: string;
  readonly message: string;
}

/** The recovery page for a failure before a Host feed opens. */
export const failureMarkdown = (failure: Failure): string =>
  `# ${plain(failure.title)}\n\n${plain(failure.message)}`;

const notGranted = (error: NotGranted): Failure =>
  error.needed === null
    ? { title: "Extensions can't do this", message: "Do it in Polaris itself." }
    : {
        title: `This pairing can't ${GRANT_COPY[error.needed].can}`,
        message: `${PAIR_AGAIN} with “${GRANT_COPY[error.needed].label}” on, and add it in Hosts.`,
      };

const mismatch = (error: ProtocolMismatch): Failure =>
  error.update === "polaris"
    ? { title: "Polaris is too old for Raycast", message: "Update Polaris on that host." }
    : { title: "Raycast's Polaris extension is too old", message: "Update the extension." };

const rejected = (error: ExtensionTokenRejected): Failure => ({
  title:
    error.reason === "revoked" ? "This pairing was revoked" : "Polaris doesn't know this pairing",
  message: `${PAIR_AGAIN} and add the new pairing string in Hosts.`,
});

/**
 * What to tell the user when `action` ("send the turn") failed with `error`.
 * `hostName` names the Host in an unreachable one.
 */
const failureOf = (error: Error | null, action: string, hostName?: string): Failure => {
  if (error instanceof NotGranted) return notGranted(error);

  if (error instanceof ProtocolMismatch) return mismatch(error);

  if (error instanceof ExtensionTokenRejected) return rejected(error);

  if (error instanceof HostUnreachable)
    return { title: `Can't reach ${hostName ?? "Polaris"}`, message: error.detail };

  if (error instanceof CommandRejected)
    return { title: `Polaris didn't ${action}`, message: error.reason };

  if (error instanceof NotFound)
    return { title: `This ${error.what} is no longer there`, message: `Couldn't ${action}.` };

  if (error instanceof UnknownHost)
    return { title: "No pairing for this host", message: "Add one in Hosts." };

  if (error instanceof InvalidPairing)
    return { title: "Not a pairing string", message: `It can't be read: ${error.reason}.` };

  return { title: `Couldn't ${action}`, message: error?.message ?? "" };
};

/** Never repeat a pairing credential embedded in transport or validation errors. */
const redact = (text: string): string =>
  text.replaceAll(/pol_ext_[A-Za-z0-9_-]+|polaris-pair:v1:[A-Za-z0-9_-]+/g, "[redacted]");

export const describeFailure = (
  error: Error | null,
  action: string,
  hostName?: string
): Failure => {
  const failure = failureOf(error, action, hostName);

  return { title: redact(failure.title), message: redact(failure.message) };
};

/** The page a command shows instead of its list when no Host can be reached. */
export const unavailableMarkdown = (
  views: ReadonlyArray<Pick<HostView, "hostName" | "error">>
): string => {
  const lines = views.map((view) => {
    const failure = describeFailure(view.error, "connect", view.hostName);

    return `- **${plain(view.hostName)}**: ${plain(`${failure.title}. ${failure.message}`)}`;
  });

  return ["# Polaris can't be reached", "", ...lines].join("\n");
};
