/** Start an Agent Session: a Workspace on some Host, a Harness, and the first Turn. */
import { Action, ActionPanel, Form, open, popToRoot, showToast, Toast } from "@raycast/api";
import { HARNESS_CATALOGUE, type PermissionMode, type StartSessionInput } from "@polaris/sdk";
import { useState } from "react";
import { usePolaris } from "../polaris.tsx";
import { PERMISSION_MODES, permissionModesOn } from "../lib/copy.ts";
import { sessionLink } from "../lib/links.ts";
import { workspaceRows } from "../lib/rows.ts";
import { attempt } from "./toast.ts";

interface Values {
  readonly workspace: string;
  readonly harness: string;
  readonly prompt: string;
  readonly permissionMode: string;
  readonly branch: string;
}

const modeOf = (value: string): PermissionMode =>
  PERMISSION_MODES.find((m) => m.mode === value)?.mode ?? "supervised";

export const NewSessionForm = (props: {
  readonly prompt?: string;
  /** A `WorkspaceRow` key to start in. */
  readonly workspace?: string;
}) => {
  const { client, views } = usePolaris();
  const rows = workspaceRows(views, null);
  const [promptError, setPromptError] = useState<string | undefined>();
  const [workspaceKey, setWorkspaceKey] = useState(props.workspace);
  const hostId = rows.find((r) => r.key === workspaceKey)?.hostId;
  const modes = permissionModesOn(views.find((v) => v.hostId === hostId)?.capabilities ?? []);

  const submit = async (values: Values) => {
    const row = rows.find((r) => r.key === values.workspace);
    const prompt = values.prompt.trim();

    if (prompt === "") return setPromptError("Write the first turn");

    if (row === undefined) return;
    const branch = values.branch.trim();
    let sessionId = "";

    const started = await attempt(
      {
        progress: "Starting agent session…",
        done: "Agent session started",
        action: "start the agent session",
        hostName: row.hostName,
      },
      async () => {
        const input: StartSessionInput = {
          workspaceId: row.workspace.id,
          harness: values.harness,
          prompt,
          permissionMode: modeOf(values.permissionMode),
        };

        sessionId = await client.startSession(
          row.hostId,
          branch === "" ? input : { ...input, worktree: { branch } }
        );
      }
    );

    if (!started) return;
    await showToast({
      style: Toast.Style.Success,
      title: "Agent session started",
      message: `${row.workspace.name} on ${row.hostName}`,
      primaryAction: {
        title: "Open in Polaris",
        onAction: () => void open(sessionLink(row.hostId, sessionId)),
      },
    });
    await popToRoot();
  };

  return (
    <Form
      navigationTitle="New Agent Session"
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Start Agent Session" onSubmit={submit} />
        </ActionPanel>
      }
    >
      <Form.Dropdown
        id="workspace"
        title="Workspace"
        {...(props.workspace === undefined ? {} : { defaultValue: props.workspace })}
        storeValue={props.workspace === undefined}
        onChange={setWorkspaceKey}
      >
        {views.map((view) => (
          <Form.Dropdown.Section key={view.hostId} title={view.hostName}>
            {rows
              .filter((row) => row.hostId === view.hostId)
              .map((row) => (
                <Form.Dropdown.Item
                  key={row.key}
                  title={row.workspace.name}
                  value={row.key}
                  keywords={[row.workspace.path, row.hostName]}
                />
              ))}
          </Form.Dropdown.Section>
        ))}
      </Form.Dropdown>
      <Form.Dropdown id="harness" title="Harness" storeValue>
        {HARNESS_CATALOGUE.map((harness) => (
          <Form.Dropdown.Item key={harness.kind} title={harness.name} value={harness.kind} />
        ))}
      </Form.Dropdown>
      <Form.TextArea
        id="prompt"
        title="First turn"
        defaultValue={props.prompt ?? ""}
        {...(promptError === undefined ? {} : { error: promptError })}
        onChange={() => setPromptError(undefined)}
      />
      <Form.Dropdown
        id="permissionMode"
        title="Permission mode"
        defaultValue="supervised"
        info="Anything but Plan or Supervised also needs the Approve grant."
      >
        {modes.map((m) => (
          <Form.Dropdown.Item key={m.mode} title={`${m.label} · ${m.detail}`} value={m.mode} />
        ))}
      </Form.Dropdown>
      <Form.TextField
        id="branch"
        title="Worktree branch"
        placeholder="Work in the workspace itself"
        info="A branch name starts the agent session in a new worktree on that branch."
      />
    </Form>
  );
};
