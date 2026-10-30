/**
 * Advanced → Markdown preview: external images per Workspace on the picked Host.
 * The preview can only allow; this is where a Workspace goes back to asking or blocks.
 */
import * as P from "@polaris/protocol";
import { Schema } from "effect";
import {
  SettingsCard,
  SettingsEmpty,
  SettingsRow,
  SettingsSelect,
  SettingsWell,
} from "@polaris/ui";
import { useEffect, useId, useState } from "react";
import type { LanguageApi } from "../../../../shared/api.ts";

export interface PolicyWorkspace {
  readonly id: P.WorkspaceId;
  readonly name: string;
}

type Choice = P.LanguagePreviewPolicy["externalImages"];

const CHOICES: ReadonlyArray<{ readonly value: Choice; readonly label: string }> = [
  { value: "ask", label: "Ask before loading" },
  { value: "allow", label: "Allow" },
  { value: "deny", label: "Block" },
];

const WorkspaceImages = ({
  api,
  hostKey,
  hostId,
  workspace,
  onSaved,
}: {
  readonly api: LanguageApi;
  readonly hostKey: string;
  readonly hostId: P.HostId;
  readonly workspace: PolicyWorkspace;
  readonly onSaved: (workspaceId: P.WorkspaceId) => void;
}) => {
  const id = useId();
  const [policy, setPolicy] = useState<P.LanguagePreviewPolicy | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    void api
      .request("languages.preview.policy.get", { hostKey, workspaceId: workspace.id })
      .then((reply) => {
        if (!live) return;

        if (!reply.ok) return setFailed(true);
        const valid = Schema.decodeUnknownSync(P.LanguagePreviewPolicy)(reply.value);

        if (valid.hostId === hostId && valid.workspaceId === workspace.id) setPolicy(valid);
        else setFailed(true);
      });

    return () => {
      live = false;
    };
  }, [api, hostKey, hostId, workspace.id]);

  const choose = async (externalImages: Choice) => {
    if (policy === null) return;

    const reply = await api.request("languages.preview.policy.set", {
      hostKey,
      policy: P.LanguagePreviewPolicy.make({ ...policy, externalImages }),
    });

    if (!reply.ok) return setFailed(true);
    setPolicy(Schema.decodeUnknownSync(P.LanguagePreviewPolicy)(reply.value));
    setFailed(false);
    onSaved(workspace.id);
  };

  return (
    <SettingsRow
      title={workspace.name}
      htmlFor={id}
      caption={
        failed ? (
          <span role="status">Couldn't read or save this workspace's choice.</span>
        ) : undefined
      }
    >
      <SettingsSelect
        id={id}
        label={`External images in ${workspace.name}`}
        value={policy?.externalImages ?? "ask"}
        options={CHOICES}
        disabled={policy === null}
        onChange={(value) => void choose(value)}
      />
    </SettingsRow>
  );
};

export const MarkdownImages = ({
  api,
  hostKey,
  hostId,
  workspaces,
  onSaved,
}: {
  readonly api: LanguageApi;
  readonly hostKey: string;
  readonly hostId: P.HostId;
  readonly workspaces: ReadonlyArray<PolicyWorkspace>;
  readonly onSaved: (workspaceId: P.WorkspaceId) => void;
}) => (
  <SettingsCard
    aria-label="External images in Markdown previews"
    title="External images in Markdown previews"
    aside="Per workspace · scripts never run"
  >
    {workspaces.length === 0 ? (
      <SettingsEmpty>No workspaces on this host yet.</SettingsEmpty>
    ) : (
      <SettingsWell>
        {workspaces.map((workspace) => (
          <WorkspaceImages
            key={workspace.id}
            api={api}
            hostKey={hostKey}
            hostId={hostId}
            workspace={workspace}
            onSaved={onSaved}
          />
        ))}
      </SettingsWell>
    )}
  </SettingsCard>
);
