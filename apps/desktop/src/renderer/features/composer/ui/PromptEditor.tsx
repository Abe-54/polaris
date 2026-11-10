/**
 * The composer's prompt: a Lexical plain-text editor with Skill, Slash
 * Command and file mention chips, the `/` menu and the `@` picker (portalled
 * above the composer). Its own chunk; `./Prompt.tsx` shows a stand-in first.
 */
import type { PolarisAction } from "@polaris/protocol";
import { cn } from "@polaris/ui";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createPromptEditor, type EditorHooks } from "../editor/editor.ts";
import type { TypedWord } from "../editor/state.ts";
import {
  type CommandOption,
  type Draft,
  EMPTY_DRAFT,
  insertsChip,
  matchMenu,
  type Menu,
} from "../model/commands.ts";
import type { FrecencyTable } from "../model/frecency.ts";
import { AT_DRAFT, type HistoryCursor, stepHistory } from "../model/history.ts";
import type { MentionRow, MentionSearch } from "../model/mentions.ts";
import { type CommandNotice, noticeFor } from "../model/notice.ts";
import type { OfferedReply } from "../model/suggestion.ts";
import { CommandMenu } from "./CommandMenu.tsx";
import { MentionMenu } from "./MentionMenu.tsx";
import { replyAnnouncement, SuggestedReplyGhost } from "./SuggestedReply.tsx";
import { showsResults, useMentionPicker } from "./useMentionPicker.ts";
import { useTypeToFocus } from "./typeToFocus.ts";
import "./composer.css";

export interface PromptEditorProps {
  readonly value: string;
  readonly onChange: (text: string) => void;
  readonly placeholder: string;
  readonly disabled: boolean;
  readonly autoFocus: boolean;
  /** Each new value focuses the prompt again, the caret after the draft. */
  readonly focusKey?: number | undefined;
  /** Stray typing on the screen (nothing editable focused) goes here (`./typeToFocus.ts`). */
  readonly typeToFocus?: boolean | undefined;
  readonly options: ReadonlyArray<CommandOption>;
  /** The list is still being read from the Host. */
  readonly loading: boolean;
  /** ↵; `queue` is true with ⌘ or Ctrl. */
  readonly onSubmit: (queue: boolean) => void;
  /** esc outside the menu; true when it did something. */
  readonly onEscape: () => boolean;
  readonly takesFiles: boolean;
  /** A command Polaris runs itself was picked. */
  readonly onAction: (action: PolarisAction) => void;
  /** First focus: when to read the Host's commands, so the menu is ready by the first `/`. */
  readonly onFocus?: (() => void) | undefined;
  /** Where the menu draws: a box above the composer's card, which clips its own content. */
  readonly menuSlot: HTMLElement | null;
  /** Said instead of a list when the Host can't list commands; ↵ runs its action. */
  readonly notice: CommandNotice | null;
  /** The user's frecency of picks here: ranks ties, and leads a bare `/`. */
  readonly frecency: FrecencyTable;
  /** A command was picked from the menu (it counts toward frecency). */
  readonly onPicked: (option: CommandOption) => void;
  /** What the user sent here, oldest first, for ↑/↓ (`sentMessages`); read only when they're pressed. */
  readonly history?: (() => ReadonlyArray<string>) | undefined;
  /** Shell mode: the draft is a command, set in mono. */
  readonly mono?: boolean | undefined;
  /** The `@` picker's file search in the session's directory; unset, `@` is just text. */
  readonly mentions?: MentionSearch | null | undefined;
  /** The session's Suggested Reply when it may be offered (`offeredReply`); shown while empty. */
  readonly suggestion?: OfferedReply | null | undefined;
}

const NO_HISTORY: ReadonlyArray<string> = [];

const optionsKey = (options: ReadonlyArray<CommandOption>) =>
  options.map((o) => `${o.sigil}${o.name}`).join("\u0000");

/** Menu state: the word typed, the row highlighted, and the word esc was pressed on. */
const useMenu = (options: ReadonlyArray<CommandOption>, draft: Draft, frecency: FrecencyTable) => {
  const [typed, setTyped] = useState<TypedWord | null>(null);
  const [index, setIndex] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const word = typed?.word ?? null;

  const menu =
    typed === null || dismissed === word
      ? null
      : matchMenu(typed.word, typed.atHead, options, draft.tokens, frecency);

  const active = menu === null ? 0 : Math.min(index, menu.options.length - 1);

  return { typed, setTyped, menu, active, index, setIndex, dismissed, setDismissed };
};

