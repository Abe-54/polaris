/**
 * Constellation items in the Needs You inbox (Paper C5): one group per Lead, headed by the
 * Constellation mark and the Lead's name, its cards in the decided priority order (spec §5).
 */
import {
  AnswerAction,
  type HarnessKind,
  MessageTarget,
  ReviewAction,
  SetConstellationStateAction,
  WorkerPlacement,
} from "@polaris/protocol";
import { Button, CodeWell, PixelHandIcon, Textarea, Tile } from "@polaris/ui";
import { Match } from "effect";
import { type ReactNode, useState } from "react";
import { age } from "../../../shell/copy.ts";
import { openSessionReview } from "../../../routes/review.ts";
import { useShellActions } from "../../../shell/hooks.ts";
import { ConstellationMark } from "../../sessions/glyphs.tsx";
import { sendConstellation } from "../../sessions/constellationApi.ts";
import { retrySetup, setupExit, useConstellationActions } from "../../sessions/source.ts";
import type { ConstellationGroup, ConstellationItem } from "../model/constellation.ts";
import { offersAlwaysAllow } from "../../data/approval/decide.ts";
import { approve, deny } from "../respond.ts";

interface CardProps {
  readonly harness: HarnessKind;
  readonly title: string;
  readonly since: string;
  readonly now: number;
  readonly kind: ConstellationItem["kind"];
  readonly children?: ReactNode;
}

const Card = ({ harness, title, since, now, kind, children }: CardProps) => (
  <div
    data-testid="constellation-card"
    data-kind={kind}
    className="rounded-card border-hairline bg-surface-raised flex flex-col gap-2.5 border p-3"
  >
    <div className="flex items-center gap-2.5">
      <Tile hue={harness} size={28}>
        <PixelHandIcon size={14} className="text-needs-you" />
      </Tile>
      <p className="text-label text-text-strong min-w-0 flex-1">{title}</p>
      <span className="text-caption text-text-subtle tabular shrink-0 self-start pt-0.5">
        {age(since, now)}
      </span>
    </div>
    {children}
  </div>
);

const Body = ({ children }: { readonly children: ReactNode }) => (
  <p className="text-caption text-text-default leading-[17px]">{children}</p>
);

const Actions = ({ children }: { readonly children: ReactNode }) => (
  <div className="flex items-center gap-1.5">{children}</div>
);

/** A context meter: neutral, never a signal colour (rule/context-is-quiet). */
const Meter = ({ share }: { readonly share: number }) => (
  <div className="flex items-center gap-2.5">
    <span className="bg-fill-selected h-1 flex-1 overflow-clip rounded-full">
      <span
        className="bg-text-subtle block h-full rounded-full"
        style={{ width: `${Math.min(100, Math.round(share * 100))}%` }}
      />
    </span>
    <span className="text-caption text-text-default tabular">{Math.round(share * 100)}%</span>
  </div>
);

interface ItemProps {
  readonly group: ConstellationGroup;
  readonly item: ConstellationItem;
  readonly now: number;
}

const who = (item: ConstellationItem) => (item.taskId === null ? "The lead" : item.taskId);

/** Opens the Lead, focused on the item's Task. */
export const useOpen = (group: ConstellationGroup, item: ConstellationItem) => {
  const { selectSession } = useShellActions();
  const { focusTask } = useConstellationActions();
  const leadSessionId = group.view.constellation.leadSessionId;

  return () => {
    selectSession({ hostKey: group.leadHostKey, sessionId: leadSessionId });

    if (item.taskId !== null)
      focusTask({ hostKey: group.leadHostKey, leadSessionId, taskId: item.taskId });
  };
};

/** Sends the worker back to a fresh session in the same worktree (spec §4, Send-back). */
const restartFresh = (group: ConstellationGroup, item: ConstellationItem, reason: string) => {
  const attempt = item.worker?.attempt;

  if (attempt === undefined) return;
  void sendConstellation(
    group.leadHostKey,
    "constellation.review",
    {
      constellationId: group.view.constellation.id,
      attemptId: attempt.id,
      revision: attempt.revision,
      action: ReviewAction.cases.SendBack.make({
        reason,
        worker: WorkerPlacement.cases.New.make({
          hostId: attempt.hostId,
          worktree: attempt.worktree,
          branch: attempt.branch,
        }),
      }),
    },
    "Couldn't restart it"
  );
};

