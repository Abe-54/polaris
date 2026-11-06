import { expect, test } from "bun:test";
import {
  Actor,
  ApprovalDecision,
  DomainEvent,
  EventEnvelope,
  LinkedDeviceId,
  RequestId,
  Sequence,
  SessionId,
  SessionStreamItem,
} from "@polaris/protocol";
import { Predicate, Schema } from "effect";
import { actorSessionItemsFor } from "./actorCompat.ts";

const phone = Actor.cases.LinkedDevice.make({
  deviceId: LinkedDeviceId.make("dev_1"),
  name: "Phone",
});

const resolved = SessionStreamItem.cases.Event.make({
  envelope: new EventEnvelope({
    sequence: Sequence.make(3),
    occurredAt: "2026-10-27T00:00:00.000Z",
    commandId: null,
    event: DomainEvent.cases.ApprovalResolved.make({
      sessionId: SessionId.make("s1"),
      requestId: RequestId.make("r1"),
      decision: ApprovalDecision.cases.Allow.make({ remember: false }),
      resolvedBy: "Phone",
      actor: phone,
    }),
  }),
});

/** What a Client from before Linked Devices decodes the Actor with. */
const OldActor = Schema.TaggedUnion({
  Client: {},
  Extension: { pairingId: Schema.String, name: Schema.String },
});

/** The approval's Actor as it goes on the wire. */
const encodeActor = Schema.encodeSync(Actor);

const actorIn = (item: SessionStreamItem): typeof Actor.Encoded | null | undefined => {
  if (
    !Predicate.isTagged(item, "Event") ||
    !Predicate.isTagged(item.envelope.event, "ApprovalResolved")
  )
    throw new Error("expected the approval event");
  const actor = item.envelope.event.actor;

  return actor == null ? actor : encodeActor(actor);
};

test("a Client without actor.linked-device reads a Linked Device's approval as a Client's", () => {
  const old = actorSessionItemsFor([]);

  if (old === null) throw new Error("expected a rewrite for an older Client");
  const actor = actorIn(old(resolved));

  expect(Schema.is(OldActor)(actor)).toBe(true);
  expect(actor).toEqual(encodeActor(Actor.cases.Client.make({})));
});

test("a Client with actor.linked-device sees the device", () => {
  expect(actorSessionItemsFor(["actor.linked-device"])).toBeNull();
});
