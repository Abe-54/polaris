/**
 * A Lead chat's open questions to the user, pinned above its composer (ENG-345, option A): the
 * user answers a worker here as in Needs you, on this app's own connection, so it is theirs.
 */
import { AnswerAction } from "@polaris/protocol";
import { Button, PixelHandIcon, Textarea } from "@polaris/ui";
import { useState } from "react";
import { constellationCommands } from "../client.ts";
import { type AskedQuestion, leadQuestions } from "../model/questions.ts";
import type { ConstellationRecord } from "../model/index.ts";

/** Past this many the rest wait in Needs you, so the conversation keeps its room. */
const SHOWN = 3;

interface QuestionProps {
  readonly hostKey: string;
  readonly constellationId: ConstellationRecord["constellation"]["id"];
  readonly asked: AskedQuestion;
}

const AnswerField = ({
  hostKey,
  constellationId,
  asked,
  onDone,
}: QuestionProps & { readonly onDone: () => void }) => {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const ready = text.trim() !== "" && !sending;

  const send = async () => {
    setSending(true);

    const sent = await constellationCommands
      .answer(
        hostKey,
        {
          constellationId,
          action: AnswerAction.cases.Question.make({
            attemptId: asked.attemptId,
            questionId: asked.question.id,
            text: text.trim(),
          }),
        },
        `Couldn't answer ${asked.taskId}`
      )
      .finally(() => setSending(false));

    if (sent) onDone();
  };

  return (
    <div className="flex flex-col gap-1.5">
      <Textarea
        autoFocus
        aria-label={`Answer ${asked.taskId}`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && ready) void send();

          if (e.key === "Escape") onDone();
        }}
        className="text-caption min-h-[56px]"
      />
      <div className="flex items-center gap-2">
        <Button variant="primary" size="xs" disabled={!ready} onClick={() => void send()}>
          Send to {asked.taskId}
        </Button>
        <Button variant="ghost" size="xs" onClick={onDone}>
          Cancel
        </Button>
        <span className="text-caption text-text-subtle ml-auto truncate">
          Sent as your answer · the lead is told
        </span>
      </div>
    </div>
  );
};

const Question = (props: QuestionProps) => {
  const [answering, setAnswering] = useState(false);
  const { asked } = props;

  return (
    <div
      className="border-hairline bg-surface-sunken rounded-row flex flex-col gap-1.5 border px-3 py-2"
      data-testid="lead-question"
    >
      <div className="flex items-center gap-2">
        <PixelHandIcon size={14} className="text-needs-you shrink-0" />
        <span className="text-label text-needs-you-text">{asked.taskId} asks you</span>
        {asked.question.blocking ? (
          <span className="text-caption text-text-subtle">blocking</span>
        ) : null}
        <span className="flex-1" />
        {answering ? null : (
          <Button size="xs" onClick={() => setAnswering(true)}>
            Answer
          </Button>
        )}
      </div>
      <p className="text-label text-text-default break-words whitespace-pre-wrap">
        {asked.question.text}
      </p>
      {answering ? <AnswerField {...props} onDone={() => setAnswering(false)} /> : null}
    </div>
  );
};

/** The dock: nothing while no question to the user is open. */
export const LeadQuestions = ({
  hostKey,
  record,
}: {
  readonly hostKey: string;
  readonly record: ConstellationRecord;
}) => {
  const asked = leadQuestions(record.constellation);

  if (asked.length === 0) return null;

  const more = asked.length - SHOWN;

  return (
    <section aria-label="Questions for you" className="mx-panel mb-2 flex flex-col gap-1.5">
      {asked.slice(0, SHOWN).map((q) => (
        <Question
          key={`${q.attemptId}\u0000${q.question.id}`}
          hostKey={hostKey}
          constellationId={record.constellation.id}
          asked={q}
        />
      ))}
      {more > 0 ? (
        <span className="text-caption text-text-subtle px-1">{more} more in Needs you</span>
      ) : null}
    </section>
  );
};
