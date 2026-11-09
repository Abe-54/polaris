// Portions adapted from raycast/extensions@3048c09 zed-recent-projects/src/search.tsx (MIT)
/** One Agent Session in a list: its state, Workspace, Host and last Turn, and what you can do. */
import { Action, ActionPanel, Icon, Keyboard, List } from "@raycast/api";
import { harnessEntry } from "@polaris/sdk";
import { usePolaris } from "../polaris.tsx";
import { permissionModeLabel, STATE_LABEL } from "../lib/copy.ts";
import { canSendTurn } from "../lib/actions.ts";
import { sessionLink } from "../lib/links.ts";
import { fence, plain, quote } from "../lib/markdown.ts";
import type { SessionRow } from "../lib/rows.ts";
import { AnswerForm } from "./AnswerForm.tsx";
import { stateIcon, stateTag } from "./look.ts";
import { SendTurnForm } from "./SendTurnForm.tsx";
import { attempt } from "./toast.ts";

export interface DetailToggle {
  readonly showing: boolean;
  readonly toggle: () => void;
}

export interface Pins {
  readonly pin: (key: string) => void;
  readonly unpin: (key: string) => void;
}

export const sessionMarkdown = (row: SessionRow): string => {
  const { session, pendingApprovals, lastTurnPreview } = row.entry;
  const parts = [`## ${plain(session.title)}`];

  for (const approval of pendingApprovals) {
    parts.push(`**Needs you** · ${plain(approval.title)}`);

    if (approval.detail !== null) parts.push(fence(approval.detail));
  }

  if (lastTurnPreview !== null) parts.push("**Last turn**", quote(lastTurnPreview));

  if (session.lastReplyPreview != null) parts.push("**Reply**", quote(session.lastReplyPreview));

  if (session.lastError !== null) parts.push("**Error**", fence(session.lastError));

  return parts.join("\n\n");
};

const SessionDetail = (props: { readonly row: SessionRow }) => {
  const { session } = props.row.entry;
  const Meta = List.Item.Detail.Metadata;

  return (
    <List.Item.Detail
      markdown={sessionMarkdown(props.row)}
      metadata={
        <Meta>
          <Meta.TagList title="Session state">
            <Meta.TagList.Item text={STATE_LABEL[session.state]} />
          </Meta.TagList>
          <Meta.Label
            title="Harness"
            text={harnessEntry(session.harness)?.name ?? session.harness}
          />
          <Meta.Label title="Model" text={session.model ?? "Default"} />
          <Meta.Label title="Permission mode" text={permissionModeLabel(session.permissionMode)} />
          <Meta.Separator />
          <Meta.Label title="Workspace" text={props.row.workspaceName} />
          <Meta.Label title="Directory" text={session.cwd} />
          <Meta.Label title="Host" text={props.row.hostName} />
          <Meta.Separator />
          <Meta.Label title="Turns" text={String(session.turnCount)} />
          <Meta.Label title="Last turn" text={new Date(props.row.lastTurnAt).toLocaleString()} />
          <Meta.Label title="Session ID" text={session.id} />
        </Meta>
      }
    />
  );
};

const ApprovalActions = (props: { readonly row: SessionRow }) => {
  const { client } = usePolaris();
  const { hostId, hostName, entry } = props.row;
  const approval = entry.pendingApprovals[0];

  if (approval === undefined) return null;

  if (approval.kind === "question")
    return (
      <Action.Push
        title="Answer"
        icon={Icon.Message}
        shortcut={{ modifiers: ["cmd", "shift"], key: "a" }}
        target={<AnswerForm row={props.row} question={approval} />}
      />
    );

  const respond = (kind: "allow" | "deny") =>
    attempt(
      kind === "allow"
        ? { progress: "Approving…", done: "Approved", action: "approve", hostName }
        : { progress: "Denying…", done: "Denied", action: "deny", hostName },
      () => client.respondToApproval(hostId, entry.session.id, approval.id, { kind })
    );

  return (
    <>
      <Action
        title="Approve"
        icon={Icon.Check}
        shortcut={{ modifiers: ["cmd", "shift"], key: "a" }}
        onAction={() => void respond("allow")}
      />
      <Action
        title="Deny"
        icon={Icon.XMarkCircle}
        shortcut={{ modifiers: ["cmd", "shift"], key: "d" }}
        onAction={() => void respond("deny")}
      />
    </>
  );
};

