/**
 * Asking the Reviewer (Paper X-G): a slim composer under the Risk Summary card for a question
 * about the whole change, or the finding "Ask about this" picked. It continues the Reviewer's
 * read-only session; while it chats, the conversation stands in for the findings (`Conversation`)
 * and an answering strip with the live dither sits over the composer.
 */
import type { SessionId, TurnId } from "@polaris/protocol";
import { ArrowUpIcon, Button, CloseIcon, harnessHue, LiveDither, SeverityGlyph } from "@polaris/ui";
import { Predicate } from "effect";
import { useEffect, useRef, useState } from "react";
import { useSession } from "../../session/hooks.ts";
import { Markdown } from "../../session/ui/markdown/index.tsx";
import { type Ask, askReviewer, useAsks } from "../data/actions.ts";
import { setAskAbout, setChatting, useAskAbout } from "../data/ui.ts";
import { type Answer, answerOf, type TurnSnapshot } from "../model/answer.ts";
import { askPlaceholder, canAskReviewer, type Summary } from "../model/summary.ts";

const isMessage = Predicate.isTagged("AssistantMessage");

const useTurn = (hostKey: string, sessionId: SessionId, turnId: TurnId): TurnSnapshot | null => {
  const model = useSession(hostKey, sessionId);
  const view = model.turns.find((t) => t.turn.id === turnId);

  if (view === undefined) return null;
  const messages: Array<string> = [];

  for (const item of view.items) if (isMessage(item)) messages.push(item.text);

  for (const live of view.live.values()) {
    if (live.item !== null && isMessage(live.item)) messages.push(live.text);
  }

  return { status: view.turn.status, messages };
};

/** "Claude Code", or "The reviewer" when the summary names none. */
export const reviewerName = (summary: Summary) =>
  summary.reviewer === null ? "The reviewer" : harnessHue(summary.reviewer.harness).name;

const AnswerBody = ({ answer }: { readonly answer: Answer }) => {
  if (answer.kind === "thinking") return null;

  if (answer.kind === "failed") {
    return <p className="text-caption text-failed-text">{answer.text}</p>;
  }

  return <Markdown text={answer.text} live={false} />;
};

const SentAnswer = ({
  hostKey,
  sessionId,
  turnId,
  name,
}: {
  readonly hostKey: string;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly name: string;
}) => {
  const answer = answerOf(useTurn(hostKey, sessionId, turnId));

  if (answer.kind === "thinking") return null;

  return (
    <div className="flex flex-col gap-1.5" data-testid="reviewer-answer">
      <span className="text-caption text-text-subtle">{name}</span>
      <AnswerBody answer={answer} />
    </div>
  );
};

const AskItem = ({
  hostKey,
  ask,
  summary,
}: {
  readonly hostKey: string;
  readonly ask: Ask;
  readonly summary: Summary;
}) => {
  const about = summary.findings.find((f) => f.id === ask.findingId);

  return (
    <div className="flex flex-col gap-3" data-testid="reviewer-ask">
      <p className="rounded-card bg-raised border-hairline text-body text-text-default ml-8 border px-3 py-2">
        {about !== undefined && <span className="text-text-subtle">On “{about.title}”: </span>}
        {ask.question}
      </p>
      {ask.state.kind === "failed" && (
        <p className="text-caption text-failed-text">{ask.state.message}</p>
      )}
      {ask.state.kind === "sent" && (
        <SentAnswer
          hostKey={hostKey}
          sessionId={ask.state.sessionId}
          turnId={ask.state.turnId}
          name={reviewerName(summary)}
        />
      )}
    </div>
  );
};

export interface AskReviewerProps {
  readonly subjectKey: string;
  readonly hostKey: string;
  readonly summary: Summary;
}

