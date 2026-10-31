/** COMMIT has a bounded, non-cancellable confirmation window; lost confirmation is never retryable. */
import { DataError } from "@polaris/protocol";

export const outcomeUnknown = () =>
  new DataError({
    code: "E-DATA-OUTCOME-UNKNOWN",
    message: "The write may have committed, but its outcome could not be confirmed.",
    fix: "Check the rows in the database before retrying this write.",
  });

export function commitWindow(close: () => Promise<void>, graceMs = 5000) {
  let sent = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expire: (error: DataError) => void = () => {};

  const expired = new Promise<never>((_, reject) => {
    expire = reject;
  });

  return {
    get sent() {
      return sent;
    },
    start() {
      sent = true;
      timer = setTimeout(() => {
        expire(outcomeUnknown());
        void close().catch(() => {});
      }, graceMs);
    },
    async wait<A>(transaction: Promise<A>) {
      try {
        return await Promise.race([transaction, expired]);
      } catch (error) {
        if (sent) throw outcomeUnknown();
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
