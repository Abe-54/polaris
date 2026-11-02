/**
 * The open Profile under the waterfall and span panel (DESIGN.md, Traces → Profile; Paper T2):
 * `PROFILE`, its process and the stretch of the open trace it overlaps ("60–700 ms of this
 * trace"), the selected frame's file:line, "Add to agent session ⌘L"; then the flame chart with
 * that stretch marked, and the hot functions beside it.
 */
import {
  type Profile,
  type ProfileDetail,
  type ProfileFunction,
  type TraceDetail,
  WorkspaceId,
} from "@polaris/protocol";
import { CloseIcon, IconButton } from "@polaris/ui";
import { Match } from "effect";
import { type ReactNode, useCallback, useEffect, useMemo } from "react";
import { commandShortcut } from "../../../../../shared/keymap.ts";
import { useApp, useCommands } from "../../../../shell/hooks.ts";
import { menuShortcut } from "../../../../shell/menu/index.ts";
import { useOpenInEditor } from "../../../editor-links/index.ts";
import { useProfile } from "../../data/profiles.tsx";
import { formatDuration } from "../../model/format.ts";
import { openTraceNs } from "../../model/profile/openTrace.ts";
import { type FlameLayout, flameLayout } from "../../model/profile/flame.ts";
import { functionPath, opensInEditor, placeLabel } from "../../model/profile/labels.ts";
import { overlap, rangeLabel } from "../../model/profile/overlap.ts";
import { profileReference } from "../../model/profile/reference.ts";
import {
  selectFrame,
  selectProfile,
  setFlameWindow,
  setProfileFocused,
  useProfileFocused,
  useProfileSelection,
} from "../../model/profile/store.ts";
import { useOpenTrace } from "../../model/openTrace.ts";
import type { TracesSessionKey } from "../../model/session.ts";
import type { TracesSlotProps } from "../slots.ts";
import { KICKER, Pill } from "../span/parts.tsx";
import { useAddToSession } from "../useAddToSession.tsx";
import { FlameChart } from "./FlameChart.tsx";
import { HotFunctions } from "./HotFunctions.tsx";

const facts = (profile: Profile, trace: TraceDetail | null): ReactNode => {
  const recorded = Match.value(profile.status).pipe(
    Match.when("failed", () => "recording failed"),
    Match.when("recording", () => `recording · ${formatDuration(profile.durationMs)} so far`),
    Match.when("completed", () => `${formatDuration(profile.durationMs)} recorded`),
    Match.exhaustive
  );

  if (trace === null) return recorded;
  const { startNs, endNs } = openTraceNs(trace);
  const shared = overlap(profile, startNs, endNs);

  return shared === null ? (
    `not during this trace · ${recorded}`
  ) : (
    <>
      <span className="text-text-strong" data-testid="profile-range">
        {rangeLabel(shared.stretch)}
      </span>
      {` of this trace · ${recorded}`}
    </>
  );
};

/** The checkout the session works in, for paths the Editor opens. */
const useCheckout = (at: TracesSessionKey) =>
  useApp((s) => s.hostModels[at.hostKey]?.sessions.get(at.sessionId)?.session.cwd ?? null);

/** ⌘L adds the Profile while focus is in the panel, or when no trace is open to take it. */
const useAddProfile = (
  at: TracesSessionKey,
  detail: ProfileDetail | null,
  frame: number | null,
  checkout: string | null,
  active: boolean
) => {
  const add = useAddToSession(at);
  const commands = useCommands();

  const run = useCallback(() => {
    if (detail === null) return;
    const node = frame === null ? undefined : detail.nodes[frame];

    add(profileReference(detail, node === undefined ? null : node, checkout), "profile");
  }, [add, detail, frame, checkout]);

  useEffect(() => {
    return detail === null || !active
      ? undefined
      : commands.register({ "traces.addToSession": { run } });
  }, [commands, detail, active, run]);

  return run;
};