const Approval = ({ item, now }: ItemProps) => {
  const request = item.request;
  const sessionId = item.entry?.session.id;

  if (request === undefined || sessionId === undefined || item.hostKey === null) return null;
  const target = { hostKey: item.hostKey, sessionId, request };

  return (
    <Card
      kind={item.kind}
      harness={item.entry?.session.harness ?? "claude"}
      title={`${who(item)} wants to run`}
      since={item.since}
      now={now}
    >
      <CodeWell size="sm" className="border-transparent">
        {request.detail ?? request.title}
      </CodeWell>
      <Actions>
        <Button variant="primary" size="xs" onClick={() => void approve(target)}>
          Approve
        </Button>
        {offersAlwaysAllow(request) ? (
          <Button size="xs" className="px-2" onClick={() => void approve(target, true)}>
            Always here
          </Button>
        ) : null}
        <span className="flex-1" />
        <Button variant="ghost" size="xs" className="px-1.5" onClick={() => void deny(target)}>
          Deny
        </Button>
      </Actions>
    </Card>
  );
};

/** A Secret Request: its label, and the session whose card takes the value (ADR 0089). */
const Secret = ({ item, now }: ItemProps) => {
  const { selectSession } = useShellActions();
  const request = item.request;
  const sessionId = item.entry?.session.id;
  const { hostKey } = item;

  if (request === undefined || sessionId === undefined || hostKey === null) return null;
  const name = item.taskId ?? "The lead";

  return (
    <Card
      kind={item.kind}
      harness={item.entry?.session.harness ?? "claude"}
      title={`${name} is asking for a secret`}
      since={item.since}
      now={now}
    >
      <Body>{request.title}</Body>
      <Actions>
        <Button size="xs" onClick={() => selectSession({ hostKey, sessionId })}>
          Answer in the conversation
        </Button>
      </Actions>
    </Card>
  );
};

const AnswerField = ({ group, item, onDone }: ItemProps & { readonly onDone: () => void }) => {
  const [text, setText] = useState("");
  const { question, worker } = item;

  if (question === undefined || worker === undefined) return null;

  const send = async () => {
    const sent = await sendConstellation(
      group.leadHostKey,
      "constellation.answer",
      {
        constellationId: group.view.constellation.id,
        action: AnswerAction.cases.Question.make({
          attemptId: worker.attempt.id,
          questionId: question.id,
          text: text.trim(),
        }),
      },
      "Couldn't answer"
    );

    if (sent) onDone();
  };

  return (
    <div className="flex flex-col gap-1.5">
      <Textarea
        autoFocus
        aria-label={`Answer ${who(item)}`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim() !== "") void send();
        }}
        className="text-caption min-h-[56px]"
      />
      <Actions>
        <Button
          variant="primary"
          size="xs"
          disabled={text.trim() === ""}
          onClick={() => void send()}
        >
          Send to {who(item)}
        </Button>
        <Button variant="ghost" size="xs" onClick={onDone}>
          Cancel
        </Button>
        <span className="text-caption text-text-subtle ml-auto">the lead is told</span>
      </Actions>
    </div>
  );
};

const fromClaim = (item: ConstellationItem) =>
  item.worker?.attempt.claim?.questions.some((q) => q.id === item.question?.id) === true;

const Question = ({ group, item, now }: ItemProps) => {
  const open = useOpen(group, item);
  const [answering, setAnswering] = useState(false);
  const text = item.question?.text ?? item.request?.title ?? "";

  return (
    <Card
      kind={item.kind}
      harness={item.entry?.session.harness ?? "claude"}
      title={`${who(item)} asks you`}
      since={item.since}
      now={now}
    >
      <p className="text-label text-text-default">{text}</p>
      {answering ? (
        <AnswerField group={group} item={item} now={now} onDone={() => setAnswering(false)} />
      ) : (
        <Actions>
          {item.question === undefined ? (
            <Button size="xs" onClick={open}>
              Open {who(item)}
            </Button>
          ) : (
            <Button size="xs" onClick={() => setAnswering(true)}>
              Answer
            </Button>
          )}
          {fromClaim(item) ? (
            <span className="text-caption text-text-subtle">from {who(item)}'s claim</span>
          ) : null}
        </Actions>
      )}
    </Card>
  );
};

