import { Duration, Effect } from "effect";

const SETTLE_MS = 200;
const SETTLE = "2 seconds";
const SETTLE_DURATION = Duration.seconds(1);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const wait = async (ms: number) => {
  await Bun.sleep(ms);
};

export async function reported() {
  await Bun.sleep(51);
  Bun.sleepSync(1000);
  await sleep(15_000);
  await sleep(SETTLE_MS);
  await sleep(60 * 1000);
  await sleep(process.platform === "win32" ? 500 : 10);
  await wait(100);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await new Promise<void>((resolve) => {
    setTimeout(() => resolve(), 100);
  });
  await new Promise((r) => globalThis.setTimeout(r, 100));
  await Effect.runPromise(Effect.sleep("100 millis"));
  await Effect.runPromise(Effect.sleep(SETTLE));
  await Effect.runPromise(Effect.sleep(Duration.seconds(1)));
  await Effect.runPromise(Effect.sleep(SETTLE_DURATION));
  await Effect.runPromise(Effect.sleep(500));
}

export async function silent(ms: number, done: Promise<void>, stop: () => void) {
  await Bun.sleep(50);
  await sleep(50);
  await sleep(ms);
  await wait(10);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Effect.runPromise(Effect.sleep("50 millis"));
  await Effect.runPromise(Effect.sleep(Duration.millis(5)));
  await Effect.runPromise(Effect.sleep("5 micros"));

  // A timer scheduling work, a rejecting timeout and a race's bound are not sleeps.
  setTimeout(stop, 1000);

  await new Promise((_, reject) => {
    setTimeout(() => reject(new Error("timed out")), 5000);
  });

  await new Promise((resolve) => {
    done.then(resolve, resolve);
    setTimeout(resolve, 5000);
  });

  await Promise.race([done, Bun.sleep(5000)]);
  await Promise.race([done, sleep(5000).then(() => "timeout")]);
  await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 5000))]);
  await Effect.runPromise(Effect.never.pipe(Effect.race(Effect.sleep("5 seconds"))));
}
