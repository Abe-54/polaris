/**
 * A composer's attachments in React: one store per Host, Workspace and session, so chips staged
 * for one place never ride along to another. Null where the Host can't stage them.
 */
import type { Attachment, AttachmentId } from "@polaris/protocol";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useLiveHost } from "../runtime/hosts.tsx";
import {
  attachCaption,
  attachmentStore,
  type StageTarget,
  stagedIds,
  stagePicked,
  type Submission,
} from "./attach.ts";
import type { AttachInput } from "./controls.tsx";
import { pickAttachments, readBytes } from "./pick.ts";
import { keepStaged } from "../attachments/index.ts";

export interface Attachments {
  /** Pass to the composer; null hides Attach. */
  readonly input: AttachInput | null;
  /** What Send or Start carries. */
  readonly ids: ReadonlyArray<AttachmentId>;
  /** Some are still on their way: Send and Start wait. */
  readonly staging: boolean;
  /** What one Send or Queue carries, so its success removes only those chips. */
  readonly submission: () => Submission;
  readonly clear: () => void;
  /** Puts files already staged back as chips. */
  readonly restore: (attachments: ReadonlyArray<Attachment>) => void;
}

const NONE: ReadonlyArray<never> = [];

const NOTHING: Submission = { ids: NONE, attachments: NONE, done: () => undefined };

export const useAttachments = (target: StageTarget | null): Attachments => {
  const live = useLiveHost(target?.connection ?? null);
  const able = target !== null && (live?.capabilities.includes("attachments.stage") ?? false);

  const key =
    target === null
      ? null
      : `${target.connection.hostId}:${target.workspaceId}:${target.sessionId ?? ""}`;

  // The store is keyed by place; `target` is read only when the key changes.
  const store = useMemo(
    () =>
      target === null
        ? null
        : attachmentStore((picked) =>
            stagePicked(target, picked, readBytes).then((attachment) => {
              if (picked.isImage) void keepStaged(attachment.id, picked.uri);

              return attachment;
            })
          ),
    [key]
  );

  const chips = useSyncExternalStore(store?.subscribe ?? noSubscribe, store?.chips ?? noChips);

  const pick = useCallback(() => {
    if (store === null) return;
    void pickAttachments().then(store.add, () => undefined);
  }, [store]);

  const input = useMemo<AttachInput | null>(
    () =>
      store === null || !able
        ? null
        : { chips, caption: attachCaption(chips), pick, add: store.add, remove: store.remove },
    [store, able, chips, pick]
  );

  return {
    input,
    ids: able ? stagedIds(chips) : NONE,
    staging: able && chips.some((chip) => chip.status === "staging"),
    submission: () => (able && store !== null ? store.submission() : NOTHING),
    clear: () => store?.clear(),
    restore: (attachments) => store?.restore(attachments),
  };
};

const noSubscribe = () => () => undefined;

const noChips = () => NONE;