const Unclaimed = ({ group, item, now }: ItemProps) => {
  const open = useOpen(group, item);

  return (
    <Card
      kind={item.kind}
      harness={item.entry?.session.harness ?? "claude"}
      title={`${who(item)} stopped without reporting back`}
      since={item.since}
      now={now}
    >
      <Body>Reminded once, then ended again. The lead knows.</Body>
      <Actions>
        <Button size="xs" onClick={open}>
          Open {who(item)}
        </Button>
        <Button
          variant="ghost"
          size="xs"
          onClick={() =>
            restartFresh(group, item, "Stopped without reporting back; start again fresh.")
          }
        >
          Restart fresh
        </Button>
      </Actions>
    </Card>
  );
};

/** Worktree setup failed before the Attempt (it ranks with "stopped without reporting back"). */
const SetupFailed = ({ group, item, now }: ItemProps) => {
  const open = useOpen(group, item);
  const setup = item.setup;

  if (setup === undefined) return null;

  const retry = () =>
    void sendConstellation(
      group.leadHostKey,
      "constellation.dispatch",
      retrySetup(setup, group.view.constellation.hostId),
      `Couldn't retry ${who(item)}`
    );

  return (
    <Card
      kind={item.kind}
      harness={item.entry?.session.harness ?? "codex"}
      title={`${who(item)} setup failed`}
      since={item.since}
      now={now}
    >
      <Body>
        <span className="font-mono">{setup.run.command}</span> {setupExit(setup.run)}
        {setup.remoteHost === null ? null : (
          <span className="text-text-subtle"> · on {setup.remoteHost}</span>
        )}
        . No worker slot was used.
      </Body>
      <Actions>
        <Button size="xs" onClick={retry}>
          Retry
        </Button>
        <Button variant="ghost" size="xs" onClick={open}>
          Open the log
        </Button>
      </Actions>
    </Card>
  );
};

/** A worker holding its slot with no first Turn (ENG-264): Start sends its brief, once. */
const Stalled = ({ group, item, now }: ItemProps) => {
  const open = useOpen(group, item);
  const attempt = item.worker?.attempt;

  const start = () => {
    if (item.hostKey === null || attempt === undefined) return;
    void sendConstellation(
      item.hostKey,
      "constellation.worker.start",
      { constellationId: group.view.constellation.id, attemptId: attempt.id },
      `Couldn't start ${who(item)}`
    );
  };

  return (
    <Card
      kind={item.kind}
      harness={item.entry?.session.harness ?? "codex"}
      title={`${who(item)} stalled`}
      since={item.since}
      now={now}
    >
      <Body>
        It holds a worker slot but its first turn never started, so other workers wait. Start sends
        its brief once.
      </Body>
      <Actions>
        <Button size="xs" onClick={start}>
          Start
        </Button>
        <Button variant="ghost" size="xs" onClick={open}>
          Open {who(item)}
        </Button>
      </Actions>
    </Card>
  );
};

const Stale = ({ group, item, now }: ItemProps) => {
  const open = useOpen(group, item);

  return (
    <Card
      kind={item.kind}
      harness={item.entry?.session.harness ?? "codex"}
      title={`${who(item)} went stale`}
      since={item.since}
      now={now}
    >
      <Body>
        Its host is offline. The attempt waits; it never settles by itself. Stop it from the
        constellation to restart it elsewhere.
      </Body>
      <Actions>
        <Button size="xs" onClick={open}>
          Open {who(item)}
        </Button>
      </Actions>
    </Card>
  );
};

/** A Claim the user decides: the Lead handed it up (and why), or the Constellation is paused. */
const Claim = ({ item, now }: ItemProps) => {
  const actions = useShellActions();
  const attempt = item.worker?.attempt;
  const handedUp = item.worker?.state === "handed-up";
  const head = attempt?.claim?.head.slice(0, 7);

  const review = () => {
    if (item.hostKey !== null && attempt !== undefined)
      openSessionReview(actions, item.hostKey, attempt.sessionId);
  };

  return (
    <Card
      kind={item.kind}
      harness={item.entry?.session.harness ?? "codex"}
      title={handedUp ? `The lead handed ${who(item)}'s claim to you` : `${who(item)} claimed`}
      since={attempt?.handedUpAt ?? item.since}
      now={now}
    >
      <Body>
        {handedUp
          ? (attempt?.handedUpReason ?? "It can't decide it.")
          : "The constellation is paused, so this claim waits on you."}
        {head === undefined ? null : <span className="text-text-subtle font-mono"> · {head}</span>}
      </Body>
      <Actions>
        <Button size="xs" onClick={review}>
          Review {who(item)}
        </Button>
      </Actions>
    </Card>
  );
};

