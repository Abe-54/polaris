import { rejects } from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, link, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { verifyStoredFile } from "./fileVerification.ts";
import { posixTest } from "../../platform/testing.ts";
import { newTempDir, removeTempDirSettled } from "../../platform/tempDir.testing.ts";

const test = posixTest(
  "language storage is checked private by POSIX owner, mode and link counts; Windows needs ACL checks (ENG-314)"
);

const integrity = (bytes: Uint8Array, sha512 = false) =>
  sha512
    ? `sha512-${createHash("sha512").update(bytes).digest("base64")}`
    : `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

test("stored verification hashes bytes across chunk boundaries and refuses tail corruption, truncation and growth", async () => {
  const root = newTempDir("polaris-stored-file-");
  const path = join(root, "runtime");
  const bytes = Buffer.alloc(2 * 1024 * 1024 + 37, 61);
  const expected = { size: bytes.length, mode: 0o600, integrity: integrity(bytes) };

  try {
    await writeFile(path, bytes, { mode: expected.mode });
    await verifyStoredFile(path, expected);
    await verifyStoredFile(path, { ...expected, integrity: integrity(bytes, true) });
    bytes[bytes.length - 1] = 62;
    await writeFile(path, bytes);
    await rejects(verifyStoredFile(path, expected), { reason: "install-failed" });
    await writeFile(path, bytes.subarray(0, bytes.length - 1));
    await rejects(verifyStoredFile(path, expected), { reason: "install-failed" });
    await writeFile(path, Buffer.alloc(expected.size + 1));
    await rejects(verifyStoredFile(path, expected), { reason: "too-large" });
    await writeFile(path, Buffer.alloc(0));
    await verifyStoredFile(path, { ...expected, size: 0, integrity: integrity(Buffer.alloc(0)) });
  } finally {
    await removeTempDirSettled(root);
  }
});

test("stored streaming reads retain final-link, hardlink, mode and malformed-integrity refusal", async () => {
  const root = newTempDir("polaris-stored-file-");
  const path = join(root, "runtime");
  const bytes = Buffer.from("tool");
  const expected = { size: bytes.length, mode: 0o600, integrity: integrity(bytes) };

  try {
    await writeFile(path, bytes, { mode: expected.mode });
    await rejects(verifyStoredFile(path, { ...expected, integrity: "sha256:bad" }), {
      reason: "install-failed",
    });
    await chmod(path, 0o700);
    await rejects(verifyStoredFile(path, expected), { reason: "install-failed" });
    await chmod(path, expected.mode);
    await symlink(path, join(root, "link"));
    await rejects(verifyStoredFile(join(root, "link"), expected));
    await link(path, join(root, "hardlink"));
    await rejects(verifyStoredFile(path, expected), { reason: "too-large" });
  } finally {
    await removeTempDirSettled(root);
  }
});
