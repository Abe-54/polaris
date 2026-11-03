import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { native as reference } from "../../../src/sodium/nativeOnBun.testing.ts";
import { sodiumOver, type NativeSodium } from "../../../src/sodium/shim.ts";
import { native, nativeCalls } from "./jniOnBun.testing.ts";

const hostBuild = process.argv[2];

assert(
  hostBuild,
  "usage: bun modules/polaris-sodium/testing/check.ts <host CMake build> [scratch directory]"
);

assert(process.env.JAVA_HOME, "JAVA_HOME must point to JDK 17 or newer");

const scratch = resolve(process.argv[3] ?? mkdtempSync(join(tmpdir(), "polaris-sodium-jni-")));

const repo = resolve(import.meta.dir, "../../../../..");

assert(
  scratch.toLowerCase() !== repo.toLowerCase() &&
    !scratch.toLowerCase().startsWith(`${repo}${sep}`.toLowerCase()),
  "keep build outputs outside the checkout"
);

const classes = join(scratch, "classes");

mkdirSync(classes, { recursive: true });

process.env.POLARIS_SODIUM_HOST_BUILD = resolve(hostBuild);

process.env.POLARIS_SODIUM_HOST_CLASSES = classes;

const javac = join(
  process.env.JAVA_HOME,
  "bin",
  process.platform === "win32" ? "javac.exe" : "javac"
);

const compiled = Bun.spawnSync(
  [
    javac,
    "-d",
    classes,
    join(import.meta.dir, "../android/src/main/java/dev/lux/polaris/sodium/Sodium.java"),
    join(import.meta.dir, "NativeProbe.java"),
  ],
  { stdout: "pipe", stderr: "pipe" }
);

assert.equal(compiled.exitCode, 0, compiled.stderr.toString());

const pattern = (size: number, salt = 0) =>
  Uint8Array.from({ length: size }, (_, i) => (i * 71 + salt) % 251);

const view = (size: number) => new Uint8Array(size + 19).fill(0xa5).subarray(7, 7 + size);

let compared = 0;

const same = (run: (api: NativeSodium) => ReadonlyArray<Uint8Array | number>) => {
  assert.deepEqual(run(native), run(reference));
  compared++;
};

const seed = pattern(32, 17);

const nonce = pattern(12, 9);

const key = pattern(32, 61);

const ad = pattern(27, 42);

const signingKeys = (api: NativeSodium) => {
  const pk = view(32),
    sk = view(64);

  api.crypto_sign_seed_keypair(pk, sk, seed);

  return { pk, sk };
};

same((api) => {
  const { pk, sk } = signingKeys(api);

  return [pk, sk];
});

same((api) => {
  const pk = view(32),
    sk = view(32);

  api.crypto_kx_seed_keypair(pk, sk, seed);

  return [pk, sk];
});

same((api) => {
  const pk = view(32),
    shared = view(32);

  api.crypto_scalarmult_base(pk, seed);
  api.crypto_scalarmult(shared, key, pk);

  return [pk, shared];
});

for (const size of [0, 1, 31, 64, 255, 70_000]) {
  const message = pattern(size);
  same((api) => {
    const out = view(32);
    api.crypto_hash_sha256(out, message);

    return [out];
  });
  same((api) => {
    const signature = view(64);
    api.crypto_sign_detached(signature, message, signingKeys(api).sk);

    return [signature];
  });

  for (const associated of [new Uint8Array(), ad]) {
    same((api) => {
      const ciphertext = view(size + 16),
        opened = view(size);

      const encrypted = api.crypto_aead_chacha20poly1305_ietf_encrypt(
        ciphertext,
        message,
        associated,
        nonce,
        key
      );

      const decrypted = api.crypto_aead_chacha20poly1305_ietf_decrypt(
        opened,
        ciphertext,
        associated,
        nonce,
        key
      );

      assert.deepEqual(opened, message);

      return [ciphertext, opened, encrypted, decrypted];
    });
  }

  for (const length of [16, 32, 64]) {
    for (const hashKey of [new Uint8Array(), pattern(16, 2), pattern(64, 8)]) {
      same((api) => {
        const out = view(length);
        api.crypto_generichash(out, message, hashKey);

        return [out];
      });
    }
  }
}

same((api) => {
  const backing = pattern(128),
    out = backing.subarray(13, 45);

  api.crypto_hash_sha256(out, backing.subarray(7, 100));

  return [backing];
});

same((api) => {
  const backing = pattern(128),
    ciphertext = backing.subarray(9, 105);

  const encrypted = api.crypto_aead_chacha20poly1305_ietf_encrypt(
    ciphertext,
    ciphertext.subarray(0, 80),
    ad,
    nonce,
    key
  );

  const decrypted = api.crypto_aead_chacha20poly1305_ietf_decrypt(
    ciphertext.subarray(0, 80),
    ciphertext,
    ad,
    nonce,
    key
  );

  return [backing, encrypted, decrypted];
});

