import { useState } from "react";

import {
  SettingsButton,
  SettingsCard,
  SettingsConfirmRow,
  SettingsEmpty,
  SettingsEmptyTile,
  SettingsGrid,
  SettingsHostRow,
  SettingsOverrideRow,
  SettingsPage,
  SettingsRow,
  SettingsSelect,
  SettingsSelectRow,
  SettingsStepperRow,
  SettingsToggleRow,
  SettingsWell,
} from "../../src";
import { Section } from "./layout";

const ScreenGlyph = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
    <rect x="1.5" y="2.5" width="9" height="6" rx="1" fill="none" stroke="currentColor" />
    <path d="M4 10.5h4" stroke="currentColor" />
  </svg>
);

const PhoneGlyph = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden>
    <rect
      x="6.5"
      y="3.5"
      width="7"
      height="13"
      fill="none"
      stroke="var(--tile-ink, currentColor)"
    />
    <rect x="9" y="14" width="2" height="1" fill="var(--tile-ink, currentColor)" />
  </svg>
);

const COMMIT = [
  { value: "default", label: "Branch only from the default branch", short: "Branch from default" },
  { value: "current", label: "Commit to the current branch" },
] as const;

type Archive = "7" | "30" | "never";

const ARCHIVE: ReadonlyArray<{ value: Archive; label: string }> = [
  { value: "7", label: "After 7 days" },
  { value: "30", label: "After 30 days" },
  { value: "never", label: "Never" },
];

function WhileSessionsRun() {
  const [notify, setNotify] = useState(true);
  const [commit, setCommit] = useState<"default" | "current">("default");
  const [minutes, setMinutes] = useState(5);

  return (
    <SettingsCard
      title="While sessions run"
      aside="4 of 5 on"
      status="macOS notifications · your phone has its own switch"
      action={<SettingsButton>Open notification settings</SettingsButton>}
    >
      <SettingsWell>
        <SettingsToggleRow
          title="Notify when a session needs you"
          caption="Unless Polaris is showing that session"
          checked={notify}
          onCheckedChange={setNotify}
        />
        <SettingsSelectRow
          title="Where accepted turns are committed"
          caption="New branches are named polaris/<session>"
          value={commit}
          options={COMMIT}
          onChange={setCommit}
        />
        <SettingsStepperRow
          title="Only turns longer than"
          nested
          dimmed={!notify}
          value={minutes}
          min={1}
          max={60}
          onChange={setMinutes}
          format={(n) => `${n} min`}
        />
      </SettingsWell>
    </SettingsCard>
  );
}

function ArchiveDormant() {
  const [studio, setStudio] = useState<Archive>("7");
  const [dotfiles, setDotfiles] = useState<Archive | null>("30");
  const [polaris, setPolaris] = useState<Archive | null>(null);

  return (
    <SettingsCard
      title="Archive dormant sessions"
      aside="Saved on each host"
      status="Pinned and constellation sessions are kept"
    >
      <SettingsWell>
        <SettingsHostRow name="Mac Studio" colour="#8FB0E8" fact="macOS arm64">
          <SettingsSelect
            label="Mac Studio"
            value={studio}
            options={ARCHIVE}
            onChange={setStudio}
          />
        </SettingsHostRow>
        <SettingsHostRow
          name="Raspberry Pi 4"
          colour="#9FD0B4"
          fact="Offline · last seen 2h ago"
          offline
        />
      </SettingsWell>
      <SettingsWell>
        <SettingsOverrideRow
          name="polaris"
          value={polaris}
          options={ARCHIVE}
          defaultLabel="After 7 days"
          onChange={setPolaris}
        />
        <SettingsOverrideRow
          name="dotfiles"
          value={dotfiles}
          options={ARCHIVE}
          defaultLabel="After 7 days"
          onChange={setDotfiles}
        />
      </SettingsWell>
    </SettingsCard>
  );
}

function Controls() {
  const [account, setAccount] = useState<"lux" | undefined>(undefined);

  return (
    <SettingsCard
      title="Controls"
      aside={<SettingsButton variant="ghost">Edit overrides</SettingsButton>}
    >
      <SettingsWell>
        <SettingsRow title="Buttons" caption="28px pills: primary, secondary, ghost, danger, quiet">
          <SettingsButton variant="primary">Add account</SettingsButton>
          <SettingsButton>Check now</SettingsButton>
          <SettingsButton variant="ghost">Unhide</SettingsButton>
          <SettingsButton variant="quiet">Reset</SettingsButton>
        </SettingsRow>
        <SettingsRow title="Account for acme" caption="Dashed until it is set">
          <SettingsSelect
            label="Account for acme"
            value={account}
            placeholder="Choose account"
            options={[{ value: "lux", label: "lux (github.com)" }]}
            onChange={setAccount}
          />
        </SettingsRow>
        <SettingsConfirmRow
          title="Even G2"
          caption="Read · approve · send turns · used 3h ago"
          action="Revoke"
          consequence="Revoking disconnects it now. To use it again, pair it again."
          confirm="Revoke Even G2"
          onConfirm={() => {}}
        />
        <SettingsConfirmRow
          title="~/code/old-api"
          caption="Hidden 3 days ago"
          action="Remove workspace…"
          consequence="Polaris forgets old-api and its agent sessions. The folder stays on disk."
          confirm="Remove old-api"
          disabledReason="2 agent sessions remain"
          onConfirm={() => {}}
        >
          <SettingsButton variant="ghost">Unhide</SettingsButton>
        </SettingsConfirmRow>
      </SettingsWell>
    </SettingsCard>
  );
}

/** Paper SR-Kit: the page header, cards two-up, every row and the empty states. */
export function SettingsKitSection() {
  return (
    <Section title="Settings kit (SR-Kit)">
      <div className="bg-ground rounded-card -mx-2">
        <SettingsPage
          title="Sessions"
          blurb="How new agent sessions start, and what happens while they run."
          scope="This Mac · archive and setup per host"
          scopeIcon={<ScreenGlyph />}
          className="py-section"
        >
          <SettingsGrid>
            <WhileSessionsRun />
            <ArchiveDormant />
          </SettingsGrid>
          <Controls />
          <SettingsGrid>
            <SettingsCard title="Hidden workspaces">
              <SettingsEmpty>No hidden workspaces</SettingsEmpty>
            </SettingsCard>
            <SettingsCard title="Linked devices">
              <SettingsEmptyTile
                icon={<PhoneGlyph />}
                title="No linked devices"
                caption="Link your phone once; it reaches every relay host."
                action={<SettingsButton>Link a device</SettingsButton>}
              />
            </SettingsCard>
          </SettingsGrid>
        </SettingsPage>
      </div>
    </Section>
  );
}
