import { describe, expect, test } from "bun:test";
import { developerModeLine, hostsLine } from "./model.ts";

const host = (name: string, state: "connected" | "reconnecting" | "offline" | "needs-attention") =>
  ({ name, state }) as const;

describe("the Hosts row's line", () => {
  test("names two Hosts, counts the rest and flags one reconnecting (MX-G)", () => {
    expect(
      hostsLine([
        host("mac-studio", "connected"),
        host("lucas-rpi", "connected"),
        host("ci-box", "reconnecting"),
        host("vm", "connected"),
      ])
    ).toEqual({ names: "mac-studio, lucas-rpi", more: "+ 2", note: "1 reconnecting" });
  });

  test("a single healthy Host has no note and no count", () => {
    expect(hostsLine([host("mac-studio", "connected")])).toEqual({
      names: "mac-studio",
      more: null,
      note: null,
    });
  });

  test("needs attention outranks offline", () => {
    expect(
      hostsLine([host("a", "offline"), host("b", "needs-attention"), host("c", "offline")]).note
    ).toBe("1 needs attention");
  });

  test("a tailnet name is cut to its machine name; an address stays whole", () => {
    expect(
      hostsLine([
        host("lucas-mac-studio.taild0d828.ts.net", "connected"),
        host("192.168.1.20", "connected"),
      ]).names
    ).toBe("lucas-mac-studio, 192.168.1.20");
  });

  test("no Hosts says so", () => {
    expect(hostsLine([]).names).toBe("No hosts yet");
  });
});

describe("the Developer Mode row's line", () => {
  test("shows the stored setting, with no host yet saying where it is set", () => {
    expect(developerModeLine([])).toBe("Set in Polaris on your computer");
    expect(developerModeLine([{ stored: true, effective: true }])).toBe(
      "On · set in Polaris on your computer"
    );
  });

  test("a host on only through Polaris Dev's lease still reads as off, saying it is on for now", () => {
    expect(
      developerModeLine([
        { stored: false, effective: true },
        { stored: false, effective: false },
      ])
    ).toBe("Off · on for now on 1 of 2 hosts");
    expect(developerModeLine([{ stored: false, effective: false }])).toBe("Off");
  });
});
