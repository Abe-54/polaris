/**
 * An Agent Session's Turns in Review (Paper R2 223-0): the Turns since the last accept,
 * each its own section with a divider, or one Turn picked in the header.
 */
import { harnessHue } from "@polaris/ui";
import { useEffect, useState } from "react";
import type { SessionSubject } from "../../../routes/review.ts";
import { useApp, useShellActions } from "../../../shell/hooks.ts";
import { hasCapability, useSession } from "../../session/hooks.ts";
import {
  pendingTurns,
  reviewTurns,
  sessionSource,
  turnRange,
  type TurnPick,
} from "../data/source.ts";
import { useReviewDiff } from "../data/useReviewDiff.ts";
import { promptTurns } from "../overview/model/prompts.ts";
import { reviewSlots, subjectKey } from "../surface.ts";
import { ReviewBody } from "./ReviewBody.tsx";
import { SessionHeader } from "./SubjectHeader.tsx";
import { useWorkerCaption } from "../constellation/useWorkerCaption.ts";
import { useReviewSchema } from "../schema/useReviewSchema.ts";

const ALL: TurnPick = { kind: "all" };

/** The pick a subject opens with: its Turn when it names one, else every Turn. */
export const subjectPick = (subject: SessionSubject): TurnPick =>
  subject.turnId === undefined ? ALL : { kind: "turn", turnId: subject.turnId };

export const SessionReview = ({ subject }: { readonly subject: SessionSubject }) => {
  const { hostKey, sessionId } = subject;
  const model = useSession(hostKey, sessionId);
  const host = useApp((s) => s.hosts.find((h) => h.key === hostKey));
  const workspaces = useApp((s) => s.hostModels[hostKey]?.workspaces);
  const [pick, setPick] = useState<TurnPick>(() => subjectPick(subject));

  // Opened again at a Turn while shown (the Data tab's "Schema diff"): that Turn is picked.
  useEffect(() => {
    if (subject.turnId !== undefined) setPick(subjectPick(subject));
  }, [subject]);
  const { session } = model;
  const turns = reviewTurns(model.turns);
  const spans = hasCapability(host, "git.diff-turns");
  const source = session === null ? null : sessionSource(hostKey, session, turns, pick, spans);
  const diff = useReviewDiff(source);
  const pending = pendingTurns(turns, session?.acceptedThroughIndex ?? null);
  const slotProps = { subject, checkout: null };
  const actions = useShellActions();
  const turnsScope = pending.length === 0 ? "" : turnRange(pending);

  const { CheckoutChip, PrimaryAction } = reviewSlots.current;

  const workspace =
    session === null ? undefined : (workspaces?.get(session.workspaceId)?.name ?? undefined);

  const worker = useWorkerCaption(hostKey, sessionId);
  const schema = useReviewSchema({ hostKey, sessionId, host, turns, pick, views: model.turns });

  const caption = [
    session === null ? null : harnessHue(session.harness).name,
    worker ?? session?.state ?? null,
    workspace === undefined ? null : `${workspace} on ${host?.label ?? hostKey}`,
    pending.length === 0
      ? null
      : `${pending.length} ${pending.length === 1 ? "turn" : "turns"} since your last review`,
  ]
    .filter((part) => part !== null)
    .join(" · ");

  return (
    <section data-testid="session-review" className="flex min-h-0 min-w-0 flex-1 gap-2">
      <ReviewBody
        header={
          <SessionHeader
            title={session?.title ?? "Agent session"}
            harness={session?.harness ?? ""}
            caption={caption}
            pending={pending}
            pick={pick}
            onPick={setPick}
            actions={
              <>
                <CheckoutChip {...slotProps} />
                <PrimaryAction {...slotProps} />
              </>
            }
          />
        }
        subjectKey={subjectKey(subject)}
        slotProps={slotProps}
        place={
          session === null ? null : { hostKey, root: session.cwd, workspaceId: session.workspaceId }
        }
        diff={diff}
        schema={schema}
        pullViewed={null}
        mergeBase={null}
        session={{
          where:
            session === null
              ? ""
              : `${harnessHue(session.harness).name} on ${host?.label ?? hostKey}`,
          scope: turnsScope,
          turns: promptTurns(turns),
          onOpenSession: () => actions.selectSession({ hostKey, sessionId }),
        }}
        placeholder={
          session !== null && turns.length === 0
            ? { title: "No turns yet", fact: "This session hasn’t changed anything to review" }
            : null
        }
      />
    </section>
  );
};
