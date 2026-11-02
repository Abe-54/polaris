import { rejects, throws } from "node:assert/strict";
import { test, expect } from "bun:test";
import { gzipSync } from "node:zlib";
import { mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { artifactFixture, hostId, platform } from "./fixture.testing.ts";
import { artifactIdentity } from "./identity.ts";
import { digest, verifyPayload } from "./validation.ts";
import { defaultLimits, descriptor, type ExactArtifact } from "./types.ts";
import { httpsArtifactDownload } from "./download.ts";
import { artifactDecoder } from "./decode.ts";
import { packagedEvidenceReader } from "./evidence.ts";
import { gunzip, tarEntries } from "./archive.ts";
import { webDependencies } from "./webDependencies.ts";
import { createHash } from "node:crypto";
import { newTempDir, removeTempDirSettled } from "../../platform/tempDir.testing.ts";

function exactFixture(format: "binary" | "tar.gz" = "binary") {
  const source = artifactFixture();
  source.tool.artifacts[0]!.format = format;
  const parsed = descriptor(source.tool, defaultLimits.metadataBytes);
  const artifact = parsed.tool.artifacts[0]!;

  const exact: ExactArtifact = {
    hostId,
    platform,
    tool: parsed.tool,
    descriptor: parsed.raw,
    artifact,
    identity: artifactIdentity({ hostId, platform, descriptor: source.tool, artifact }),
  };

  return { ...source, exact };
}

function tar(path = "bin/tool", type = "0", content = Buffer.from("synthetic"), gnu = false) {
  const header = Buffer.alloc(512);
  header.write(path, 0, 100);
  header.write("0000755\0", 100);
  header.write(content.length.toString(8).padStart(11, "0") + "\0", 124);
  header.fill(32, 148, 156);
  header.write(type, 156);
  header.write(gnu ? "ustar  \0" : "ustar\0", 257);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148);

  return Buffer.concat([
    header,
    content,
    Buffer.alloc(Math.ceil(content.length / 512) * 512 - content.length),
    Buffer.alloc(1024),
  ]);
}

test("selected Node files support GNU names while refusing traversal, selected links and other extensions", () => {
  const signal = new AbortController().signal;
  const select = (path: string) => path === "node/bin/node";
  const name = tar("././@LongLink", "L", Buffer.from("node/bin/node\0"), true);
  const selected = tar("node/truncated", "0", Buffer.from("runtime"), true);
  const archive = Buffer.concat([name.subarray(0, -1024), selected]);
  expect(tarEntries(archive, signal, defaultLimits, select)[0]).toMatchObject({
    path: "node/bin/node",
    bytes: Buffer.from("runtime"),
  });
  throws(() => tarEntries(archive, signal), { reason: "install-failed" });
  throws(() => tarEntries(name, signal, defaultLimits, select), { reason: "install-failed" });
  const unsafe = tar("././@LongLink", "L", Buffer.from("../escape\0"), true);
  throws(
    () =>
      tarEntries(
        Buffer.concat([unsafe.subarray(0, -1024), selected]),
        signal,
        defaultLimits,
        select
      ),
    { reason: "install-failed" }
  );
  throws(
    () =>
      tarEntries(tar("node/bin/node", "2", Buffer.alloc(0), true), signal, defaultLimits, select),
    {
      reason: "install-failed",
    }
  );
  expect(
    tarEntries(tar("node/bin/npm", "2", Buffer.alloc(0), true), signal, defaultLimits, select)
  ).toEqual([]);
  throws(
    () =>
      tarEntries(tar("node/metadata", "x", Buffer.alloc(0), true), signal, defaultLimits, select),
    {
      reason: "install-failed",
    }
  );
  throws(
    () =>
      tarEntries(
        tar("node/omitted", "0", Buffer.alloc(8), true),
        signal,
        { ...defaultLimits, fileBytes: 4 },
        select
      ),
    {
      reason: "too-large",
    }
  );
});

test("pinned GNU headers retain regular files and directories but reject unsafe entries and extensions", () => {
  const signal = new AbortController().signal;

  const read = (bytes: Buffer) =>
    tarEntries(bytes, signal, defaultLimits, undefined, { gnuHeaders: true });

  expect(read(tar("ruff-linux/ruff", "0", Buffer.from("runtime"), true))[0]).toMatchObject({
    path: "ruff-linux/ruff",
    bytes: Buffer.from("runtime"),
  });
  expect(read(tar("ruff-linux/", "5", Buffer.alloc(0), true))[0]?.kind).toBe("directory");
  throws(() => tarEntries(tar("ruff-linux/ruff", "0", Buffer.from("runtime"), true), signal), {
    reason: "install-failed",
  });

  for (const type of ["1", "2", "3", "4", "6", "S", "x", "g", "K", "L"])
    throws(() => read(tar("ruff-linux/ruff", type, Buffer.alloc(0), true)), {
      reason: "install-failed",
    });
  throws(() => read(tar("././@LongLink", "L", Buffer.from("ruff-linux/ruff\0"), true)), {
    reason: "install-failed",
  });
  throws(() => read(tar("../escape", "0", Buffer.alloc(0), true)), { reason: "install-failed" });

  const corrupt = tar("ruff-linux/ruff", "0", Buffer.from("runtime"), true);
  corrupt.write("X", 0);
  throws(() => read(corrupt), { reason: "install-failed" });
});

