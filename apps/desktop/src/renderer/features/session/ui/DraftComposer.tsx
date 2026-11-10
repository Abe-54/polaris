/**
 * `@polaris/ui`'s Composer wired for typing: ↵ sends, ⇧↵ breaks the line, esc
 * stops a Working Turn, ↑/↓ bring back sent messages, pasted or dropped files
 * become attachment chips, `/` lists the Harness's Skills and Slash Commands,
 * and `@` picks a file or folder to mention.
 */
import type { PolarisAction } from "@polaris/protocol";
import { Composer, type Harness, harnessHue } from "@polaris/ui";
import { type CSSProperties, type ReactNode, type RefObject, useRef, useState } from "react";
import {
  AttachmentDrop,
  AttachmentTray,
  type DropMode,
  type Upload,
} from "../../attachments/index.ts";
import {
  type CommandNotice,
  type CommandOption,
  type FrecencyTable,
  type MentionSearch,
  Prompt,
  type OfferedReply,
} from "../../composer/index.ts";
import type { StagedAttachment } from "../state.ts";
import { ComposerMenu } from "./ComposerMenu.tsx";
import { useToastsClear } from "./toastClearance.ts";
import { useMenuPlacement } from "./useMenuPlacement.ts";

/** The `/` menu's list, and what to do for a command Polaris runs itself. */
export interface ComposerCommands {
  readonly options: ReadonlyArray<CommandOption>;
  readonly loading: boolean;
  /** Called on focus: the list is read from the Host then. */
  readonly want: () => void;
  readonly onAction: (action: PolarisAction) => void;
  /** Said instead of a list when the Host can't list them (its Daemon is too old). */
  readonly notice: CommandNotice | null;
  /** The user's frecency of picks where this composer runs, and recording a pick. */
  readonly frecency: FrecencyTable;
  readonly onPicked: (option: CommandOption) => void;
}

const NO_COMMANDS: ComposerCommands = {
  options: [],
  loading: false,
  want: () => undefined,
  onAction: () => undefined,
  notice: null,
  frecency: {},
  onPicked: () => undefined,
};

export interface DraftComposerProps {
  readonly harness: Harness;
  readonly picker: ReactNode;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly placeholder: string;
  readonly canSubmit: boolean;
  readonly working?:
    | {
        readonly elapsed: ReactNode;
        readonly onStop: () => void;
        readonly label?: ReactNode;
        readonly detail?: ReactNode;
      }
    | undefined;
  readonly onEscape?: (() => void) | undefined;
  /** ⌘↵: queue the draft as a follow-up for after the Turn in flight. */
  readonly onQueue?: (() => void) | undefined;
  /** Above the composer: the queued follow-up, when there is one. */
  readonly notice?: ReactNode;
  readonly attachments: ReadonlyArray<StagedAttachment>;
  readonly uploads: ReadonlyArray<Upload>;
  readonly onFiles?: ((files: ReadonlyArray<File>, mode: DropMode) => void) | undefined;
  /** Where ⌥-drop copies files, as shown; null or unset turns copying off. */
  readonly copyTo?: string | null;
  readonly onRemoveAttachment: (attachment: StagedAttachment) => void;
  readonly branch?: string | undefined;
  readonly tools?: ReactNode;
  readonly prominentSend?: boolean;
  readonly disabled?: boolean;
  readonly autoFocus?: boolean;
  /** Each new value focuses the prompt again (another ⌘N on an open new-session page). */
  readonly focusKey?: number;
  /** Stray typing on the screen goes to this prompt. */
  readonly typeToFocus?: boolean;
  readonly className?: string;
  readonly commands?: ComposerCommands;
  /** What the user sent in this session, oldest first, for ↑/↓. */
  readonly history?: ReadonlyArray<string>;
  /** Shell mode (a `!` draft): where the command runs, and whether it waits for this Turn. */
  readonly shell?: { readonly where: string; readonly queued: boolean } | undefined;
  /** The notice strip, when there is something to know (`NoticeStrip`). */
  readonly strip?: ReactNode;
  /** The footer's right side before Send (`ComposerStatus`). */
  readonly status?: ReactNode;
  /** The `@` picker's file search (`useMentionSearch`); unset, `@` is just text. */
  readonly mentions?: MentionSearch | null;
  /** The Suggested Reply to offer in the empty prompt (`offeredReply`). */
  readonly suggestion?: OfferedReply | null;
}

