import { type HTMLAttributes, type ReactNode, useState } from "react";

import { PixelHandIcon } from "../../icons/pixel";
import { CheckIcon } from "../../icons/nucleo/ui";
import { ChevronLeftIcon } from "../../icons/nucleo/ui-more";
import { cn } from "../../lib/cn";
import { harnessHue, type Harness } from "../../lib/hue";
import { Button } from "../ui/button";

export interface QuestionAnswer {
  readonly label: ReactNode;
  /** A line under the label saying what choosing it means. */
  readonly description?: ReactNode;
  readonly recommended?: boolean;
}

/** One question of a request; a Harness may ask several at once. */
export interface QuestionStep {
  /** A short tag ("Scope"). */
  readonly header?: ReactNode;
  readonly question: ReactNode;
  /** Why it asks, in a sentence or two. */
  readonly context?: ReactNode;
  readonly answers: readonly QuestionAnswer[];
  /** Several answers may be chosen; they are confirmed with Next (or Send on the last). */
  readonly multiSelect?: boolean;
}

/** Where the card is: the question on screen, and each question's picks or typed answer. */
export interface QuestionProgress {
  readonly step: number;
  readonly picks: ReadonlyArray<ReadonlyArray<number>>;
  /** An answer typed in place of a pick (in the composer), per question; null where none. */
  readonly typed: ReadonlyArray<string | null>;
}

export const startProgress = (count: number): QuestionProgress => ({
  step: 0,
  picks: Array.from({ length: count }, () => []),
  typed: Array.from({ length: count }, () => null),
});

export interface QuestionCardProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  readonly harness: Harness;
  readonly questions: readonly QuestionStep[];
  /** Once every question has an answer: the chosen indexes and typed answers, per question. */
  readonly onAnswer?: (
    picks: ReadonlyArray<ReadonlyArray<number>>,
    typed: ReadonlyArray<string | null>
  ) => void;
  /** Set to hold the progress outside the card (a composer answers its current question). */
  readonly progress?: QuestionProgress;
  readonly onProgressChange?: (progress: QuestionProgress) => void;
  /** "18m". */
  readonly age?: ReactNode;
}

/**
 * A Harness's question in the conversation: a needs-you washed header strip, then numbered
 * answer rows with the recommended one filled (DESIGN.md, Needs You inbox). Several questions
 * are asked one at a time ("1 of 2", Back); a pick moves on, and the last sends them all.
 * An answer typed in the composer stands in for a pick on the question on screen.
 */
export function QuestionCard({
  harness,
  questions,
  onAnswer,
  progress,
  onProgressChange,
  age,
  className,
  ...props
}: QuestionCardProps) {
  const [own, setOwn] = useState(() => startProgress(questions.length));
  const { step, picks, typed } = progress ?? own;

  const set = (next: QuestionProgress) => {
    setOwn(next);
    onProgressChange?.(next);
  };

  const current = questions[Math.min(step, questions.length - 1)];

  if (current === undefined) return null;
  const chosen = picks[step] ?? [];
  const typedHere = typed[step] ?? null;
  const last = step >= questions.length - 1;

  const advance = (next: QuestionProgress) => {
    if (last) {
      set(next);
      onAnswer?.(next.picks, next.typed);
    } else set({ ...next, step: step + 1 });
  };

  const pick = (index: number) => {
    const mine = current.multiSelect === true ? toggle(chosen, index) : [index];

    const next = {
      step,
      picks: picks.map((p, n) => (n === step ? mine : p)),
      typed: typed.map((t, n) => (n === step ? null : t)),
    };

    if (current.multiSelect === true) set(next);
    else advance(next);
  };

  return (
    <div
      data-slot="question-card"
      className={cn(
        "flex flex-col overflow-clip rounded-card border border-hairline bg-surface-raised",
        className
      )}
      {...props}
    >
      <div className="pixelated border-needs-you/14 flex h-10 shrink-0 items-center gap-2.5 border-b bg-(image:--wash-needs-you) bg-cover bg-center px-3.5">
        <PixelHandIcon size={14} className="text-needs-you" />
        <span className="text-caption text-text-strong font-medium">
          {harnessHue(harness).name} needs an answer
        </span>
        <span className="flex-1" />
        {questions.length > 1 ? (
          <span className="text-caption text-text-subtle tabular">
            {step + 1} of {questions.length}
          </span>
        ) : null}
        {age === undefined ? null : (
          <span className="text-caption text-text-subtle tabular">{age}</span>
        )}
      </div>
      <div className="flex flex-col gap-3 p-3.5">
        <div className="flex flex-col gap-1">
          {isAbsent(current.header) ? null : (
            <p className="text-caption text-text-subtle">{current.header}</p>
          )}
          <p className="text-heading-sm text-text-strong">{current.question}</p>
        </div>
        {isAbsent(current.context) ? null : (
          <p className="text-body text-text-subtle">{current.context}</p>
        )}
        <ol className="flex flex-col gap-1.5">
          {current.answers.map((answer, index) => (
            <li key={index}>
              <AnswerRow
                answer={answer}
                index={index}
                multiSelect={current.multiSelect === true}
                filled={
                  typedHere === null &&
                  isFilled(answer, index, chosen, current.multiSelect === true)
                }
                checked={chosen.includes(index)}
                onPick={() => pick(index)}
              />
            </li>
          ))}
          {typedHere === null ? null : (
            <li
              className="rounded-row bg-primary text-primary-foreground flex min-h-9 items-center gap-2.5 px-3 py-1.5"
              data-testid="typed-answer"
            >
              <span className="text-label min-w-0 flex-1 [overflow-wrap:anywhere]">
                {typedHere}
              </span>
              <span className="text-caption shrink-0 opacity-70">Your answer</span>
            </li>
          )}
        </ol>
        <StepFooter
          back={step > 0 ? () => set({ step: step - 1, picks, typed }) : null}
          confirm={
            current.multiSelect === true
              ? {
                  label: last ? "Send" : "Next",
                  ready: chosen.length > 0 || typedHere !== null,
                  run: () => advance({ step, picks, typed }),
                }
              : null
          }
        />
      </div>
    </div>
  );
}

