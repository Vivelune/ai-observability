import http from "k6/http";
import { check } from "k6";

export const options = { vus: 5, duration: "10s" };

export default function () {
  const body = JSON.stringify({
    events: [{ schemaVersion: "0.1", traceId: `t-${__VU}-${__ITER}`, spanId: `s-${__VU}-${__ITER}`,
      name: "smoke", startTime: new Date().toISOString(), durationMs: 10 }],
  });
  const res = http.post(`${__ENV.INGEST_URL || "http://localhost:3001"}/v1/spans`, body, {
    headers: { "content-type": "application/json", authorization: `Bearer ${__ENV.API_KEY || "dev-key"}` },
  });
  check(res, { "status is 2xx": (r) => r.status >= 200 && r.status < 300 });
}
