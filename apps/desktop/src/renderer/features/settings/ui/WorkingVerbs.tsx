/**
 * Settings → Sessions' "Working verbs" card (DESIGN.md, Working strip): the list the strip
 * rotates through for every Harness, edited in place (add, remove, reset). Claude Code
 * sessions follow `spinnerVerbs` from Claude Code's own settings first, as Claude Code does.
 */
import {
  CloseIcon,
  Dither,
  IconButton,
  Input,
  Kicker,
  SettingsButton,
  SettingsCard,
  SettingsWell,
} from "@polaris/ui";
import { useState } from "react";
import {
  addVerb,
  cleanVerb,
  editableVerbs,
  MAX_VERBS,
  removeVerb,
} from "../../session/verbs/index.ts";
import { setSessionPrefs, useSettings } from "../store.ts";

const save = (verbs: ReadonlyArray<string>) => setSessionPrefs({ spinnerVerbs: [...verbs] });

const AddVerb = ({ app }: { readonly app: ReadonlyArray<string> | null }) => {
  const [draft, setDraft] = useState("");
  const verbs = editableVerbs(app);
  const next = addVerb(app, draft);
  const adds = cleanVerb(draft) !== "" && next.length > verbs.length;

  const add = () => {
    if (!adds) return;
    save(next);
    setDraft("");
  };

  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        add();
      }}
    >
      <Input
        aria-label="New verb"
        className="h-7 flex-1"
        placeholder="Reticulating splines…"
        value={draft}
        maxLength={120}
        onChange={(event) => setDraft(event.target.value)}
        data-testid="verb-input"
      />
      <SettingsButton type="submit" disabled={!adds || verbs.length >= MAX_VERBS}>
        Add
      </SettingsButton>
    </form>
  );
};

/** Chips shown before "+n more". */
const SHOWN = 4;

export const WorkingVerbs = () => {
  const app = useSettings((s) => s.sessions.spinnerVerbs);
  const verbs = editableVerbs(app);
  const [all, setAll] = useState(false);
  const shown = all ? verbs : verbs.slice(0, SHOWN);

  return (
    <SettingsCard
      title="Working verbs"
      aside={`${verbs.length} of ${MAX_VERBS}`}
      status="Claude Code's spinnerVerbs come first"
      action={
        app === null ? undefined : (
          <SettingsButton variant="quiet" onClick={() => setSessionPrefs({ spinnerVerbs: null })}>
            Reset
          </SettingsButton>
        )
      }
    >
      <SettingsWell>
        <div className="px-panel flex items-center gap-2.5 py-[calc(var(--spacing-gap)+4px)]">
          <Dither hue="claude-code" size={12} />
          <span className="text-body text-text-default min-w-0 flex-1 truncate">
            {verbs[0] ?? ""}
          </span>
          <Kicker>As the strip shows it</Kicker>
        </div>
        <div className="px-panel flex flex-col gap-3 py-[calc(var(--spacing-gap)+4px)]">
          <ul
            className="flex flex-wrap items-center gap-1.5"
            aria-label="Verbs"
            data-testid="verb-list"
          >
            {shown.map((verb, index) => (
              <li
                key={verb}
                className="border-hairline text-caption text-text-default flex h-7 max-w-full items-center gap-0.5 rounded-full border pr-0.5 pl-2.5"
              >
                <span className="truncate">{verb}</span>
                <IconButton
                  size="sm"
                  label={`Remove ${verb}`}
                  disabled={verbs.length === 1}
                  icon={<CloseIcon size={10} />}
                  onClick={() => save(removeVerb(app, index))}
                />
              </li>
            ))}
            {verbs.length > SHOWN ? (
              <li>
                <SettingsButton variant="ghost" onClick={() => setAll(!all)}>
                  {all ? "Show fewer" : `+${verbs.length - SHOWN} more`}
                </SettingsButton>
              </li>
            ) : null}
          </ul>
          <AddVerb app={app} />
        </div>
      </SettingsWell>
    </SettingsCard>
  );
};
