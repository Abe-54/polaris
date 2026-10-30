import "../../test/dom.testing.ts";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Result } from "../../../shared/api.ts";
import type { LinkResultView } from "../../../shared/linkedDevicesContract.ts";
import { type FakeBridge, installFakeBridge } from "../../test/bridge.testing.ts";
import { Devices } from "./DevicesPage.tsx";
import { host, noiseKey, phone, route } from "./fixture.testing.ts";

let fake: FakeBridge;

beforeEach(() => {
  fake = installFakeBridge();
});

afterEach(cleanup);

const LINK = "polaris-link:v2:secret-part";

const hosts = [host("studio", "Mac Studio"), host("pi", "Raspberry Pi 4")];

/** Both Hosts on the relay; `devices.finishLink` waits for the returned `finish`. */
const relayOn = async () => {
  const on = await route("on");
  fake.answerOk("relayRoute.status", on);
  fake.answerOk("devices.list", []);
  fake.answerOk("devices.startLink", {
    hostKey: "studio",
    linkId: "link-1",
    linkString: LINK,
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    shareTo: ["pi"],
  });

  const finish = Promise.withResolvers<Result<LinkResultView>>();
  fake.answer("devices.finishLink", () => finish.promise);
  fake.answerOk("devices.cancelLink", undefined);

  return finish;
};

const page = (onOpenHosts: () => void = () => undefined) =>
  within(render(<Devices hosts={hosts} onOpenHosts={onOpenHosts} />).container);

const lists = () => fake.sent("devices.list").length;

test("linking shows the link as a QR code, copies it through the clearing clipboard, and reloads once linked", async () => {
  const finish = await relayOn();
  const view = page();

  fireEvent.click(await view.findByRole("button", { name: "Link a device" }));

  expect(await view.findByRole("img", { name: "Link QR code" })).toBeTruthy();
  expect(
    view.getByText(/reaches Mac Studio and Raspberry Pi 4 through the Polaris Relay/)
  ).toBeTruthy();
  expect(view.queryByText(LINK)).toBeNull();

  fireEvent.click(view.getByRole("button", { name: "Copy link" }));
  await view.findByRole("button", { name: "Copied" });
  expect(fake.sent("clipboard.writeSecret")).toEqual([{ text: LINK }]);
  expect(fake.sent("devices.finishLink")).toEqual([
    { hostKey: "studio", linkId: "link-1", shareTo: ["pi"] },
  ]);

  const before = lists();
  finish.resolve({
    ok: true,
    value: { device: await phone({ noiseKey: noiseKey() }), shares: [{ hostKey: "pi", ok: true }] },
  });

  await waitFor(() => expect(lists()).toBeGreaterThan(before));
  expect(view.queryByRole("img", { name: "Link QR code" })).toBeNull();
});

test("after Cancel, a phone that links late doesn't reopen the panel", async () => {
  const finish = await relayOn();
  const view = page();

  fireEvent.click(await view.findByRole("button", { name: "Link a device" }));
  await view.findByRole("img", { name: "Link QR code" });
  fireEvent.click(view.getByRole("button", { name: "Cancel" }));

  // RX1-2: Cancel ends the link on its Host, not just the panel.
  expect(fake.sent("devices.cancelLink")).toEqual([{ hostKey: "studio", linkId: "link-1" }]);

  const before = lists();
  finish.resolve({ ok: false, error: { code: "Expired", message: "The link expired." } });
  await new Promise((settle) => setTimeout(settle, 20));

  expect(view.getByRole("button", { name: "Link a device" })).toBeTruthy();
  expect(view.queryByText(/The link ended/)).toBeNull();
  expect(lists()).toBe(before);
});

test("leaving the page while a link waits ends the link on its Host (RX1-2)", async () => {
  await relayOn();
  const rendered = render(<Devices hosts={hosts} onOpenHosts={() => undefined} />);

  fireEvent.click(await within(rendered.container).findByRole("button", { name: "Link a device" }));
  await within(rendered.container).findByRole("img", { name: "Link QR code" });
  rendered.unmount();

  expect(fake.sent("devices.cancelLink")).toEqual([{ hostKey: "studio", linkId: "link-1" }]);
});