const shim = sodiumOver(native),
  referenceShim = sodiumOver(reference);

for (const hashKey of [undefined, key]) {
  const actual = view(64),
    expected = view(64);

  const parts = [pattern(5), new Uint8Array(), pattern(213, 8)];
  shim.crypto_generichash_batch(actual, parts, hashKey);
  referenceShim.crypto_generichash_batch(expected, parts, hashKey);
  assert.deepEqual(actual, expected);
}

const zeroed = pattern(64),
  expectedZeroed = zeroed.slice();

shim.sodium_memzero(zeroed);

referenceShim.sodium_memzero(expectedZeroed);

assert.deepEqual(zeroed, expectedZeroed);

const sealed = view(17),
  opened = view(1);

assert.equal(
  shim.crypto_aead_chacha20poly1305_ietf_encrypt(sealed, Uint8Array.of(3), null, null, nonce, key),
  17
);

assert.equal(
  shim.crypto_aead_chacha20poly1305_ietf_decrypt(opened, null, sealed, null, nonce, key),
  1
);

assert.deepEqual(opened, Uint8Array.of(3));

console.log(
  `PASS ${compared} deterministic JNI comparisons against sodium-native, batch hash, memzero, null AD, aliasing and offset views`
);

for (let i = 0; i < 3; i++) {
  const random = view(64),
    next = view(64);

  native.randombytes_buf(random);
  native.randombytes_buf(next);
  assert.notDeepEqual(random, new Uint8Array(64).fill(0xa5));
  assert.notDeepEqual(random, next);

  const pk = view(32),
    sk = view(64),
    derivedPk = view(32),
    derivedSk = view(64),
    signature = view(64);

  native.crypto_sign_keypair(pk, sk);
  reference.crypto_sign_seed_keypair(derivedPk, derivedSk, sk.subarray(0, 32));
  assert.deepEqual([pk, sk], [derivedPk, derivedSk]);
  native.crypto_sign_detached(signature, random, sk);
  const expectedSignature = view(64);
  reference.crypto_sign_detached(expectedSignature, random, derivedSk);
  assert.deepEqual(signature, expectedSignature);

  const kxPk = view(32),
    kxSk = view(32),
    derivedKx = view(32);

  native.crypto_kx_keypair(kxPk, kxSk);
  reference.crypto_scalarmult_base(derivedKx, kxSk);
  assert.deepEqual(kxPk, derivedKx);
}

native.randombytes_buf(new Uint8Array());

console.log(
  "PASS randombytes, random Ed25519 keypairs/signatures and random X25519 keypairs interoperate with sodium-native"
);

const { sk } = signingKeys(reference);

