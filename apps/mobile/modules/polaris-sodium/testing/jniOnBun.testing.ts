import { join } from "node:path";
import type { NativeSodium } from "../../../src/sodium/shim.ts";

let calls = 0;

export const nativeCalls = () => calls;

const required = (name: string) => {
  const value = process.env[name];

  if (value === undefined) throw new Error(`${name} is required`);

  return value;
};

const invoke = (operation: string, args: ReadonlyArray<Uint8Array>): number => {
  calls++;
  const groups: Array<{ buffer: ArrayBufferLike; start: number; end: number }> = [];
  const indices = new Map<ArrayBufferLike, number>();

  const views = args.map((arg) => {
    let index = indices.get(arg.buffer);

    if (index === undefined) {
      index = groups.length;
      indices.set(arg.buffer, index);
      groups.push({
        buffer: arg.buffer,
        start: arg.byteOffset,
        end: arg.byteOffset + arg.byteLength,
      });
    }

    const group = groups[index];

    if (group === undefined) throw new Error("missing buffer group");
    group.start = Math.min(group.start, arg.byteOffset);
    group.end = Math.max(group.end, arg.byteOffset + arg.byteLength);

    return { index, offset: arg.byteOffset, length: arg.byteLength };
  });

  const contents = groups.map(
    (group) => new Uint8Array(group.buffer, group.start, group.end - group.start)
  );

  const input = [
    operation,
    groups.length.toString(),
    ...contents.map((bytes) => Buffer.from(bytes).toString("hex")),
    args.length.toString(),
    ...views.map(
      ({ index, offset, length }) => `${index}\t${offset - (groups[index]?.start ?? 0)}\t${length}`
    ),
    "",
  ].join("\n");

  const java = join(
    required("JAVA_HOME"),
    "bin",
    process.platform === "win32" ? "java.exe" : "java"
  );

  const child = Bun.spawnSync(
    [
      java,
      "-Xcheck:jni",
      `-Djava.library.path=${required("POLARIS_SODIUM_HOST_BUILD")}`,
      "-cp",
      required("POLARIS_SODIUM_HOST_CLASSES"),
      "dev.lux.polaris.sodium.NativeProbe",
    ],
    { stdin: Buffer.from(input), stdout: "pipe", stderr: "pipe", maxBuffer: 16 * 1024 * 1024 }
  );

  if (child.exitCode !== 0) throw new Error(child.stderr.toString() || child.stdout.toString());
  const lines = child.stdout.toString().replaceAll("\r", "").split("\n");
  const status = lines.shift();
  contents.forEach((bytes, index) => {
    const result = Buffer.from(lines[index] ?? "", "hex");

    if (result.byteLength !== bytes.byteLength)
      throw new Error("JNI returned an incomplete buffer");
    bytes.set(result);
  });

  if (status?.startsWith("ERR\t")) throw new Error(status.slice(4));

  if (!status?.startsWith("OK\t")) throw new Error(`invalid JVM reply ${child.stdout.toString()}`);

  return Number(status.slice(3));
};

export const native: NativeSodium = {
  randombytes_buf: (buffer) => {
    invoke("randombytesBuf", [buffer]);
  },
  crypto_hash_sha256: (out, input) => {
    invoke("hashSha256", [out, input]);
  },
  crypto_sign_keypair: (pk, sk) => {
    invoke("signKeypair", [pk, sk]);
  },
  crypto_sign_seed_keypair: (pk, sk, seed) => {
    invoke("signSeedKeypair", [pk, sk, seed]);
  },
  crypto_sign_detached: (sig, message, sk) => {
    invoke("signDetached", [sig, message, sk]);
  },
  crypto_kx_keypair: (pk, sk) => {
    invoke("kxKeypair", [pk, sk]);
  },
  crypto_kx_seed_keypair: (pk, sk, seed) => {
    invoke("kxSeedKeypair", [pk, sk, seed]);
  },
  crypto_scalarmult: (out, sk, pk) => {
    invoke("scalarmult", [out, sk, pk]);
  },
  crypto_scalarmult_base: (out, sk) => {
    invoke("scalarmultBase", [out, sk]);
  },
  crypto_aead_chacha20poly1305_ietf_encrypt: (out, input, ad, nonce, key) =>
    invoke("encrypt", [out, input, ad, nonce, key]),
  crypto_aead_chacha20poly1305_ietf_decrypt: (out, input, ad, nonce, key) =>
    invoke("decrypt", [out, input, ad, nonce, key]),
  crypto_generichash: (out, input, key) => {
    invoke("generichash", [out, input, key]);
  },
};