const isAbsent = (node: ReactNode): node is null | undefined => node === null || node === undefined;

const toggle = (chosen: ReadonlyArray<number>, index: number): ReadonlyArray<number> =>
  chosen.includes(index)
    ? chosen.filter((i) => i !== index)
    : [...chosen, index].sort((a, b) => a - b);

/** Single-select fills the pick (after Back) or else the recommended one; multi-select its checks. */
const isFilled = (
  answer: QuestionAnswer,
  index: number,
  chosen: ReadonlyArray<number>,
  multiSelect: boolean
): boolean => {
  if (multiSelect || chosen.length > 0) return chosen.includes(index);

  return answer.recommended === true;
};

const AnswerRow = ({
  answer,
  index,
  multiSelect,
  filled,
  checked,
  onPick,
}: {
  readonly answer: QuestionAnswer;
  readonly index: number;
  readonly multiSelect: boolean;
  readonly filled: boolean;
  readonly checked: boolean;
  readonly onPick: () => void;
}) => (
  <button
    type="button"
    onClick={onPick}
    {...(multiSelect ? { role: "checkbox", "aria-checked": checked } : {})}
    className={cn(
      "flex min-h-9 w-full cursor-default items-center gap-2.5 rounded-row border px-3 py-1.5 text-left select-none",
      filled
        ? "border-transparent bg-primary text-primary-foreground hover:bg-primary/90"
        : "border-hairline text-text-default hover:bg-fill-hover"
    )}
  >
    {multiSelect ? (
      <span className="flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border border-current opacity-70">
        {checked ? <CheckIcon size={10} /> : null}
      </span>
    ) : (
      <span className="text-micro tabular font-medium opacity-70">{index + 1}</span>
    )}
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="text-label [overflow-wrap:anywhere]">{answer.label}</span>
      {isAbsent(answer.description) ? null : (
        <span className="text-caption [overflow-wrap:anywhere] opacity-70">
          {answer.description}
        </span>
      )}
    </span>
    {answer.recommended === true ? (
      <span className="text-caption shrink-0 opacity-70">Recommended</span>
    ) : null}
  </button>
);

const StepFooter = ({
  back,
  confirm,
}: {
  readonly back: (() => void) | null;
  readonly confirm: {
    readonly label: string;
    readonly ready: boolean;
    readonly run: () => void;
  } | null;
}) =>
  back === null && confirm === null ? null : (
    <div className="flex items-center gap-2">
      {back === null ? null : (
        <Button variant="ghost" size="xs" className="text-text-default px-1.5" onClick={back}>
          <ChevronLeftIcon size={12} />
          Back
        </Button>
      )}
      <span className="flex-1" />
      {confirm === null ? null : (
        <Button variant="primary" size="xs" disabled={!confirm.ready} onClick={confirm.run}>
          {confirm.label}
        </Button>
      )}
    </div>
  );
