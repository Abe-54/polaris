import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { basename, posix } from "node:path";
import { Option, Schema } from "effect";
import { localHost, type DataConnection, type Candidate } from "./connection.ts";

import { linuxOwners } from "./linuxListener.ts";

interface Owner {
  readonly pid: number;
  readonly executable: string;
}

export const command = (file: string, args: string[]) =>
  new Promise<string>((resolve) => {
    execFile(
      file,
      args,
      { timeout: 1000, maxBuffer: 1024 * 1024, env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } },
      (error, stdout) => resolve(error ? "" : stdout)
    );
  });

const socketPath = (connection: DataConnection) =>
  connection.path ||
  (connection.hostname.startsWith("/")
    ? posix.join(connection.hostname, `.s.PGSQL.${connection.port}`)
    : undefined);

export const lsofOwners = (text: string, connection: DataConnection): Owner[] => {
  const socket = socketPath(connection);
  const owners = new Map<number, Owner>();
  let pid = 0;
  let executable = "";

  for (const line of text.split("\n")) {
    if (line.startsWith("p")) {
      pid = Number(line.slice(1));
      executable = "";
    } else if (line.startsWith("c")) executable = line.slice(1);
    else if (line.startsWith("n")) {
      const target = line.slice(1);

      const matches = socket
        ? target === socket
        : /^(?:\*|127(?:\.\d+){3}|\[::1\]):\d+$/.test(target) &&
          target.endsWith(`:${connection.port}`);

      if (matches && pid) owners.set(pid, { pid, executable });
    }
  }

  return [...owners.values()];
};

const macOwners = async (connection: DataConnection) => {
  const owners = lsofOwners(
    await command("/usr/sbin/lsof", [
      "-nP",
      "+c",
      "0",
      "-Fpcn",
      ...(socketPath(connection) ? ["-U"] : [`-iTCP:${connection.port}`, "-sTCP:LISTEN"]),
    ]),
    connection
  );

  return Promise.all(
    owners.map(async (owner) => {
      const text = await command("/usr/sbin/lsof", [
        "-a",
        "-p",
        String(owner.pid),
        "-d",
        "txt",
        "-Fn",
      ]);

      const executable =
        text
          .split("\n")
          .find((line) => line.startsWith("n/"))
          ?.slice(1) ?? "";

      return { ...owner, executable };
    })
  );
};

export const listenerOwners = (connection: DataConnection) => {
  // Windows has no supported listener-owner inspection; locality remains unverified.
  if (process.platform === "win32") return Promise.resolve([]);

  return process.platform === "darwin" ? macOwners(connection) : linuxOwners(connection);
};

const Inspection = Schema.Array(
  Schema.Struct({
    Config: Schema.Struct({
      Image: Schema.String,
      Labels: Schema.Record(Schema.String, Schema.String),
    }),
    NetworkSettings: Schema.Struct({
      Ports: Schema.Record(
        Schema.String,
        Schema.NullOr(
          Schema.Array(Schema.Struct({ HostIp: Schema.String, HostPort: Schema.String }))
        )
      ),
    }),
  })
);

export const composePublished = async (
  checkout: string,
  connection: DataConnection,
  text: string
) => {
  const inspected = Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.fromJsonString(Inspection))(text)
  );

  for (const container of inspected ?? []) {
    const labels = container.Config.Labels;
    const directory = labels["com.docker.compose.project.working_dir"];

    if (!directory || !labels["com.docker.compose.service"]) continue;

    if ((await realpath(directory).catch(() => "")) !== checkout) continue;

    if (!/(?:^|\/)(?:postgres|mysql|mariadb)(?::|@|$)/.test(container.Config.Image)) continue;
    const ports = Object.values(container.NetworkSettings.Ports).flatMap((value) => value ?? []);

    if (
      ports.some(
        (port) =>
          Number(port.HostPort) === connection.port &&
          ["", "0.0.0.0", "::", "127.0.0.1", "::1"].includes(port.HostIp)
      )
    )
      return true;
  }

  return false;
};

const composeOwner = async (checkout: string, connection: DataConnection) => {
  for (const docker of ["/usr/local/bin/docker", "/opt/homebrew/bin/docker", "/usr/bin/docker"]) {
    if (!(await stat(docker).catch(() => undefined))?.isFile()) continue;

    const ids = (
      await command(docker, ["ps", "--filter", `publish=${connection.port}`, "--format", "{{.ID}}"])
    )
      .trim()
      .split(/\s+/)
      .filter((id) => /^[a-f0-9]{12,64}$/.test(id));

    if (!ids.length) continue;

    if (await composePublished(checkout, connection, await command(docker, ["inspect", ...ids])))
      return true;
  }

  return false;
};

/** Request-scoped only: owner changes are observed on every list, refresh and resolve. */
export const localityProbe = (checkout: string) => {
  const cache = new Map<string, Promise<"local" | "remote">>();

  return (connection: DataConnection, _candidate: Candidate): Promise<"local" | "remote"> => {
    if (!localHost(connection.path ?? connection.hostname)) return Promise.resolve("remote");
    const key = JSON.stringify([connection.hostname, connection.port, connection.path]);
    const cached = cache.get(key);

    if (cached) return cached;

    const probe = (async (): Promise<"local" | "remote"> => {
      const owners = await listenerOwners(connection);

      return verifiedLocality(owners, () => composeOwner(checkout, connection));
    })().catch(() => "remote" as const);

    cache.set(key, probe);

    return probe;
  };
};

export const verifiedLocality = async (
  owners: ReadonlyArray<Owner>,
  compose: () => Promise<boolean>
): Promise<"local" | "remote"> => {
  if (!owners.length) return "remote";

  for (const owner of owners) {
    const name = basename(owner.executable);

    if (["postgres", "mysqld", "mariadbd"].includes(name)) continue;

    if (
      !["docker-proxy", "com.docker.backend", "OrbStack", "orbstack"].includes(name) ||
      !(await compose())
    )
      return "remote";
  }

  return "local";
};
