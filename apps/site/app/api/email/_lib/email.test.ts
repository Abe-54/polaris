import { describe, expect, test } from "bun:test";
import { SendEmailCommand, type SESv2ClientConfig } from "@aws-sdk/client-sesv2";
import type { Level } from "../../../../lib/log";
import { createEmailHandler } from "./index";
import { createAdmission, memoryStore } from "./limiter";
import { createTransport, previewOnly, type EmailEnv, type SesFactory } from "./transport";
import { validEmail } from "./validation";
import { fakeValidator } from "./validator";

const configured: EmailEnv = {
  NODE_ENV: "production",
  AWS_REGION: "us-east-1",
  POLARIS_EMAIL_FROM: "download@example.com",
  POLARIS_EMAIL_CONFIGURATION_SET: "polaris-download",
  AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/polaris-download-email",
};

const submission = (
  body: null | Record<string, string | number> = { email: "ada@example.com", website: "" },
  headers: Readonly<Record<string, string>> = {}
) =>
  new Request("https://polaris.lux.dev/api/email", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

function fixture(env: EmailEnv = configured) {
  const sent: SendEmailCommand[] = [];

  const handler = createEmailHandler({
    validator: fakeValidator,
    checkBot: async () => ({ isBot: false, isVerifiedBot: false }),
    transport: () =>
      createTransport(env, () => ({
        send: async (command) => {
          sent.push(command);

          return {};
        },
      })),
    ...createAdmission({ store: memoryStore(), vercel: true }),
    preview: previewOnly(env),
  });

  const run = async (input: Request) => {
    const tasks: Array<() => Promise<Level | void>> = [];
    const response = await handler(input, {}, (task) => tasks.push(task));
    await Promise.all(tasks.map((task) => task()));

    return response;
  };

  return { handler: run, sent };
}

const from = (ip: string, email = "ada@example.com") =>
  submission({ email, website: "" }, { "x-vercel-forwarded-for": ip });

describe("email endpoint", () => {
  test("sends one SESv2 email (HTML and plain text) with download and source links", async () => {
    const f = fixture();
    const response = await f.handler(submission({ email: " ada+mac@example.com ", website: "" }));
    expect(response.status).toBe(202);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toBeInstanceOf(SendEmailCommand);
    expect(f.sent[0]?.input).toMatchObject({
      FromEmailAddress: "download@example.com",
      ConfigurationSetName: "polaris-download",
      Destination: { ToAddresses: ["ada+mac@example.com"] },
      Content: { Simple: { Subject: { Data: "Polaris for Mac", Charset: "UTF-8" } } },
    });
    const body = f.sent[0]?.input.Content?.Simple?.Body;
    expect(body?.Text?.Data).toContain("https://polaris.lux.dev/download/mac");
    expect(body?.Text?.Data).toContain("https://github.com/luxdotdev/polaris");
    expect(body?.Html?.Data).toContain('href="https://polaris.lux.dev/download/mac"');
    expect(body?.Html?.Data).toContain("https://polaris.lux.dev/email/dawn.png");
    expect(body?.Html?.Data).not.toContain("ada+mac");
    expect(await response.text()).not.toContain("ada");
  });

  test.each([
    null,
    {},
    { email: 12, website: "" },
    { email: "x@example.com" },
    { email: "x@example.com\r\nBcc:private@example.com", website: "" },
    { email: "x@@example.com", website: "" },
    { email: "x@-bad.com", website: "" },
    { email: "x".repeat(2049), website: "" },
  ])("rejects malformed submission %# without sending", async (input) => {
    const f = fixture();
    expect((await f.handler(submission(input))).status).toBe(400);
    expect(f.sent).toHaveLength(0);
  });

  test("honeypot gets the same reply as a delivery without transport", async () => {
    const f = fixture();
    const delivered = await fixture().handler(submission());

    const trapped = await f.handler(
      submission({ email: "ada@example.com", website: "bot.example" })
    );

    expect(trapped.status).toBe(delivered.status);
    expect(await trapped.text()).toBe(await delivered.text());
    expect(f.sent).toHaveLength(0);
  });

  test("a fourth request from one IP sends nothing, another IP is separate", async () => {
    const f = fixture();

    for (let i = 0; i < 3; i++)
      expect((await f.handler(from("192.0.2.1", `ada${i}@example.com`))).status).toBe(202);

    expect((await f.handler(from("192.0.2.1", "bob@example.com"))).status).toBe(202);
    expect(f.sent).toHaveLength(3);
    await f.handler(from("192.0.2.2", "bob@example.com"));
    expect(f.sent).toHaveLength(4);
  });

  test("one recipient is mailed once however its address is spelled", async () => {
    const f = fixture();
    await f.handler(from("192.0.2.1", "ada@example.com"));
    await f.handler(from("192.0.2.2", "Ada+again@Example.com"));
    expect(f.sent).toHaveLength(1);
  });

  test("unconfigured production fails closed", async () => {
    const f = fixture({ NODE_ENV: "production" });
    expect((await f.handler(submission())).status).toBe(202);
    expect(f.sent).toHaveLength(0);
  });

  test("cross-origin and non-JSON browser submissions cannot send", async () => {
    const f = fixture();
    expect(
      (await f.handler(submission(undefined, { Origin: "https://other.example" }))).status
    ).toBe(403);
    expect((await f.handler(submission(undefined, { "Content-Type": "text/plain" }))).status).toBe(
      415
    );
    expect(f.sent).toHaveLength(0);
  });

  test("same-origin check uses the public Host when Next normalizes its internal URL", async () => {
    const f = fixture();

    const input = new Request("http://localhost:3188/api/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Host: "127.0.0.1:3188",
        Origin: "http://127.0.0.1:3188",
      },
      body: JSON.stringify({ email: "ada@example.com", website: "" }),
    });

    expect((await f.handler(input)).status).toBe(202);
    expect(f.sent).toHaveLength(1);
  });

  test("development ignores real credentials, performs no SES call and labels preview", async () => {
    const f = fixture({ ...configured, NODE_ENV: "development" });
    const response = await f.handler(submission());
    expect(response.status).toBe(202);
    expect(response.headers.get("X-Polaris-Email-Preview")).toBe("1");
    expect(f.sent).toHaveLength(0);
  });
});

