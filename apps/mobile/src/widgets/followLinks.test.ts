import { expect, test } from "bun:test";
import { type NavigationState, opened, topOf, wentBack } from "../app/navigationState.ts";
import { followWidgetLinks, type LinkSource } from "./followLinks.ts";
import { HOME_LINK, sessionLink } from "./links.ts";

/** Linking at the boundary: a launch URL and the URL events delivered after it. */
const linking = (initial: string | null) => {
  let listener: ((event: { url: string }) => void) | null = null;

  const source: LinkSource = {
    getInitialURL: () => Promise.resolve(initial),
    addEventListener: (_, next) => {
      listener = next;

      return { remove: () => (listener = null) };
    },
  };

  return {
    source,
    deliver: (url: string) => listener?.({ url }),
    listening: () => listener !== null,
  };
};

/** Warm on Review with a new agent session open over it. */
const warm: NavigationState = {
  stack: [{ screen: "tabs" }, { screen: "newSession", workspaceId: "ws1" }],
  tab: "review",
  settings: "settings",
};

const thread = { screen: "thread", hostId: "mac/studio 1", sessionId: "s1" } as const;

const follow = (initial: string | null) => {
  let state = warm;
  const links = linking(initial);
  const stop = followWidgetLinks(links.source, (route) => (state = opened(state, route)));

  return { links, stop, state: () => state };
};

test.each([
  ["launch URL", "initial"],
  ["URL event", "event"],
] as const)(
  "a session widget's %s opens its thread over Home's Sessions, new session closed",
  async (_, path) => {
    const link = sessionLink(thread.hostId, thread.sessionId);
    const run = follow(path === "initial" ? link : null);

    await Bun.sleep(0);

    if (path === "event") run.links.deliver(link);

    expect(topOf(run.state())).toEqual(thread);

    const back = wentBack(run.state());

    expect(topOf(back)).toEqual({ screen: "tabs" });
    expect(back.tab).toBe("sessions");
  }
);

test.each([
  ["launch URL", "initial"],
  ["URL event", "event"],
] as const)("the Home widget's %s opens Home's Sessions, new session closed", async (_, path) => {
  const run = follow(path === "initial" ? HOME_LINK : null);

  await Bun.sleep(0);

  if (path === "event") run.links.deliver(HOME_LINK);

  expect(run.state()).toMatchObject({
    stack: [{ screen: "tabs" }],
    tab: "sessions",
  });
});

test("after it stops, a later link opens nothing", async () => {
  const run = follow(null);

  await Bun.sleep(0);
  run.stop();
  run.links.deliver(HOME_LINK);

  expect(run.links.listening()).toBe(false);
  expect(run.state()).toEqual(warm);
});
