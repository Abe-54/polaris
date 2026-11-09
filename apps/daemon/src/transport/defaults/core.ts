import {
  AskFinding,
  ClaudeSpinnerVerbs,
  ClearAttachments,
  CommandRejected,
  CommitAccepted,
  Dispatch,
  DraftAccept,
  GetAcceptPlan,
  GetAttachmentSettings,
  GetReviewerSettings,
  GetRiskSummary,
  GitDiff,
  GitError,
  GitShow,
  GitStatus,
  Grep,
  HarnessAvailabilityQuery,
  Hello,
  InlineError,
  InlinePropose,
  LanguageIdentityError,
  ListDir,
  ListHarnessCommands,
  ListModels,
  ListVerdicts,
  NotFound,
  PROTOCOL_VERSION,
  PushAccepted,
  QueryUsage,
  ReadAttachment,
  ReadFile,
  ReviewCheckoutStatusQuery,
  RunRiskSummary,
  RunWalkthrough,
  SearchPaths,
  Sequence,
  SessionTerminalCommand,
  SetAttachmentSettings,
  SetReviewerSettings,
  StageAttachment,
  Stat,
  StopWalkthrough,
  SubscribeHost,
  SubscribeSession,
  WatchFiles,
  WatchHarnessAvailability,
  WatchRiskSummary,
  WatchUsage,
  decideProtocol,
} from "@polaris/protocol";
import { Effect, Stream } from "effect";
import { RpcGroup } from "effect/rpc";
import { ClientCapabilities, DeviceLabel } from "../../engine/rpc.ts";
import { admissionOf } from "../../extensions/admission.ts";
import { pairingOf, scopeConnection } from "../../extensions/connection.ts";
import { deviceOf } from "../../linkedDevices/connection.ts";
import { BlobChannel } from "../../services.ts";
import { helloHost } from "../hostInfo.ts";
import { bindLanguageIdentity } from "../languageIdentity.ts";
import { ConnectionBlobs } from "../rpcs.ts";
import { type DefaultOptions, fileError, notYet, unsupported, unsupportedFeed } from "./shared.ts";

/** The RPCs `DaemonRpcs` declares itself rather than merging in from a named group. */
const CoreRpcs = RpcGroup.make(
  InlinePropose,
  Hello,
  Dispatch,
  SubscribeHost,
  SubscribeSession,
  SessionTerminalCommand,
  ListModels,
  ListHarnessCommands,
  ClaudeSpinnerVerbs,
  HarnessAvailabilityQuery,
  WatchHarnessAvailability,
  QueryUsage,
  WatchUsage,
  ListDir,
  Stat,
  ReadFile,
  SearchPaths,
  Grep,
  WatchFiles,
  GitStatus,
  GitDiff,
  GitShow,
  ReviewCheckoutStatusQuery,
  RunRiskSummary,
  RunWalkthrough,
  StopWalkthrough,
  GetRiskSummary,
  WatchRiskSummary,
  AskFinding,
  ListVerdicts,
  GetAcceptPlan,
  DraftAccept,
  CommitAccepted,
  PushAccepted,
  GetReviewerSettings,
  SetReviewerSettings,
  StageAttachment,
  GetAttachmentSettings,
  SetAttachmentSettings,
  ClearAttachments,
  ReadAttachment
).middleware(ConnectionBlobs);

const gitUnavailable = (cwd: string) => new GitError({ cwd, message: notYet("git") });

/** `hello`, sessions, harnesses, the read-only files and git, Review and attachments. */
export const coreDefaults = (options: DefaultOptions) =>
  CoreRpcs.toLayer({
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

    "harness.models": unsupported("harness.models"),
    "harness.commands": unsupported("harness.commands"),
    "harness.spinnerVerbs": () => Effect.succeed(null),
    "harness.availability": unsupported("harness.availability"),
    "harness.watchAvailability": unsupportedFeed("harness.availability"),
    "usage.query": unsupported("usage"),
    "usage.watch": unsupportedFeed("usage"),
    "inline.propose": () =>
      Stream.fail(
        new InlineError({
          reason: "harness-failed",
          message: "This Daemon does not support inline.propose",
        })
      ),

    "files.listDir": ({ path }) => Effect.fail(fileError(path, "files")),
    "files.stat": ({ path }) => Effect.fail(fileError(path, "files")),
    "files.read": ({ path }) => Effect.fail(fileError(path, "files")),
    "files.searchPaths": ({ root }) => Effect.fail(fileError(root, "file search")),
    "files.grep": ({ root }) => Effect.fail(fileError(root, "file search")),
    "files.watch": ({ root }) => Stream.fail(fileError(root, "file watching")),

    "git.status": ({ cwd }) => Effect.fail(gitUnavailable(cwd)),
    "git.diff": ({ cwd }) => Effect.fail(gitUnavailable(cwd)),
    "git.show": ({ cwd }) => Effect.fail(gitUnavailable(cwd)),

    // TODO(M2-C checkout): the live status of a Review Checkout.
    "review.checkoutStatus": unsupported("review.checkouts"),
    // TODO(M2-R rules, M2-V reviewer): run the Rules and the Reviewer.
    "review.runWalkthrough": unsupported("review.walkthrough"),
    "review.stopWalkthrough": unsupported("review.walkthrough"),
    "review.runRiskSummary": unsupported("review.risk-summary"),
    "review.riskSummary": unsupported("review.risk-summary"),
    "review.watchRiskSummary": unsupportedFeed("review.risk-summary"),
    // TODO(M2-V reviewer): continue the Reviewer's own Agent Session.
    "review.askFinding": unsupported("review.ask"),
    "review.verdicts": unsupported("review.verdicts"),
    "review.reviewerSettings": unsupported("review.reviewer-settings"),
    "review.setReviewerSettings": unsupported("review.reviewer-settings"),

    "session.acceptPlan": unsupported("session.accept"),
    "session.draftAccept": unsupported("session.accept"),
    "session.commitAccepted": unsupported("session.accept"),
    "session.pushAccepted": unsupported("session.accept"),

    // Drain the bytes the Client already sent so they don't sit in the connection buffer.
    "attachments.stage": ({ name, blobId }) =>
      Effect.gen(function* () {
        const blobs = yield* BlobChannel;
        yield* Effect.ignore(blobs.take(blobId));

        return yield* fileError(name, "attachments");
      }),
    "attachments.settings": unsupported("attachments.settings"),
    "attachments.setSettings": unsupported("attachments.settings"),
    "attachments.clear": unsupported("attachments.settings"),
    "attachments.read": ({ attachmentId }) => Effect.fail(fileError(attachmentId, "attachments")),
  });
