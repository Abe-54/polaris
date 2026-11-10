/**
 * The transcript's inline prompt (Paper CU3): a Turn needs computer use while its Host is off
 * or needs setup, so the session needs you. One fix and "Not now"; it goes once it's ready.
 */
import type { ComputerUseState } from "@polaris/protocol";
import { Kicker, SettingsButton } from "@polaris/ui";
import type { HostFacts } from "../model.ts";
import { type PromptAsk, type PromptFix, promptView } from "../prompt.ts";

export interface InlinePromptProps {
  readonly host: HostFacts;
  readonly state: ComputerUseState;
  readonly ask: PromptAsk;
  readonly busy: boolean;
  readonly onFix: (fix: PromptFix) => void;
  readonly onNotNow: () => void;
}

export const InlinePrompt = ({ host, state, ask, busy, onFix, onNotNow }: InlinePromptProps) => {
  const view = promptView(host, state, ask);

  if (view === null) return null;

  return (
    <div
      data-testid="computer-use-prompt"
      className="bg-raised border-hairline flex flex-col gap-1.5 rounded-[12px] border px-3.5 py-3"
    >
      <div className="flex items-center gap-2">
        <span aria-hidden className="bg-needs-you size-1.5 shrink-0 rounded-full" />
        <span className="text-body text-text-strong">{view.title}</span>
      </div>
      <p className="text-caption text-text-subtle">{view.line}</p>
      <div className="flex flex-wrap items-center gap-2 pt-1.5">
        <SettingsButton variant="primary" disabled={busy} onClick={() => onFix(view.fix)}>
          {view.fix.label}
        </SettingsButton>
        <SettingsButton variant="quiet" onClick={onNotNow}>
          Not now
        </SettingsButton>
        {view.note === null ? null : (
          <Kicker className="font-normal tracking-[0.06em]">{view.note}</Kicker>
        )}
      </div>
    </div>
  );
};
