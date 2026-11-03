/** Review's submission slots in React, sending through the Host's live connection. */
import type { Command } from "@polaris/protocol";
import { useCallback, useSyncExternalStore } from "react";
import type { LiveHost } from "../runtime/hostConnection.ts";
import { dispatchReview } from "./actions.ts";
import { DEVICE_COPY } from "../app/platformCopy.ts";
import { hostSubmissions, type SubmissionState } from "./submissions.ts";

/** The running app's slots. */
const submissionsFor = hostSubmissions(DEVICE_COPY.phone);

export interface ReviewSubmit {
  /** Answers why it failed, or null; "The host isn't connected" when there's no connection. */
  readonly submit: (
    slot: string,
    payload: string,
    build: (itemId: string) => Command
  ) => Promise<string | null>;
  readonly state: (slot: string) => SubmissionState | null;
  /** Changes whenever a slot's state does, for memos that read `state`. */
  readonly version: number;
}

/** The Host's slots, shared by every view that submits for it and kept across their remounts. */
export const useReviewSubmissions = (hostId: string, live: LiveHost | null): ReviewSubmit => {
  const submissions = submissionsFor(hostId);
  const version = useSyncExternalStore(submissions.subscribe, submissions.version);

  const submit = useCallback<ReviewSubmit["submit"]>(
    (slot, payload, build) =>
      live === null
        ? Promise.resolve("The host isn't connected")
        : submissions.submit(slot, payload, build, (command, id) =>
            dispatchReview(live.client, command, id)
          ),
    [live, submissions]
  );

  return { submit, state: submissions.state, version };
};
