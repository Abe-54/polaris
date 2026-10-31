/**
 * Add data source (DESIGN.md, Data → Sidebar): a manual source posted with `data.source.save`.
 * The password is write-only: never shown, never read back, and blank keeps the saved one.
 */
import type { DataSource, DataSourceLabel } from "@polaris/protocol";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  SegmentedControl,
} from "@polaris/ui";
import { type FormEvent, type ReactNode, type RefObject, useRef, useState } from "react";
import type { IpcError } from "../../../../../shared/api.ts";
import { useDataApi } from "../../data/hooks.tsx";
import { closeSourceForm, type SourceForm as Form, useSourceForm } from "../../model/sidebar.ts";
import { MANUAL_LABEL } from "../../model/source.ts";
import type { DataSessionKey } from "../../model/store.ts";
import { LabelSwatches } from "../connection/LabelSwatches.tsx";

const PORTS: Record<DataSource["engine"], number> = { postgres: 5432, mysql: 3306 };

/** The password isn't here: it stays in its uncontrolled field, so it never reaches the DOM's attributes. */
export interface Draft {
  readonly name: string;
  readonly engine: DataSource["engine"];
  readonly host: string;
  readonly port: string;
  readonly database: string;
  readonly user: string;
  /** null until the user picks one (`MANUAL_LABEL`); its text as typed, uppercased on save. */
  readonly label: DataSourceLabel | null;
  /** Editing only: Save removes the saved password (`passwordAction: "clear"`). */
  readonly clearPassword: boolean;
}

const draftOf = (form: Form): Draft =>
  form.mode === "add"
    ? {
        name: "",
        engine: "postgres",
        host: "localhost",
        port: "",
        database: "",
        user: "",
        label: null,
        clearPassword: false,
      }
    : {
        name: form.source.name,
        engine: form.source.engine,
        host: form.source.host,
        port: String(form.source.port),
        database: form.source.database,
        user: form.source.user ?? "",
        label: form.source.label,
        clearPassword: false,
      };

/** The Daemon's rule (data/sources.ts): it trims and lowercases, then takes `[a-z0-9][a-z0-9._-]*`. */
const NAME_RULE = /^[a-z0-9][a-z0-9._-]*$/;

/** The name the Host saves: trimmed and lowercased. */
export const savedName = (name: string) => name.trim().toLowerCase();

export const NAME_PROBLEM = "Use only a–z, 0–9, “.”, “_” or “-”, starting with a letter or digit";

/** The first thing missing or wrong, in the form's order; null when it can be saved. */
export const problemOf = (draft: Draft): string | null => {
  if (draft.name.trim() === "") return "Name the data source";

  if (!NAME_RULE.test(savedName(draft.name))) return NAME_PROBLEM;

  if (draft.host.trim() === "") return "Enter the host";
  const port = draft.port === "" ? PORTS[draft.engine] : Number(draft.port);

  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    return "The port is a number from 1 to 65535";

  return draft.database.trim() === "" ? "Enter the database" : null;
};

/** The Daemon's catch-all for a save it can't match to a source (data/sources.ts `unknownSource`). */
const NO_SUCH_SOURCE = "No data source by that name in this checkout.";

/** What a failed save says: the Daemon's lookup message read as what the user did. */
export const saveErrorText = (error: IpcError, editing: boolean): string => {
  if (error.code !== "E-DATA-UNKNOWN-SOURCE" || error.message !== NO_SUCH_SOURCE)
    return error.message;

  return editing
    ? "This data source is no longer in this checkout. Close the form and look again."
    : `The Host couldn't save it under that name. ${NAME_PROBLEM}, and check the host and database.`;
};

const Field = ({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string | undefined;
  children: ReactNode;
}) => (
  <label className="flex flex-col gap-1">
    <span className="text-caption text-text-subtle">{label}</span>
    {children}
    {hint === undefined ? null : <span className="text-caption text-text-faint">{hint}</span>}
  </label>
);

const NameField = ({ draft, set, editing }: FieldsProps) => {
  const saved = savedName(draft.name);
  const renamed = saved !== draft.name.trim() && NAME_RULE.test(saved);

  return (
    <Field label="Name" hint={renamed ? `Saved as ${saved}` : undefined}>
      <Input
        value={draft.name}
        disabled={editing}
        autoFocus={!editing}
        placeholder="analytics"
        dir="auto"
        onChange={(e) => set({ name: e.target.value })}
      />
    </Field>
  );
};

const passwordHint = (draft: Draft, editing: boolean) => {
  if (!editing) return "Kept on the Host. Agents never see it.";

  return draft.clearPassword
    ? "Save removes the saved password."
    : "Leave blank to keep the saved password. Agents never see it.";
};

