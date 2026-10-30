import { Effect, Option, Redacted } from "effect";
import type { HostSecrets } from "../secrets/index.ts";

/** Base64 stays inside SECRET_VALUE's safe token alphabet, including for quotes and Unicode. */
export const dataPasswords = (secrets: HostSecrets["Service"]) => ({
  set: (id: string, password: Redacted.Redacted<string>) =>
    secrets.set(
      `data/${id}`,
      Redacted.make(Buffer.from(Redacted.value(password), "utf8").toString("base64") || "=")
    ),
  get: (id: string) =>
    secrets.get(`data/${id}`).pipe(
      // An empty password is encoded as `=`, since other namespaces refuse empty tokens.
      // Every value in this namespace is written by set above.
      Effect.map((value) =>
        Option.map(value, (encoded) =>
          Redacted.make(Buffer.from(Redacted.value(encoded), "base64").toString("utf8"))
        )
      )
    ),
  remove: (id: string) => secrets.remove(`data/${id}`),
});
