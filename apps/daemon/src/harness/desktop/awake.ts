/**
 * Keeps the display awake while a Turn uses computer use: an idle sleep would lock the screen
 * under the agent. One holder per session; the Turn's end releases it.
 */
import { Effect } from "effect";

export interface DisplayAwake {
  /** Starts holding the display awake; the answer stops. */
  readonly hold: Effect.Effect<() => void>;
}

/** `caffeinate -d` until it is killed, or until this Daemon exits (`-w`). */
export const caffeinate: DisplayAwake = {
  hold: Effect.sync(() => {
    const proc = Bun.spawn(["/usr/bin/caffeinate", "-d", "-w", String(process.pid)], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });

    return () => proc.kill();
  }).pipe(Effect.orElseSucceed(() => () => {})),
};

export const noAwake: DisplayAwake = { hold: Effect.succeed(() => {}) };

export const hostAwake = (): DisplayAwake => (process.platform === "darwin" ? caffeinate : noAwake);

/** Holds once per Turn: the first call holds, `release` (the Turn's end) lets go. */
export const turnAwake = (awake: DisplayAwake) => {
  let held: (() => void) | null = null;

  return {
    use: Effect.gen(function* () {
      if (held === null) held = yield* awake.hold;
    }),
    get holding() {
      return held !== null;
    },
    release: Effect.sync(() => {
      held?.();
      held = null;
    }),
  };
};
