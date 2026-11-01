import {
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  fstatSync,
  readFileSync,
  closeSync,
  readdirSync,
  writeFileSync,
  renameSync,
  rmSync,
  chmodSync,
  fchmodSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Schema } from "effect";
import { Profile, ProfileDetail, ProfileError, Timestamp } from "@polaris/protocol";
import { parseProfile, invalidProfile } from "./parser.ts";
import { ProfileChanged, ProfileJob, type ProfileReply } from "./workerProtocol.ts";

declare const self: Worker;

export const MAX_ARTIFACT = 64 * 1024 * 1024;

let changed = false;

const FileFailure = Schema.Struct({ code: Schema.String });

const storageError = () =>
  new ProfileError({
    code: "E-PROFILE-UNAVAILABLE",
    message: "The profile store is unavailable.",
    fix: "Check free space and permissions in the Daemon's home, then retry.",
  });

const notFound = () =>
  new ProfileError({
    code: "E-PROFILE-NOT-FOUND",
    message: "This profile is not retained in this checkout.",
    fix: "Select a retained recording in Traces (⌘5), or run profile again.",
  });

const read = (path: string): string => {
  const before = lstatSync(path);

  if (!before.isFile() || before.isSymbolicLink()) throw invalidProfile();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);

  try {
    const stat = fstatSync(fd);

    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > MAX_ARTIFACT ||
      stat.ino !== before.ino ||
      stat.dev !== before.dev
    )
      throw invalidProfile();

    fchmodSync(fd, 0o600);

    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
};

const write = (path: string, value: Profile | ProfileDetail) => {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;

  try {
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
    changed = true;
  } finally {
    rmSync(temporary, { force: true });
  }
};

const privateDirectory = (path: string) => {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);

  if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalidProfile();
  chmodSync(path, 0o700);
};

const diskSize = (directory: string): number => {
  const pending = [directory];
  let bytes = 0;
  let entries = 0;

  while (pending.length > 0) {
    const current = pending.pop()!;

    for (const name of readdirSync(current)) {
      if (++entries > 4096) return Number.MAX_SAFE_INTEGER;
      const path = join(current, name);
      const stat = lstatSync(path);
      bytes += stat.size;

      if (stat.isDirectory() && !stat.isSymbolicLink()) pending.push(path);
    }
  }

  return bytes;
};

const profilesAt = (directory: string) =>
  readdirSync(directory).flatMap((id) => {
    if (!/^[0-9a-f-]{36}$/.test(id)) return [];

    try {
      if (
        !lstatSync(join(directory, id)).isDirectory() ||
        lstatSync(join(directory, id)).isSymbolicLink()
      )
        return [];

      const profile = Schema.decodeUnknownSync(Schema.fromJsonString(Profile))(
        read(join(directory, id, "profile.json"))
      );

      if (profile.id !== id) return [];

      return [{ profile, bytes: diskSize(join(directory, id)) }];
    } catch {
      return [];
    }
  });

const prune = (directory: string, job: ProfileJob) => {
  const entries = profilesAt(directory).sort(
    (a, b) => Date.parse(a.profile.startedAt) - Date.parse(b.profile.startedAt)
  );

  const known = new Set<string>(entries.map((entry) => entry.profile.id));

  for (const id of readdirSync(directory)) {
    if (
      !/^[0-9a-f-]{36}$/.test(id) ||
      known.has(id) ||
      job.active.includes(id) ||
      (job.operation === "start" && id === job.id)
    )
      continue;
    rmSync(join(directory, id), { recursive: true, force: true });
    changed = true;
  }

  const finished = entries.filter((e) => !job.active.includes(e.profile.id));
  let bytes = finished.reduce((total, e) => total + e.bytes, 0);
  let count = finished.length;

  for (const entry of entries) {
    if (job.active.includes(entry.profile.id)) continue;

    if (
      job.now - Date.parse(entry.profile.startedAt) <= job.maxAgeMs &&
      bytes <= job.maxBytes &&
      count <= 200
    )
      continue;
    rmSync(join(directory, entry.profile.id), { recursive: true, force: true });
    changed = true;
    bytes -= entry.bytes;
    count--;
  }
};

