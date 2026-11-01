import { constants, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const knownSdk = (name, version) =>
  name === "@opentelemetry/sdk-node" ||
  name === "@opentelemetry/sdk-trace" ||
  name.startsWith("@opentelemetry/sdk-trace-") ||
  name === "@vercel/otel" ||
  name === "@honeycombio/opentelemetry-node" ||
  name === "@azure/monitor-opentelemetry" ||
  name === "dd-trace" ||
  (name === "@sentry/node" && !/^[~^]?[0-7]\./.test(version));

const manifestOwnsSdk = (file) => {
  let fd;

  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);

    if (!stat.isFile() || stat.size > 65536) return true;
    const bytes = Buffer.alloc(65537);
    const count = readSync(fd, bytes, 0, bytes.length, 0);

    if (count > 65536) return true;
    const manifest = JSON.parse(bytes.subarray(0, count).toString("utf8"));

    return ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].some(
      (field) =>
        Object.entries(manifest[field] ?? {}).some(([name, version]) => knownSdk(name, version))
    );
  } catch (error) {
    return error.code !== "ENOENT";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
};

const packageOwnsSdk = (start) => {
  let current = start;

  for (let depth = 0; depth < 64; depth++) {
    if (manifestOwnsSdk(join(current, "package.json"))) return true;
    const parent = dirname(current);

    if (parent === current) return false;
    current = parent;
  }

  return true;
};

export const appOwnsTelemetry = () => {
  const options = process.env.NODE_OPTIONS ?? "";
  // Another register remains authoritative even when the user overrides manifest detection.

  if (
    /(?:--import[=\s]+|--require[=\s]+|(?:^|\s)-r[=\s]*)[^\s]*(?:opentelemetry|@vercel\/otel|@sentry\/node|dd-trace)/.test(
      options
    )
  )
    return true;

  if (process.env.POLARIS_OTEL_OVERRIDE === "1") return false;

  return (
    packageOwnsSdk(process.cwd()) ||
    (process.argv[1] && packageOwnsSdk(dirname(resolve(process.argv[1]))))
  );
};
