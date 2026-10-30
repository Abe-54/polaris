import { describe, expect, test } from "bun:test";
import type { HarnessAvailability } from "@polaris/protocol";
import type { Plain } from "../../../../shared/api.ts";
import type { ProbedHost } from "./harnesses.ts";
import {
  AUTO_CHAIN,
  chainLabel,
  DEFAULT_POLICY,
  type HostReviewer,
  overridesOf,
  prettyModel,
  readySummary,
  reviewerHostRows,
  reviewerTitle,
  sharedDefault,
  sharedPolicy,
  sharedWalkthrough,
  SOL,
  thresholdLabel,
  withDefault,
  withOverride,
  withPolicy,
  withWalkthrough,
} from "./reviewer.ts";

const codex = (status: "ready" | "needs-sign-in"): Plain<HarnessAvailability> => ({
  harness: "codex",
  status,
  version: "0.61.0",
  minVersion: "0.50.0",
  signInArgv: ["codex", "login"],
  signInKind: status === "ready" ? "ChatGPT Pro" : null,
  olderThanTested: null,
  detail: null,
});

const host = (hostKey: string, label: string, status: "ready" | "needs-sign-in"): ProbedHost => ({
  hostKey,
  label,
  probe: {
    kind: "reported",
    report: { harnesses: [codex(status)], checkedAt: "2026-10-01T00:00:00Z" },
  },
});

const loaded = (choice = SOL, workspaces = {}): HostReviewer => ({
  kind: "loaded",
  settings: { default: choice, workspaces, ...DEFAULT_POLICY },
  resolved: { choice, source: "settings", note: null },
});

describe("the Reviewer every host runs", () => {
  test("the default is shared; a host that disagrees is flagged", () => {
    expect(sharedDefault([loaded(), loaded()])).toEqual({ choice: SOL, differs: false });
    expect(sharedDefault([loaded(), { kind: "loading" }]).differs).toBe(false);
    expect(sharedDefault([loaded(), loaded({ ...SOL, effort: "low" })]).differs).toBe(true);
  });

  test("automatic reads as its chain, with Claude model ids named until the harness lists them", () => {
    expect(AUTO_CHAIN.map((choice) => chainLabel(choice))).toEqual([
      "Claude Code · Opus 5.5 high",
      "Codex · GPT-6.1-Sol",
    ]);
    expect(chainLabel(SOL, () => "GPT-6.1 Sol")).toBe("Codex · GPT-6.1 Sol high");
  });

  test("the heading names it, or says it picks automatically", () => {
    expect(reviewerTitle(SOL, () => "GPT-6.1-Sol")).toBe("Reviews with Codex · GPT-6.1-Sol · High");
    expect(reviewerTitle(null)).toBe("Picks a reviewer automatically");
    expect(reviewerTitle(SOL)).toBe("Reviews with Codex · GPT-6.1-Sol · High");
  });

  test("each host says whether its reviewer can run; one that can't runs rules only", () => {
    const hosts = [host("local", "Mac Studio", "ready"), host("vm", "Linux VM", "needs-sign-in")];
    const rows = reviewerHostRows(hosts, { local: loaded(), vm: loaded() }, { local: 3 });

    expect(rows.map((r) => [r.hostLabel, r.text, r.caption, r.aside])).toEqual([
      ["Mac Studio", "Ready · ChatGPT Pro", null, "3 review checkouts"],
      [
        "Linux VM",
        "Needs sign-in",
        "Risk summaries for checkouts here run rules only",
        "No checkouts",
      ],
    ]);
    expect(readySummary(rows)).toBe("Ready on 1 of 2 hosts");
  });

  test("a host whose daemon can't run a reviewer says so", () => {
    const rows = reviewerHostRows(
      [host("pi", "Raspberry Pi 4", "ready")],
      { pi: { kind: "unavailable", reason: "This host's daemon can't run a reviewer" } },
      {}
    );

    expect(rows[0]?.text).toBe("This host's daemon can't run a reviewer");
  });

  test("automatic with nothing available is rules only, with the Daemon's note", () => {
    const none: HostReviewer = {
      kind: "loaded",
      settings: { default: null, workspaces: {}, ...DEFAULT_POLICY },
      resolved: { choice: null, source: "auto", note: "No reviewer harness is ready" },
    };

    const [row] = reviewerHostRows([host("local", "Mac", "ready")], { local: none }, {});

    expect(row?.caption).toBe("No reviewer harness is ready");
  });

  test("changing the default keeps overrides; overrides are set and cleared per Workspace", () => {
    const settings = { default: null, workspaces: { w1: SOL }, ...DEFAULT_POLICY };

    expect(withDefault(settings, SOL)).toEqual({ ...settings, default: SOL });
    expect(withOverride(settings, "w1", null)).toEqual({ ...settings, workspaces: {} });
    expect(withOverride(settings, "w2", SOL).workspaces).toEqual({ w1: SOL, w2: SOL });
    expect(overridesOf({ local: loaded(SOL, { w1: SOL }) })).toEqual({ "local/w1": SOL });
  });

  test("when it runs is host-wide; a threshold of null never asks", () => {
    const off = loaded();

    const host =
      off.kind === "loaded"
        ? withPolicy(off.settings, { onSessions: false, askAboveLines: null })
        : null;

    expect(host).toMatchObject({
      onPullRequests: true,
      onSessions: false,
      askAboveLines: null,
      default: SOL,
    });
    expect(sharedPolicy([{ kind: "loading" }])).toEqual(DEFAULT_POLICY);
    expect(thresholdLabel(2000)).toBe("Over 2,000 lines");
    expect(thresholdLabel(null)).toBe("Never");
  });
});

describe("a Model the Harness hasn't listed under its id", () => {
  test.each([
    ["claude-opus-5-5", "Opus 5.5"],
    ["claude-haiku-5-5", "Haiku 5.5"],
    ["claude-sonnet-4-5-20250929", "Sonnet 4.5"],
    ["gpt-6.1-sol", "GPT-6.1-Sol"],
    ["gpt-6-luna", "GPT-6-Luna"],
  ])("%s reads as %s", (id, name) => {
    expect(prettyModel(id)).toBe(name);
  });
});

describe("the walkthrough's settings", () => {
  const base = { default: null, workspaces: {}, ...DEFAULT_POLICY };

  test("on, with the reviewer's model, until set", () => {
    expect(sharedWalkthrough([loaded()])).toEqual({ enabled: true, choice: null });
  });

  test("a separate model, and back to the reviewer's", () => {
    const sol = withWalkthrough(base, { choice: SOL });

    const host: HostReviewer = {
      kind: "loaded",
      settings: sol,
      resolved: { choice: null, source: "settings", note: null },
    };

    expect(sharedWalkthrough([host]).choice).toEqual(SOL);
    expect(withWalkthrough(sol, { choice: null }).walkthrough).toEqual({
      enabled: true,
      harness: null,
      model: null,
      effort: null,
    });
    expect(withWalkthrough(sol, { enabled: false }).walkthrough?.harness).toBe("codex");
  });
});
