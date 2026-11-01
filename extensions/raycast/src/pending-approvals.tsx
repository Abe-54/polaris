/** Every approval waiting on you, oldest first, with what the agent wants to do. */
import { Action, ActionPanel, Icon, List } from "@raycast/api";
import { useState } from "react";
import { AnswerForm } from "./components/AnswerForm.tsx";
import { HostDropdown, hostFilterOf } from "./components/HostDropdown.tsx";
import { attempt } from "./components/toast.ts";
import { sessionLink } from "./lib/links.ts";
import { fence, plain } from "./lib/markdown.ts";
import { type ApprovalRow, approvalRows, offersAlwaysAllow } from "./lib/rows.ts";
import { usePolaris, withPolaris } from "./polaris.tsx";

const KIND_LABEL = {
  command: "Command",
  "file-change": "File change",
  tool: "Tool call",
  question: "Question",
  // The SDK doesn't announce `approval.secret`, so a Daemon never sends one.
  secret: "Secret",
} as const;

const markdownOf = ({ approval, session }: ApprovalRow) =>
  [
    `## ${plain(approval.title)}`,
    approval.detail === null ? "" : fence(approval.detail),
    approval.options.length === 0 ? "" : approval.options.map((o) => `- ${plain(o)}`).join("\n"),
    plain(`${session.entry.session.title} · ${session.workspaceName} · ${session.hostName}`),
  ]
    .filter((part) => part !== "")
    .join("\n\n");

const Actions = (props: { readonly row: ApprovalRow }) => {
  const { client } = usePolaris();
  const { approval, session } = props.row;
  const sessionId = session.entry.session.id;

  const respond = (
    response: { readonly kind: "allow"; readonly remember: boolean } | { readonly kind: "deny" }
  ) =>
    attempt(
      response.kind === "allow"
        ? {
            progress: "Approving…",
            done: "Approved",
            action: "approve",
            hostName: session.hostName,
          }
        : { progress: "Denying…", done: "Denied", action: "deny", hostName: session.hostName },
      () => client.respondToApproval(session.hostId, sessionId, approval.id, response)
    );

  return (
    <ActionPanel>
      <Action.Open
        title="Open in Polaris"
        icon="icon.png"
        target={sessionLink(session.hostId, sessionId)}
      />
      {approval.kind === "question" ? (
        <Action.Push
          title="Answer"
          icon={Icon.Message}
          shortcut={{ modifiers: ["cmd", "shift"], key: "a" }}
          target={<AnswerForm row={session} question={approval} />}
        />
      ) : (
        <>
          <Action
            title="Approve"
            icon={Icon.Check}
            shortcut={{ modifiers: ["cmd", "shift"], key: "a" }}
            onAction={() => void respond({ kind: "allow", remember: false })}
          />
          <Action
            title="Deny"
            icon={Icon.XMarkCircle}
            shortcut={{ modifiers: ["cmd", "shift"], key: "d" }}
            onAction={() => void respond({ kind: "deny" })}
          />
          {offersAlwaysAllow(approval) ? (
            <Action
              title="Always Approve"
              icon={Icon.CheckCircle}
              shortcut={{ modifiers: ["cmd", "shift", "opt"], key: "a" }}
              onAction={() => void respond({ kind: "allow", remember: true })}
            />
          ) : null}
        </>
      )}
      <Action.CopyToClipboard title="Copy Session ID" content={sessionId} />
    </ActionPanel>
  );
};

const PendingApprovals = () => {
  const { views } = usePolaris();
  const [host, setHost] = useState("all");
  const rows = approvalRows(views, hostFilterOf(host, views));

  return (
    <List
      isShowingDetail={rows.length > 0}
      searchBarPlaceholder="Search approvals"
      searchBarAccessory={
        views.length > 1 ? <HostDropdown views={views} onChange={setHost} /> : undefined
      }
    >
      <List.EmptyView
        title="Nothing needs you"
        description="Approvals appear here as agent sessions ask."
      />
      {rows.map((row) => (
        <List.Item
          key={row.key}
          title={row.approval.title}
          keywords={[
            row.session.entry.session.title,
            row.session.workspaceName,
            row.session.hostName,
          ]}
          accessories={[
            { tag: KIND_LABEL[row.approval.kind] },
            { date: new Date(row.approval.openedAt), tooltip: "Asked" },
          ]}
          detail={<List.Item.Detail markdown={markdownOf(row)} />}
          actions={<Actions row={row} />}
        />
      ))}
    </List>
  );
};

export default withPolaris(PendingApprovals);
