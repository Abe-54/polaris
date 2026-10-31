/**
 * The sidebar's Profiles (DESIGN.md, Traces → Sidebar; Paper T2): "Restart ‹service› with
 * profiling", then recordings under Turn kickers, newest first: 48px rows of the process and its
 * length, and how it was made.
 */
import type { Profile, ProfilesSnapshot } from "@polaris/protocol";
import { cn } from "@polaris/ui";
import { type KeyboardEvent, useMemo } from "react";
import type { Loaded } from "../../data/hooks.tsx";
import { lengthLabel, originLabel, processLabel } from "../../model/profile/labels.ts";
import { useRequestedHere } from "../../model/profile/restarts.ts";
import { selectProfile, useProfileSelection } from "../../model/profile/store.ts";
import type { TracesSessionKey } from "../../model/session.ts";
import { groupItemsByTurn, profilesLabel, turnKicker } from "../../model/sidebar.ts";
import { RestartButton } from "./RestartButton.tsx";

const Quiet = ({ children }: { readonly children: string }) => (
  <p className="text-caption text-text-subtle px-2 py-2" data-testid="profiles-quiet">
    {children}
  </p>
);

const ProfileRow = ({
  at,
  profile,
  open,
}: {
  readonly at: TracesSessionKey;
  readonly profile: Profile;
  readonly open: boolean;
}) => {
  const requestedHere = useRequestedHere(at, profile.id);

  return (
    <button
      type="button"
      data-testid="profiles-row"
      data-profile={profile.id}
      aria-current={open ? "true" : undefined}
      title={`${profile.command} · pid ${profile.pid}`}
      onClick={() => selectProfile(at, open ? null : profile)}
      className={cn(
        "min-h-session-row hover:bg-fill-hover focus-visible:ring-starlight rounded-card flex w-full shrink-0 cursor-default flex-col justify-center gap-0.5 px-3 py-1 text-left outline-none focus-visible:ring-2",
        open && "bg-raised ring-hairline hover:bg-raised ring-1 ring-inset"
      )}
    >
      <span className="flex w-full min-w-0 items-baseline justify-between gap-2">
        <span
          className={cn(
            "text-code-inline min-w-0 truncate font-mono",
            open ? "text-text-strong" : "text-text-default"
          )}
        >
          {processLabel(profile)}
        </span>
        <span
          className={cn(
            "tabular shrink-0 font-mono text-[11px] leading-[14px]",
            open ? "text-text-strong" : "text-text-subtle"
          )}
        >
          {lengthLabel(profile)}
        </span>
      </span>
      <span className="text-caption text-text-subtle min-w-0 truncate">
        {originLabel(profile, requestedHere)}
      </span>
    </button>
  );
};

/** Up and Down move between recordings and open the one reached. */
const moveFocus = (event: KeyboardEvent<HTMLElement>) => {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-profile]")];
  const at = rows.findIndex((row) => row === document.activeElement);
  const next = rows[at + (event.key === "ArrowDown" ? 1 : -1)];

  if (next === undefined) return;
  event.preventDefault();
  next.focus();
  next.click();
};

const Recordings = ({
  at,
  profiles,
  latestTurn,
}: {
  readonly at: TracesSessionKey;
  readonly profiles: ReadonlyArray<Profile>;
  readonly latestTurn: number | null;
}) => {
  const groups = useMemo(() => groupItemsByTurn(profiles), [profiles]);
  const openId = useProfileSelection(at).profile?.id ?? null;

  return (
    <div
      role="list"
      aria-label="Profiles by turn"
      className="flex flex-col gap-0.5"
      onKeyDown={moveFocus}
    >
      {groups.map((group) => (
        <section key={group.key} role="listitem" className="flex flex-col gap-0.5">
          <h2 className="flex h-8 shrink-0 items-center justify-between pt-2 pr-2.5 pl-2 font-mono">
            <span className="text-micro text-text-subtle font-medium tracking-[0.06em]">
              {turnKicker(group.turn, latestTurn)}
            </span>
            <span className="text-micro text-text-subtle">{profilesLabel(group.items.length)}</span>
          </h2>
          {group.items.map((profile) => (
            <ProfileRow key={profile.id} at={at} profile={profile} open={profile.id === openId} />
          ))}
        </section>
      ))}
    </div>
  );
};

export const ProfileList = ({
  at,
  traceId,
  snapshot,
  unavailable,
  latestTurn,
}: {
  readonly at: TracesSessionKey;
  readonly traceId: string | null;
  readonly snapshot: Loaded<ProfilesSnapshot>;
  readonly unavailable: string | null;
  readonly latestTurn: number | null;
}) => {
  if (unavailable !== null)
    return <Quiet>{`${unavailable}. Update it in Settings → Hosts.`}</Quiet>;

  return (
    <div className="flex flex-col gap-0.5" data-testid="profiles-list">
      <RestartButton at={at} traceId={traceId} />
      {snapshot.status === "failed" ? <Quiet>{snapshot.error.message}</Quiet> : null}
      {snapshot.status === "ready" && snapshot.value.profiles.length === 0 ? (
        <Quiet>No profiles yet</Quiet>
      ) : null}
      {snapshot.status === "ready" ? (
        <Recordings at={at} profiles={snapshot.value.profiles} latestTurn={latestTurn} />
      ) : null}
    </div>
  );
};
