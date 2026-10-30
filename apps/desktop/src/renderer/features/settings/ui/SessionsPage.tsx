/**
 * Settings → Sessions (DESIGN.md, Settings redesign SR-01): new sessions beside accepting work,
 * what happens while sessions run, Visuals, idle compaction beside archive, hidden workspaces, then
 * worker worktree setup beside the Working strip's verbs, on the Settings kit.
 * Each Harness's Model, effort and permissions stay in Settings → Harnesses.
 */
import {
  Input,
  Kicker,
  SettingsButton,
  SettingsCard,
  SettingsGrid,
  SettingsPage,
  SettingsRow,
  SettingsToggleRow,
  SettingsWell,
} from "@polaris/ui";
import { useState } from "react";
import { clientCopy } from "../../../../shared/clientCopy.ts";
import { isBranchPrefix } from "../../../../shared/sessionPrefs.ts";
import { useShellActions } from "../../../shell/hooks.ts";
import { sectionInfo } from "../model/sections.ts";
import { setSessionPrefs, useSettings } from "../store.ts";
import { AcceptingWorkCard } from "./AcceptBranch.tsx";
import { ArchiveCard } from "./AutoArchive.tsx";
import { HiddenWorkspaces } from "./HiddenWorkspaces.tsx";
import { IdleCompactionCard } from "./IdleCompaction.tsx";
import { TurnNotifications } from "./TurnNotifications.tsx";
import { Visuals } from "./Visuals.tsx";
import { WorkingVerbs } from "./WorkingVerbs.tsx";
import { WorktreeSetupSettings } from "./WorktreeSetup.tsx";

const ScreenGlyph = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
    <rect x="1.5" y="2.5" width="9" height="6" rx="1" fill="none" stroke="currentColor" />
    <path d="M4 10.5h4" stroke="currentColor" />
  </svg>
);

/** Saved on blur or ↵ when git would take it; otherwise the field says why and keeps the old one. */
const BranchPrefixField = ({ value }: { readonly value: string }) => {
  const [draft, setDraft] = useState(value);
  const valid = isBranchPrefix(draft.trim());

  const save = () => {
    const next = draft.trim();

    if (isBranchPrefix(next) && next !== value) setSessionPrefs({ branchPrefix: next });
  };

  return (
    <Input
      id="branch-prefix"
      className="text-code-inline h-[26px] w-[120px] font-mono"
      value={draft}
      placeholder="none"
      aria-invalid={!valid}
      spellCheck={false}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={save}
      onKeyDown={(event) => {
        if (event.key === "Enter") save();
      }}
    />
  );
};

const example = (prefix: string) => `${prefix}fix-the-login-form-3f9a`;

const NewSessionsCard = () => {
  const prefs = useSettings((s) => s.sessions);

  return (
    <SettingsCard
      title="New sessions"
      aside="Each can still choose"
      status={`Next · ${example(prefs.branchPrefix)}`}
    >
      <SettingsWell>
        <SettingsToggleRow
          title="Start on a new worktree"
          caption="Otherwise in the workspace folder"
          checked={prefs.newWorktree}
          onCheckedChange={(on) => setSessionPrefs({ newWorktree: on })}
        />
        <SettingsRow title="Branch prefix" caption="Named from the prompt" htmlFor="branch-prefix">
          <BranchPrefixField key={prefs.branchPrefix} value={prefs.branchPrefix} />
        </SettingsRow>
      </SettingsWell>
    </SettingsCard>
  );
};

const WhileSessionsRunCard = () => {
  const prefs = useSettings((s) => s.sessions);

  const notify = [
    prefs.notifyNeedsYou,
    prefs.notifyConstellations,
    prefs.notifyReviewRequests,
    prefs.notifyTurnEnded,
    prefs.quietPhoneWhilePresent,
  ];

  return (
    <SettingsCard
      title="While sessions run"
      aside={`${notify.filter(Boolean).length} of ${notify.length} notifications on`}
      status={`${clientCopy().os} notifications · your phone has its own switches`}
    >
      <SettingsWell>
        <SettingsToggleRow
          title="Open output on a turn's first edit"
          caption="Once per turn; closing it keeps it closed until the next"
          checked={prefs.openOutputOnEdit}
          onCheckedChange={(on) => setSessionPrefs({ openOutputOnEdit: on })}
        />
      </SettingsWell>
      <SettingsWell aria-label="Notify me">
        <Kicker className="px-panel pt-[calc(var(--spacing-gap)+2px)]">
          Notify me · unless Polaris is showing that session
        </Kicker>
        <SettingsToggleRow
          title="When a session needs you"
          caption="The star still counts"
          checked={prefs.notifyNeedsYou}
          onCheckedChange={(on) => setSessionPrefs({ notifyNeedsYou: on })}
        />
        <SettingsToggleRow
          title="When a constellation needs you"
          caption="A question to you or a claim the lead hands up, once each"
          checked={prefs.notifyConstellations}
          onCheckedChange={(on) => setSessionPrefs({ notifyConstellations: on })}
        />
        <SettingsToggleRow
          title="When your review is requested"
          caption="One per new request on GitHub"
          checked={prefs.notifyReviewRequests}
          onCheckedChange={(on) => setSessionPrefs({ notifyReviewRequests: on })}
        />
        <TurnNotifications />
        <SettingsToggleRow
          title="Quiet my phone while I'm at this computer"
          caption="Hosts hold your phone's notifications until you step away or lock the screen"
          checked={prefs.quietPhoneWhilePresent}
          onCheckedChange={(on) => setSessionPrefs({ quietPhoneWhilePresent: on })}
        />
      </SettingsWell>
    </SettingsCard>
  );
};

export const SessionsPage = () => {
  const { openSettings } = useShellActions();
  const info = sectionInfo("sessions");

  return (
    <SettingsPage
      title={info.title}
      blurb="How new agent sessions start, and what happens while they run."
      scope="This Mac · archive and setup per host"
      scopeIcon={<ScreenGlyph />}
    >
      <SettingsGrid>
        <NewSessionsCard />
        <AcceptingWorkCard />
      </SettingsGrid>
      <WhileSessionsRunCard />
      <Visuals />
      <SettingsGrid>
        <IdleCompactionCard />
        <ArchiveCard />
      </SettingsGrid>
      <HiddenWorkspaces />
      <SettingsGrid>
        <WorktreeSetupSettings />
        <WorkingVerbs />
      </SettingsGrid>
      <p className="text-caption text-text-subtle px-gap flex items-center gap-2">
        Model, effort and permissions start per harness.
        <SettingsButton onClick={() => openSettings("harnesses")}>Open harnesses</SettingsButton>
      </p>
    </SettingsPage>
  );
};