const failures: ReadonlyArray<readonly [string, () => void]> = [
  ["out must be 32 bytes, not 31", () => native.crypto_hash_sha256(view(31), seed)],
  ["publicKey must be 32 bytes, not 31", () => native.crypto_sign_keypair(view(31), view(64))],
  ["secretKey must be 64 bytes, not 63", () => native.crypto_sign_keypair(view(32), view(63))],
  [
    "publicKey must be 32 bytes, not 33",
    () => native.crypto_sign_seed_keypair(view(33), view(64), seed),
  ],
  [
    "secretKey must be 64 bytes, not 65",
    () => native.crypto_sign_seed_keypair(view(32), view(65), seed),
  ],
  [
    "seed must be 32 bytes, not 31",
    () => native.crypto_sign_seed_keypair(view(32), view(64), view(31)),
  ],
  ["signature must be 64 bytes, not 63", () => native.crypto_sign_detached(view(63), seed, sk)],
  [
    "secretKey must be 64 bytes, not 31",
    () => native.crypto_sign_detached(view(64), seed, view(31)),
  ],
  ["publicKey must be 32 bytes, not 31", () => native.crypto_kx_keypair(view(31), view(32))],
  ["secretKey must be 32 bytes, not 31", () => native.crypto_kx_keypair(view(32), view(31))],
  [
    "publicKey must be 32 bytes, not 33",
    () => native.crypto_kx_seed_keypair(view(33), view(32), seed),
  ],
  [
    "secretKey must be 32 bytes, not 33",
    () => native.crypto_kx_seed_keypair(view(32), view(33), seed),
  ],
  [
    "seed must be 32 bytes, not 33",
    () => native.crypto_kx_seed_keypair(view(32), view(32), view(33)),
  ],
  ["output must be 32 bytes, not 31", () => native.crypto_scalarmult(view(31), seed, key)],
  ["secretKey must be 32 bytes, not 31", () => native.crypto_scalarmult(view(32), view(31), key)],
  ["publicKey must be 32 bytes, not 31", () => native.crypto_scalarmult(view(32), seed, view(31))],
  ["scalarmult failed", () => native.crypto_scalarmult(view(32), seed, new Uint8Array(32))],
  ["output must be 32 bytes, not 31", () => native.crypto_scalarmult_base(view(31), seed)],
  ["secretKey must be 32 bytes, not 31", () => native.crypto_scalarmult_base(view(32), view(31))],
  [
    "ciphertext must be 48 bytes, not 47",
    () => native.crypto_aead_chacha20poly1305_ietf_encrypt(view(47), seed, ad, nonce, key),
  ],
  [
    "nonce must be 12 bytes, not 11",
    () => native.crypto_aead_chacha20poly1305_ietf_encrypt(view(48), seed, ad, view(11), key),
  ],
  [
    "key must be 32 bytes, not 31",
    () => native.crypto_aead_chacha20poly1305_ietf_encrypt(view(48), seed, ad, nonce, view(31)),
  ],
  [
    "ciphertext is too short",
    () => native.crypto_aead_chacha20poly1305_ietf_decrypt(view(0), view(15), ad, nonce, key),
  ],
  [
    "message must be 32 bytes, not 31",
    () => native.crypto_aead_chacha20poly1305_ietf_decrypt(view(31), view(48), ad, nonce, key),
  ],
  [
    "nonce must be 12 bytes, not 13",
    () => native.crypto_aead_chacha20poly1305_ietf_decrypt(view(32), view(48), ad, view(13), key),
  ],
  [
    "key must be 32 bytes, not 33",
    () => native.crypto_aead_chacha20poly1305_ietf_decrypt(view(32), view(48), ad, nonce, view(33)),
  ],
  ...[0, 15, 65].map(
    (length) =>
      [
        "hash output must be 16 to 64 bytes",
        () => native.crypto_generichash(view(length), seed, key),
      ] as const
  ),
  ...[1, 15, 65].map(
    (length) =>
      [
        "hash key must be 16 to 64 bytes",
        () => native.crypto_generichash(view(32), seed, view(length)),
      ] as const
  ),
];

for (const [message, run] of failures) assert.throws(run, { message });

for (const field of ["ciphertext", "AD", "nonce", "key"]) {
  const ciphertext = view(48),
    associated = ad.slice(),
    iv = nonce.slice(),
    secret = key.slice();

  native.crypto_aead_chacha20poly1305_ietf_encrypt(ciphertext, seed, associated, iv, secret);
  const changed = { ciphertext, AD: associated, nonce: iv, key: secret }[field];
  assert(changed);
  changed[0] = (changed[0] ?? 0) ^ 1;
  assert.throws(
    () =>
      native.crypto_aead_chacha20poly1305_ietf_decrypt(
        view(32),
        ciphertext,
        associated,
        iv,
        secret
      ),
    { message: "could not verify data" }
  );
}

console.log(
  `PASS ${failures.length} iOS-compatible length/key rejection cases and ciphertext/AD/nonce/key tamper rejection`
);

const built = await Bun.build({
  entrypoints: [join(import.meta.dir, "../../../src/sodium/shimProbe.testing.ts")],
  target: "bun",
  external: ["sodium-native"],
  plugins: [
    {
      name: "the mobile shim over the real JNI library",
      setup(build) {
        build.onResolve({ filter: /^sodium-universal$/ }, () => ({
          path: join(import.meta.dir, "../../../src/sodium/universal.ts"),
        }));
        build.onResolve({ filter: /^\.\/(native|nativeOnBun\.testing)\.ts$/ }, () => ({
          path: join(import.meta.dir, "jniOnBun.testing.ts"),
        }));
      },
    },
  ],
});

assert(built.success, built.logs.map(String).join("\n"));

const output = built.outputs[0];

assert(output);

const probe = join(scratch, "shim-probe.js");

await Bun.write(probe, await output.text());

const child = Bun.spawn([process.execPath, probe], {
  env: { ...process.env },
  stdout: "pipe",
  stderr: "pipe",
});

const [stdout, stderr] = await Promise.all([
  new Response(child.stdout).text(),
  new Response(child.stderr).text(),
]);

assert.equal(await child.exited, 0, stderr);

// SAFETY: shimProbe.testing.ts prints this exact JSON record and is bundled above.
const report = JSON.parse(stdout) as {
  results: Array<{ name: string; ok: boolean; detail: string }>;
  nativeCalls: number;
};

assert.equal(report.results.length, 3);

for (const result of report.results) {
  assert(result.ok, `${result.name}: ${result.detail}`);
  console.log(`PASS ${result.name}`);
}

assert(report.nativeCalls > 50, "the relay probe must reach JNI through the shim");

console.log(
  `PASS ${nativeCalls()} direct JNI calls and ${report.nativeCalls} relay JNI calls with -Xcheck:jni`
);
