import { tracedFetch } from "./http.ts";
import { log, traced } from "./tracing.ts";

const loadRate = async (currency: string) =>
  await traced("rates.load", async (span) => { // EXPECT rates.load line 5
    span.setAttribute("currency", currency);
    log("loaded rate", { currency });
    return 1.08;
  });

async function charge() {
  await traced("orders.charge", async () => { // EXPECT orders.charge line 12
    throw new TypeError("card declined for customer 42");
  });
}

// The tail-call form the helper warns about, to check the warning.
const tail = () => traced("tail.call", async () => 1); // line 18

async function handle(req: Request): Promise<Response> {
  const path = new URL(req.url).pathname;
  if (path.startsWith("/rates/")) return Response.json({ rate: await loadRate(path.slice(7)) });
  if (path.startsWith("/orders/")) {
    await tail();
    return new Response("ok");
  }
  if (path === "/fail") {
    await charge();
    return new Response("unreachable");
  }
  return new Response("ok");
}

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  fetch: tracedFetch(
    (req) => (new URL(req.url).pathname.startsWith("/rates/") ? "/rates/:currency" : new URL(req.url).pathname),
    handle
  ),
});
console.log(`listening ${server.port}`);

process.on("SIGTERM", () => {
  console.log("app: SIGTERM, draining");
  server.stop();
  setTimeout(() => {
    console.log("app: drained");
    process.exit(3);
  }, process.env.APP_EXIT_FAST ? 0 : 300);
});
