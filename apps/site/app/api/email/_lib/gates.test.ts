import { describe, expect, test } from "bun:test";
import { checkBotId } from "botid/server";
import type { Level } from "../../../../lib/log";
import { checkEmailBot } from "./bot";
import { createEmailHandler } from "./index";
import type { EmailValidator } from "./validator";

const request = (email = "ada@example.com") =>
  new Request("https://polaris.lux.dev/api/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, website: "" }),
  });

/** Runs the handler, then the work it handed to the background. */
async function run(handler: ReturnType<typeof createEmailHandler>, input: Request) {
  const tasks: Array<() => Promise<Level | void>> = [];
  const response = await handler(input, {}, (task) => tasks.push(task));
  await Promise.all(tasks.map((task) => task()));

  return response;
}

describe("BotID gate", () => {
  test.each([
    { isBot: true, isVerifiedBot: false },
    { isBot: true, isVerifiedBot: true },
    { isBot: false, isVerifiedBot: true },
  ])("blocks every bot classification before even reading the body %#", async (verdict) => {
    const calls: string[] = [];
    const input = request();

    const handler = createEmailHandler({
      checkBot: async () => verdict,
      preview: false,
      validator: {
        validate: async () => {
          calls.push("validator");

          return true;
        },
      },
      admit: async () => {
        calls.push("admit");

        return "admitted";
      },
      transport: () => {
        calls.push("SES");

        return null;
      },
    });

    expect((await run(handler, input)).status).toBe(403);
    expect(input.bodyUsed).toBe(false);
    expect(calls).toEqual([]);
  });

  test("detection failure fails closed and hides provider errors", async () => {
    const handler = createEmailHandler({
      checkBot: async () => {
        throw new Error("private headers");
      },
      preview: false,
      admit: async () => {
        throw new Error("must not run");
      },
      transport: () => null,
    });

    const response = await run(handler, request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private");
  });

  test("missing client protection is rejected without calling the SDK", async () => {
    expect(await checkEmailBot(request())).toEqual({ isBot: true, isVerifiedBot: false });
  });

  test("actual SDK development bypass permits humans and classifies BAD-BOT and GOOD-BOT separately", async () => {
    const human = await checkBotId({
      developmentOptions: { isDevelopment: true, bypass: "HUMAN" },
    });

    const bad = await checkBotId({
      developmentOptions: { isDevelopment: true, bypass: "BAD-BOT" },
    });

    const good = await checkBotId({
      developmentOptions: { isDevelopment: true, bypass: "GOOD-BOT" },
    });

    expect(human.isBot || human.isVerifiedBot).toBe(false);
    expect(bad.isBot).toBe(true);
    expect(good.isBot).toBe(false);
    expect(good.isVerifiedBot).toBe(true);
  });
});

describe("recipient validator seam", () => {
  function fixture(validator?: EmailValidator, admitted = true) {
    const calls: string[] = [];

    const dependencies = {
      checkBot: async () => {
        calls.push("BotID");

        return { isBot: false, isVerifiedBot: false };
      },
      preview: false,
      admit: async () => {
        calls.push("admit");

        return admitted ? ("admitted" as const) : ("recipient_cooldown" as const);
      },
      transport: () => ({
        preview: false,
        send: async () => {
          calls.push("SES");
        },
      }),
    };

    const handler = createEmailHandler(
      validator
        ? {
            ...dependencies,
            validator: {
              validate: async (email) => {
                calls.push("validator");

                return validator.validate(email);
              },
            },
          }
        : dependencies
    );

    return { handler, calls };
  }

  test("human → syntax/honeypot → admission → validator → SES", async () => {
    const f = fixture({
      validate: async (email) => {
        expect(email).toBe("ada@example.com");

        return true;
      },
    });

    expect((await run(f.handler, request())).status).toBe(202);
    expect(f.calls).toEqual(["BotID", "admit", "validator", "SES"]);
  });

  test("a refused admission reaches neither the provider nor SES", async () => {
    const f = fixture({ validate: async () => true }, false);
    expect((await run(f.handler, request())).status).toBe(202);
    expect(f.calls).toEqual(["BotID", "admit"]);
  });

  test("syntax rejection does not reach admission, provider or SES", async () => {
    const f = fixture({
      validate: async () => {
        throw new Error("must not run");
      },
    });

    expect((await run(f.handler, request("bad"))).status).toBe(400);
    expect(f.calls).toEqual(["BotID"]);
  });

  test("provider rejection blocks SES", async () => {
    const f = fixture({ validate: async () => false });
    await run(f.handler, request());
    expect(f.calls).toEqual(["BotID", "admit", "validator"]);
  });

  test("provider error fails closed", async () => {
    const f = fixture({
      validate: async () => {
        throw new Error("private recipient");
      },
    });

    const response = await run(f.handler, request());
    expect(await response.text()).not.toContain("private");
    expect(f.calls).toEqual(["BotID", "admit", "validator"]);
  });

  test("missing validator fails closed instead of bypassing validation", async () => {
    const f = fixture();
    await run(f.handler, request());
    expect(f.calls).toEqual(["BotID", "admit"]);
  });
});