const Header = ({
  profile,
  trace,
  frameFn,
  checkout,
  onOpen,
  onAdd,
  onClose,
}: {
  readonly profile: Profile;
  readonly trace: TraceDetail | null;
  readonly frameFn: ProfileFunction | null;
  readonly checkout: string | null;
  readonly onOpen: (fn: ProfileFunction) => void;
  readonly onAdd: (() => void) | null;
  readonly onClose: () => void;
}) => (
  <div className="px-panel flex h-11 shrink-0 items-center gap-3" data-testid="profile-header">
    <span className={`${KICKER} text-text-subtle font-medium`}>Profile</span>
    <span
      className="text-label text-text-strong max-w-[240px] shrink-0 truncate font-mono font-medium"
      title={`${profile.command} · pid ${profile.pid}`}
    >
      {profile.service ?? profile.command}
    </span>
    <span className="text-caption text-text-subtle min-w-0 flex-1 truncate font-mono">
      {facts(profile, trace)}
    </span>
    {frameFn === null ? null : opensInEditor(frameFn, checkout) ? (
      <Pill
        mono
        onClick={() => onOpen(frameFn)}
        hint={menuShortcut("view.edit")}
        title={`Open ${placeLabel(frameFn, checkout)} in the editor`}
        testId="profile-open-frame"
      >
        {`${frameFn.name} · ${placeLabel(frameFn, checkout)}`}
      </Pill>
    ) : (
      <span
        className="text-code-inline text-text-subtle shrink-0 font-mono"
        data-testid="profile-frame"
      >
        {`${frameFn.name} ${placeLabel(frameFn, checkout)}`}
      </span>
    )}
    {onAdd === null ? null : (
      <Pill
        onClick={onAdd}
        hint={commandShortcut("traces.addToSession")}
        testId="profile-add-to-session"
      >
        Add to agent session
      </Pill>
    )}
    <IconButton size="sm" label="Close profile" icon={<CloseIcon size={14} />} onClick={onClose} />
  </div>
);

const Body = ({
  at,
  detail,
  layout,
  trace,
  checkout,
  onOpen,
}: {
  readonly at: TracesSessionKey;
  readonly detail: ProfileDetail;
  readonly layout: FlameLayout;
  readonly trace: TraceDetail | null;
  readonly checkout: string | null;
  readonly onOpen: (fn: ProfileFunction) => void;
}) => {
  const { frame, window } = useProfileSelection(at);

  const whole = useMemo(
    () => ({ from: 0, to: Math.max(layout.endMs, detail.profile.durationMs, 0.001) }),
    [layout, detail.profile.durationMs]
  );

  const mark = useMemo(() => {
    if (trace === null) return null;
    const { startNs, endNs } = openTraceNs(trace);

    return overlap(detail.profile, startNs, endNs)?.profile ?? null;
  }, [trace, detail.profile]);

  const { hostKey, sessionId } = at;
  const key = useMemo(() => ({ hostKey, sessionId }), [hostKey, sessionId]);
  // A Profile opens on the stretch it shares with the open trace; a reset shows all of it.
  const opening = mark ?? whole;

  return (
    <div className="px-panel pb-panel flex gap-6 pt-1">
      <FlameChart
        detail={detail}
        layout={layout}
        window={window ?? opening}
        total={whole.to}
        frame={frame}
        mark={mark}
        checkout={checkout}
        onFrame={(node) => selectFrame(key, node)}
        onOpen={(node) => {
          const fn = detail.hotFunctions[layout.functionOf[node] ?? -1];

          if (fn !== undefined && opensInEditor(fn, checkout)) onOpen(fn);
        }}
        onWindow={(next) => setFlameWindow(key, next ?? whole)}
      />
      <HotFunctions detail={detail} checkout={checkout} onOpen={onOpen} />
    </div>
  );
};