test("unlinking a device unlinks it on every host it's on", async () => {
  const iphone = noiseKey();
  const onStudio = await phone({ noiseKey: iphone });
  const onPi = await phone({ noiseKey: iphone });
  fake.answerOk("relayRoute.status", await route("on"));
  fake.answer("devices.list", ({ hostKey }) => ({
    ok: true,
    value: [hostKey === "studio" ? onStudio : onPi],
  }));
  const view = page();

  const row = within(await view.findByTestId("device-row"));
  expect(row.getByText("Linked Oct 20 · not seen yet")).toBeTruthy();
  expect(row.getByRole("button", { name: "Unlink" }).dataset.variant).toBe("secondary");
  fireEvent.click(row.getByRole("button", { name: "Unlink" }));
  fireEvent.click(row.getByRole("button", { name: "Unlink Lucas's iPhone" }));

  await waitFor(() =>
    expect(fake.sent("devices.unlink")).toEqual([
      { hostKey: "studio", id: onStudio.id },
      { hostKey: "pi", id: onPi.id },
    ])
  );
});

test("Retry shares a device with the host it missed", async () => {
  const device = await phone({ noiseKey: noiseKey() });
  fake.answerOk("relayRoute.status", await route("on"));
  fake.answer("devices.list", ({ hostKey }) => ({
    ok: true,
    value: hostKey === "studio" ? [device] : [],
  }));
  const view = page();

  const row = within(await view.findByTestId("device-row"));
  expect(row.getByText(/not shared with Raspberry Pi 4/)).toBeTruthy();
  fireEvent.click(row.getByRole("button", { name: "Retry" }));

  await waitFor(() =>
    expect(fake.sent("devices.share")).toEqual([
      {
        hostKey: "pi",
        name: device.name,
        relayAddress: device.relayAddress,
        noiseKey: device.noiseKey,
      },
    ])
  );
});

test("with the relay off everywhere, linking points to Hosts instead", async () => {
  fake.answerOk("relayRoute.status", await route("off"));
  fake.answerOk("devices.list", []);
  const opened: Array<true> = [];
  const view = page(() => opened.push(true));

  await view.findAllByRole("button", { name: "Turn on" });
  expect(view.queryByRole("button", { name: "Link a device" })).toBeNull();
  expect(view.getByText("Turn on the Polaris Relay for a host to link a device.")).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Open hosts" }));

  for (const turnOn of view.getAllByRole("button", { name: "Turn on" })) fireEvent.click(turnOn);

  expect(opened).toEqual([true, true, true]);
});

test("a host with presence keeps the map live while its device's session is open (ENG-629)", async () => {
  const withPresence = [
    host("studio", "Mac Studio", "connected", ["linked-devices", "linked-devices.presence"]),
  ];

  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const iphone = await phone({ noiseKey: noiseKey(), lastUsedAt: hourAgo });

  fake.answerOk("relayRoute.status", await route("on"));
  fake.answerOk("devices.list", [iphone]);

  const view = within(
    render(<Devices hosts={withPresence} onOpenHosts={() => undefined} />).container
  );

  await view.findByText("No device live right now");
  const [feed] = fake.feeds("devices.watch");
  expect(feed?.input).toEqual({ hostKey: "studio" });

  act(() => feed?.listener.items([[{ ...iphone, connectedSince: hourAgo }]]));
  await view.findByText("1 device live, through 1 of 1 host");

  act(() => feed?.listener.items([[{ ...iphone, connectedSince: null }]]));
  await view.findByText("No device live right now");
});

describe("the reach map's packets", () => {
  afterEach(() => {
    delete document.documentElement.dataset.reduceMotion;
  });

  /** Mac Studio's relay connected with the iPhone fresh; the Pi's relay still connecting. */
  const oneLiveRoute = async () => {
    const iphone = noiseKey();
    const fresh = new Date(Date.now() - 60_000).toISOString();
    const connected = await route("on");
    const connecting = await route("on", false);
    fake.answer("relayRoute.status", ({ hostKey }) => ({
      ok: true,
      value: hostKey === "studio" ? connected : connecting,
    }));
    fake.answerOk("devices.list", [await phone({ noiseKey: iphone, lastUsedAt: fresh })]);
  };

  const packets = (view: ReturnType<typeof page>) => view.queryAllByTestId("packet").length;

  test("three cross each segment of the live route, and none the connecting one", async () => {
    await oneLiveRoute();
    const view = page();

    await view.findByText("1 device live, through 1 of 2 hosts");
    expect(packets(view)).toBe(2 * 3);
  });

  test("Reduce Motion keeps the map still, and turning it on mid-flow stops them", async () => {
    await oneLiveRoute();
    document.documentElement.dataset.reduceMotion = "true";
    const view = page();

    await view.findByText("1 device live, through 1 of 2 hosts");
    expect(packets(view)).toBe(0);

    document.documentElement.dataset.reduceMotion = "false";
    await waitFor(() => expect(packets(view)).toBe(6));
    document.documentElement.dataset.reduceMotion = "true";
    await waitFor(() => expect(packets(view)).toBe(0));
  });
});
