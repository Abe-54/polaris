/** Advanced (SR-02, Paper L4): custom servers, executable overrides and Markdown images, per Host. */
import * as P from "@polaris/protocol";
import { SettingsCard, SettingsEmpty } from "@polaris/ui";
import { useMemo } from "react";
import type { LanguageApi } from "../../../../shared/api.ts";
import { CustomServers } from "./CustomServers.tsx";
import { useRecord, type Committed } from "./hooks.ts";
import { MarkdownImages, type PolicyWorkspace } from "./MarkdownImages.tsx";
import { Overrides } from "./Overrides.tsx";
import { withKey } from "./records.ts";

export interface AdvancedHost {
  readonly key: string;
  readonly id: P.HostId;
  readonly label: string;
}

const Sections = ({
  api,
  host,
  providers,
  workspaces,
  committed,
  onPolicySaved,
}: {
  readonly api: LanguageApi;
  readonly host: AdvancedHost;
  readonly providers: ReadonlyArray<string>;
  readonly workspaces: ReadonlyArray<PolicyWorkspace>;
  readonly committed: Committed;
  readonly onPolicySaved: (workspaceId: P.WorkspaceId) => void;
}) => {
  const scope = useMemo(
    () => P.LanguageSettingsScope.cases.Host.make({ hostId: host.id }),
    [host.id]
  );

  const { record, failed, update } = useRecord(api, host.key, scope, committed);
  const disabled = record === null;

  return (
    <>
      {failed && (
        <p role="status" className="text-caption text-text-subtle px-panel">
          Couldn't read or save {host.label}'s language settings. Try again.
        </p>
      )}
      <CustomServers
        host={host.label}
        servers={record?.settings.customServers ?? []}
        disabled={disabled}
        onChange={(servers) =>
          void update(withKey("customServers", servers.length > 0 ? servers : undefined))
        }
      />
      <Overrides
        host={host.label}
        overrides={record?.settings.executableOverrides ?? {}}
        providers={providers}
        disabled={disabled}
        onChange={(overrides) =>
          void update(
            withKey(
              "executableOverrides",
              Object.keys(overrides).length > 0 ? overrides : undefined
            )
          )
        }
      />
      <MarkdownImages
        api={api}
        hostKey={host.key}
        hostId={host.id}
        workspaces={workspaces}
        onSaved={onPolicySaved}
      />
    </>
  );
};

/** Opened from the Languages card's Advanced… button: a card per form under it. */
export const Advanced = (props: {
  readonly api: LanguageApi | undefined;
  readonly host: AdvancedHost | null;
  readonly providers: ReadonlyArray<string>;
  readonly workspaces: ReadonlyArray<PolicyWorkspace>;
  readonly committed: Committed;
  readonly onPolicySaved: (workspaceId: P.WorkspaceId) => void;
}) => {
  const { api, host } = props;

  return (
    <section aria-label="Advanced" className="gap-gap flex flex-col">
      {api && host ? (
        <Sections {...props} api={api} host={host} />
      ) : (
        <SettingsCard title="Advanced">
          <SettingsEmpty>Pick a connected host to change its language servers.</SettingsEmpty>
        </SettingsCard>
      )}
    </section>
  );
};