const INTERRUPTIBLE = new Set(["starting", "working", "needs-you"]);

export const SessionActions = (props: {
  readonly row: SessionRow;
  readonly detail: DetailToggle;
  readonly pins: Pins;
}) => {
  const { client } = usePolaris();
  const { row } = props;
  const { session } = row.entry;

  return (
    <ActionPanel>
      <ActionPanel.Section>
        <Action.Open
          title="Open in Polaris"
          icon="icon.png"
          target={sessionLink(row.hostId, session.id)}
        />
        {!canSendTurn(row.entry) ? null : (
          <Action.Push
            title="Send Turn"
            icon={Icon.Message}
            shortcut={{ modifiers: ["cmd"], key: "t" }}
            target={<SendTurnForm row={row} />}
          />
        )}
        <ApprovalActions row={row} />
        {INTERRUPTIBLE.has(session.state) ? (
          <Action
            title="Interrupt"
            icon={Icon.Stop}
            shortcut={{ modifiers: ["cmd"], key: "." }}
            onAction={() =>
              void attempt(
                {
                  progress: "Interrupting…",
                  done: "Interrupted",
                  action: "interrupt",
                  hostName: row.hostName,
                },
                () => client.interrupt(row.hostId, session.id)
              )
            }
          />
        ) : null}
      </ActionPanel.Section>
      <ActionPanel.Section>
        <Action
          title={props.detail.showing ? "Hide Details" : "Show Details"}
          icon={Icon.Sidebar}
          shortcut={{ modifiers: ["cmd"], key: "d" }}
          onAction={props.detail.toggle}
        />
        <Action
          title={row.pinned ? "Unpin Session" : "Pin Session"}
          icon={row.pinned ? Icon.PinDisabled : Icon.Pin}
          shortcut={Keyboard.Shortcut.Common.Pin}
          onAction={() => (row.pinned ? props.pins.unpin(row.key) : props.pins.pin(row.key))}
        />
        <Action.CopyToClipboard
          title="Copy Session ID"
          content={session.id}
          shortcut={Keyboard.Shortcut.Common.Copy}
        />
      </ActionPanel.Section>
    </ActionPanel>
  );
};

const subtitleOf = (row: SessionRow) => {
  const approval = row.entry.pendingApprovals[0];

  return approval?.title ?? row.entry.lastTurnPreview ?? "";
};

export const SessionItem = (props: {
  readonly row: SessionRow;
  readonly detail: DetailToggle;
  readonly pins: Pins;
}) => {
  const { row } = props;
  const { session } = row.entry;
  const when = { date: new Date(row.lastTurnAt), tooltip: "Last turn" };

  return (
    <List.Item
      id={row.key}
      title={session.title}
      subtitle={props.detail.showing ? "" : subtitleOf(row)}
      icon={stateIcon(session.state)}
      keywords={[row.workspaceName, row.hostName, session.harness]}
      accessories={
        props.detail.showing
          ? [stateTag(session.state)]
          : [
              ...(row.pinned ? [{ icon: Icon.Pin, tooltip: "Pinned" }] : []),
              stateTag(session.state),
              { text: row.workspaceName, tooltip: "Workspace" },
              { text: row.hostName, icon: Icon.Network, tooltip: "Host" },
              when,
            ]
      }
      detail={<SessionDetail row={row} />}
      actions={<SessionActions {...props} />}
    />
  );
};
