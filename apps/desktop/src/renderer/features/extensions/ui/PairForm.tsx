/**
 * Pairing an Extension inside its host's card (Paper SR-07): a name, and the Grant as chips,
 * read only at first. A Grant is fixed once paired.
 */
import type { Grant, GrantKind } from "@polaris/protocol";
import { cn, Input, SettingsButton, SettingsRow, SettingsWell } from "@polaris/ui";
import { useState } from "react";
import { DEFAULT_GRANT, GRANT_CHOICES, type GrantChoice, pairName, toggleGrant } from "../model.ts";

const Check = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className="shrink-0">
    <path d="M2 5.2l2 2L8 3" fill="none" stroke="currentColor" strokeWidth="1.4" />
  </svg>
);

const Chip = ({
  id,
  choice,
  checked,
  onToggle,
  onHint,
}: {
  readonly id: string;
  readonly choice: GrantChoice;
  readonly checked: boolean;
  readonly onToggle: () => void;
  readonly onHint: (help: string | null) => void;
}) => (
  <label
    htmlFor={id}
    onPointerEnter={() => onHint(choice.help)}
    onPointerLeave={() => onHint(null)}
    className={cn(
      "text-caption flex h-7 cursor-default items-center gap-1.5 rounded-full border px-3 select-none has-focus-visible:outline-2 has-focus-visible:outline-starlight",
      checked
        ? "text-text-strong border-[light-dark(#00000029,#ffffff29)] bg-[light-dark(#0000000f,#ffffff0f)]"
        : "text-text-subtle border-[light-dark(#00000014,#ffffff14)]"
    )}
  >
    <input
      type="checkbox"
      id={id}
      checked={checked}
      onChange={onToggle}
      onFocus={() => onHint(choice.help)}
      onBlur={() => onHint(null)}
      aria-describedby={`${id}-help`}
      className="sr-only"
    />
    {checked ? <Check /> : null}
    {choice.label}
  </label>
);

/** What the chosen Grant allows, one line: "See agent sessions… · Allow or deny approvals…". */
const allows = (grant: ReadonlyArray<GrantKind>) =>
  GRANT_CHOICES.filter((c) => grant.includes(c.kind))
    .map((c) => c.help)
    .join(" · ") || "Nothing yet. Choose at least what it needs.";

export const PairForm = ({
  hostKey,
  hostLabel,
  onPair,
  onCancel,
}: {
  readonly hostKey: string;
  readonly hostLabel: string;
  readonly onPair: (name: string, grant: Grant) => Promise<void>;
  readonly onCancel: () => void;
}) => {
  const [draft, setDraft] = useState("");
  const [grant, setGrant] = useState<ReadonlyArray<GrantKind>>(DEFAULT_GRANT);
  const [hint, setHint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const name = pairName(draft);
  const nameId = `pair-name-${hostKey}`;

  const submit = () => {
    if (name === null || busy) return;
    setBusy(true);
    void onPair(name, grant).finally(() => setBusy(false));
  };

  return (
    <form
      className="gap-gap flex flex-col"
      aria-label={`Pair an extension with ${hostLabel}`}
      data-testid="pair-form"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <SettingsWell>
        <SettingsRow title="Name" htmlFor={nameId}>
          <Input
            id={nameId}
            autoFocus
            value={draft}
            placeholder="Raycast"
            onChange={(event) => setDraft(event.currentTarget.value)}
            className="bg-raised-control h-7 w-60 font-mono text-[12px]"
          />
        </SettingsRow>
        <fieldset className="px-panel flex flex-col gap-2.5 py-[calc(var(--spacing-gap)+4px)]">
          <legend className="text-body text-text-default float-left w-full">Allow it to</legend>
          <div className="flex flex-wrap gap-2">
            {GRANT_CHOICES.map((choice) => (
              <Chip
                key={choice.kind}
                id={`grant-${hostKey}-${choice.kind}`}
                choice={choice}
                checked={grant.includes(choice.kind)}
                onToggle={() => setGrant((g) => toggleGrant(g, choice.kind))}
                onHint={setHint}
              />
            ))}
          </div>
          {GRANT_CHOICES.map((choice) => (
            <span key={choice.kind} id={`grant-${hostKey}-${choice.kind}-help`} className="sr-only">
              {choice.help}
            </span>
          ))}
          <p className="text-caption text-text-subtle" aria-live="polite">
            {hint ?? allows(grant)}
          </p>
        </fieldset>
      </SettingsWell>
      <div className="pl-gap flex min-h-10 items-center gap-2">
        <span className="text-caption text-text-subtle min-w-0 flex-1 truncate">
          You can't change a grant later; revoke and pair again instead.
        </span>
        <SettingsButton variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </SettingsButton>
        <SettingsButton type="submit" variant="primary" disabled={name === null || busy}>
          Pair
        </SettingsButton>
      </div>
    </form>
  );
};
