import http from "k6/http";
import { check } from "k6";

export const options = { vus: 5, duration: "10s" };

function uuid() {
  const hex = () => Math.floor(Math.random() * 16).toString(16);
  const part = (n) => Array.from({ length: n }, hex).join("");
  return `${part(8)}-${part(4)}-4${part(3)}-8${part(3)}-${part(12)}`;
}

export default function () {
  const now = new Date().toISOString();
  const body = JSON.stringify({
    events: [
      {
        schema_version: "0.1",
        event_id: uuid(),
        event_type: "span",
        sent_at: now,
        data: {
          span_id: uuid(),
          trace_id: uuid(),
          type: "generic",
          name: "smoke",
          start_time: now,
          end_time: now,
          status: "ok",
        },
      },
    ],
  });
  const res = http.post(`${__ENV.INGEST_URL || "http://localhost:3001"}/v1/events`, body, {
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${__ENV.API_KEY || "dev-key"}`,
    },
  });
  check(res, { "status is 2xx": (r) => r.status >= 200 && r.status < 300 });
}
