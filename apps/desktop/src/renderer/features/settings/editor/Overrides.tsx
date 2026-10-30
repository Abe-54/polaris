/** Advanced → executable overrides on the picked Host: run your own build of a catalog server. */
import * as P from "@polaris/protocol";
import {
  SettingsButton,
  SettingsCard,
  SettingsConfirmRow,
  SettingsEmpty,
  SettingsWell,
} from "@polaris/ui";
import { Schema } from "effect";
import { useState } from "react";
import { Field, FormBlock } from "./fields.tsx";

type Overrides = NonNullable<P.LanguageSettingsPatch["executableOverrides"]>;

const EMPTY = { key: "", executable: "", argv: "[]", environment: "{}" };

const json = (text: string) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(P.LanguageJson))(text);

export const Overrides = ({
  host,
  overrides,
  providers,
  disabled,
  onChange,
}: {
  readonly host: string;
  readonly overrides: Overrides;
  /** The catalog's provider ids, offered as a hint. */
  readonly providers: ReadonlyArray<string>;
  readonly disabled: boolean;
  readonly onChange: (overrides: Overrides) => void;
}) => {
  const [draft, setDraft] = useState(EMPTY);
  const [error, setError] = useState("");

  const add = () => {
    try {
      const launch = Schema.decodeUnknownSync(P.LanguageExecutable)({
        executable: draft.executable,
        argv: json(draft.argv),
        environment: json(draft.environment),
      });

      const next = { ...overrides, [draft.key]: launch };

      const valid = Schema.decodeUnknownSync(P.LanguageSettingsPatch)({
        executableOverrides: next,
      });

      onChange(valid.executableOverrides ?? {});
      setDraft(EMPTY);
      setError("");
    } catch {
      setError(
        "Check the provider ID, the executable path and that arguments and environment are JSON. Values aren't shown here."
      );
    }
  };

  const remove = (key: string) => {
    const { [key]: _removed, ...rest } = overrides;
    onChange(rest);
  };

  return (
    <SettingsCard
      aria-label="Executable overrides"
      title="Executable overrides"
      aside="Your own build of a catalog server"
    >
      {Object.keys(overrides).length === 0 ? (
        <SettingsEmpty>No overrides on {host}</SettingsEmpty>
      ) : (
        <SettingsWell>
          {Object.entries(overrides).map(([key, launch]) => (
            <SettingsConfirmRow
              key={key}
              title={key}
              caption={<span className="font-mono">{launch.executable}</span>}
              action="Remove"
              consequence={`Removing it runs the catalog's ${key} on ${host} again.`}
              confirm={`Remove the override for ${key}`}
              onConfirm={() => remove(key)}
              {...(disabled ? { disabledReason: `Reading ${host}'s language settings…` } : {})}
            />
          ))}
        </SettingsWell>
      )}
      <SettingsWell rows={false} aria-label="New override">
        <FormBlock>
          <Field
            label="Provider ID"
            {...(providers.length > 0 ? { hint: `One of ${providers.join(", ")}.` } : {})}
            value={draft.key}
            disabled={disabled}
            onChange={(key) => setDraft({ ...draft, key })}
          />
          <Field
            label="Executable on the host"
            value={draft.executable}
            disabled={disabled}
            onChange={(executable) => setDraft({ ...draft, executable })}
          />
          <Field
            label="Arguments"
            hint="A JSON array of strings, never a shell command."
            value={draft.argv}
            disabled={disabled}
            onChange={(argv) => setDraft({ ...draft, argv })}
          />
          <Field
            label="Environment"
            hint="A JSON object of strings. Values stay private: never shown or logged."
            secret
            value={draft.environment}
            disabled={disabled}
            onChange={(environment) => setDraft({ ...draft, environment })}
          />
          {error && (
            <p role="alert" className="text-caption text-text-default">
              {error}
            </p>
          )}
          <SettingsButton className="self-start" disabled={disabled} onClick={add}>
            Add override
          </SettingsButton>
        </FormBlock>
      </SettingsWell>
    </SettingsCard>
  );
};
