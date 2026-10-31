import { createServer } from "node:http";
import { log, traced } from "./tracing.ts";

const loadOrders = async (customer: string) =>
  await traced("orders.load", async (span) => { // EXPECT orders.load line 5
    span.setAttribute("customer.id", customer);
    log("loaded orders", { customer, count: 2 });
    return [{ id: 1 }, { id: 2 }];
  });

async function charge() {
  await traced("orders.charge", async () => { // EXPECT orders.charge line 12
    throw new TypeError("card declined for customer 42");
  });
}

const server = createServer(async (req, res) => {
  try {
    if (req.url?.startsWith("/orders/")) {
      const rows = await loadOrders(req.url.slice(8));
      res.end(JSON.stringify(rows));
    } else if (req.url === "/fail") {
      await charge();
      res.end("unreachable");
    } else res.end("ok");
  } catch (error) {
    res.statusCode = 500;
    res.end(String(error));
  }
});

server.listen(Number(process.env.PORT ?? 0), () => {
  const address = server.address();
  console.log(`listening ${typeof address === "object" && address ? address.port : address}`);
});

// The app's own graceful shutdown: drain, then exit 3 so the test can see whose exit won.
process.on("SIGTERM", () => {
  console.log("app: SIGTERM, draining");
  server.close();
  setTimeout(() => {
    console.log("app: drained");
    process.exit(3);
  }, 300);
});
