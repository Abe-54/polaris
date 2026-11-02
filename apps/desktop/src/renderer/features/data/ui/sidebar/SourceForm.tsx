/**
 * Add data source (DESIGN.md, Data → Sidebar): a server posted with `data.source.save`, a SQLite
 * file with `data.source.saveFile`. The password is write-only: never shown, never read back.
 */
import type { DataEngine, DataSourceLabel, DataTls, ServerDataEngine } from "@polaris/protocol";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@polaris/ui";
import {
  type ClipboardEvent,
  type FormEvent,
  type ReactNode,
  type RefObject,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { IpcError } from "../../../../../shared/api.ts";
import { useDataApi } from "../../data/hooks.tsx";
import { closeSourceForm, type SourceForm as Form, useSourceForm } from "../../model/sidebar.ts";
import { type PastedConnection, parseConnectionString } from "../../model/connectionString.ts";
import { MANUAL_LABEL } from "../../model/source.ts";
import type { DataSessionKey } from "../../model/store.ts";
import { LabelSwatches } from "../connection/LabelSwatches.tsx";

const PORTS: Record<ServerDataEngine, number> = { postgres: 5432, mysql: 3306 };

/** The password isn't here: it stays in its uncontrolled field, so it never reaches the DOM's attributes. */
export interface Draft {
  readonly name: string;
  readonly engine: DataEngine;
  /** SQLite only: the database file, an absolute path on the Host. */
  readonly path: string;
  readonly host: string;
  readonly port: string;
  readonly database: string;
  readonly user: string;
  /** Server sources: the TLS mode, "" for none. */
  readonly tls: DataTls | "";
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
        path: "",
        host: "localhost",
        port: "",
        database: "",
        user: "",
        tls: "",
        label: null,
        clearPassword: false,
      }
    : {
        name: form.source.name,
        engine: form.source.engine,
        path: form.source.path ?? "",
        // A SQLite source's server fields are placeholders: switching engine starts them blank.
        host: form.source.engine === "sqlite" ? "localhost" : form.source.host,
        port: form.source.engine === "sqlite" ? "" : String(form.source.port),
        database: form.source.engine === "sqlite" ? "" : form.source.database,
        user: form.source.user ?? "",
        tls: form.source.tls === undefined || form.source.tls === "disable" ? "" : form.source.tls,
        label: form.source.label,
        clearPassword: false,
      };

/** The Daemon's rule (data/sources.ts): it trims and lowercases, then takes `[a-z0-9][a-z0-9._-]*`. */
const NAME_RULE = /^[a-z0-9][a-z0-9._-]*$/;

/** The name the Host saves: trimmed and lowercased. */
export const savedName = (name: string) => name.trim().toLowerCase();

export const NAME_PROBLEM = "Use only a–z, 0–9, “.”, “_” or “-”, starting with a letter or digit";

/** The protocol's DataFilePath: absolute on the Host (POSIX or a Windows drive), one line. */
const fileProblem = (path: string): string | null => {
  if (path === "") return "Enter the database file's path";

  if (!path.startsWith("/") && !/^[a-z]:[\\/]/i.test(path))
    return "Use the file's full path on the Host, starting with /";

  return /[\r\n]/.test(path) ? "The path is one line" : null;
};

/** The first thing missing or wrong, in the form's order; null when it can be saved. */
export const problemOf = (draft: Draft): string | null => {
  if (draft.name.trim() === "") return "Name the data source";

  if (!NAME_RULE.test(savedName(draft.name))) return NAME_PROBLEM;

  if (draft.engine === "sqlite") return fileProblem(draft.path.trim());

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

const TLS_MODES: ReadonlyArray<{ value: DataTls | ""; name: string; hint: string }> = [
  { value: "", name: "Off", hint: "Connects without TLS. Most hosted databases need Require." },
  { value: "prefer", name: "Prefer", hint: "Uses TLS when the server offers it." },
  { value: "require", name: "Require", hint: "Always uses TLS, without checking the certificate." },
  { value: "verify-ca", name: "Verify CA", hint: "Always uses TLS, with a trusted certificate." },
  {
    value: "verify-full",
    name: "Verify full",
    hint: "Always uses TLS, with a trusted certificate for this host.",
  },
];

/** `allow` stays selectable only on a source already saved with it. */
const tlsModes = (current: DataTls | "") =>
  current === "allow"
    ? [
        ...TLS_MODES,
        {
          value: "allow" as const,
          name: "Allow",
          hint: "Uses TLS only when the server requires it.",
        },
      ]
    : TLS_MODES;

const TlsField = ({ draft, set }: FieldsProps) => {
  const modes = tlsModes(draft.tls);
  const NONE = "off";

  return (
    <Field label="TLS" hint={modes.find((mode) => mode.value === draft.tls)?.hint}>
      <Select
        value={draft.tls === "" ? NONE : draft.tls}
        onValueChange={(value) => {
          const mode = modes.find((m) => (m.value === "" ? NONE : m.value) === value);

          if (mode !== undefined) set({ tls: mode.value });
        }}
      >
        <SelectTrigger data-testid="data-source-tls">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {modes.map((mode) => (
            <SelectItem key={mode.value || NONE} value={mode.value === "" ? NONE : mode.value}>
              {mode.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
};

const ServerFields = ({ draft, set, ...props }: FieldsProps & { engine: ServerDataEngine }) => (
  <>
    <div className="grid grid-cols-[1fr_96px] gap-2">
      <Field label="Host" hint="Or paste a connection string">
        <Input
          value={draft.host}
          data-testid="data-source-host"
          onPaste={props.onPaste}
          onChange={(e) => set({ host: e.target.value })}
        />
      </Field>
      <Field label="Port">
        <Input
          inputMode="numeric"
          value={draft.port}
          placeholder={String(PORTS[props.engine])}
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
    <PasswordField draft={draft} set={set} {...props} />
    <TlsField draft={draft} set={set} {...props} />
  </>
);

const FileField = ({ draft, set, onPaste }: FieldsProps) => (
  <Field label="File" hint="The database file's full path on the Host. Polaris opens it read-only.">
    <Input
      className="font-mono"
      value={draft.path}
      placeholder="/path/to/checkout/dev.db"
      spellCheck={false}
      data-testid="data-source-path"
      onPaste={onPaste}
      onChange={(e) => set({ path: e.target.value })}
    />
  </Field>
);

interface FieldsProps {
  readonly draft: Draft;
  readonly set: (patch: Partial<Draft>) => void;
  readonly editing: boolean;
  readonly password: RefObject<HTMLInputElement | null>;
  /** Fills the form from a pasted connection string; anything else pastes as typed. */
  readonly onPaste: (event: ClipboardEvent<HTMLInputElement>) => void;
}

const Fields = (props: FieldsProps) => {
  const { draft, set } = props;
  const label = draft.label ?? MANUAL_LABEL;

  return (
    <div className="flex flex-col gap-3 px-5 pb-4">
      <NameField {...props} />
      <SegmentedControl<DataEngine>
        aria-label="Engine"
        variant="fill"
        value={draft.engine}
        onValueChange={(engine) => set({ engine })}
        options={[
          { value: "postgres", label: "PostgreSQL" },
          { value: "mysql", label: "MySQL" },
          { value: "sqlite", label: "SQLite" },
        ]}
      />
      {draft.engine === "sqlite" ? (
        <FileField {...props} />
      ) : (
        <ServerFields {...props} engine={draft.engine} />
      )}
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

const savedLabel = (draft: Draft) => {
  const label = draft.label ?? MANUAL_LABEL;

  return { ...label, text: label.text.toUpperCase() };
};

/** What `data.source.saveFile` gets: the name, the file and the label; no server or password. */
export const saveFileInput = (draft: Draft, previousName: string | undefined) => {
  const input = { name: savedName(draft.name), path: draft.path.trim(), label: savedLabel(draft) };

  return previousName === undefined ? input : { ...input, previousName };
};

/** What `data.source.save` gets: blank keeps the saved password, a typed one sets it. */
const saveInput = (draft: Draft & { engine: ServerDataEngine }, password: string) => {
  const label = draft.label ?? MANUAL_LABEL;

  const input = {
    name: savedName(draft.name),
    engine: draft.engine,
    host: draft.host.trim(),
    port: draft.port === "" ? PORTS[draft.engine] : Number(draft.port),
    database: draft.database.trim(),
    user: draft.user.trim(),
    label: { ...label, text: label.text.toUpperCase() },
    ...(draft.tls === "" ? undefined : { tls: draft.tls }),
  };

  if (draft.clearPassword) return { ...input, passwordAction: "clear" as const };

  return password === "" ? input : { ...input, password };
};

/** The draft fields a connection string names; its password goes to the uncontrolled field. */
const patchOf = (pasted: PastedConnection): Partial<Draft> =>
  pasted.engine === "sqlite"
    ? { engine: "sqlite", path: pasted.path }
    : {
        engine: pasted.engine,
        host: pasted.host,
        port: String(pasted.port),
        database: pasted.database,
        user: pasted.user,
        tls: pasted.tls ?? "",
      };

/** A pasted password waits here until its field is mounted (pasting into File switches engine). */
const usePastedPassword = (password: RefObject<HTMLInputElement | null>) => {
  const pending = useRef<string | null>(null);

  useLayoutEffect(() => {
    if (pending.current === null || password.current === null) return;
    password.current.value = pending.current;
    pending.current = null;
  });

  return (value: string) => {
    pending.current = value;
  };
};

const Body = ({ at, form }: { readonly at: DataSessionKey; readonly form: Form }) => {
  const api = useDataApi();
  const [draft, setDraft] = useState(() => draftOf(form));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const password = useRef<HTMLInputElement>(null);
  const editing = form.mode === "edit";
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const pastePassword = usePastedPassword(password);

  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const pasted = parseConnectionString(event.clipboardData.getData("text"));

    if (pasted === undefined) return;
    event.preventDefault();
    setError(null);
    set(patchOf(pasted));

    if (pasted.engine !== "sqlite" && pasted.password !== "") {
      pastePassword(pasted.password);
      set({ clearPassword: false });
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const problem = problemOf(draft);

    if (problem !== null) return setError(problem);
    setSaving(true);
    const previous = editing ? form.source.name : undefined;

    const result =
      draft.engine === "sqlite"
        ? await api.saveFileSource(at, saveFileInput(draft, previous))
        : await api.saveSource(
            at,
            saveInput({ ...draft, engine: draft.engine }, password.current?.value ?? "")
          );

    setSaving(false);

    if (result.ok) closeSourceForm(at);
    else setError(saveErrorText(result.error, editing));
  };

  return (
    <form onSubmit={(e) => void submit(e)} data-testid="data-source-form">
      <DialogHeader>
        <DialogTitle>{editing ? `Edit ${form.source.name}` : "Add data source"}</DialogTitle>
        <DialogDescription>
          {draft.engine === "sqlite"
            ? "Agents in this checkout can query a file inside it by name. SQLite is read-only."
            : "Agents in this checkout can query it by name. A remote one needs your approval first."}
        </DialogDescription>
      </DialogHeader>
      <Fields draft={draft} set={set} editing={editing} password={password} onPaste={onPaste} />
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
