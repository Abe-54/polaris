---
status: accepted (ENG-901)
---

# A snapshot checks its tree only when `write-tree` left the index alone

## Context

A snapshot (`apps/daemon/src/git/snapshot.ts`) runs `git add -A` and `git write-tree` on
Polaris's own index, `<git dir>/polaris/index`. `git gc` doesn't treat that index as a root, so
the trees its cache-tree extension names can be pruned once no checkpoint ref holds them. Since
1ae6b2837 every snapshot ran `git cat-file -e <tree>^{tree}` after `write-tree`, and took the
throwaway-index fallback when the tree was gone. That is one more git per Checkpoint (two per
Turn) and per working-tree diff. ENG-901 asked where the check is needed.

Measured with git 2.54.0 (Apple Git-157), and read in git's `cache-tree.c`:

- Up to git 2.49, `cache_tree_fully_valid` counts a cached tree as valid only if its object
  exists. A pruned tree is rebuilt, and the rebuild fails on a pruned blob, so `write-tree`
  never names a missing tree.
- From git 2.50 to at least 2.54 the test is inverted (`odb_has_object(…)` lost its `!`). A cache
  whose trees all exist counts as invalid: `write-tree` walks it again, finds each tree present,
  and rewrites the index. A cache whose trees are all gone counts as valid: `write-tree` prints
  the pruned tree's name, exits 0 and leaves the index as it was. In 180 runs of snapshot, drop
  the ref, `gc --prune=now`, snapshot, the second `write-tree` named a missing tree in the 11 runs
  where `add -A` had nothing to restage, and in none of the others.
- In every version, when `write-tree` rewrites the index it has just been through
  `cache_tree_update`, which returns a tree only after finding its object or writing it.

So a missing tree is only ever named by a `write-tree` that left the index file alone.

## Decision

`addAndWriteTree` compares the index's stat signature (device, inode, size, mtime, ctime) before
and after `write-tree`. A rewritten index means the tree exists and no check runs. An index left
alone gets the `cat-file -e` check as before, and a missing tree takes the fallback.

Only this Daemon writes its own index and snapshots of one index are serialized, so a changed
signature is `write-tree`'s own write. git writes an index as a new file renamed into place: the
inode changes even where timestamps are coarse. A signature read as unchanged when it did change
only costs the check.

## Consequences

- On git 2.50 and later a snapshot starts three gits (`add`, `write-tree`, `rev-parse HEAD`)
  instead of four, except right after a prune, where the check and then the fallback run. Before
  2.50 a snapshot of an unchanged working tree still runs the check, which there can't fail.
- The check covers the root tree only, as before. A pruned blob or subtree under a root that
  survived is not noticed by either version of this code.
- `snapshot.slow.test.ts` holds both sides: a tree pruned from under an index that `add -A`
  doesn't touch is written again, and a snapshot of an edited working tree starts no `cat-file`.
- If git fixes `cache_tree_fully_valid`, the check runs more often and stays correct.