test("Host HTTPS download preserves bytes, requires exact URL and cancels its body on limits", async () => {
  const f = exactFixture();
  let init: RequestInit | undefined;

  const download = httpsArtifactDownload(async (_url, options) => {
    init = options;

    return new Response(f.bytes, { headers: { "content-length": String(f.bytes.length) } });
  });

  const result: Uint8Array[] = [];

  for await (const bytes of download(f.exact, new AbortController().signal)) result.push(bytes);
  expect(Buffer.concat(result)).toEqual(f.bytes);
  expect(init).toMatchObject({ redirect: "manual", credentials: "omit" });
  expect(init?.signal?.aborted).toBe(true);
  let cancelled = false;

  const oversized = httpsArtifactDownload(
    async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-length": String(defaultLimits.downloadBytes + 1) } }
      )
  );

  await rejects(Array.fromAsync(oversized(f.exact, new AbortController().signal)), {
    reason: "too-large",
  });
  expect(cancelled).toBe(true);
  const redirect = httpsArtifactDownload(async () => new Response(null, { status: 302 }));
  await rejects(Array.fromAsync(redirect(f.exact, new AbortController().signal)), {
    reason: "install-failed",
  });
  const unsafe = { ...f.exact, artifact: { ...f.exact.artifact, url: "http://invalid.example" } };
  await rejects(Array.fromAsync(download(unsafe, new AbortController().signal)), {
    reason: "audit-required",
  });
});

test("strict archive decoding rejects links, traversal, truncation, corrupt headers and gzip expansion", async () => {
  const signal = new AbortController().signal;
  expect(tarEntries(tar(), signal)[0]).toMatchObject({
    path: "bin/tool",
    mode: 0o755,
    kind: "file",
  });
  expect(() => tarEntries(tar("../escape"), signal)).toThrow("Unsafe archive path");

  for (const type of ["1", "2", "x", "g", "L", "3"])
    expect(() => tarEntries(tar("link", type), signal)).toThrow("not permitted");
  expect(() => tarEntries(tar().subarray(0, 800), signal)).toThrow("truncated");
  const corrupt = tar();
  corrupt[0] = 0;
  expect(() => tarEntries(corrupt, signal)).toThrow("checksum");
  expect(await gunzip(gzipSync(Buffer.from("synthetic")), signal, 16)).toEqual(
    Buffer.from("synthetic")
  );
  await rejects(gunzip(gzipSync(Buffer.alloc(4096)), signal, 32), {
    reason: "too-large",
  });
  await rejects(gunzip(Buffer.from("corrupt"), signal, 32));
  const aborted = new AbortController();
  aborted.abort();
  await rejects(gunzip(gzipSync(Buffer.alloc(1)), aborted.signal, 32), {
    reason: "cancelled",
  });
});

test("frozen npm decoding accepts old node-tar timestamps with an empty prefix and keeps path/type checks", () => {
  const signal = new AbortController().signal;

  const legacy = (path: string, type = "0") => {
    const bytes = tar(path, type);
    bytes.write("15176726014\0", 476);
    bytes.write("15176726014\0", 488);
    bytes.fill(32, 148, 156);
    const checksum = bytes.subarray(0, 512).reduce((sum, byte) => sum + byte, 0);
    bytes.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148);

    return bytes;
  };

  throws(() => tarEntries(legacy("package/index.js"), signal));
  expect(
    tarEntries(legacy("package/index.js"), signal, defaultLimits, undefined, { npm: true })[0]?.path
  ).toBe("package/index.js");
  throws(() => tarEntries(legacy("../escape"), signal, defaultLimits, undefined, { npm: true }));
  throws(() =>
    tarEntries(legacy("package/link", "2"), signal, defaultLimits, undefined, { npm: true })
  );
});

test("verified packaged evidence and pure binary decoder retain exact notices and reject tampering/links", async () => {
  const f = exactFixture();
  const root = newTempDir("m31-i1-evidence-");
  const signal = new AbortController().signal;

  try {
    await mkdir(join(root, "audits"));
    await writeFile(join(root, "audits/fake.json"), f.payload.manifestBytes);
    await writeFile(join(root, "LICENSE"), f.payload.entries[1]!.bytes);
    const reader = await packagedEvidenceReader(root);
    const decode = artifactDecoder(reader);
    const payload = await decode(f.bytes, f.exact, signal);
    expect(
      verifyPayload(f.bytes, payload, f.exact, defaultLimits).map((entry) => entry.path)
    ).toEqual(["bin/tool", "LICENSE"]);
    await writeFile(join(root, "LICENSE"), "corrupt");
    await rejects(decode(f.bytes, f.exact, signal), {
      reason: "audit-required",
    });
    await rm(join(root, "LICENSE"));
    await symlink("audits/fake.json", join(root, "LICENSE"));
    await rejects(reader(f.exact, signal));
    await rejects(decode(Buffer.from("tampered"), f.exact, signal), {
      reason: "audit-required",
    });
    await rejects(
      decode(
        f.bytes,
        { ...f.exact, artifact: { ...f.exact.artifact, bundle: "pinned-but-not-adapted" } },
        signal
      ),
      { reason: "audit-required" }
    );
  } finally {
    await removeTempDirSettled(root);
  }
});