/** The conversation, oldest first, in place of the findings; it keeps the newest in view. */
export const Conversation = ({ hostKey, summary }: AskReviewerProps) => {
  const asks = useAsks(summary.id);
  const end = useRef<HTMLDivElement>(null);

  // Chromium's scrollIntoView returns a Promise: returned here, React would call it as the cleanup.
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "end" });
  }, [asks.length]);

  return (
    <div className="px-panel flex flex-col gap-4 py-3" data-testid="reviewer-asks">
      {asks.map((a) => (
        <AskItem key={a.id} hostKey={hostKey} ask={a} summary={summary} />
      ))}
      <div ref={end} />
    </div>
  );
};

/** "Claude Code is answering": the live field behind it while the answer streams. */
const AnsweringStrip = ({ summary }: { readonly summary: Summary }) => (
  <div
    data-testid="reviewer-answering"
    className="border-hairline relative flex h-8 items-center gap-2 overflow-clip border-b px-3"
  >
    {summary.reviewer !== null && <LiveDither harness={summary.reviewer.harness} active />}
    <span className="text-caption text-text-default relative font-medium">
      {reviewerName(summary)} is answering
    </span>
  </div>
);

const WhileStreaming = ({
  hostKey,
  sessionId,
  turnId,
  summary,
}: {
  readonly hostKey: string;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly summary: Summary;
}) => {
  const turn = useTurn(hostKey, sessionId, turnId);

  return turn === null || turn.status === "working" ? <AnsweringStrip summary={summary} /> : null;
};

/** The strip while the newest question waits for its answer. */
const Answering = ({
  hostKey,
  latest,
  summary,
}: {
  readonly hostKey: string;
  readonly latest: Ask | undefined;
  readonly summary: Summary;
}) => {
  if (latest?.state.kind === "sending") return <AnsweringStrip summary={summary} />;

  return latest?.state.kind === "sent" ? (
    <WhileStreaming
      hostKey={hostKey}
      sessionId={latest.state.sessionId}
      turnId={latest.state.turnId}
      summary={summary}
    />
  ) : null;
};

export const AskReviewer = ({ subjectKey, hostKey, summary }: AskReviewerProps) => {
  const asks = useAsks(summary.id);
  const aboutId = useAskAbout(subjectKey);
  const about = summary.findings.find((f) => f.id === aboutId) ?? null;
  const [question, setQuestion] = useState("");
  const canAsk = canAskReviewer(summary);

  const ask = () => {
    if (question.trim() === "" || !canAsk) return;
    void askReviewer(hostKey, summary.id, about?.id ?? null, question);
    setQuestion("");
    setAskAbout(subjectKey, null);
    setChatting(subjectKey, true);
  };

  return (
    <div className="flex flex-col gap-2 px-3 pt-2" data-testid="ask-reviewer">
      {about !== null && (
        <div className="gap-gap text-caption text-text-subtle flex items-center px-1">
          <SeverityGlyph severity={about.severity} tone="text" />
          <span className="min-w-0 flex-1 truncate">About “{about.title}”</span>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Ask about the whole change"
            onClick={() => setAskAbout(subjectKey, null)}
          >
            <CloseIcon size={12} />
          </Button>
        </div>
      )}
      <div className="rounded-card bg-well border-hairline flex flex-col overflow-clip border">
        <Answering hostKey={hostKey} latest={asks.at(-1)} summary={summary} />
        <div className="gap-gap flex h-9 items-center pr-1.5 pl-3">
          <input
            aria-label="Ask the reviewer"
            data-testid="ask-input"
            disabled={!canAsk}
            className="text-body text-text-default placeholder:text-text-faint min-w-0 flex-1 bg-transparent outline-none"
            placeholder={askPlaceholder(summary, about !== null, reviewerName(summary))}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") ask();
            }}
          />
          <Button
            size="icon-sm"
            variant="secondary"
            className="rounded-full"
            aria-label="Ask"
            disabled={!canAsk || question.trim() === ""}
            onClick={ask}
          >
            <ArrowUpIcon size={12} />
          </Button>
        </div>
      </div>
    </div>
  );
};
