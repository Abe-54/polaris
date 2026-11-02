import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { spinnerVerbsHandler, parseSetting, settingsFiles } from "./spinnerVerbs.ts";
import { newTempDir, removeTempDir } from "../../platform/tempDir.testing.ts";

const dirs: Array<string> = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) removeTempDir(dir);
});

const temp = () => {
  const dir = newTempDir("polaris-verbs-");

  dirs.push(dir);

  return dir;
};

/** A Claude Code settings file, as far as these tests write one. */
interface SettingsJson {
  readonly theme?: string;
  readonly spinnerVerbs?: { readonly mode?: string; readonly verbs?: ReadonlyArray<string> };
}

const writeSettings = (root: string, name: string, value: SettingsJson) => {
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(join(root, ".claude", name), JSON.stringify(value));
};

describe("parseSetting", () => {
  test("reads mode and verbs; Claude Code's default mode is append", () => {
    expect(parseSetting('{"spinnerVerbs":{"mode":"replace","verbs":["Flat out"]}}')).toEqual({
      mode: "replace",
      verbs: ["Flat out"],
    });
    expect(parseSetting('{"spinnerVerbs":{"verbs":["Pondering"]}}')).toEqual({
      mode: "append",
      verbs: ["Pondering"],
    });
  });

  test("no setting, invalid JSON, or nothing usable is null", () => {
    expect(parseSetting('{"model":"opus"}')).toBeNull();
    expect(parseSetting("{ not json")).toBeNull();
    expect(parseSetting('{"spinnerVerbs":{"mode":"append","verbs":[]}}')).toBeNull();
    expect(parseSetting('{"spinnerVerbs":"Pondering"}')).toBeNull();
  });

  test("non-strings and blanks are dropped, control characters cleaned, length capped", () => {
    const parsed = parseSetting(
      JSON.stringify({ spinnerVerbs: { verbs: ["  A\nB ", 3, "", "x".repeat(200)] } })
    );

    expect(parsed?.verbs).toEqual(["A B", "x".repeat(80)]);
  });

  test("an empty replace list can't replace anything", () => {
    expect(parseSetting('{"spinnerVerbs":{"mode":"replace","verbs":[" "]}}')).toBeNull();
  });
});

describe("harness.spinnerVerbs", () => {
  test("user < project < project local; the file that wins is named", async () => {
    const home = temp();
    const project = temp();
    const read = spinnerVerbsHandler({ home });

    expect(await Effect.runPromise(read({ cwd: project }))).toBeNull();

    writeSettings(home, "settings.json", { spinnerVerbs: { verbs: ["Mine"] } });
    expect(await Effect.runPromise(read({ cwd: null }))).toMatchObject({
      mode: "append",
      verbs: ["Mine"],
      source: join(home, ".claude", "settings.json"),
    });

    writeSettings(project, "settings.json", { spinnerVerbs: { mode: "replace", verbs: ["Team"] } });
    writeSettings(project, "settings.local.json", { theme: "dark" });
    expect(await Effect.runPromise(read({ cwd: project }))).toMatchObject({
      mode: "replace",
      verbs: ["Team"],
    });

    writeSettings(project, "settings.local.json", { spinnerVerbs: { verbs: ["Local"] } });
    expect(await Effect.runPromise(read({ cwd: project }))).toMatchObject({ verbs: ["Local"] });
  });

  test("a changed file is read again; a removed one no longer counts", async () => {
    const home = temp();
    const read = spinnerVerbsHandler({ home });
    const file = join(home, ".claude", "settings.json");

    writeSettings(home, "settings.json", { spinnerVerbs: { verbs: ["One"] } });
    utimesSync(file, 1000, 1000);
    expect(await Effect.runPromise(read({ cwd: null }))).toMatchObject({ verbs: ["One"] });

    writeSettings(home, "settings.json", { spinnerVerbs: { verbs: ["Two"] } });
    utimesSync(file, 2000, 2000);
    expect(await Effect.runPromise(read({ cwd: null }))).toMatchObject({ verbs: ["Two"] });

    rmSync(file);
    expect(await Effect.runPromise(read({ cwd: null }))).toBeNull();
  });

  test("the files, in Claude Code's order", () => {
    expect(settingsFiles("/h", "/p")).toEqual([
      join("/h", ".claude", "settings.json"),
      join("/p", ".claude", "settings.json"),
      join("/p", ".claude", "settings.local.json"),
    ]);
  });
});
