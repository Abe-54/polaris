/**
 * A cell's editor over the grid (DESIGN.md, Data: Table tab): ↵ stages, esc puts the cell back,
 * leaving it stages a changed valid value, ⌘S stages then commits. Its own type's field: text
 * (multi-line) and numbers as text, true/false, a timestamp, JSON checked as typed; NULL toggles.
 */
import { cn } from "@polaris/ui";
import { type ChangeEvent, type FocusEvent, type KeyboardEvent, useRef, useState } from "react";
import { matches, parseChord, shortcutLabel } from "../../../../shared/chord.ts";
import { chordOf, FIELD_CHORDS } from "../../../../shared/keymap.ts";
import type { LaidColumn } from "./columns.ts";
import { draftOf, type Editable, parseDraft, timeExample } from "./editors.ts";
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
  /** ⌘S: the draft is staged first, then this commits. */
  readonly onCommit?: (() => void) | undefined;
}

const NEW_LINE = `${shortcutLabel(FIELD_CHORDS.newLine)} new line`;

const hintOf = (editable: Editable) => {
  switch (editable.kind) {
    case "text":
      return `${NEW_LINE} · ↵ stage · esc cancel`;
    case "number":
      return "a number, kept as written · ↵ stage";
    case "bool":
      return "t or f · ↵ stage";
    case "time":
      return `${editable.dateOnly === true ? "2026-08-02" : timeExample(editable)} · ↵ stage`;
    default:
      return `JSON · ${NEW_LINE} · ↵ stage`;
  }
};

/** The commit chord as pressed here (⌘S, or Ctrl+S off macOS). */
const COMMIT = parseChord(chordOf("data.commitEdits", "mac") ?? "CmdOrCtrl+S");

/** An IME's keystrokes belong to its composition, not to the editor. */
const composing = (event: KeyboardEvent) => event.nativeEvent.isComposing || event.keyCode === 229;

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

/** The field for the editor's kind: true/false, a textarea for text and JSON, else one line. */
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

  if (props.multiline) {
    const lines = props.draft.split("\n").length;

    // Text stays a textarea at one line, so a pasted line break is kept and the field never swaps.
    return (
      <textarea
        {...props.field}
        rows={lines === 1 && props.editable.kind === "text" ? 1 : Math.min(8, Math.max(3, lines))}
        className={cn(
          FIELD,
          "resize-none leading-[18px] whitespace-pre",
          lines === 1 && props.editable.kind === "text" ? "py-[5px]" : "py-1.5"
        )}
        style={lines === 1 ? { minHeight: props.height } : undefined}
      />
    );
  }

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
  const [error, setError] = useState<{ error: string; suggestion?: string } | null>(null);
  // A typed key or a paste starts the edit; looking at a cell never stages it.
  const [touched, setTouched] = useState(props.typed !== null);
  const root = useRef<HTMLDivElement>(null);
  const multiline = editable.kind === "json" || editable.kind === "text";

  /** Stages the draft, or closes untouched; false when the draft is refused (and says why). */
  const stage = (quiet: boolean): boolean => {
    if (!touched) {
      props.onCancel();

      return true;
    }

    if (isNull) {
      props.onStage(null);

      return true;
    }

    const parsed = parseDraft(editable, draft, value);

    if ("value" in parsed) {
      props.onStage(parsed.value);

      return true;
    }

    if (quiet) props.onCancel();
    else setError(parsed);

    return false;
  };

  const edit = (next: string) => {
    setDraft(next);
    setNull(false);
    setTouched(true);
    setError(null);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    // The grid's own keys (arrows, ⌘A, ⌘Z) belong to the field while it edits.
    event.stopPropagation();

    if (composing(event)) return;

    if (matches(COMMIT, event)) {
      event.preventDefault();

      if (stage(false)) props.onCommit?.();
    } else if (event.key === "Escape") {
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
              setTouched(true);
              setError(null);
            }}
          />
        ) : null}
      </div>
      <div
        className={cn(
          "bg-raised border-hairline text-caption flex items-center gap-2 border-x border-b px-2.5 py-1",
          error === null ? "text-text-subtle" : "text-failed-text"
        )}
      >
        <span
          role={error === null ? undefined : "alert"}
          data-testid="data-cell-editor-note"
          className="min-w-0 truncate"
        >
          {error?.error ?? hintOf(editable)}
        </span>
        {error?.suggestion === undefined ? null : (
          <button
            type="button"
            data-testid="data-cell-editor-suggestion"
            className="text-text-default hover:text-text-strong shrink-0 font-mono underline-offset-2 hover:underline"
            onClick={() => {
              edit(error.suggestion ?? draft);
              root.current
                ?.querySelector<HTMLElement>("[data-testid=data-cell-editor-field]")
                ?.focus();
            }}
          >
            Use {error.suggestion}
          </button>
        )}
      </div>
    </div>
  );
};