/** What a screen reader hears as the keyboard walks the chart: "fetchRate · fx.ts:23 · 670 ms · level 4". */
const frameAnnouncement = (
  detail: ProfileDetail,
  layout: FlameLayout,
  frame: number,
  fn: ProfileFunction,
  checkout: string | null
) => {
  const level = (layout.depth[layout.positionOf[frame] ?? 0] ?? 0) + 1;
  const ms = detail.nodes[frame]?.durationMs ?? 0;

  return `${fn.name} · ${placeLabel(fn, checkout)} · ${formatDuration(ms)} · level ${level}`;
};

const Quiet = ({ children }: { readonly children: ReactNode }) => (
  <div className="px-panel pb-panel flex min-h-[100px] flex-col gap-1 pt-1">{children}</div>
);

const Shown = ({
  at,
  workspaceId,
  traceId,
  profile,
}: Pick<TracesSlotProps, "at" | "workspaceId" | "traceId"> & { readonly profile: Profile }) => {
  const loaded = useProfile(at, profile);
  const detail = loaded.status === "ready" ? loaded.value : null;
  const trace = useOpenTrace(at, traceId);
  const checkout = useCheckout(at);
  const { frame } = useProfileSelection(at);
  const focused = useProfileFocused(at);
  const { hostKey, sessionId } = at;

  useEffect(() => () => setProfileFocused({ hostKey, sessionId }, false), [hostKey, sessionId]);
  const layout = useMemo(() => (detail === null ? null : flameLayout(detail)), [detail]);
  const openInEditor = useOpenInEditor();
  const add = useAddProfile(at, detail, frame, checkout, focused || trace === null);

  const frameFn =
    detail === null || layout === null || frame === null
      ? null
      : (detail.hotFunctions[layout.functionOf[frame] ?? -1] ?? null);

  const open = (fn: ProfileFunction) => {
    const path = functionPath(fn, checkout);

    if (path !== null)
      openInEditor({
        hostKey: at.hostKey,
        root: checkout,
        workspaceId: WorkspaceId.make(workspaceId),
        path,
        line: fn.line,
        column: null,
      });
  };

  return (
    <section
      aria-label="Profile"
      data-testid="profile-panel"
      className="border-hairline bg-panel flex shrink-0 flex-col border-t"
      onFocus={() => setProfileFocused(at, true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setProfileFocused(at, false);
      }}
    >
      <Header
        profile={detail?.profile ?? profile}
        trace={trace}
        frameFn={frameFn}
        checkout={checkout}
        onOpen={open}
        onAdd={detail === null ? null : add}
        onClose={() => selectProfile(at, null)}
      />
      <p className="sr-only" aria-live="polite" data-testid="profile-frame-announce">
        {detail === null || layout === null || frame === null || frameFn === null
          ? ""
          : frameAnnouncement(detail, layout, frame, frameFn, checkout)}
      </p>
      {profile.status === "recording" && detail === null ? (
        <Quiet>
          <p className="text-caption text-text-subtle">
            The flame chart shows once the process stops and its profile is written
          </p>
        </Quiet>
      ) : null}
      {loaded.status === "loading" && profile.status !== "recording" ? (
        <Quiet>
          <p className="text-caption text-text-subtle">Reading the profile…</p>
        </Quiet>
      ) : null}
      {loaded.status === "failed" ? (
        <Quiet>
          <p className="text-caption text-text-default">{loaded.error.message}</p>
          {loaded.error.fix === undefined ? null : (
            <p className="text-caption text-text-subtle">{loaded.error.fix}</p>
          )}
        </Quiet>
      ) : null}
      {detail !== null && layout !== null ? (
        <Body
          at={at}
          detail={detail}
          layout={layout}
          trace={trace}
          checkout={checkout}
          onOpen={open}
        />
      ) : null}
    </section>
  );
};

export const ProfilePanel = ({ at, workspaceId, traceId }: TracesSlotProps) => {
  const { profile } = useProfileSelection(at);

  if (profile === null) return null;

  return (
    <Shown key={profile.id} at={at} workspaceId={workspaceId} traceId={traceId} profile={profile} />
  );
};
