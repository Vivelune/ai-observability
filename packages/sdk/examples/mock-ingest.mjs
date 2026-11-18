// A tiny stand-in for the ingest API (the real one comes in the next phase).
// It validates every event against the contract and counts UNIQUE event_ids.
//
// Run:      node packages/sdk/examples/mock-ingest.mjs
// Commands: type "down" + Enter to simulate unplugging the network (connections are refused),
//           "up" + Enter to reconnect, "stats" + Enter to print the counts.
import http from "node:http";
import readline from "node:readline";
import schema from "@ai-observability/schema";

const { EventSchema } = schema;
const PORT = Number(process.env.PORT || 3001);
const seen = new Map(); // event_id -> event_type
let requests = 0;
let server;

function counts() {
  const totals = { trace: 0, span: 0, eval_result: 0 };
  for (const type of seen.values()) totals[type]++;
  return totals;
}

function report() {
  const c = counts();
  console.log(
    `unique events: ${seen.size} (traces ${c.trace}, spans ${c.span}) after ${requests} requests`,
  );
}

function handle(req, res) {
  if (req.method !== "POST" || req.url !== "/v1/events") {
    res.writeHead(404).end();
    return;
  }
  if (!String(req.headers.authorization || "").startsWith("Bearer ")) {
    res.writeHead(401).end();
    return;
  }
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (!body || !Array.isArray(body.events)) {
      res.writeHead(400).end();
      return;
    }
    const rejected = [];
    let accepted = 0;
    body.events.forEach((event, index) => {
      const parsed = EventSchema.safeParse(event);
      if (!parsed.success) {
        rejected.push({
          index,
          code: "invalid_event",
          message: parsed.error.issues[0]?.message ?? "invalid",
        });
        return;
      }
      accepted++;
      seen.set(parsed.data.event_id, parsed.data.event_type);
    });
    requests++;
    res.writeHead(202, { "content-type": "application/json" });
    res.end(JSON.stringify({ accepted, rejected }));
    report();
  });
}

function up() {
  server = http.createServer(handle);
  server.listen(PORT, () => console.log(`ingest UP on http://localhost:${PORT}`));
}

function down() {
  if (!server) return;
  server.close();
  server.closeAllConnections();
  server = undefined;
  console.log("ingest DOWN (connections are refused)");
}

up();
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const command = line.trim();
  if (command === "down") down();
  else if (command === "up" && !server) up();
  else if (command === "stats") report();
  else console.log("commands: down, up, stats");
});
