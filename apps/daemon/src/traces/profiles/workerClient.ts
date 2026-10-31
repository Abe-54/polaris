import { Schema } from "effect";
import { ProfileError } from "@polaris/protocol";
import { isEmbeddedPath } from "../../platform/detect.ts";
import { ProfileChanged, ProfileReply, type ProfileJob } from "./workerProtocol.ts";

export const profileDirectory = async (
  root: string,
  checkout: string,
  id: string
): Promise<string> => {
  const { createHash } = await import("node:crypto");
  const { join } = await import("node:path");

  return join(root, createHash("sha256").update(checkout).digest("hex"), id);
};

const workerUrl = () =>
  isEmbeddedPath(new URL("./worker.ts", import.meta.url).pathname)
    ? new URL("./traces/profiles/worker.js", import.meta.url).href
    : new URL("./worker.ts", import.meta.url).href;

/** One-shot workers return small metadata on completion; large detail tables are read only on demand. */
export const profileJob = (
  job: ProfileJob,
  changed: () => void = () => {}
): Promise<ProfileReply> =>
  new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl());

    const timer = setTimeout(
      () =>
        finish(
          new ProfileError({
            code: "E-PROFILE-UNAVAILABLE",
            message: "The profile worker timed out.",
            fix: "Run a shorter recording and retry.",
          })
        ),
      60_000
    );

    const finish = (error?: ProfileError, result?: ProfileReply) => {
      clearTimeout(timer);
      worker.terminate();

      if (error !== undefined) reject(error);
      else resolve(result!);
    };

    worker.onmessage = (event: MessageEvent<unknown>) => {
      try {
        if (Schema.is(ProfileChanged)(event.data)) {
          changed();

          return;
        }

        const reply = Schema.decodeUnknownSync(ProfileReply)(event.data);

        if ("error" in reply) finish(new ProfileError(reply.error));
        else finish(undefined, reply);
      } catch {
        finish(
          new ProfileError({
            code: "E-PROFILE-UNAVAILABLE",
            message: "The profile worker returned invalid data.",
            fix: "Retry the recording.",
          })
        );
      }
    };

    worker.onerror = () =>
      finish(
        new ProfileError({
          code: "E-PROFILE-UNAVAILABLE",
          message: "The profile worker is unavailable.",
          fix: "Check the Daemon installation and retry.",
        })
      );
    worker.postMessage(job);
  });
