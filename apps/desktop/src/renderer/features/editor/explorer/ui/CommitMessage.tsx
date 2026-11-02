/**
 * The Commit box's Message field with "Write a message" in its corner (Paper 15c, 15d):
 * writing streams in read-only with Stop (Esc), a written message keeps Undo until you
 * type, and a refusal says which Harness and Host and the one thing to do.
 */
import {
  Button,
  SparkleIcon,
  Textarea,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn,
} from "@polaris/ui";
import { useEffect, useState } from "react";
import { HARNESS_CATALOGUE } from "@polaris/protocol";
import { commandShortcut } from "../../../../../shared/keymap.ts";
import { useApp, useCommands } from "../../../../shell/hooks.ts";
import {
  modelLabel,
  useAvailability,
  useHarnessModels,
  useSignIn,
} from "../../../harness/index.ts";
import { useOpenEditorSettings, useSettings } from "../../../settings/index.ts";
import type { Place } from "../data/actions.ts";
import { setMessage, useCommitDraft } from "../data/git.ts";
import { dismissFailure, stopSuggesting, suggest, undoSuggestion } from "../data/suggest.ts";
import { failureLine, fallbackModelName, suggestBlock, type Suggestion } from "../model/suggest.ts";

const useSeconds = (since: number | null) => {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (since === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);

    return () => clearInterval(timer);
  }, [since]);

  return since === null ? 0 : Math.max(0, Math.floor((now - since) / 1000));
};

const harnessName = (kind: string) => HARNESS_CATALOGUE.find((h) => h.kind === kind)?.name ?? kind;

const useCommitChoice = () => useSettings((s) => s.sessions.commitMessages);

const useModelName = (hostKey: string, harness: string, model: string) => {
  const { models } = useHarnessModels(hostKey, harness);
  const known = models.some((m) => m.id === model);

  return known ? modelLabel(models, model, null) : fallbackModelName(model);
};

const WriteButton = ({ blocked, onWrite }: { blocked: string | null; onWrite: () => void }) => {
  const shortcut = commandShortcut("git.writeMessage");

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* A disabled button gets no hover, so its wrapper carries the reason. */}
        <span className="inline-flex shrink-0">
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-[22px] rounded-[5px]"
            aria-label="Write a message"
            disabled={blocked !== null}
            onClick={onWrite}
            data-testid="commit-write"
          >
            <SparkleIcon size={14} />
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {blocked ?? "Write a message"}
        {blocked === null && shortcut !== "" ? (
          <span className="text-text-subtle ml-2">{shortcut}</span>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
};

const Writing = ({
  place,
  suggestion,
}: {
  readonly place: Place;
  readonly suggestion: Extract<Suggestion, { kind: "writing" }>;
}) => {
  const choice = useCommitChoice();
  const seconds = useSeconds(suggestion.startedAt);
  const model = useModelName(place.hostKey, choice.harness, suggestion.model);

  return (
    <>
      <span className="text-caption text-text-subtle min-w-0 flex-1 truncate" aria-live="polite">
        Writing · {model} · {seconds}s
      </span>
      <Button
        variant="ghost"
        size="xs"
        className="h-[22px] gap-1.5 px-1.5"
        onClick={() => stopSuggesting(place.key)}
        data-testid="commit-write-stop"
      >
        <span className="size-2 rounded-[1.5px] bg-current" aria-hidden />
        Stop
        <span className="text-text-subtle font-normal">esc</span>
      </Button>
    </>
  );
};

/** The field, its footer (status and the button), and ⌘⇧M while the Changes tab is open. */
export const MessageField = ({
  place,
  staged,
  committing,
  onSubmit,
}: {
  readonly place: Place;
  readonly staged: number;
  readonly committing: boolean;
  readonly onSubmit: () => void;
}) => {
  const draft = useCommitDraft(place.key);
  const choice = useCommitChoice();
  const commands = useCommands();
  const { suggestion } = draft;
  const writing = suggestion.kind === "writing";
  const blocked = suggestBlock(staged, committing, suggestion);
  const write = () => (blocked === null ? suggest(place, place.root, choice) : undefined);

  useEffect(() => {
    return commands.register({
      "git.writeMessage": {
        run: () => (blocked === null ? suggest(place, place.root, choice) : undefined),
        enabled: () => blocked === null,
      },
    });
  }, [commands, blocked, place, choice]);

  return (
    <div
      className={cn(
        "rounded-control border-hairline bg-bg flex flex-col border",
        "has-[textarea:focus-visible]:outline-starlight has-[textarea:focus-visible]:outline-2 has-[textarea:focus-visible]:outline-offset-2"
      )}
      data-testid="commit-field"
    >
      <Textarea
        bare
        aria-label="Commit message"
        placeholder="Message"
        value={draft.message}
        disabled={committing}
        readOnly={writing}
        data-testid="commit-message"
        className={cn("max-h-40 min-h-9 px-2.5 pt-1.5", writing && "text-text-subtle")}
        onChange={(event) => setMessage(place.key, event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && writing) {
            event.preventDefault();
            stopSuggesting(place.key);
          } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            onSubmit();
          }
        }}
      />
      <div className="flex h-[26px] items-center justify-end gap-2 pr-1 pb-1 pl-2.5">
        {writing ? (
          <Writing place={place} suggestion={suggestion} />
        ) : (
          <>
            {suggestion.kind === "replaced" ? (
              <span className="text-caption text-text-subtle min-w-0 flex-1 truncate">
                Replaced ·{" "}
                <button
                  type="button"
                  className="text-text-default hover:text-text-strong cursor-default font-medium"
                  onClick={() => undoSuggestion(place.key)}
                  data-testid="commit-write-undo"
                >
                  Undo
                </button>
              </span>
            ) : null}
            <WriteButton blocked={blocked} onWrite={write} />
          </>
        )}
      </div>
    </div>
  );
};

/** Under the Commit button when writing failed: the reason, then sign-in or the setting. */
export const WriteFailed = ({ place }: { readonly place: Place }) => {
  const { suggestion } = useCommitDraft(place.key);
  const choice = useCommitChoice();
  const host = useApp((s) => s.hosts.find((h) => h.key === place.hostKey));
  const { options } = useAvailability(place.hostKey);
  const signIn = useSignIn(place.hostKey);
  const openSettings = useOpenEditorSettings();

  if (suggestion.kind !== "failed") return null;
  const name = harnessName(choice.harness);
  const option = options.find((o) => o.kind === choice.harness);
  const signable = suggestion.reason === "needs-sign-in" && option !== undefined;

  return (
    <div className="flex flex-col gap-1.5" data-testid="commit-write-failed">
      <p className="text-caption text-failed-text">
        {failureLine(suggestion, name, host?.label ?? place.hostKey)}
      </p>
      <div className="flex items-center gap-3">
        {signable && option.signInArgv !== null ? (
          <Button size="xs" onClick={() => signIn.begin(option)}>
            Sign in in terminal
          </Button>
        ) : null}
        <button
          type="button"
          className="text-caption text-text-subtle hover:text-text-default cursor-default"
          onClick={openSettings}
        >
          Change model
        </button>
        <button
          type="button"
          className="text-caption text-text-subtle hover:text-text-default ml-auto cursor-default"
          onClick={() => dismissFailure(place.key)}
        >
          Dismiss
        </button>
      </div>
      {signIn.dialog}
    </div>
  );
};
