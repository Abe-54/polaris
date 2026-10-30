/**
 * Settings → Sessions' "Idle compaction" card (ENG-562): the switch, the timeline (turn, idle,
 * compact at 55 minutes, the prompt cache ends at 60), the minimum context, and the line the
 * conversation shows. One setting for every host: the Desktop App writes it to each.
 */
import { MIN_IDLE_COMPACTION_TOKENS } from "@polaris/protocol";
import {
  cn,
  Kicker,
  SettingsCard,
  SettingsStepperRow,
  SettingsSwitch,
  SettingsWell,
} from "@polaris/ui";
import { setSessionPrefs, useSettings } from "../store.ts";

/** Tokens a press moves the minimum. */
const TOKEN_STEP = 50_000;

const MAX_TOKENS = 9_999_000;

const LANE = "text-text-subtle font-mono text-[10px] leading-3 tracking-[0.06em] uppercase";

/** Turn, idle, compact, then the cache's last minutes; the lanes line up with their labels. */
const Timeline = () => (
  <div className="px-panel flex flex-col gap-2 pt-[calc(var(--spacing-gap)+6px)] pb-[calc(var(--spacing-gap)+2px)]">
    <div className="flex h-3 items-center" aria-hidden>
      <span className="bg-text-subtle h-1 w-[18%] shrink-0" />
      <span className="border-text-faint h-0 flex-1 border-t border-dotted" />
      <span className="flex w-16 shrink-0 justify-center">
        <span className="bg-text-strong size-3" />
      </span>
      <span className="border-text-faint h-0 w-20 shrink-0 border-t border-dotted" />
      <span className="border-text-subtle h-3 shrink-0 border-l border-dashed" />
    </div>
    <div className="flex">
      <span className={cn(LANE, "w-[18%] shrink-0")}>Turn</span>
      <span className={cn(LANE, "flex-1 text-center")}>Idle 55 min</span>
      <span className={cn(LANE, "text-text-default w-16 shrink-0 text-center")}>Compact</span>
      <span className={cn(LANE, "w-20 shrink-0 text-right")}>Cache ends</span>
    </div>
  </div>
);

/** The summary the conversation shows for an idle compaction (conversation.idleCompaction). */
const ConversationLine = () => (
  <div className="px-panel flex flex-col gap-1.5 py-[calc(var(--spacing-gap)+4px)]">
    <Kicker>In the conversation</Kicker>
    <div className="text-caption text-text-default flex items-center gap-3">
      <span className="bg-hairline h-px flex-1" />
      Compacted while idle, before the prompt cache expired
      <span className="bg-hairline h-px flex-1" />
    </div>
  </div>
);

export const IdleCompactionCard = () => {
  const { enabled, minTokens } = useSettings((s) => s.sessions.idleCompaction);

  return (
    <SettingsCard
      title="Idle compaction"
      aside={
        <SettingsSwitch
          aria-label="Compact idle sessions"
          checked={enabled}
          onCheckedChange={(on) => setSessionPrefs({ idleCompaction: { enabled: on, minTokens } })}
        />
      }
      status="Every host · never while a session works or needs you"
    >
      <SettingsWell className={cn(!enabled && "opacity-(--opacity-dimmed)")}>
        <Timeline />
        <SettingsStepperRow
          title="Minimum context"
          caption="Smaller sessions are left alone"
          value={minTokens}
          min={MIN_IDLE_COMPACTION_TOKENS}
          max={MAX_TOKENS}
          step={TOKEN_STEP}
          format={(tokens) => tokens.toLocaleString("en-US")}
          disabled={!enabled}
          onChange={(next) => setSessionPrefs({ idleCompaction: { enabled, minTokens: next } })}
        />
        <ConversationLine />
      </SettingsWell>
    </SettingsCard>
  );
};
