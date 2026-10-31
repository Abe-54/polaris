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
import { type FormEvent, type ReactNode, useState } from "react";
import { useDataApi } from "../../data/hooks.tsx";
import { closeSourceForm, type SourceForm as Form, useSourceForm } from "../../model/sidebar.ts";
import { MANUAL_LABEL } from "../../model/source.ts";
import type { DataSessionKey } from "../../model/store.ts";
import { LabelSwatches } from "../connection/LabelSwatches.tsx";

const PORTS: Record<DataSource["engine"], number> = { postgres: 5432, mysql: 3306 };

export interface Draft {
  readonly name: string;
  readonly engine: DataSource["engine"];
  readonly host: string;
  readonly port: string;
  readonly database: string;
  readonly user: string;
  readonly password: string;
  /** null until the user picks one (`MANUAL_LABEL`). */
  readonly label: DataSourceLabel | null;
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
        password: "",
        label: null,
      }
    : {
        name: form.source.name,
        engine: form.source.engine,
        host: form.source.host,
        port: String(form.source.port),
        database: form.source.database,
        user: form.source.user ?? "",
        password: "",
        label: form.source.label,
      };

/** The first thing missing or wrong, in the form's order; null when it can be saved. */
export const problemOf = (draft: Draft): string | null => {
  if (draft.name.trim() === "") return "Name the data source";

  if (draft.host.trim() === "") return "Enter the host";
  const port = draft.port === "" ? PORTS[draft.engine] : Number(draft.port);

  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    return "The port is a number from 1 to 65535";

  return draft.database.trim() === "" ? "Enter the database" : null;
};

const Field = ({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) => (
  <label className="flex flex-col gap-1">
    <span className="text-caption text-text-subtle">{label}</span>
    {children}
    {hint === undefined ? null : <span className="text-caption text-text-faint">{hint}</span>}
  </label>
);

const Fields = ({
  draft,
  set,
  editing,
}: {
  draft: Draft;
  set: (patch: Partial<Draft>) => void;
  editing: boolean;
}) => {
  const label = draft.label ?? MANUAL_LABEL;

  return (
    <div className="flex flex-col gap-3 px-5 pb-4">
      <Field label="Name">
        <Input
          value={draft.name}
          disabled={editing}
          autoFocus={!editing}
          placeholder="analytics"
          onChange={(e) => set({ name: e.target.value })}
        />
      </Field>
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
      <Field
        label="Password"
        hint={
          editing
            ? "Leave blank to keep the saved password. Agents never see it."
            : "Kept on the Host. Agents never see it."
        }
      >
        <Input
          type="password"
          autoComplete="new-password"
          value={draft.password}
          onChange={(e) => set({ password: e.target.value })}
        />
      </Field>
      <div className="flex items-end gap-3">
        <Field label="Label">
          <Input
            className="font-mono uppercase"
            value={label.text}
            onChange={(e) => set({ label: { ...label, text: e.target.value.toUpperCase() } })}
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

const Body = ({ at, form }: { readonly at: DataSessionKey; readonly form: Form }) => {
  const api = useDataApi();
  const [draft, setDraft] = useState(() => draftOf(form));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const editing = form.mode === "edit";
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const problem = problemOf(draft);

    if (problem !== null) return setError(problem);
    setSaving(true);

    const input = {
      name: draft.name.trim(),
      engine: draft.engine,
      host: draft.host.trim(),
      port: draft.port === "" ? PORTS[draft.engine] : Number(draft.port),
      database: draft.database.trim(),
      user: draft.user.trim(),
      label: draft.label ?? MANUAL_LABEL,
    };

    const result = await api.saveSource(
      at,
      draft.password === "" ? input : { ...input, password: draft.password }
    );

    setSaving(false);

    if (result.ok) closeSourceForm();
    else setError(result.error.message);
  };

  return (
    <form onSubmit={(e) => void submit(e)} data-testid="data-source-form">
      <DialogHeader>
        <DialogTitle>{editing ? `Edit ${form.source.name}` : "Add data source"}</DialogTitle>
        <DialogDescription>
          Agents in this checkout can query it by name. A remote one needs your approval first.
        </DialogDescription>
      </DialogHeader>
      <Fields draft={draft} set={set} editing={editing} />
      <DialogFooter>
        {error === null ? null : (
          <p role="alert" className="text-caption text-failed-text mr-auto min-w-0">
            {error}
          </p>
        )}
        <Button type="button" variant="ghost" onClick={closeSourceForm}>
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
  const form = useSourceForm();

  return (
    <Dialog open={form !== null} onOpenChange={(open) => !open && closeSourceForm()}>
      <DialogContent className="w-[460px]">
        {form === null ? null : <Body at={at} form={form} />}
      </DialogContent>
    </Dialog>
  );
};