const PasswordField = ({ draft, set, editing, password }: FieldsProps) => (
  <div className="flex flex-col gap-1">
    <Field label="Password" hint={passwordHint(draft, editing)}>
      <Input
        ref={password}
        type="password"
        autoComplete="new-password"
        defaultValue=""
        disabled={draft.clearPassword}
        data-testid="data-source-password"
      />
    </Field>
    {editing ? (
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="self-start"
        data-testid="data-source-clear-password"
        aria-pressed={draft.clearPassword}
        onClick={() => set({ clearPassword: !draft.clearPassword })}
      >
        {draft.clearPassword ? "Keep the saved password" : "Remove saved password"}
      </Button>
    ) : null}
  </div>
);

interface FieldsProps {
  readonly draft: Draft;
  readonly set: (patch: Partial<Draft>) => void;
  readonly editing: boolean;
  readonly password: RefObject<HTMLInputElement | null>;
}

const Fields = (props: FieldsProps) => {
  const { draft, set } = props;
  const label = draft.label ?? MANUAL_LABEL;

  return (
    <div className="flex flex-col gap-3 px-5 pb-4">
      <NameField {...props} />
      <SegmentedControl<DataSource["engine"]>
        aria-label="Engine"
        variant="fill"
        value={draft.engine}
        onValueChange={(engine) => set({ engine })}
        options={[
          { value: "postgres", label: "PostgreSQL" },
          { value: "mysql", label: "MySQL" },
        ]}
      />
      <div className="grid grid-cols-[1fr_96px] gap-2">
        <Field label="Host">
          <Input value={draft.host} onChange={(e) => set({ host: e.target.value })} />
        </Field>
        <Field label="Port">
          <Input
            inputMode="numeric"
            value={draft.port}
            placeholder={String(PORTS[draft.engine])}
            onChange={(e) => set({ port: e.target.value })}
          />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Database">
          <Input value={draft.database} onChange={(e) => set({ database: e.target.value })} />
        </Field>
        <Field label="User">
          <Input value={draft.user} onChange={(e) => set({ user: e.target.value })} />
        </Field>
      </div>
      <PasswordField {...props} />
      <div className="flex items-end gap-3">
        <Field label="Label">
          {/* Uppercase on screen only: rewriting the value would move the caret (F8). */}
          <Input
            className="font-mono uppercase"
            value={label.text}
            data-testid="data-source-label"
            onChange={(e) => set({ label: { ...label, text: e.target.value } })}
          />
        </Field>
        <div className="pb-0.5">
          <LabelSwatches
            value={label.colour}
            onChange={(colour) => set({ label: { ...label, colour } })}
          />
        </div>
      </div>
    </div>
  );
};

/** What `data.source.save` gets: blank keeps the saved password, a typed one sets it. */
const saveInput = (draft: Draft, password: string) => {
  const label = draft.label ?? MANUAL_LABEL;

  const input = {
    name: savedName(draft.name),
    engine: draft.engine,
    host: draft.host.trim(),
    port: draft.port === "" ? PORTS[draft.engine] : Number(draft.port),
    database: draft.database.trim(),
    user: draft.user.trim(),
    label: { ...label, text: label.text.toUpperCase() },
  };

  if (draft.clearPassword) return { ...input, passwordAction: "clear" as const };

  return password === "" ? input : { ...input, password };
};

const Body = ({ at, form }: { readonly at: DataSessionKey; readonly form: Form }) => {
  const api = useDataApi();
  const [draft, setDraft] = useState(() => draftOf(form));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const password = useRef<HTMLInputElement>(null);
  const editing = form.mode === "edit";
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const problem = problemOf(draft);

    if (problem !== null) return setError(problem);
    setSaving(true);
    const result = await api.saveSource(at, saveInput(draft, password.current?.value ?? ""));

    setSaving(false);

    if (result.ok) closeSourceForm(at);
    else setError(saveErrorText(result.error, editing));
  };

  return (
    <form onSubmit={(e) => void submit(e)} data-testid="data-source-form">
      <DialogHeader>
        <DialogTitle>{editing ? `Edit ${form.source.name}` : "Add data source"}</DialogTitle>
        <DialogDescription>
          Agents in this checkout can query it by name. A remote one needs your approval first.
        </DialogDescription>
      </DialogHeader>
      <Fields draft={draft} set={set} editing={editing} password={password} />
      <DialogFooter>
        {error === null ? null : (
          <p role="alert" className="text-caption text-failed-text mr-auto min-w-0">
            {error}
          </p>
        )}
        <Button type="button" variant="ghost" onClick={() => closeSourceForm(at)}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={saving}>
          {editing ? "Save" : "Add data source"}
        </Button>
      </DialogFooter>
    </form>
  );
};

export const SourceFormDialog = ({ at }: { readonly at: DataSessionKey }) => {
  const form = useSourceForm(at);

  return (
    <Dialog open={form !== null} onOpenChange={(open) => !open && closeSourceForm(at)}>
      <DialogContent className="w-[460px]">
        {form === null ? null : <Body at={at} form={form} />}
      </DialogContent>
    </Dialog>
  );
};