const WorkerContext = ({ group, item, now }: ItemProps) => {
  const worker = item.worker;

  const compact = () => {
    if (worker === undefined) return;
    void sendConstellation(
      group.leadHostKey,
      "constellation.message",
      {
        constellationId: group.view.constellation.id,
        target: MessageTarget.cases.Worker.make({ attemptId: worker.attempt.id }),
        text: "Your context is nearly full: compact it, then carry on with your Task.",
      },
      "Couldn't ask it to compact"
    );
  };

  return (
    <Card
      kind={item.kind}
      harness={item.entry?.session.harness ?? "codex"}
      title={`${who(item)} is near its context limit`}
      since={item.since}
      now={now}
    >
      <Meter share={item.context ?? 0} />
      <Actions>
        <Button size="xs" onClick={compact}>
          Compact
        </Button>
        <Button
          variant="ghost"
          size="xs"
          onClick={() =>
            restartFresh(group, item, "Context nearly full; carry on in a fresh session.")
          }
        >
          Fresh session
        </Button>
      </Actions>
    </Card>
  );
};

const LeadContext = ({ group, item, now }: ItemProps) => (
  <Card
    kind={item.kind}
    harness={item.entry?.session.harness ?? "claude"}
    title="The lead is near its context limit"
    since={item.since}
    now={now}
  >
    <Meter share={item.context ?? 0} />
    <Actions>
      <Button
        size="xs"
        onClick={() =>
          void sendConstellation(
            group.leadHostKey,
            "constellation.set_state",
            {
              constellationId: group.view.constellation.id,
              action: SetConstellationStateAction.cases.HandOver.make({
                summary: "",
                interrupt: false,
              }),
            },
            "Couldn't hand over"
          )
        }
      >
        Hand over
      </Button>
      <span className="text-caption text-text-subtle">after its turn ends</span>
    </Actions>
  </Card>
);

const Item = (props: ItemProps) =>
  Match.value(props.item.kind).pipe(
    Match.when("worker-approval", () =>
      props.item.request?.kind === "secret" ? <Secret {...props} /> : <Approval {...props} />
    ),
    Match.when("lead", () =>
      Match.value(props.item.request?.kind).pipe(
        Match.when("question", () => <Question {...props} />),
        Match.when("secret", () => <Secret {...props} />),
        Match.orElse(() => <Approval {...props} />)
      )
    ),
    Match.when("question", () => <Question {...props} />),
    Match.when("claim", () => <Claim {...props} />),
    Match.when("unclaimed", () => <Unclaimed {...props} />),
    Match.when("setup", () => <SetupFailed {...props} />),
    Match.when("stale", () => <Stale {...props} />),
    Match.when("stalled", () => <Stalled {...props} />),
    Match.when("worker-context", () => <WorkerContext {...props} />),
    Match.when("lead-context", () => <LeadContext {...props} />),
    Match.exhaustive
  );

const leadName = (group: ConstellationGroup) =>
  group.lead?.session.title || `${group.view.constellation.name} lead`;

export const ConstellationGroups = ({
  groups,
  now,
}: {
  readonly groups: ReadonlyArray<ConstellationGroup>;
  readonly now: number;
}) =>
  groups.map((group) => (
    <section
      key={group.key}
      data-testid="constellation-needs-you"
      aria-label={leadName(group)}
      className="flex flex-col gap-2"
    >
      <h3 className="text-caption text-text-subtle flex items-center gap-1.5 px-1.5 pt-1.5">
        <ConstellationMark size={14} />
        <span className="truncate">{leadName(group)}</span>
      </h3>
      {group.items.map((item) => (
        <Item key={item.key} group={group} item={item} now={now} />
      ))}
    </section>
  ));