describe("transport configuration", () => {
  test.each([
    { ...configured, AWS_REGION: "" },
    { ...configured, POLARIS_EMAIL_CONFIGURATION_SET: "" },
    { ...configured, POLARIS_EMAIL_FROM: "bad" },
    { ...configured, AWS_ROLE_ARN: "" },
    { ...configured, AWS_ROLE_ARN: "not-an-arn" },
    {
      ...configured,
      AWS_ROLE_ARN: "",
      AWS_ACCESS_KEY_ID: "static-key",
      AWS_SECRET_ACCESS_KEY: "static-secret",
    },
    { ...configured, POLARIS_EMAIL_TRANSPORT: "fake" },
  ])("fails closed before creating a client %#", (env) => {
    let calls = 0;
    expect(
      createTransport(env, () => {
        calls++;
        throw new Error("must not run");
      })
    ).toBeNull();
    expect(calls).toBe(0);
  });

  test("credentials come from the Vercel OIDC role and retries are bounded", () => {
    const configs: SESv2ClientConfig[] = [];

    const factory: SesFactory = (config) => {
      configs.push(config);

      return { send: async () => ({}) };
    };

    expect(
      createTransport(
        {
          NODE_ENV: "production",
          AWS_REGION: "us-east-1",
          POLARIS_EMAIL_FROM: "download@example.com",
          POLARIS_EMAIL_CONFIGURATION_SET: "polaris-download",
          AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/polaris-download-email",
        },
        factory
      )
    ).not.toBeNull();
    expect(configs[0]?.credentials).toBeInstanceOf(Function);
    expect(configs[0]?.maxAttempts).toBe(1);
  });
});

describe("address syntax", () => {
  test.each([
    ".ada@example.com",
    "ada..x@example.com",
    "ada@example..com",
    "ada@localhost",
    "x".repeat(65) + "@example.com",
    "Ada <ada@example.com>",
  ])("invalid email %s", (email) => {
    expect(validEmail(email)).toBe(false);
  });
});