/** The paperclip's file picker: a hidden input whose picks are attached like dropped files. */
const FilePicker = ({
  onFiles,
  inputRef,
}: {
  readonly onFiles: (files: ReadonlyArray<File>) => void;
  readonly inputRef: RefObject<HTMLInputElement | null>;
}) => (
  <input
    ref={inputRef}
    type="file"
    multiple
    hidden
    data-testid="paperclip-input"
    onChange={(event) => {
      const files = [...(event.currentTarget.files ?? [])];

      event.currentTarget.value = "";

      if (files.length > 0) onFiles(files);
    }}
  />
);

/** Shell mode's strip line: where the command runs, and whether it waits for this Turn. */
const shellWhere = (where: string, queued: boolean) => (
  <>
    {queued ? "runs after this turn, in " : "runs in "}
    <span className="font-mono">{where}</span>
  </>
);

export const DraftComposer = ({
  harness,
  picker,
  value,
  onChange,
  onSubmit,
  placeholder,
  canSubmit,
  working,
  onEscape,
  onQueue,
  notice,
  attachments,
  uploads,
  onFiles,
  copyTo = null,
  onRemoveAttachment,
  branch,
  tools,
  prominentSend = false,
  disabled = false,
  autoFocus = false,
  focusKey,
  typeToFocus = false,
  className,
  commands = NO_COMMANDS,
  history,
  shell,
  strip,
  status,
  mentions = null,
  suggestion = null,
}: DraftComposerProps) => {
  const filePicker = useRef<HTMLInputElement>(null);
  // The menu draws in this box, above the card (which clips what it holds).
  const [menuSlot, setMenuSlot] = useState<HTMLDivElement | null>(null);
  const composerBox = useRef<HTMLDivElement>(null);

  useToastsClear(composerBox);
  const placement = useMenuPlacement(composerBox, menuSlot);

  const submit = (queue: boolean) => {
    if (queue && onQueue !== undefined) onQueue();
    else if (canSubmit) onSubmit();
  };

  const escape = () => {
    onEscape?.();

    return onEscape !== undefined;
  };

  return (
    <div className={className}>
      {notice}
      <div ref={composerBox} className="relative">
        <div
          ref={setMenuSlot}
          data-side={placement.side}
          className={
            placement.side === "above"
              ? "absolute inset-x-0 bottom-full z-20 pb-2"
              : "absolute inset-x-0 top-full z-20 pt-2"
          }
          // SAFETY: React passes custom properties through `style`; its type only lacks the name.
          style={{ "--menu-room": `${placement.room}px` } as CSSProperties}
        />
        <AttachmentDrop onFiles={onFiles} copyTo={copyTo}>
          <Composer
            harness={harness}
            model=""
            picker={picker}
            working={working}
            strip={strip}
            status={status}
            branch={branch}
            tools={tools}
            onAttach={onFiles === undefined ? undefined : () => filePicker.current?.click()}
            shell={
              shell === undefined
                ? undefined
                : {
                    where: shellWhere(shell.where, shell.queued),
                    title: `Runs in your login shell; ${harnessHue(harness).name} reads the output and replies`,
                  }
            }
            prominentSend={prominentSend}
            sendDisabled={!canSubmit}
            onSend={onSubmit}
            attachments={
              <AttachmentTray
                attachments={attachments}
                uploads={uploads}
                onRemove={onRemoveAttachment}
              />
            }
            input={
              <ComposerMenu
                onFiles={onFiles === undefined ? undefined : (files) => onFiles(files, "attach")}
              >
                <Prompt
                  value={value}
                  onChange={onChange}
                  placeholder={placeholder}
                  disabled={disabled}
                  autoFocus={autoFocus}
                  focusKey={focusKey}
                  typeToFocus={typeToFocus}
                  options={commands.options}
                  loading={commands.loading}
                  onSubmit={submit}
                  onEscape={escape}
                  takesFiles={onFiles !== undefined}
                  onAction={commands.onAction}
                  notice={commands.notice}
                  frecency={commands.frecency}
                  onPicked={commands.onPicked}
                  onFocus={commands.want}
                  menuSlot={menuSlot}
                  history={history}
                  mono={shell !== undefined}
                  mentions={shell === undefined ? mentions : null}
                  suggestion={suggestion}
                />
              </ComposerMenu>
            }
          />
        </AttachmentDrop>
        {onFiles === undefined ? null : (
          <FilePicker inputRef={filePicker} onFiles={(files) => onFiles(files, "attach")} />
        )}
      </div>
    </div>
  );
};
