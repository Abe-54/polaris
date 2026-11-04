import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Redacted } from "effect";
import { loadLanguageCredential, LanguageCredentialError } from "./credential.ts";

const privateRoot = (run: (root: string) => void) => {
  const root = mkdtempSync(join(tmpdir(), "pl-a0-credential-"));

  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test("Main proof persists privately across loads without diagnostic exposure", () =>
  privateRoot((root) => {
    const dir = join(root, "private");
    const first = loadLanguageCredential(dir);
    const second = loadLanguageCredential(dir);
    expect(Redacted.value(first) === Redacted.value(second)).toBe(true);
    expect(Redacted.value(first).length).toBe(64);
    expect(JSON.stringify(first).includes(Redacted.value(first))).toBe(false);
    expect(JSON.stringify(first)).toBe('"<redacted:language identity>"');
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "language-client-proof-v1")).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["language-client-proof-v1"]);
  }));

for (const fault of ["world-readable", "corrupt", "symlink", "hardlink"] as const) {
  test(`unsafe ${fault} credential is refused without silent ownership replacement`, () =>
    privateRoot((root) => {
      const dir = join(root, "private");
      const proof = loadLanguageCredential(dir);
      const path = join(dir, "language-client-proof-v1");

      if (fault === "world-readable") chmodSync(path, 0o644);

      if (fault === "corrupt") writeFileSync(path, "incomplete", { mode: 0o600 });

      if (fault === "symlink") {
        rmSync(path);
        const other = join(root, "other");
        writeFileSync(other, `${Redacted.value(proof)}\n`, { mode: 0o600 });
        symlinkSync(other, path);
      }

      if (fault === "hardlink") linkSync(path, join(root, "linked"));
      const before = readFileSync(path);
      let failure: Error | null = null;

      try {
        loadLanguageCredential(dir);
      } catch (error) {
        if (error instanceof Error) failure = error;
      }

      expect(failure).toBeInstanceOf(LanguageCredentialError);
      expect(String(failure).includes(Redacted.value(proof))).toBe(false);
      expect(String(failure).includes(root)).toBe(false);
      expect(readFileSync(path).equals(before)).toBe(true);
    }));
}

test("unsafe directory and partial persisted write faults fail closed", () =>
  privateRoot((root) => {
    const dir = join(root, "private");
    loadLanguageCredential(dir);
    chmodSync(dir, 0o755);
    expect(() => loadLanguageCredential(dir)).toThrow("Language credential unavailable");
    chmodSync(dir, 0o700);
    const alias = join(root, "alias");
    symlinkSync(dir, alias);
    expect(() => loadLanguageCredential(alias)).toThrow("Language credential unavailable");
    const path = join(dir, "language-client-proof-v1");
    writeFileSync(path, "0".repeat(32), { mode: 0o600 });
    expect(() => loadLanguageCredential(dir)).toThrow("Language credential unavailable");
    expect(readFileSync(path, "utf8")).toBe("0".repeat(32));
  }));

for (const failureAt of [1, 2]) {
  test(`actual private write fsync fault ${failureAt} preserves committed ownership`, () =>
    privateRoot((root) => {
      const dir = join(root, "private");
      const module = fileURLToPath(new URL("./credential.ts", import.meta.url));

      const source = `
        import { mock } from "bun:test";
        import * as fs from "node:fs";
        const original = fs.fsyncSync;
        let calls = 0;
        mock.module("node:fs", () => ({ ...fs, fsyncSync(fd) {
          if (++calls === ${failureAt}) throw new Error("injected persistence fault");
          original(fd);
        }}));
        const { loadLanguageCredential } = await import(${JSON.stringify(module)});
        try { loadLanguageCredential(${JSON.stringify(dir)}); process.exitCode = 1; }
        catch (error) { if (error.message !== "Language credential unavailable") process.exitCode = 2; }
      `;

      const env = { ...process.env };

      delete env.POLARIS_HOST_SOCKET;
      delete env.POLARIS_SESSION_ID;
      delete env.POLARIS_HANDOFF;
      env.POLARIS_HOME = root;

      const child = Bun.spawnSync([process.execPath, "-e", source], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(child.exitCode).toBe(0);
      expect(child.stdout.length + child.stderr.length).toBe(0);
      expect(readdirSync(dir).some((name) => name.endsWith(".part"))).toBe(false);
      const records = readdirSync(dir);

      expect(records.length).toBe(failureAt === 1 ? 0 : 1);

      const before =
        records.length === 0 ? null : readFileSync(join(dir, "language-client-proof-v1"));

      const credential = loadLanguageCredential(dir);

      if (before !== null)
        expect(readFileSync(join(dir, "language-client-proof-v1")).equals(before)).toBe(true);
      expect(Redacted.value(credential).length).toBe(64);
    }));
}
