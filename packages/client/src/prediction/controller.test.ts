import { expect, test } from "bun:test";
import { PlacementController } from "./controller.ts";
import { input } from "./fixtures.testing.ts";

test("A failed side falls back once, then Off; reprobe recovers", async () => {
  const controller = new PlacementController();
  await controller.probe(async () => input());
  const sides: string[] = [];
  expect(
    await controller
      .run(async (target) => {
        sides.push(target.side);
        throw new Error("unavailable");
      }, new AbortController().signal)
      .then(
        () => false,
        () => true
      )
  ).toBe(true);
  expect(sides).toEqual(["client", "host"]);
  expect(controller.state.value).toBe("off");
  await controller.probe(async () => input());
  expect(await controller.run(async (target) => target.side, new AbortController().signal)).toBe(
    "client"
  );
});

test("Cancellation never degrades a side; explicit override never falls back", async () => {
  const controller = new PlacementController();
  await controller.probe(async () => input());
  const abort = new AbortController();
  expect(
    await controller
      .run(async () => {
        abort.abort();
        throw new Error("cancelled");
      }, abort.signal)
      .then(
        () => false,
        () => true
      )
  ).toBe(true);
  expect(controller.state.value).toBe("serving");
  await controller.probe(async () => ({ ...input(), override: "client" }));
  expect(
    await controller
      .run(async () => {
        throw new Error("failed");
      }, new AbortController().signal)
      .then(
        () => false,
        () => true
      )
  ).toBe(true);
  expect(controller.state.value).toBe("off");
});

test("A late probe cannot undo Off", async () => {
  const controller = new PlacementController();
  let resolve: (value: ReturnType<typeof input>) => void = () => {};

  const pending = controller.probe(
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );

  controller.off();
  resolve(input());
  await pending;
  expect(controller.state.value).toBe("off");
});
