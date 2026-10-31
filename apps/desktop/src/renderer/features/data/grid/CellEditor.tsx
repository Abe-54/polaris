/**
 * A cell's editor over the grid (DESIGN.md, Data: Table tab): ↵ stages, esc puts the cell back,
 * leaving it stages a valid value. Its own type's field: text and numbers as text, true/false,
 * a timestamp with its offset, JSON checked as typed; NULL is a toggle, never typed.
 */
import { cn } from "@polaris/ui";
import { type ChangeEvent, type FocusEvent, type KeyboardEvent, useRef, useState } from "react";
import { shortcutLabel } from "../../../../shared/chord.ts";
import { FIELD_CHORDS } from "../../../../shared/keymap.ts";
import type { LaidColumn } from "./columns.ts";
import { draftOf, type Editable, parseDraft } from "./editors.ts";
import type { DataValue } from "./value.ts";

export interface CellEditorProps {
  readonly column: LaidColumn;
  readonly editable: Editable;
  readonly value: DataValue;
  /** A key typed on the cell starts the draft over with it. */
  readonly typed: string | null;
  readonly top: number;
  readonly left: number;
  readonly height: number;
  readonly onStage: (value: DataValue) => void;
  readonly onCancel: () => void;
}

const HINTS: Record<Editable["kind"], string> = {
  text: "↵ stage · esc cancel",
  number: "a number, kept as written · ↵ stage",
  bool: "t or f · ↵ stage",
  time: "2026-08-02 09:30:00+00:00 · ↵ stage",
  json: `JSON · ${shortcutLabel(FIELD_CHORDS.newLine)} new line · ↵ stage`,
};

const boolDraft = (value: DataValue) => (value === true || value === 1 ? "true" : "false");

const firstDraft = (editable: Editable, value: DataValue, typed: string | null) => {
  if (editable.kind === "bool") return boolDraft(value);

  return typed ?? draftOf(value);
};

const FIELD =
  "text-code-inline text-text-strong min-w-0 flex-1 bg-transparent px-2.5 font-mono outline-none placeholder:text-text-faint placeholder:italic";

const BoolChoice = ({
  draft,
  onChoose,
}: {
  readonly draft: string;
  readonly onChoose: (next: string) => void;
}) => (
  <div role="radiogroup" aria-label="Value" className="flex flex-1 items-center gap-1 px-1.5">
    {["true", "false"].map((choice) => (
      <button
        key={choice}
        type="button"
        role="radio"
        aria-checked={draft === choice}
        onClick={() => onChoose(choice)}
        className={cn(
          "text-code-inline rounded-control h-5 px-2 font-mono",
          draft === choice ? "bg-fill-selected text-text-strong" : "text-text-subtle"
        )}
      >
        {choice}
      </button>
    ))}
  </div>
);

type FieldElement = HTMLInputElement | HTMLTextAreaElement;

/** What every field kind shares: its label, value, and the draft's handlers. */
interface FieldProps {
  readonly autoFocus: boolean;
  readonly "aria-label": string;
  readonly "aria-invalid": boolean;
  readonly "data-testid": string;
  readonly value: string;
  readonly placeholder: string | undefined;
  readonly spellCheck: boolean;
  readonly onFocus: (event: FocusEvent<FieldElement>) => void;
  readonly onChange: (event: ChangeEvent<FieldElement>) => void;
}

/** The field for the editor's kind: true/false, a growing textarea for JSON and lines, else one line. */
const Field = (props: {
  readonly editable: Editable;
  readonly numeric: boolean;
  readonly height: number;
  readonly multiline: boolean;
  readonly draft: string;
  readonly isNull: boolean;
  readonly onChoose: (next: string) => void;
  readonly field: FieldProps;
}) => {
  if (props.editable.kind === "bool")
    return (
      <div className="flex flex-1 items-center" style={{ height: props.height }}>
        <BoolChoice draft={props.isNull ? "" : props.draft} onChoose={props.onChoose} />
        <input {...props.field} readOnly className="sr-only" />
      </div>
    );

  if (props.multiline)
    return (
      <textarea
        {...props.field}
        rows={Math.min(8, Math.max(3, props.draft.split("\n").length))}
        className={cn(FIELD, "resize-none py-1.5 leading-[18px] whitespace-pre")}
      />
    );

  return (
    <input
      {...props.field}
      className={FIELD}
      style={{ height: props.height, textAlign: props.numeric ? "right" : undefined }}
    />
  );
};

