// Makes 50 traced calls (each with one child span) against the ingest endpoint.
// Run after building:  pnpm build  then  node packages/sdk/examples/demo.mjs
import sdk from "../dist/index.js";

const { Observe } = sdk;
const COUNT = Number(process.env.COUNT || 50);
const DELAY_MS = Number(process.env.DELAY_MS || 400);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const obs = new Observe({
  apiKey: "dev-key",
  endpoint: process.env.ENDPOINT || "http://localhost:3001",
  flushAt: 10,
  flushIntervalMs: 1000,
  retryBaseDelayMs: 200,
  retryMaxDelayMs: 3000,
  onError: (error) => console.log("  sdk:", error.message),
});

for (let i = 1; i <= COUNT; i++) {
  await obs.trace(`call-${i}`, async (t) => {
    await t.span("work", async () => {
      await sleep(DELAY_MS);
    });
  });
  console.log(`made call ${i}/${COUNT}`, JSON.stringify(obs.stats()));
}

console.log("all calls made. Waiting up to 60s for delivery...");
console.log("final stats:", JSON.stringify(await obs.shutdown(60_000)));
