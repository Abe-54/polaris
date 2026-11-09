import { expect, test } from "bun:test";
import { encodeJsonFrame, FrameDecoder } from "@polaris/protocol";
import {
  acceptHandshake,
  generateStaticKeyPair,
  RelayInitiator,
} from "@polaris/protocol/relay/party";
import { TestParty } from "./testing/party.ts";
import { identify } from "./testing/relay.ts";

const freePort = () => {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data: () => undefined },
  });

  const port = listener.port;
  listener.stop(true);

  return port;
};

/** Collects a stream's text in the background; `waitFor` polls it. */
const collect = (stream: ReadableStream<Uint8Array>) => {
  let text = "";

  const done = (async () => {
    for await (const chunk of stream) text += new TextDecoder().decode(chunk);
  })();

  const waitFor = async (needle: string) => {
    const deadline = Date.now() + 10_000;

    while (!text.includes(needle)) {
      if (Date.now() > deadline) throw new Error(`relay never logged ${needle}`);
      await Bun.sleep(20);
    }
  };

  return { waitFor, all: async () => (await done, text) };
};

test("the relay process carries an encrypted exchange and logs no payload or identifier", async () => {
  const port = freePort();

  const child = Bun.spawn(["bun", "src/main.ts"], {
    cwd: `${import.meta.dir}/..`,
    env: { ...process.env, PORT: String(port), POLARIS_RELAY_HOSTNAME: "127.0.0.1" },
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = collect(child.stdout);
  const stderr = collect(child.stderr);
  await stdout.waitFor('"relay.start"');

  const url = `ws://127.0.0.1:${port}/v1`;
  const host = { ...(await identify()), noise: generateStaticKeyPair() };
  const device = { ...(await identify()), noise: generateStaticKeyPair() };

  const hostParty = await TestParty.connect(url, "host", {
    identity: host.identity,
    peers: [device.address],
  });

  const deviceParty = await TestParty.connect(url, "device", { identity: device.identity });

  const initiator = new RelayInitiator(device.noise, host.noise.publicKey);
  deviceParty.sendRecord(host.address, initiator.init);
  const accepted = acceptHandshake(host.noise, (await hostParty.data()).payload, () => true);
  hostParty.sendRecord(device.address, accepted.reply);
  const session = initiator.finish((await deviceParty.data()).payload);

  const marker = "process-plaintext-91c3";

  for (const record of session.seal(encodeJsonFrame(`{"m":"${marker}"}`)))
    deviceParty.sendRecord(host.address, record);
  const opened = accepted.session.open((await hostParty.data()).payload);
  expect(new FrameDecoder().push(opened)).toEqual([{ kind: "json", text: `{"m":"${marker}"}` }]);

  await deviceParty.close();
  await hostParty.close();
  child.kill("SIGTERM");
  expect(await child.exited).toBe(0);
  const lines = (await stdout.all()).split("\n").filter((line) => line !== "");
  const log = `${lines.join("\n")}${await stderr.all()}`;

  expect(lines.filter((line) => line.includes('"relay.connection"'))).toHaveLength(2);
  expect(log).not.toContain(marker);

  for (const secret of [...host.secrets, ...device.secrets, "127.0.0.1"])
    expect(log).not.toContain(secret);
}, 20_000);