const complete = (directory: string, profile: Profile, checkout: string): Profile => {
  const artifacts = readdirSync(directory).filter((name) => name.endsWith(".cpuprofile"));

  const main =
    artifacts.find((name) => name.includes(`.${profile.pid}.0.`)) ??
    (artifacts.length === 1 ? artifacts[0] : undefined);

  const path = join(directory, main ?? "capture.cpuprofile");

  try {
    if (main === undefined) throw invalidProfile();
    const parsed = parseProfile(read(path), checkout);
    const { durationMs, clockStartMicros, ...data } = parsed;
    const epochOffsetMs = Date.now() - Number(process.hrtime.bigint()) / 1_000_000;
    const clockStart = clockStartMicros / 1000 + (clockStartMicros > 1e15 ? 0 : epochOffsetMs);
    const launchedAt = Date.parse(profile.startedAt);

    if (durationMs > Date.now() - launchedAt + 1000) throw invalidProfile();

    const startedAt = Timestamp.make(
      new Date(
        clockStart >= launchedAt && clockStart + durationMs <= Date.now() + 10
          ? clockStart
          : launchedAt
      ).toISOString()
    );

    const completed = Profile.make({
      ...profile,
      path,
      startedAt,
      durationMs,
      status: "completed",
    });

    write(join(directory, "detail.json"), { profile: completed, ...data });
    write(join(directory, "profile.json"), completed);

    for (const artifact of artifacts)
      if (artifact !== main) rmSync(join(directory, artifact), { force: true });

    return completed;
  } catch {
    for (const artifact of artifacts) rmSync(join(directory, artifact), { force: true });
    const failed = Profile.make({ ...profile, path: null, status: "failed" });
    write(join(directory, "profile.json"), failed);

    return failed;
  }
};

const recover = (directory: string, profile: Profile, job: ProfileJob) =>
  profile.status === "recording" && !job.active.includes(profile.id)
    ? complete(join(directory, profile.id), profile, job.checkout)
    : profile;

const retainedStatus = (profile: Profile, active: ReadonlyArray<string>) =>
  active.includes(profile.id) || profile.status !== "recording"
    ? profile
    : Profile.make({ ...profile, status: "failed" });

const run = (job: ProfileJob): ProfileReply => {
  privateDirectory(job.root);
  const directory = join(job.root, createHash("sha256").update(job.checkout).digest("hex"));
  privateDirectory(directory);
  prune(directory, job);

  if (job.operation === "list") {
    return {
      profiles: profilesAt(directory)
        .map(({ profile }) => recover(directory, profile, job))
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.id.localeCompare(b.id)),
    };
  }

  if (!/^[0-9a-f-]{36}$/.test(job.id)) throw notFound();
  const recording = join(directory, job.id);

  if (job.operation === "discard") {
    rmSync(recording, { recursive: true, force: true });
    changed = true;

    return { profiles: [] };
  }

  if (job.operation === "start") {
    if (job.profile === undefined) throw invalidProfile();
    privateDirectory(recording);

    try {
      write(join(recording, "profile.json"), job.profile);
    } catch (error) {
      rmSync(recording, { recursive: true, force: true });
      throw error;
    }

    return { profile: job.profile };
  }

  return readRecording(recording, directory, job);
};

const readRecording = (recording: string, directory: string, job: ProfileJob): ProfileReply => {
  try {
    let profile = Schema.decodeUnknownSync(Schema.fromJsonString(Profile))(
      read(join(recording, "profile.json"))
    );

    if (job.operation === "complete") {
      const finished = complete(recording, profile, job.checkout);
      prune(directory, { ...job, active: job.active.filter((id) => id !== job.id) });

      return { profile: finished };
    }

    profile = recover(directory, profile, job);

    if (profile.status !== "completed")
      return {
        profile: retainedStatus(profile, job.active),
        hotFunctions: [],
        hotPath: [],
        nodes: [],
      };

    const detailPath = join(recording, "detail.json");

    if (!readdirSync(recording).includes("detail.json")) complete(recording, profile, job.checkout);

    return Schema.decodeUnknownSync(Schema.fromJsonString(ProfileDetail))(read(detailPath));
  } catch (cause) {
    if (cause instanceof ProfileError) throw cause;

    if (Schema.is(FileFailure)(cause) && cause.code !== "ENOENT") throw storageError();
    throw notFound();
  }
};

self.onmessage = (event: MessageEvent<unknown>) => {
  try {
    const value = run(Schema.decodeUnknownSync(ProfileJob)(event.data));

    if (changed) self.postMessage(ProfileChanged.make({ changed: true }));
    self.postMessage(value);
  } catch (cause) {
    let error = invalidProfile();

    if (cause instanceof ProfileError) error = cause;
    else if (Schema.is(FileFailure)(cause)) error = storageError();

    if (changed) self.postMessage(ProfileChanged.make({ changed: true }));
    self.postMessage({ error: { code: error.code, message: error.message, fix: error.fix } });
  }
};