const NullToggle = ({ on, onToggle }: { readonly on: boolean; readonly onToggle: () => void }) => (
  <button
    type="button"
    aria-pressed={on}
    data-testid="data-cell-editor-null"
    title="Set to NULL"
    onClick={onToggle}
    className={cn(
      "text-micro rounded-control mx-1 shrink-0 self-center px-1.5 py-0.5 font-mono tracking-[0.06em]",
      on ? "bg-fill-selected text-text-strong" : "text-text-faint hover:text-text-default"
    )}
  >
    NULL
  </button>
);

export const CellEditor = (props: CellEditorProps) => {
  const { column, editable, value } = props;
  const [draft, setDraft] = useState(() => firstDraft(editable, value, props.typed));
  const [isNull, setNull] = useState(value === null && props.typed === null);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const multiline = editable.kind === "json" || (editable.kind === "text" && draft.includes("\n"));

  const stage = (quiet: boolean) => {
    if (isNull) return props.onStage(null);
    const parsed = parseDraft(editable, draft, value);

    if ("value" in parsed) return props.onStage(parsed.value);

    if (quiet) return props.onCancel();
    setError(parsed.error);
  };

  const edit = (next: string) => {
    setDraft(next);
    setNull(false);
    setError(null);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    // The grid's own keys (arrows, ⌘A, ⌘Z) belong to the field while it edits.
    event.stopPropagation();

    if (event.key === "Escape") {
      event.preventDefault();
      props.onCancel();
    } else if (event.key === "Enter" && !(multiline && event.shiftKey)) {
      event.preventDefault();
      stage(false);
    } else if (editable.kind === "bool" && /^[tf]$/i.test(event.key)) {
      edit(event.key.toLowerCase() === "t" ? "true" : "false");
    }
  };

  const fieldProps: FieldProps = {
    autoFocus: true,
    "aria-label": `Edit ${column.name}`,
    "aria-invalid": error !== null,
    "data-testid": "data-cell-editor-field",
    value: isNull ? "" : draft,
    placeholder: isNull ? "NULL" : undefined,
    spellCheck: false,
    onFocus: (event) => {
      if (props.typed === null) event.currentTarget.select();
    },
    onChange: (event) => edit(event.currentTarget.value),
  };

  return (
    <div
      ref={root}
      data-testid="data-cell-editor"
      data-kind={editable.kind}
      onKeyDown={onKeyDown}
      onMouseDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onBlur={(event) => {
        // Switching apps blurs too; the editor waits for the user to come back.
        if (document.hasFocus() && !root.current?.contains(event.relatedTarget)) stage(true);
      }}
      className="absolute z-[3] flex flex-col"
      style={{ top: props.top, left: props.left, minWidth: Math.max(column.width, 240) }}
    >
      <div
        className="bg-raised ring-starlight shadow-float flex items-start ring-2 ring-inset"
        style={{ minHeight: props.height }}
      >
        <Field
          editable={editable}
          numeric={column.numeric}
          height={props.height}
          multiline={multiline}
          draft={draft}
          isNull={isNull}
          onChoose={edit}
          field={fieldProps}
        />
        {editable.nullable ? (
          <NullToggle
            on={isNull}
            onToggle={() => {
              setNull((on) => !on);
              setError(null);
            }}
          />
        ) : null}
      </div>
      <div
        role={error === null ? undefined : "alert"}
        data-testid="data-cell-editor-note"
        className={cn(
          "bg-raised border-hairline text-caption truncate border-x border-b px-2.5 py-1",
          error === null ? "text-text-subtle" : "text-failed-text"
        )}
      >
        {error ?? HINTS[editable.kind]}
      </div>
    </div>
  );
};
