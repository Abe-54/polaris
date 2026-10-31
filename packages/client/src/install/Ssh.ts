/**
 * Runs one command on a Host over OpenSSH, non-interactively. The Client
 * never answers prompts itself: `BatchMode=yes` turns a password, 2FA or
 * changed-host-key prompt into a failure that surfaces as Needs Attention.
 */
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { Transform } from "node:stream";
import { Context, Effect, Layer, Schema } from "effect";
import { type ChildProcessApi, childProcesses, spawnFailed } from "../process/index.ts";
import { resolveSshBinary, type SshOptions } from "../ssh.ts";
import { LINE_BYTES } from "./windows/powershell.ts";

export interface SshResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Why ssh itself failed (exit 255), as far as its stderr tells. */
export const SshFailure = Schema.Literals(["host-key", "auth", "unreachable", "spawn", "unknown"]);

export type SshFailure = typeof SshFailure.Type;

export class SshError extends Schema.TaggedError<SshError>()("SshError", {
  alias: Schema.String,
  failure: SshFailure,
  message: Schema.String,
}) {
  /** The user has to act (verify a host key, set up keys) before we can retry. */
  get needsAttention(): boolean {
    return this.failure === "host-key" || this.failure === "auth";
  }
}

export const classifySshFailure = (stderr: string): SshFailure => {
  if (/host key verification failed|remote host identification has changed/i.test(stderr))
    return "host-key";

  if (/^ssh: connect to host .+ port \d+: permission denied\.?\r?$/im.test(stderr))
    return "unreachable";

  if (
    /permission denied|too many authentication failures|no supported authentication/i.test(stderr)
  )
    return "auth";

  if (
    /could not resolve hostname|no such host is known|connection refused|timed out|no route to host|network is unreachable|connection closed/i.test(
      stderr
    )
  )
    return "unreachable";

  return "unknown";
};

/** Single-quote `value` for a POSIX shell. */
export const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * Wrap a POSIX `sh` script so it runs the same whatever the user's login
 * shell is (bash, zsh, fish, csh all pass a single-quoted word through).
 */
export const shScript = (script: string): string => `sh -c ${shellQuote(script)}`;

export interface Spawned {
  readonly alias: string;
  readonly file: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdinFile?: string | undefined;
  readonly onStdinBytes?: ((bytes: number) => void) | undefined;
  /** Sends `stdinFile` as base64 lines, for a Windows Host (`windows/powershell.ts`). */
  readonly stdinLines?: boolean | undefined;
  /** ssh's own exit code; a local shell has none, so every exit is the command's. */
  readonly transportFailure: number | null;
  /** Starts the process (`ChildProcess`); tests script or record it. */
  readonly processes?: ChildProcessApi;
}

/** Each chunk (at most `LINE_BYTES`) as one base64 line. */
const base64Lines = () =>
  new Transform({
    transform(chunk: Buffer, _encoding, done) {
      done(null, `${chunk.toString("base64")}\n`);
    },
  });

export const runCommand = ({
  alias,
  file,
  args,
  env,
  stdinFile,
  onStdinBytes,
  stdinLines,
  transportFailure,
  processes = childProcesses,
}: Spawned) =>
  Effect.callback<SshResult, SshError>((resume) => {
    const child = processes.spawn({
      file,
      args,
      stdio: [stdinFile ? "pipe" : "ignore", "pipe", "pipe"],
      env: env ?? process.env,
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    let input: ReturnType<typeof createReadStream> | undefined;

    if (stdinFile && child.stdin) {
      // The command exiting early (EPIPE) is reported through its exit code below.
      child.stdin.on("error", () => {});
      input = createReadStream(stdinFile, stdinLines ? { highWaterMark: LINE_BYTES } : {});
      let bytes = 0;
      input.on("data", (chunk) => {
        bytes += chunk.length;
        onStdinBytes?.(bytes);
      });
      input.on("error", (error) => {
        child.kill();
        resume(Effect.fail(new SshError({ alias, failure: "spawn", message: error.message })));
      });

      if (stdinLines) input.pipe(base64Lines()).pipe(child.stdin);
      else input.pipe(child.stdin);
    }

    child.on("error", (error: NodeJS.ErrnoException) =>
      resume(
        Effect.fail(
          new SshError({ alias, failure: "spawn", message: spawnFailed(file, error).message })
        )
      )
    );
    child.on("close", (code) => {
      input?.destroy();

      if (code !== null && code === transportFailure) {
        resume(
          Effect.fail(
            new SshError({ alias, failure: classifySshFailure(stderr), message: stderr.trim() })
          )
        );
      } else {
        resume(Effect.succeed({ code: code ?? 1, stdout, stderr }));
      }
    });

    return Effect.sync(() => {
      input?.destroy();
      child.kill();
    });
  });

export interface ExecStdin {
  readonly stdinFile?: string;
  readonly onStdinBytes?: (bytes: number) => void;
  /** Send `stdinFile` as base64 lines: a Windows Host's PowerShell reads stdin as text. */
  readonly stdinLines?: boolean;
}

export class Ssh extends Context.Service<
  Ssh,
  {
    /**
     * Run `command` (a remote shell command line) on `alias`. With
     * `stdinFile`, stream that local file to the command's stdin.
     * Fails with SshError only when ssh itself fails (exit 255).
     */
    readonly exec: (
      alias: string,
      command: string,
      options?: ExecStdin
    ) => Effect.Effect<SshResult, SshError>;
  }
>()("polaris/client/install/Ssh") {
  /** The system `ssh`, honouring the user's ~/.ssh/config for the alias. */
  static readonly withOptions = (sshOptions: SshOptions = {}) =>
    Layer.succeed(
      Ssh,
      Ssh.of({
        exec: (alias, command, options) =>
          alias.startsWith("-")
            ? Effect.fail(new SshError({ alias, failure: "spawn", message: "invalid alias" }))
            : runCommand({
                alias,
                file: resolveSshBinary(sshOptions),
                args: [
                  "-T",
                  "-o",
                  "BatchMode=yes",
                  // Never write known_hosts (ssh.ts); no agent for install commands.
                  "-o",
                  "StrictHostKeyChecking=yes",
                  "-o",
                  "UpdateHostKeys=no",
                  "-o",
                  "ForwardAgent=no",
                  "-o",
                  "ConnectTimeout=15",
                  "--",
                  alias,
                  command,
                ],
                stdinFile: options?.stdinFile,
                onStdinBytes: options?.onStdinBytes,
                stdinLines: options?.stdinLines,
                transportFailure: 255,
              }),
      })
    );

  static readonly layer = Ssh.withOptions();

  /**
   * This machine itself, for its own installed Daemon: the same commands in a
   * local `sh`, with `HOME` as given (tests use a temporary one). The alias is ignored.
   * `HostAccess` builds it only for a local Host Polaris installed, never on Windows.
   */
  static readonly local = (home: string) =>
    Layer.succeed(
      Ssh,
      Ssh.of({
        exec: (alias, command, options) =>
          runCommand({
            alias,
            file: "/bin/sh",
            args: ["-c", command],
            env: { ...process.env, HOME: home, POLARIS_HOME: join(home, ".polaris") },
            stdinFile: options?.stdinFile,
            onStdinBytes: options?.onStdinBytes,
            stdinLines: options?.stdinLines,
            transportFailure: null,
          }),
      })
    );
}
