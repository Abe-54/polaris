/**
 * A fake `tailscale` CLI for tests, its state in `$FAKE_TAILSCALE_DIR`: `status.json` (or
 * `status.fail`: exit 1 with that file's text on stderr), `serve.json` as `serve status --json`
 * prints it, `serve.fail` the same for `serve`, and every call appended to `calls.log`.
 * `serve.race.json` replaces `serve.json` just before the next changing `serve`, as another CLI would.
 */
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";

const dir = process.env.FAKE_TAILSCALE_DIR ?? "";

const args = process.argv.slice(2);

const file = (name: string) => join(dir, name);

appendFileSync(
  file("calls.log"),
  `${JSON.stringify({ args, beCli: process.env.TAILSCALE_BE_CLI ?? null })}\n`
);

const failWith = (name: string) => {
  if (!existsSync(file(name))) return;
  process.stderr.write(readFileSync(file(name), "utf8"));
  process.exit(1);
};

const Serve = Schema.Struct({
  Foreground: Schema.optional(Schema.Unknown),
  AllowFunnel: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  TCP: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  Web: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        Handlers: Schema.Record(
          Schema.String,
          Schema.Struct({
            Proxy: Schema.optional(Schema.String),
            Path: Schema.optional(Schema.String),
            Text: Schema.optional(Schema.String),
          })
        ),
      })
    )
  ),
});

const Status = Schema.Struct({ Self: Schema.Struct({ DNSName: Schema.String }) });

const readServe = (): typeof Serve.Type =>
  existsSync(file("serve.json"))
    ? Schema.decodeUnknownSync(Schema.fromJsonString(Serve))(
        readFileSync(file("serve.json"), "utf8")
      )
    : {};

const host = (): string =>
  Schema.decodeUnknownSync(Schema.fromJsonString(Status))(
    readFileSync(file("status.json"), "utf8")
  ).Self.DNSName.replace(/\.$/, "");

if (args[0] === "status") {
  failWith("status.fail");
  process.stdout.write(readFileSync(file("status.json"), "utf8"));
} else if (args[0] === "serve" && args[1] === "status") {
  process.stdout.write(
    existsSync(file("serve.json")) ? readFileSync(file("serve.json"), "utf8") : "{}"
  );
} else if (args[0] === "serve") {
  if (existsSync(file("serve.race.json"))) renameSync(file("serve.race.json"), file("serve.json"));
  failWith("serve.fail");
  const path = args[args.indexOf("--set-path") + 1] ?? "/";
  const serve = readServe();
  const key = `${host()}:443`;
  const handlers = { ...serve.Web?.[key]?.Handlers };
  const funnel = { ...serve.AllowFunnel };

  if (args.at(-1) === "off") {
    if (handlers[path] === undefined) {
      process.stderr.write("error: handler does not exist\n");
      process.exit(1);
    }

    delete handlers[path];
  } else {
    delete handlers[`${path}/`];
    handlers[path] = { Proxy: args.at(-1) ?? "" };

    // Serve clears Funnel for the listener, even when other paths still use it.
    delete funnel[key];
  }

  writeFileSync(
    file("serve.json"),
    JSON.stringify({
      ...serve,
      AllowFunnel: funnel,
      Web: { ...serve.Web, [key]: { Handlers: handlers } },
    })
  );
} else {
  process.exit(2);
}
