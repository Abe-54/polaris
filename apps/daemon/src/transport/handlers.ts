/**
 * Handlers the transport owns (`hello`) and placeholders for every other RPC,
 * so a Daemon is runnable end to end before the store, files, git and terminal
 * modules land. `server.ts` layers real handlers over these.
 */
import {
  InlineError,
  PredictionError,
  CommitMessageError,
  LanguageIdentityError,
  type Capability,
  CommandRejected,
  ConstellationRejected,
  ConstellationTransferError,
  ConstellationFinding,
  FileError,
  GitError,
  type HostInfo,
  NotFound,
  Sequence,
  Unsupported,
  ResourceError,
  RestartError,
  encodePairingString,
  VoiceError,
  SecretRejected,
  PROTOCOL_VERSION,
  decideProtocol,
  PushRegistrationError,
  PresenceLease,
} from "@polaris/protocol";
import { Effect, Option, Stream } from "effect";
import { ClientCapabilities, DeviceLabel } from "../engine/rpc.ts";
import { BlobChannel } from "../services.ts";
import { ServerRpcs } from "./rpcs.ts";
import { languageDefaults } from "./languageDefaults.ts";
import { helloHost } from "./hostInfo.ts";
import { bindLanguageIdentity } from "./languageIdentity.ts";
import { pairingOf, revokePairing, scopeConnection } from "../extensions/connection.ts";
import { Pairings } from "../extensions/pairings.ts";
import { RemoteAccessControl } from "../remoteAccess/index.ts";
import { RemoteAccess } from "../extensions/remoteAccess.ts";
import { admissionOf } from "../extensions/admission.ts";
import { deviceOf } from "../linkedDevices/connection.ts";
import { RelayRoute } from "../linkedDevices/route.ts";
import { HostPresence } from "../presence/index.ts";
import { browserDefaults } from "../browser/index.ts";

const notADevice = () =>
  new PushRegistrationError({
    reason: "not-a-device",
    message: "Only a Linked Device registers for push, over the Relay route",
  });

const constellationUnavailable = () =>
  new ConstellationRejected({
    findings: [
      new ConstellationFinding({
        code: "E-UNAVAILABLE",
        message: "Constellations are not available on this Daemon yet",
        fix: "Connect to a Daemon with the constellation capability",
      }),
    ],
    graph: null,
    revision: 0,
  });

const notYet = (what: string) => `${what} is not available on this Daemon yet`;

const fileError = (path: string, what: string) =>
  new FileError({ path, code: "ENOTSUP", message: notYet(what) });

