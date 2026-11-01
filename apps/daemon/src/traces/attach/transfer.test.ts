import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TEST_SESSION } from "../testing.ts";
import { TargetRegistry, type RegisteredTarget } from "./registry.ts";

const withPeer = async (
  response: string,
  run: (registry: TargetRegistry, target: RegisteredTarget) => Promise<void>
) => {
  const root = await mkdtemp("/tmp/p9-transfer-");
  const registry = new TargetRegistry(join(root, "bootstrap"));
  const program = join(root, "peer.cjs");

  await writeFile(
    program,
    `const net = require('node:net');
const token = process.env.POLARIS_PROFILE_TOKEN;
const path = process.env.POLARIS_PROFILE_SOCKET;
const registration = net.connect(path);
registration.on('connect', () => registration.write(JSON.stringify({kind:'register',runtime:'node',pid:process.pid,token})+'\\n'));
registration.on('data', chunk => {
  const {nonce} = JSON.parse(chunk);
  const worker = net.connect(path);
  worker.on('connect', () => worker.write(JSON.stringify({kind:'watchdog',pid:process.pid,token,nonce})+'\\n'));
  worker.once('data', () => { ${response} });
});`
  );

  const child = Bun.spawn([Bun.which("node")!, program], {
    env: { ...process.env, ...(await registry.environment(TEST_SESSION)), NODE_OPTIONS: "" },
    stdout: "ignore",
    stderr: "ignore",
  });

  try {
    let target;

    for (let n = 0; n < 250; n++) {
      try {
        target = registry.get(TEST_SESSION, child.pid);
        break;
      } catch {
        await Bun.sleep(20);
      }
    }

    if (!target) throw new Error("target did not register");
    await run(registry, target);
  } finally {
    child.kill();
    await child.exited;
    await registry.close();
    await rm(root, { recursive: true, force: true });
  }
};

test("private profile transfer preserves UTF-8 split across socket reads", async () => {
  const profile = JSON.stringify({
    nodes: [{ callFrame: { functionName: "函数", url: "file:///tmp/café.js" } }],
  });

  await withPeer(
    `worker.write(JSON.stringify({kind:'opened',pid:process.pid})+'\\n');
const frame = Buffer.from(JSON.stringify({kind:'chunk',pid:process.pid,data:${JSON.stringify(profile)}})+'\\n');
const split = frame.indexOf(Buffer.from('函'))+1;
worker.write(frame.subarray(0,split));
setTimeout(() => { worker.write(frame.subarray(split)); worker.write(JSON.stringify({kind:'completed',pid:process.pid})+'\\n'); },30);`,
    async (registry, target) => {
      const capture = await registry.open(target, 1);
      expect(await capture.profile).toBe(profile);
      await capture.close();
    }
  );
}, 10000);

test("P9-1: completion before capture acknowledgement cannot strand the request", async () => {
  await withPeer(
    "worker.write(JSON.stringify({kind:'completed',pid:process.pid})+'\\n');",
    async (registry, target) => {
      const outcome = registry.open(target, 1).then(
        () => "opened",
        () => "refused"
      );

      expect(await Promise.race([outcome, Bun.sleep(500).then(() => "pending")])).toBe("refused");
    }
  );
}, 10000);
