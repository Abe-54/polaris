# Recoverable regular-file operations

`createFileEditCoordinator({ journalRoot, authorize })` is a detached Host
coordinator. `files/index.ts` exports its interface; G2 owns RPC registration.
No capability is advertised here. G2 depends on X2's directory extension before
resource activation. `journalRoot` is a canonical private Daemon directory
outside the checkout, on the same filesystem as its resources. It must not be
Client configurable or shared by simultaneously running Daemons.

The integration supplies an authenticated `Owner` (Host, Client, checkout) and
an accepted `LanguageEditProposal`, matching `LanguageEditAcceptance`, and a
verified Client `DraftReceipt`. `authorize` must revalidate connection ownership,
registered checkout, current generation/sequence/document fence and accepted
preview. The coordinator additionally checks schema, owner, expiry, exact
proposal/acceptance snapshots, canonical paths and disk versions. `durable:true`
is an integration assertion about Client draft storage, not Host persistence of
text. Text changes are never written by this coordinator. G2/R1 must persist and
validate that receipt before calling `accept`.

- `accept(owner, proposal, acceptance, drafts, signal?)` returns a durable
  `LanguageOperationOutcome`. Owner plus operation ID selects a SHA-256 journal
  directory. Duplicate identical acceptance returns the stored result without
  reapplying, including partial/restored outcomes. Reuse for a different request
  fails. The same proposal with a new operation ID must be separately authorized.
- `get(owner, operationId)` returns the stored receipt, or `null` for an unknown
  operation. G2 must bind this owner to the authenticated connection, including
  status queries. `applying` after restart is an unknown disk outcome until
  recovery; it does not mean an accepted batch finished.
- `recover(owner, operationId, expectedReceiptRevision, intent)` reverses owned
  moves, for `recover`, `undo` and `cancel`. It never resumes forward application.
  Revisions are compare-and-set guards. Query after a lost recovery response;
  retry with the returned revision. An old revision fails without changing disk.
  Terminal restored/rejected/failed queries with current revision are idempotent.

Each touched path requires exactly one canonical snapshot. The planner validates
all snapshots and the complete ordered resource chain before touching checkout
files. `steps.index` and `failedChange` retain the original `documentChanges`
index, even with interleaved text edits. Create stages an empty regular file;
rename preserves exact bytes/mode/mtime; delete moves to an operation backup.
Overwrite first backs up the destination, then moves the source/staged file.
Overwrite takes precedence over ignore-if-exists. Missing delete can be ignored;
missing rename source fails. Ignore steps retain their planned before/owned
versions as no-op receipts. Before/owned on individual steps describe that
step's place in the ordered chain, not a final snapshot of the whole batch.

All canonical resource locks are acquired in sorted order using the existing
`withFileMutation` queue, held through preparation/application/recovery. Forward
moves journal intent, fsync receipt/parent directories, recheck source and absent
destination, rename, fsync changed directories, and persist applied state.
Prepared creates are fsynced before the first durable receipt. Final applied
receipt precedes acknowledgment. Receipts are atomic replacements, fsynced, with
monotone revisions. Backups remain until a future explicit retention policy;
there is no timer, idle polling or eager scan of every journal.

After a crash, a forward/backward intent is reconciled only when the original
exact version is at the source with destination absent, or at the destination
with source absent. Anything else conflicts. Reverse iteration restores backups
and chain sources in order, persisting reverse intents and restored results.
Recovery may itself be partial; earlier successful reverse moves stay recorded.
An external/Agent version or a replacement in an operation-owned absence causes
`recovery-required`, retaining remaining backups. Path-parent changes and
symlink targets fail closed. Exact ownership uses the existing
`FileVersion { mtimeMs, size, SHA-256 }`, not a filesystem history oracle.

There is no filesystem-wide atomicity or OS compare-and-rename primitive.
External writes between the final version check and rename remain the same OS
race boundary as existing versioned saves. Do not interpret these guarantees as
isolation from malicious concurrent path replacement. Cross-filesystem renames
fail and produce durable partial outcomes; provision same-filesystem journals.
Disk-full/fsync failure can prevent the newest receipt: surface unknown outcome
and query the last durable receipt; never report success from an in-memory state.
Unjournaled staging from a crash before prepare is safe to discard for that
owner/operation ID only. Private journal directories are not untrusted input.

Directories (even empty), leaf symlinks, special files, non-file URIs, checkout
escapes, and `recursive:true` deletion are explicitly unsupported. Parent
symlinks are canonicalized on acceptance; each mutation uses and revalidates the
canonical parent. A same-canonical-path rename is rejected. X2 owns dedicated
bounded no-follow directory-tree snapshots, source/overwrite-target descendant
versions, tree/root race detection, dirty descendant drafts and tree recovery;
it must not overload regular-file `FileVersion`.

Fault fixtures use temporary checkouts/private journals and fake owners. Tests
cover intent/mutation/receipt crashes for every move of an overwrite chain,
reverse-intent/reverse-mutation crashes, actual subprocess SIGKILL, cancellation,
partial failures, stale/ambiguous inputs, retry payload conflicts and intervening
versions. `model.slow.test.ts` projects real journal/file observations to
`packages/spec/file-edits.qnt`; replay rejects a corrupted ownership observation.
The single-move model composes with ordered chain fixtures; finite simulations
are not a proof of arbitrary filesystem concurrency or platform behavior.
