import { describe, expect, test } from "bun:test";
import { latestLoads, queueByKey } from "./order.ts";

const deferred = () => {
  let resolve = () => {};

  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return { promise, resolve };
};

describe("latestLoads", () => {
  test("a navigation asked for while the partition is setting up beats the saved URL", async () => {
    const started: Array<string> = [];
    const loads = latestLoads<string>((tab, url) => started.push(`${tab} ${url}`));
    const ready = deferred();

    loads.request("t1", "https://saved.example/", ready.promise);
    loads.request("t1", "http://localhost:3000/", ready.promise);
    ready.resolve();
    await ready.promise;
    await Promise.resolve();

    expect(started).toEqual(["t1 http://localhost:3000/"]);
  });

  test("other tabs' loads don't supersede each other", async () => {
    const started: Array<string> = [];
    const loads = latestLoads<string>((tab, url) => started.push(`${tab} ${url}`));

    loads.request("t1", "a", Promise.resolve());
    loads.request("t2", "b", Promise.resolve());
    await Promise.resolve();
    await Promise.resolve();

    expect(started.toSorted()).toEqual(["t1 a", "t2 b"]);
  });
});

describe("queueByKey", () => {
  test("a release that's slow to answer still lands before the next claim on that Host", async () => {
    const log: Array<string> = [];
    const queue = queueByKey<string>(() => {});
    const slow = deferred();

    void queue("mac", async () => {
      await slow.promise;
      log.push("release A");
    });

    const claimed = queue("mac", async () => {
      log.push("claim B");
    });

    await Promise.resolve();
    expect(log).toEqual([]);
    slow.resolve();
    await claimed;

    expect(log).toEqual(["release A", "claim B"]);
  });

  test("a refused call doesn't stop the ones after it", async () => {
    const log: Array<string> = [];
    const errors: Array<unknown> = [];
    const queue = queueByKey<string>((cause) => errors.push(cause));

    void queue("mac", () => Promise.reject(new Error("refused")));
    await queue("mac", async () => {
      log.push("claim");
    });

    expect(log).toEqual(["claim"]);
    expect(errors).toHaveLength(1);
  });
});
