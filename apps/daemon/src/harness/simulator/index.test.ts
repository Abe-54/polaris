import { afterEach, describe, expect, test } from "bun:test";
import { SessionId, SimulatorSupport } from "@polaris/protocol";
import { writeFileSync } from "node:fs";
import type { RunResult } from "./agentDevice.ts";
import { callTool, statusOf, textOf, toolNames } from "./mcp.testing.ts";
import { defaultAnswer, disposeAll, ok, READY, setup, UDID } from "./server.testing.ts";

afterEach(disposeAll);

describe("the Simulator's MCP server", () => {
  test("a Host that can run neither platform (a Linux arm64 Pi) gives sessions no server", async () => {
    const { open } = setup({ facts: { os: "linux", arch: "arm64", libc: "glibc" } });

    expect((await open()).server).toBeNull();
  });

  test("each session gets its own URL listing the tools, refused once the session closes", async () => {
    const { open } = setup();
    const first = await open();
    const second = await open(SessionId.make("s2"));

    expect(first.server!.url).not.toBe(second.server!.url);
    expect(await toolNames(first.server!.url)).toEqual([
      "simulator_close",
      "simulator_launch",
      "simulator_list",
      "simulator_open",
      "simulator_openurl",
      "simulator_press",
      "simulator_screenshot",
      "simulator_scroll",
      "simulator_snapshot",
      "simulator_swipe",
      "simulator_tap",
      "simulator_type",
    ]);
    await first.close();

    expect(await statusOf(first.server!.url)).toBe(401);
    expect(await statusOf(second.server!.url)).toBe(200);
  });

  test.each([
    [
      "Xcode is missing",
      {
        ios: SimulatorSupport.cases.NeedsSetup.make({ missing: ["xcode"] }),
        android: READY.android,
      },
      null,
      "need Xcode",
    ],
    [
      "Xcode is finishing an update",
      {
        ios: SimulatorSupport.cases.Updating.make({ reason: "xcode-first-launch" }),
        android: READY.android,
      },
      null,
      "Xcode is finishing an update. Try again in a few minutes.",
    ],
  ] as const)("a tool says so in plain words when %s", async (_, support, iosBlocked, says) => {
    const { open, calls } = setup({ support, iosBlocked });
    const { server } = await open();
    const result = await callTool(server!.url, "simulator_open", { id: UDID });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(says);
    expect(calls).toEqual([]);
  });

  test("an open boots, marks the shown Simulator and drives it; later tools act on it", async () => {
    const { open, calls, marks } = setup();
    const { server, close } = await open();

    const opened = await callTool(server!.url, "simulator_open", {
      id: UDID,
      app: "com.apple.Preferences",
    });

    expect(opened.isError).toBeUndefined();
    expect(marks).toEqual([
      "driving s1",
      "run open",
      `booted ${UDID}`,
      `opened s1 ${UDID}`,
      "idle s1",
    ]);
    const tapped = await callTool(server!.url, "simulator_tap", { target: "@e3" });

    expect(textOf(tapped)).toBe("ran press");
    expect(calls.at(-1)).toEqual([
      "press",
      "--settle",
      "--platform",
      "ios",
      "--udid",
      UDID,
      "--session",
      "polaris-s1",
      "--",
      "@e3",
    ]);
    await close();

    expect(calls.slice(-2).map((args) => args.slice(0, 2))).toEqual([
      ["close", "--session"],
      ["daemon", "stop"],
    ]);
  });

  test("a tool before any open says to open one, and runs nothing", async () => {
    const { open, calls } = setup();
    const { server } = await open();
    const result = await callTool(server!.url, "simulator_snapshot");

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("simulator_open");
    expect(calls).toEqual([]);
  });

  test("a slow first open answers that the runner is building, and the next call joins it", async () => {
    let finish: (result: RunResult) => void = () => {};

    const { open } = setup({
      softWaitMs: 50,
      answer: (args) =>
        args[0] === "open"
          ? new Promise((resolve) => {
              finish = resolve;
            })
          : defaultAnswer(args),
    });

    const { server } = await open();
    const first = await callTool(server!.url, "simulator_open", { id: UDID });

    expect(first.isError).toBeUndefined();
    expect(textOf(first)).toContain("builds agent-device's iOS runner");
    finish(ok({ device: "iPhone 17" }));
    const joined = await callTool(server!.url, "simulator_open", { id: UDID });

    expect(textOf(joined)).toContain("Opened iPhone 17");
  });

  test("a screenshot comes back as an image", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

    const { open } = setup({
      answer: (args) => {
        if (args[0] !== "screenshot") return defaultAnswer(args);
        writeFileSync(args.at(-1)!, png);

        return ok({ path: args.at(-1) ?? null });
      },
    });

    const { server } = await open();
    await callTool(server!.url, "simulator_open", { id: UDID });
    const shot = await callTool(server!.url, "simulator_screenshot");

    expect(shot.content).toEqual([
      { type: "image", data: png.toString("base64"), mimeType: "image/png" },
    ]);
  });
});
