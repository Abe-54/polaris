/**
 * Settings → Reviewer's lower half (DESIGN.md, Settings redesign SR-10): "When it runs"
 * (pull requests, agent sessions, the walkthrough, asking first above a size) beside "What
 * it checks against" (the rules and the review instructions), then the line to Usage.
 */
import {
  SettingsButton,
  type SettingsOption,
  SettingsRow,
  SettingsSelectRow,
  SettingsToggleRow,
  SettingsCard,
  SettingsWell,
} from "@polaris/ui";
import { useShellActions } from "../../../shell/hooks.ts";
import { type RunPolicy, THRESHOLDS, thresholdLabel } from "../model/reviewer.ts";

const NEVER = "never";

const THRESHOLD_OPTIONS: ReadonlyArray<SettingsOption<string>> = THRESHOLDS.map((lines) => ({
  value: lines === null ? NEVER : String(lines),
  label: thresholdLabel(lines),
}));

export const WhenItRuns = ({
  policy,
  walkthrough,
  onWalkthrough,
  onChange,
}: {
  readonly policy: RunPolicy;
  readonly walkthrough: boolean;
  readonly onWalkthrough: (enabled: boolean) => void;
  readonly onChange: (patch: Partial<RunPolicy>) => void;
}) => (
  <SettingsCard title="When it runs">
    <SettingsWell>
      <SettingsToggleRow
        wrap
        title="When a pull request opens in Review"
        caption="Kept per head commit; new commits are reviewed on their own"
        checked={policy.onPullRequests}
        onCheckedChange={(on) => onChange({ onPullRequests: on })}
      />
      <SettingsToggleRow
        wrap
        title="When you open an agent session in Review or accept its turns"
        caption="Rules still run after every turn"
        checked={policy.onSessions}
        onCheckedChange={(on) => onChange({ onSessions: on })}
      />
      <SettingsToggleRow
        wrap
        title="Write a walkthrough"
        caption="Lands first on Overview, rewritten when the head moves"
        checked={walkthrough}
        onCheckedChange={onWalkthrough}
      />
      <SettingsSelectRow
        wrap
        title="Ask first for large changes"
        caption={
          walkthrough
            ? "Rules run at once; the reviewer and the walkthrough wait for “Run both”"
            : "Rules run at once; the reviewer waits for “Run reviewer”"
        }
        value={policy.askAboveLines === null ? NEVER : String(policy.askAboveLines)}
        options={THRESHOLD_OPTIONS}
        onChange={(v) => onChange({ askAboveLines: v === NEVER ? null : Number(v) })}
      />
    </SettingsWell>
  </SettingsCard>
);

const CheckRow = ({
  name,
  what,
  aside,
}: {
  readonly name: string;
  readonly what?: string;
  readonly aside: string;
}) => (
  <SettingsRow wrap title={name} caption={what}>
    <span className="text-caption text-text-subtle whitespace-nowrap">{aside}</span>
  </SettingsRow>
);

/** The Daemon's built-in ast-grep pack (apps/daemon/src/rules/README.md). */
const BUILT_IN_PATTERNS = 28;

export const ChecksAgainst = () => (
  <SettingsCard
    title="What it checks against"
    status="Rules use no tokens · nothing hides a critical finding"
  >
    <SettingsWell>
      <CheckRow
        name="Secrets"
        what="Keys, tokens and credentials · critical, weak matches medium"
        aside="Always on"
      />
      <CheckRow
        name="Dangerous patterns"
        what={`${BUILT_IN_PATTERNS} built-in · TypeScript, Python, Go, Rust, shell`}
        aside="Always on"
      />
      <CheckRow
        name="Review instructions"
        what=".polaris/review.md, and a private file on each host"
        aside="Read every run"
      />
    </SettingsWell>
  </SettingsCard>
);

/** The way to Usage, under the two cards. */
export const UsageLine = () => {
  const { openSettings } = useShellActions();

  return (
    <div className="border-hairline px-panel flex min-h-10 items-center gap-3 rounded-[16px] border py-1.5">
      <span className="text-caption text-text-subtle min-w-0 flex-1 truncate">
        The reviewer&apos;s tokens count in Usage and plan limits like any session&apos;s.
      </span>
      <SettingsButton onClick={() => openSettings("usage")}>Open usage</SettingsButton>
    </div>
  );
};