export default function PromptEditor(props: PromptEditorProps) {
  const [draft, setDraft] = useState<Draft>(() => ({ ...EMPTY_DRAFT, text: props.value }));

  const { typed, setTyped, menu, active, index, setIndex, dismissed, setDismissed } = useMenu(
    props.options,
    draft,
    props.frecency
  );

  const mention = useMentionPicker(props.mentions ?? null, typed, dismissed, index);

  const waiting =
    typed !== null && typed.sigil !== "@" && props.loading && props.options.length === 0;

  const notice =
    typed !== null && dismissed !== typed.word
      ? noticeFor(typed.word, typed.atHead, draft.tokens, props.notice, props.options)
      : null;

  // The Turn whose Suggested Reply was used or dismissed; it stays gone for that Turn.
  const [replyGone, setReplyGone] = useState<string | null>(null);
  const reply = props.suggestion ?? null;

  const shownReply =
    reply !== null && !props.disabled && draft.text === "" && replyGone !== reply.turnId
      ? reply
      : null;

  const open = menu !== null;
  const latest = useRef({ props, menu, index, dismissed, mention, replyGone });
  const emitted = useRef<string | null>(null);
  // ↑/↓'s place in history, and the text it last showed; any other edit returns to the draft.
  const cursor = useRef<HistoryCursor>(AT_DRAFT);
  const recalled = useRef<string | null>(null);

  useEffect(() => {
    latest.current = { props, menu, index, dismissed, mention, replyGone };
  });

  const run = (option: CommandOption | undefined) => {
    if (option === undefined) return;
    setIndex(0);
    latest.current.props.onPicked(option);

    if (insertsChip(option)) {
      handle.insertChip(option);

      return;
    }

    handle.removeTypedWord();

    if (option.action !== null) latest.current.props.onAction(option.action);
  };

  /**
   * The menu as the editor stands now. Keys read this rather than the last
   * render, so ↵ right after a keystroke still picks instead of sending.
   */
  const live = (): Menu | null => {
    const now = handle.read();
    const { props: current, dismissed: was } = latest.current;

    if (now.typed === null || now.typed.word === was) return null;

    return matchMenu(
      now.typed.word,
      now.typed.atHead,
      current.options,
      now.draft.tokens,
      current.frecency
    );
  };

  /** The notice as the editor stands now, for the keys (like `live`). */
  const liveNotice = (): CommandNotice | null => {
    const now = handle.read();
    const { props: current, dismissed: was } = latest.current;

    if (now.typed === null || now.typed.word === was) return null;

    return noticeFor(
      now.typed.word,
      now.typed.atHead,
      now.draft.tokens,
      current.notice,
      current.options
    );
  };

  /** The `@` picker as the editor stands now: the word's query, and the rows last read. */
  const liveMention = () => {
    const { typed: now } = handle.read();
    const { props: current, dismissed: was, mention: picker } = latest.current;

    if (current.mentions == null || now?.sigil !== "@" || now.word === was) return null;

    return showsResults(picker.results) ? { query: now.query, results: picker.results } : null;
  };

  /** ⇥ on a folder goes into it, searching inside; anything else becomes its mention chip. */
  const pickMention = (row: MentionRow | undefined, via: "enter" | "tab") => {
    if (row === undefined) return;
    setIndex(0);

    if (via === "tab" && row.kind === "folder") handle.replaceTypedWord(`@${row.path}`);
    else handle.insertMention(row);
  };

  const mentionAt = () =>
    Math.min(latest.current.index, latest.current.mention.results.rows.length - 1);

  const at = (m: Menu) => Math.min(latest.current.index, m.options.length - 1);

  /** The reply as the editor stands now, for the keys (like `live`). */
  const liveReply = (): OfferedReply | null => {
    const { props: current, replyGone: gone } = latest.current;
    const now = current.suggestion ?? null;

    if (now === null || current.disabled || now.turnId === gone) return null;

    return handle.read().draft.text === "" ? now : null;
  };

  const dropReply = (turnId: string) => {
    latest.current.replyGone = turnId;
    setReplyGone(turnId);
  };

  const acceptReply = () => {
    const now = liveReply();

    if (now === null) return;
    dropReply(now.turnId);
    handle.insertWhole(now.text);
  };

  const [handle] = useState(() => {
    const hooks = (): EditorHooks => ({
      options: () => latest.current.props.options,
      onDraft: (next) => {
        if (next.text !== recalled.current) cursor.current = AT_DRAFT;
        const offered = latest.current.props.suggestion;

        // Typing or pasting over the reply dismisses it for this Turn.
        if (next.text !== "" && offered != null) dropReply(offered.turnId);
        setDraft(next);
        emitted.current = next.text;
        latest.current.props.onChange(next.text);
      },
      onTypedWord: (word) => {
        setTyped((was) => (was?.word === word?.word && was?.atHead === word?.atHead ? was : word));
        setDismissed((was) => (was === word?.word ? was : null));
      },
      menu: {
        open: () => liveMention() !== null || live() !== null || liveNotice() !== null,
        move: (by) => {
          const files = liveMention()?.results.rows.length;
          const m = live();
          const count = files ?? m?.options.length ?? 1;
          const from = files === undefined ? (m === null ? 0 : at(m)) : mentionAt();

          setIndex((Math.max(0, from) + by + count) % Math.max(1, count));
        },
        pick: (via) => {
          const files = liveMention();
          const m = live();

          // Rows for an older query wait for this one's answer rather than pick a stale row.
          if (files !== null) {
            if (files.results.query === files.query)
              pickMention(files.results.rows[mentionAt()], via);
          } else if (m !== null) run(m.options[at(m)]);
          else liveNotice()?.action?.run();
        },
        dismiss: () => setDismissed(handle.read().typed?.word ?? null),
      },
      suggestion: {
        shown: () => liveReply() !== null,
        accept: acceptReply,
        dismiss: () => {
          const now = liveReply();

          if (now !== null) dropReply(now.turnId);
        },
      },
      recall: (toward) => {
        const entries = latest.current.props.history?.() ?? NO_HISTORY;
        const step = stepHistory(entries, cursor.current, toward, handle.read().draft.text);

        if (step === null) return null;
        cursor.current = step.cursor;
        recalled.current = step.text;

        return step.text;
      },
      onSubmit: (queue) => latest.current.props.onSubmit(queue),
      onEscape: () => latest.current.props.onEscape(),
      takesFiles: () => latest.current.props.takesFiles,
    });

    return createPromptEditor(hooks, "Prompt");
  });

  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = root.current;

    if (element === null) return undefined;
    const unmount = handle.mount(element);

    if (latest.current.props.autoFocus) handle.focusEnd();

    return unmount;
  }, [handle]);

  // The draft lives outside (per session); set the editor only when it changed elsewhere.
  useEffect(() => {
    if (props.value === emitted.current) return;
    emitted.current = props.value;
    handle.setText(props.value);
  }, [handle, props.value]);

  useEffect(() => {
    handle.editor.setEditable(!props.disabled);
  }, [handle, props.disabled]);

  useEffect(() => {
    if (props.focusKey !== undefined) handle.focusEnd();
  }, [handle, props.focusKey]);

  useTypeToFocus(
    {
      ready: () => handle.editor.isEditable() && root.current?.isConnected === true,
      focusEnd: handle.focusEnd,
    },
    props.typeToFocus === true
  );

  const key = optionsKey(props.options);

  // A list that arrives after text was typed can make it a chip.
  useEffect(() => {
    if (key !== "") handle.retokenize();
  }, [handle, key]);

  const commandView =
    open || waiting || notice !== null ? (
      <CommandMenu
        notice={notice}
        menu={menu}
        loading={waiting}
        active={active}
        onPick={(i) => run(latest.current.menu?.options[i])}
        onHover={setIndex}
      />
    ) : null;

  const menuView = mention.shown ? (
    <MentionMenu
      rows={mention.results.rows}
      failed={mention.results.failed}
      active={mention.active}
      onPick={(i) => pickMention(latest.current.mention.results.rows[i], "enter")}
      onHover={setIndex}
    />
  ) : (
    commandView
  );

  return (
    <div className={cn("relative min-w-0", props.disabled && "opacity-(--opacity-dimmed)")}>
      <div
        ref={root}
        role="textbox"
        aria-multiline="true"
        aria-placeholder={props.placeholder}
        aria-autocomplete="list"
        aria-expanded={open || mention.shown}
        contentEditable={!props.disabled}
        suppressContentEditableWarning
        spellCheck
        data-testid="composer-input"
        data-slot="prompt"
        onFocus={props.onFocus}
        className={cn(
          "text-body text-text-default composer-prompt max-h-60 min-h-(--text-body--line-height) w-full min-w-0 overflow-y-auto break-words whitespace-pre-wrap outline-none",
          props.mono === true && "font-mono"
        )}
        data-shell={props.mono === true ? "" : undefined}
      />
      <div role="status" aria-live="polite" className="sr-only">
        {shownReply === null ? "" : replyAnnouncement(shownReply.text)}
      </div>
      {shownReply !== null ? (
        <SuggestedReplyGhost reply={shownReply} onAccept={acceptReply} />
      ) : draft.text === "" ? (
        <div
          aria-hidden="true"
          className="text-body text-text-faint pointer-events-none absolute inset-x-0 top-0 truncate select-none"
        >
          {props.placeholder}
        </div>
      ) : null}
      {props.menuSlot === null || menuView === null ? null : createPortal(menuView, props.menuSlot)}
    </div>
  );
}