test("tar.gz decoder verifies checksum before parsing and matches pinned archive notice bytes", async () => {
  const f = exactFixture("tar.gz");
  const bytes = gzipSync(tar());

  const manifestBytes = Buffer.from(
    JSON.stringify({
      artifactId: "fake",
      artifactIntegrity: digest(bytes),
      coverage: "complete",
      notices: [{ path: "LICENSE", integrity: digest(f.payload.entries[1]!.bytes) }],
    })
  );

  const artifact = {
    ...f.exact.artifact,
    integrity: digest(bytes),
    auditRoot: digest(manifestBytes),
  };

  const exact = { ...f.exact, artifact };
  const decode = artifactDecoder(async () => ({ manifestBytes, notices: [f.payload.entries[1]!] }));
  const payload = await decode(bytes, exact, new AbortController().signal);
  expect(verifyPayload(bytes, payload, exact, defaultLimits)).toHaveLength(2);
});

test("GitHub release permits one pinned asset-host redirect and refuses other targets or a second redirect", async () => {
  const f = exactFixture();

  const exact = {
    ...f.exact,
    artifact: {
      ...f.exact.artifact,
      url: "https://github.com/astral-sh/ruff/releases/download/0.16.10/ruff.tar.gz",
    },
  };

  const target = "https://release-assets.githubusercontent.com/asset?signature=fixture";

  const collect = async (location: string, secondStatus = 200) => {
    const seen: string[] = [];

    const download = httpsArtifactDownload(async (url, init) => {
      seen.push(url);
      expect(init.redirect).toBe("manual");
      expect(init.credentials).toBe("omit");

      return seen.length === 1
        ? new Response(null, { status: 302, headers: { location } })
        : new Response(secondStatus === 200 ? f.bytes : null, { status: secondStatus });
    });

    const chunks = [];

    for await (const bytes of download(exact, new AbortController().signal)) chunks.push(bytes);

    return { seen, bytes: Buffer.concat(chunks) };
  };

  expect(await collect(target)).toEqual({
    seen: [exact.artifact.url, target],
    bytes: Buffer.from(f.bytes),
  });

  for (const location of [
    "https://evil.test/asset",
    "http://release-assets.githubusercontent.com/asset",
    "https://release-assets.githubusercontent.com:444/asset",
    "https://user@release-assets.githubusercontent.com/asset",
  ])
    await rejects(collect(location), { reason: "audit-required" });
  await rejects(collect(target, 302), { reason: "install-failed" });
});

test("frozen web dependencies reject substituted bytes and unsafe paths before installation", async () => {
  const f = exactFixture("tar.gz");
  const bytes = gzipSync(tar("package/index.js"));

  const pin = {
    location: "node_modules/example",
    name: "example",
    version: "1.0.0",
    url: "https://registry.npmjs.org/example/-/example-1.0.0.tgz",
    integrity: digest(bytes),
    registryIntegrity: "sha512-" + createHash("sha512").update(bytes).digest("base64"),
    license: "MIT",
  };

  const signal = new AbortController().signal;
  const download = httpsArtifactDownload(async () => new Response(bytes));

  const run = (change = {}) =>
    webDependencies({ root: "root", packages: [{ ...pin, ...change }] }, f.exact, signal, download);

  expect((await run())[0]?.path).toBe("node_modules/example/index.js");
  await rejects(run({ integrity: digest(Buffer.from("substitution")) }), {
    reason: "audit-required",
  });
  await rejects(run({ registryIntegrity: "sha512-incorrect" }), { reason: "audit-required" });
  await rejects(run({ url: "https://example.com/payload.tgz" }), { reason: "audit-required" });
  await rejects(run({ location: "elsewhere/example" }), { reason: "audit-required" });
  await rejects(run({ location: "node_modules/../escape" }));

  const typesBytes = gzipSync(tar("estree/index.d.ts"));

  const typesPin = {
    ...pin,
    name: "@types/estree",
    location: "node_modules/@types/estree",
    integrity: digest(typesBytes),
    registryIntegrity: "sha512-" + createHash("sha512").update(typesBytes).digest("base64"),
  };

  const typesDownload = httpsArtifactDownload(async () => new Response(typesBytes));

  const typesEntries = await webDependencies(
    { root: "root", packages: [typesPin] },
    f.exact,
    signal,
    typesDownload
  );

  expect(typesEntries[0]?.path).toBe("node_modules/@types/estree/index.d.ts");
  await rejects(
    webDependencies(
      { root: "root", packages: [{ ...typesPin, name: "other" }] },
      f.exact,
      signal,
      typesDownload
    ),
    { reason: "install-failed" }
  );
});
