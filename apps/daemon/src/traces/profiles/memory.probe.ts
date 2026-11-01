import { profileJob } from "./workerClient.ts";

const [root, id] = process.argv.slice(2);

if (root === undefined || id === undefined)
  throw new Error("Pass the fixture root and recording id.");

const started = performance.now();

let status = "failed";

try {
  const reply = await profileJob({
    root,
    checkout: "/checkout",
    operation: "complete",
    id,
    active: [id],
    now: Date.now(),
    maxBytes: 200 * 1024 * 1024,
    maxAgeMs: 7 * 86400_000,
  });

  status = "profile" in reply ? reply.profile.status : "missing";
} finally {
  console.log(
    JSON.stringify({
      elapsedMs: performance.now() - started,
      peakRssMiB: process.resourceUsage().maxRSS / 1024,
      status,
    })
  );
}