export const defaultHandlers = (options: {
  readonly hostInfo: HostInfo;
  readonly capabilities: ReadonlyArray<Capability>;
}) =>
  ServerRpcs.toLayer({
    ...languageDefaults,
    ...browserDefaults,
    "prediction.capability": () =>
      Effect.fail(
        new PredictionError({
          reason: "unavailable",
          message: "Prediction capability is unavailable",
        })
      ),
    "prediction.context": () =>
      Effect.fail(
        new PredictionError({ reason: "unavailable", message: "Prediction context is unavailable" })
      ),
    "prediction.complete": () =>
      Stream.fail(
        new PredictionError({
          reason: "unavailable",
          message: "Prediction completion is unavailable",
        })
      ),
    "prediction.edit": () =>
      Stream.fail(
        new PredictionError({ reason: "unavailable", message: "Edit prediction is unavailable" })
      ),
    "prediction.server": () =>
      Effect.fail(
        new PredictionError({
          reason: "unavailable",
          message: "Model server checks are unavailable",
        })
      ),
    "prediction.managed": () =>
      Effect.fail(
        new PredictionError({
          reason: "unavailable",
          message: "Managed model server is unavailable",
        })
      ),
    "prediction.managed.watch": () =>
      Stream.fail(
        new PredictionError({
          reason: "unavailable",
          message: "Managed model server is unavailable",
        })
      ),
    "host.resources.get": () =>
      Effect.fail(new ResourceError({ message: "Host resources are unavailable" })),
    "host.resources.declare": () =>
      Effect.fail(new ResourceError({ message: "Host resources are unavailable" })),
    "host.resources.remove": () =>
      Effect.fail(new ResourceError({ message: "Host resources are unavailable" })),
    "host.resources.release": () =>
      Effect.fail(new ResourceError({ message: "Host resources are unavailable" })),
    "host.workers.setCap": () =>
      Effect.fail(new ResourceError({ message: "Host resources are unavailable" })),
    "host.resources.acquire": () =>
      Effect.fail(new ResourceError({ message: "Host resources are unavailable" })),

    "constellation.placements.watch": () =>
      Stream.fail(
        new ConstellationTransferError({
          code: "E-UNAVAILABLE",
          message: "Constellation transfers are not mounted",
          retryable: true,
        })
      ),
    "constellation.placement.resolve": () =>
      Effect.fail(
        new ConstellationTransferError({
          code: "E-UNAVAILABLE",
          message: "Constellation transfers are not mounted",
          retryable: true,
        })
      ),
    "constellation.repository.prepare": () =>
      Effect.fail(
        new ConstellationTransferError({
          code: "E-UNAVAILABLE",
          message: "Constellation transfers are not mounted",
          retryable: true,
        })
      ),
    "constellation.worker.prepare": () =>
      Effect.fail(
        new ConstellationTransferError({
          code: "E-UNAVAILABLE",
          message: "Constellation transfers are not mounted",
          retryable: true,
        })
      ),
    "constellation.delivery.watch": () =>
      Stream.fail(
        new ConstellationTransferError({
          code: "E-UNAVAILABLE",
          message: "Constellation transfers are not mounted",
          retryable: true,
        })
      ),
    "constellation.delivery.apply": () =>
      Effect.fail(
        new ConstellationTransferError({
          code: "E-UNAVAILABLE",
          message: "Constellation transfers are not mounted",
          retryable: true,
        })
      ),
    "constellation.delivery.ack": () =>
      Effect.fail(
        new ConstellationTransferError({
          code: "E-UNAVAILABLE",
          message: "Constellation transfers are not mounted",
          retryable: true,
        })
      ),
    "constellation.base.export": () =>
      Effect.fail(
        new ConstellationTransferError({
          code: "E-UNAVAILABLE",
          message: "Constellation transfers are not mounted",
          retryable: true,
        })
      ),
    "constellation.base.import": () =>
      Effect.fail(
        new ConstellationTransferError({
          code: "E-UNAVAILABLE",
          message: "Constellation transfers are not mounted",
          retryable: true,
        })
      ),
    "constellation.worktree.prepare": () =>
      Effect.fail(
        new ConstellationTransferError({
          code: "E-UNAVAILABLE",
          message: "Constellation transfers are not mounted",
          retryable: true,
        })
      ),
    "constellation.bundle.export": () =>
      Effect.fail(
        new ConstellationTransferError({
          code: "E-UNAVAILABLE",
          message: "Constellation transfers are not mounted",
          retryable: true,
        })
      ),
    "constellation.bundle.import": () =>
      Effect.fail(
        new ConstellationTransferError({
          code: "E-UNAVAILABLE",
          message: "Constellation transfers are not mounted",
          retryable: true,
        })
      ),
    "constellation.assignment.set": () =>
      Effect.fail(
        new ConstellationTransferError({
          code: "E-UNAVAILABLE",
          message: "Constellation transfers are not mounted",
          retryable: true,
        })
      ),
    "constellation.assignment.list": () =>
      Effect.fail(
        new ConstellationTransferError({
          code: "E-UNAVAILABLE",
          message: "Constellation transfers are not mounted",
          retryable: true,
        })
      ),
    "constellation.outbox.watch": () =>
      Stream.fail(
        new ConstellationTransferError({
          code: "E-UNAVAILABLE",
          message: "Constellation transfers are not mounted",
          retryable: true,
        })
      ),
    "constellation.outbox.apply": () =>
      Effect.fail(
        new ConstellationTransferError({
          code: "E-UNAVAILABLE",
          message: "Constellation transfers are not mounted",
          retryable: true,
        })
      ),
    "constellation.outbox.ack": () =>
      Effect.fail(
        new ConstellationTransferError({
          code: "E-UNAVAILABLE",
          message: "Constellation transfers are not mounted",
          retryable: true,
        })
      ),
    "constellation.claim.export": () =>
      Effect.fail(
        new ConstellationTransferError({
          code: "E-UNAVAILABLE",
          message: "Constellation transfers are not mounted",
          retryable: true,
        })
      ),
    "constellation.origin.import": () =>
      Effect.fail(
        new ConstellationTransferError({
          code: "E-UNAVAILABLE",
          message: "Constellation transfers are not mounted",
          retryable: true,
        })
      ),
    "constellation.defaults.get": () => Effect.fail(constellationUnavailable()),
    "constellation.defaults.set": () => Effect.fail(constellationUnavailable()),
    "constellation.plan": () => Effect.fail(constellationUnavailable()),
    "constellation.dispatch": () => Effect.fail(constellationUnavailable()),
    "constellation.review": () => Effect.fail(constellationUnavailable()),
    "constellation.answer": () => Effect.fail(constellationUnavailable()),
    "constellation.message": () => Effect.fail(constellationUnavailable()),
    "constellation.status": () => Effect.fail(constellationUnavailable()),
    "constellation.stats": () => Effect.fail(constellationUnavailable()),
    "constellation.connection": () => Effect.fail(constellationUnavailable()),
    "constellation.set_state": () => Effect.fail(constellationUnavailable()),
    "constellation.worker.block": () => Effect.fail(constellationUnavailable()),
    "constellation.worker.claim": () => Effect.fail(constellationUnavailable()),
    "constellation.worker.ask": () => Effect.fail(constellationUnavailable()),
    "constellation.worker.progress": () => Effect.fail(constellationUnavailable()),
    "constellation.worker.propose": () => Effect.fail(constellationUnavailable()),
    "constellation.worker.message": () => Effect.fail(constellationUnavailable()),
    "constellation.worker.start": () => Effect.fail(constellationUnavailable()),
    "constellation.subscribe": () => Stream.fail(constellationUnavailable()),
    // Record which device this connection is (for ApprovalResolved.resolvedBy), what it
    // understands (e.g. whether to send it ItemProgress), and the Pairing it acts as.
    hello: (
      { deviceLabel, capabilities, languageProof, extensionToken, protocolVersions },
      { client }
    ) =>
      Effect.gen(function* () {
        yield* scopeConnection(client, extensionToken);

        // The gateway (admission.tokenRequired) needs the range; a mismatch names the side to update.
        const mismatch = decideProtocol(
          PROTOCOL_VERSION,
          protocolVersions,
          admissionOf(client).tokenRequired
        );

        admissionOf(client).protocolReady = false;

        if (mismatch !== null) return yield* mismatch;

        const languageIdentity = yield* Effect.try({
          try: () => bindLanguageIdentity(client, options.hostInfo.hostId, languageProof),
          catch: () => new LanguageIdentityError({ message: "Language identity unavailable" }),
        });

        // The Pairing the connection keeps, not this hello's: a later token-less
        // hello on a scoped connection cannot relabel it.
        const pairing = pairingOf(client);

        client.annotate(DeviceLabel, pairing?.name ?? deviceOf(client)?.name ?? deviceLabel);
        client.annotate(ClientCapabilities, capabilities);
        admissionOf(client).protocolReady = true;

        const response = {
          ...helloHost(options.hostInfo, capabilities),
          capabilities: options.capabilities,
        };

        return languageIdentity === null ? response : { ...response, languageIdentity };
      }),

    // Token-less Clients only (grants.ts): the gate refuses these to Extensions.
    "extensions.pair": ({ name, grant }) =>
      Effect.gen(function* () {
        const { pairing, token } = yield* Effect.orDie((yield* Pairings).pair(name, grant));
        const url = yield* (yield* RemoteAccess).url;

        const pairingString = encodePairingString({
          hostId: options.hostInfo.hostId,
          hostName: options.hostInfo.hostname,
          url: Option.getOrNull(url),
          token,
          name: pairing.name,
        });

        return { pairing, token, pairingString };
      }),
    "extensions.list": () => Effect.flatMap(Pairings, (pairings) => Effect.orDie(pairings.list)),
    "extensions.revoke": ({ id }) => revokePairing(id),

    // Token-less Clients only, like the Pairings: Tailscale's own state, read back each time.
    "remoteAccess.status": () => Effect.flatMap(RemoteAccessControl, (control) => control.status),
    "remoteAccess.enable": () => Effect.flatMap(RemoteAccessControl, (control) => control.enable),
    "remoteAccess.disable": () => Effect.flatMap(RemoteAccessControl, (control) => control.disable),
    "host.restartPreview": () => Effect.fail(new RestartError({ message: notYet("Restart") })),
    "host.prepareRestart": () => Effect.fail(new RestartError({ message: notYet("Restart") })),

    // Token-less Clients only: the Relay route and Linked Devices (ADR 0083).
    "relayRoute.status": () => Effect.flatMap(RelayRoute, (route) => route.status),
    "relayRoute.enable": ({ url }) => Effect.flatMap(RelayRoute, (route) => route.enable(url)),
    "relayRoute.disable": () => Effect.flatMap(RelayRoute, (route) => route.disable),
    "devices.link": () => Effect.flatMap(RelayRoute, (route) => route.startLink),
    "devices.awaitLink": ({ linkId }) =>
      Effect.flatMap(RelayRoute, (route) => route.awaitLink(linkId)),
    "devices.cancelLink": ({ linkId }) =>
      Effect.flatMap(RelayRoute, (route) => route.cancelLink(linkId)),
    "devices.add": (device) => Effect.flatMap(RelayRoute, (route) => route.add(device)),
    "devices.list": () => Effect.flatMap(RelayRoute, (route) => route.list),
    "devices.watch": () => Stream.unwrap(Effect.map(RelayRoute, (route) => route.watch)),
    "devices.unlink": ({ id }) => Effect.flatMap(RelayRoute, (route) => route.unlink(id)),
    "devices.unlinkSelf": (_, { client }) => {
      const device = deviceOf(client);

      return device === null
        ? Effect.fail(new NotFound({ what: "linked device", id: "this connection" }))
        : Effect.flatMap(RelayRoute, (route) => route.unlinkSelf(device.id));
    },
    // The Desktop App's connections only (DEVICE_RPCS, RPC_GRANTS): a lease per connection.
    "presence.report": ({ presence }, { client }) =>
      Effect.map(
        HostPresence,
        (host) => new PresenceLease({ leaseMs: host.report(client.id, presence) })
      ),
    // A Linked Device's own connection only: the device registers itself (ADR 0083).
    "devices.registerPush": (registration, { client }) => {
      const device = deviceOf(client);

      return device === null
        ? Effect.fail(notADevice())
        : Effect.flatMap(RelayRoute, (route) => route.registerPush(device, registration));
    },
    "devices.unregisterPush": (_, { client }) => {
      const device = deviceOf(client);

      return device === null
        ? Effect.fail(notADevice())
        : Effect.flatMap(RelayRoute, (route) => route.unregisterPush(device));
    },
    "devices.registerLiveActivity": (registration, { client }) => {
      const device = deviceOf(client);

      return device === null
        ? Effect.fail(notADevice())
        : Effect.flatMap(RelayRoute, (route) => route.registerLiveActivity(device, registration));
    },
    "devices.unregisterLiveActivity": (_, { client }) => {
      const device = deviceOf(client);

      return device === null
        ? Effect.fail(notADevice())
        : Effect.flatMap(RelayRoute, (route) => route.unregisterLiveActivity(device));
    },

    dispatch: ({ commandId }) =>
      Effect.fail(new CommandRejected({ commandId, reason: notYet("the event store") })),

    // An empty Host: a snapshot at sequence 0, then nothing.
    subscribeHost: () =>
      Stream.concat(
        Stream.fromIterable([
          {
            _tag: "Snapshot" as const,
            sequence: Sequence.make(0),
            workspaces: [],
            worktrees: [],
            sessions: [],
            reviewCheckouts: [],
          },
          { _tag: "Synchronized" as const, sequence: Sequence.make(0) },
        ]),
        Stream.never
      ),

    subscribeSession: ({ sessionId }) =>
      Stream.fail(new NotFound({ what: "session", id: sessionId })),
    "session.terminalCommand": ({ sessionId }) =>
      Effect.fail(new NotFound({ what: "session", id: sessionId })),
    "session.turns": ({ sessionId }) =>
      Effect.fail(new NotFound({ what: "session", id: sessionId })),

    "harness.models": () => Effect.fail(new Unsupported({ capability: "harness.models" })),
    "harness.commands": () => Effect.fail(new Unsupported({ capability: "harness.commands" })),
    "harness.spinnerVerbs": () => Effect.succeed(null),
    "harness.availability": () =>
      Effect.fail(new Unsupported({ capability: "harness.availability" })),
    "harness.watchAvailability": () =>
      Stream.fail(new Unsupported({ capability: "harness.availability" })),
    "usage.query": () => Effect.fail(new Unsupported({ capability: "usage" })),
    "inline.propose": () =>
      Stream.fail(
        new InlineError({
          reason: "harness-failed",
          message: "This Daemon does not support inline.propose",
        })
      ),
    "usage.watch": () => Stream.fail(new Unsupported({ capability: "usage" })),
    "host.stats.watch": () => Stream.fail(new Unsupported({ capability: "host.stats" })),
    "commit.suggestMessage": () =>
      Stream.fail(
        new CommitMessageError({
          reason: "harness-failed",
          message: "This Daemon does not support commit.suggestMessage",
        })
      ),

    "files.listDir": ({ path }) => Effect.fail(fileError(path, "files")),
    "files.stat": ({ path }) => Effect.fail(fileError(path, "files")),
    "files.readVersioned": ({ path }) => Effect.fail(fileError(path, "versioned files")),
    "files.write": ({ path }) => Effect.fail(fileError(path, "file writing")),
    "files.create": ({ path }) => Effect.fail(fileError(path, "file management")),
    "files.rename": ({ path }) => Effect.fail(fileError(path, "file management")),
    "files.delete": ({ path }) => Effect.fail(fileError(path, "file management")),
    "files.watchFile": ({ path }) => Stream.fail(fileError(path, "file watching")),
    "files.read": ({ path }) => Effect.fail(fileError(path, "files")),
    "files.searchPaths": ({ root }) => Effect.fail(fileError(root, "file search")),
    "files.grep": ({ root }) => Effect.fail(fileError(root, "file search")),
    "files.watch": ({ root }) => Stream.fail(fileError(root, "file watching")),

    "git.status": ({ cwd }) => Effect.fail(new GitError({ cwd, message: notYet("git") })),
    "git.diff": ({ cwd }) => Effect.fail(new GitError({ cwd, message: notYet("git") })),
    "git.show": ({ cwd }) => Effect.fail(new GitError({ cwd, message: notYet("git") })),
    "git.log": ({ cwd }) => Effect.fail(new GitError({ cwd, message: notYet("git") })),
    "git.stage": ({ cwd }) => Effect.fail(new GitError({ cwd, message: notYet("git") })),
    "git.unstage": ({ cwd }) => Effect.fail(new GitError({ cwd, message: notYet("git") })),
    "git.discard": ({ cwd }) => Effect.fail(new GitError({ cwd, message: notYet("git") })),
    "git.init": ({ path }) => Effect.fail(new GitError({ cwd: path, message: notYet("git") })),
    "git.commit": ({ cwd }) => Stream.fail(new GitError({ cwd, message: notYet("git") })),
    "git.watch": ({ cwd }) => Stream.fail(new GitError({ cwd, message: notYet("git") })),
    "git.sync": ({ cwd }) => Stream.fail(new GitError({ cwd, message: notYet("git") })),

    // TODO(M2-C checkout): the live status of a Review Checkout.
    "review.checkoutStatus": () => Effect.fail(new Unsupported({ capability: "review.checkouts" })),
    // TODO(M2-R rules, M2-V reviewer): run the Rules and the Reviewer.
    "review.runWalkthrough": () =>
      Effect.fail(new Unsupported({ capability: "review.walkthrough" })),
    "review.stopWalkthrough": () =>
      Effect.fail(new Unsupported({ capability: "review.walkthrough" })),
    "review.runRiskSummary": () =>
      Effect.fail(new Unsupported({ capability: "review.risk-summary" })),
    "review.riskSummary": () => Effect.fail(new Unsupported({ capability: "review.risk-summary" })),
    "review.watchRiskSummary": () =>
      Stream.fail(new Unsupported({ capability: "review.risk-summary" })),
    // TODO(M2-V reviewer): continue the Reviewer's own Agent Session.
    "review.askFinding": () => Effect.fail(new Unsupported({ capability: "review.ask" })),
    "review.verdicts": () => Effect.fail(new Unsupported({ capability: "review.verdicts" })),
    "review.reviewerSettings": () =>
      Effect.fail(new Unsupported({ capability: "review.reviewer-settings" })),
    "review.setReviewerSettings": () =>
      Effect.fail(new Unsupported({ capability: "review.reviewer-settings" })),

    "session.acceptPlan": () => Effect.fail(new Unsupported({ capability: "session.accept" })),
    "session.draftAccept": () => Effect.fail(new Unsupported({ capability: "session.accept" })),
    "session.commitAccepted": () => Effect.fail(new Unsupported({ capability: "session.accept" })),
    "session.pushAccepted": () => Effect.fail(new Unsupported({ capability: "session.accept" })),

    // Drain the bytes the Client already sent so they don't sit in the connection buffer.
    "attachments.stage": ({ name, blobId }) =>
      Effect.gen(function* () {
        const blobs = yield* BlobChannel;
        yield* Effect.ignore(blobs.take(blobId));

        return yield* fileError(name, "attachments");
      }),

    "sessions.autoArchive": () =>
      Effect.fail(new Unsupported({ capability: "sessions.auto-archive" })),
    "sessions.setAutoArchive": () =>
      Effect.fail(new Unsupported({ capability: "sessions.auto-archive" })),
    "sessions.idleCompaction": () =>
      Effect.fail(new Unsupported({ capability: "sessions.idle-compaction" })),
    "sessions.setIdleCompaction": () =>
      Effect.fail(new Unsupported({ capability: "sessions.idle-compaction" })),
    "sessions.visuals": () => Effect.fail(new Unsupported({ capability: "sessions.visuals" })),
    "sessions.setVisuals": () => Effect.fail(new Unsupported({ capability: "sessions.visuals" })),
    "continuity.watch": () => Stream.fail(new Unsupported({ capability: "session.continuity" })),
    "continuity.markRead": () => Effect.fail(new Unsupported({ capability: "session.continuity" })),
    "continuity.saveDraft": () =>
      Effect.fail(new Unsupported({ capability: "session.continuity" })),
    "attachments.settings": () =>
      Effect.fail(new Unsupported({ capability: "attachments.settings" })),
    "attachments.setSettings": () =>
      Effect.fail(new Unsupported({ capability: "attachments.settings" })),
    "attachments.clear": () => Effect.fail(new Unsupported({ capability: "attachments.settings" })),
    "attachments.read": ({ attachmentId }) => Effect.fail(fileError(attachmentId, "attachments")),

    "voice.transcribe": () =>
      Stream.fail(new VoiceError({ reason: "provider-failed", message: notYet("Voice") })),
    "voice.settings": () =>
      Effect.fail(new VoiceError({ reason: "provider-failed", message: notYet("Voice") })),
    "voice.setKey": () =>
      Effect.fail(new VoiceError({ reason: "provider-failed", message: notYet("Voice") })),

    "secret.provide": () =>
      Effect.fail(new SecretRejected({ reason: "storage", message: notYet("Secret Requests") })),

    "terminal.open": ({ cwd }) => Effect.fail(fileError(cwd, "terminals")),
    "terminal.attach": ({ terminalId }) =>
      Stream.fail(new NotFound({ what: "terminal", id: terminalId })),
    "terminal.attachBinary": ({ terminalId }) =>
      Stream.fail(new NotFound({ what: "terminal", id: terminalId })),
    "terminal.input": ({ terminalId }) =>
      Effect.fail(new NotFound({ what: "terminal", id: terminalId })),
    "terminal.resize": ({ terminalId }) =>
      Effect.fail(new NotFound({ what: "terminal", id: terminalId })),
    "terminal.close": ({ terminalId }) =>
      Effect.fail(new NotFound({ what: "terminal", id: terminalId })),
  });
