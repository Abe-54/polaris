/**
 * Settings → Sessions' "Suggested replies" card (ENG-887, ADR 0106): the switch, then the
 * fallback Harness and Model for Harnesses without their own, and what it costs. One setting for
 * every host: the Desktop App writes it to each (suggestedRepliesSync).
 */
import { AUTO_SUGGESTED_REPLY_FALLBACKS } from "@polaris/protocol";
import { cn, SettingsCard, SettingsSwitch, SettingsWell } from "@polaris/ui";
import type { SuggestedRepliesPref } from "../../../../shared/contract.ts";
import { commitMessageModel } from "../../../../shared/sessionPrefs.ts";
import type { Choice } from "../model/reviewer.ts";
import { setSessionPrefs, useSettings } from "../store.ts";
import { useResolvedFallbacks } from "../suggestedRepliesSync.ts";
import { ReviewerChoice, useModelName } from "./ReviewerChoice.tsx";
import { useModelHost } from "./ReviewerPage.tsx";

/** A new Harness starts on its automatic Model, or its commit-message one. */
const fallbackFor = (next: Choice, previous: Choice | null): Choice => {
  const auto = AUTO_SUGGESTED_REPLY_FALLBACKS.find((f) => f.harness === next.harness);

  const model =
    next.harness === previous?.harness
      ? next.model
      : (auto?.model ?? commitMessageModel(next.harness));

  return {
    harness: next.harness,
    model,
    effort: auto !== undefined && auto.model === model ? auto.effort : null,
  };
};

/** The fallback the user picked, else the one the first answering Host resolves to. */
const useResolved = (fallback: SuggestedRepliesPref["fallback"]): Choice | null => {
  const resolved = useResolvedFallbacks();

  return fallback ?? Object.values(resolved).find((choice) => choice != null) ?? null;
};

/** The cost, stated once: one small request on the resolved model after each Turn. */
export const fallbackCost = (model: string | null) =>
  model === null
    ? "Claude Code suggests its own. Other harnesses use one small request after each turn, on the cheapest fast model that's ready."
    : `Claude Code suggests its own. Other harnesses use one small request on ${model} after each turn.`;

export const SuggestedRepliesCard = () => {
  const { enabled, fallback } = useSettings((s) => s.sessions.suggestedReplies);
  const modelHost = useModelHost();
  const resolved = useResolved(fallback);
  const resolvedHost = resolved === null ? null : modelHost(resolved.harness);
  const modelName = useModelName(resolvedHost, resolved?.harness ?? "");
  const model = resolved?.model == null ? null : modelName(resolved.model);

  const save = (next: Partial<SuggestedRepliesPref>) =>
    setSessionPrefs({ suggestedReplies: { enabled, fallback, ...next } });

  return (
    <SettingsCard
      title={
        <span className="flex items-baseline gap-2">
          Suggested replies
          <span className="text-caption text-text-subtle font-normal">
            {enabled ? "Offered in an empty composer when a turn ends" : "Off"}
          </span>
        </span>
      }
      aside={
        <SettingsSwitch
          aria-label="Suggest replies"
          checked={enabled}
          onCheckedChange={(on) => save({ enabled: on })}
        />
      }
      status="Every host · Tab accepts a suggestion"
    >
      <SettingsWell className={cn(!enabled && "opacity-(--opacity-dimmed)")}>
        <p className="px-panel text-caption text-text-subtle py-[calc(var(--spacing-gap)+4px)]">
          {fallbackCost(model)}
        </p>
        <div className="px-panel flex flex-wrap items-center gap-x-3 gap-y-2 py-[calc(var(--spacing-gap)+4px)]">
          <span className="text-body text-text-default flex-1 whitespace-nowrap">Written by</span>
          <div className="flex min-w-0 shrink items-center">
            <ReviewerChoice
              value={fallback}
              allowAuto
              modelOnly
              modelHost={modelHost}
              onChange={(next) =>
                save({ fallback: next === null ? null : fallbackFor(next, fallback) })
              }
            />
          </div>
        </div>
      </SettingsWell>
    </SettingsCard>
  );
};
