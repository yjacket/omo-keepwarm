// Passthrough proxy: 127.0.0.1:<QT_PORT> -> https://api.anthropic.com
// Logs one JSONL line per response: ts, label, path, status, model, usage,
// every anthropic-ratelimit-* header verbatim. Never logs Authorization or bodies.
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.env.QT_PORT || 18321);
const DIR = process.env.QT_DIR || path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const LOG = path.join(DIR, "raw.jsonl");
const LABEL_FILE = path.join(DIR, "label.txt");
const UPSTREAM = "api.anthropic.com";

function label() {
  try { return fs.readFileSync(LABEL_FILE, "utf8").trim(); } catch { return ""; }
}

function mergeUsage(base, delta) {
  if (!delta) return base;
  const out = { ...(base || {}) };
  for (const [k, v] of Object.entries(delta)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "object") out[k] = { ...(out[k] || {}), ...v };
    else out[k] = v; // later value wins (message_delta carries cumulative output_tokens)
  }
  return out;
}

function parseBody(contentType, text) {
  let model = null, usage = null, stop_reason = null, error = null, msg_id = null;
  if ((contentType || "").includes("text/event-stream")) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (ev.type === "message_start" && ev.message) {
        model = ev.message.model ?? model; msg_id = ev.message.id ?? msg_id;
        usage = mergeUsage(usage, ev.message.usage);
      } else if (ev.type === "message_delta") {
        usage = mergeUsage(usage, ev.usage);
        stop_reason = ev.delta?.stop_reason ?? stop_reason;
      } else if (ev.type === "error") {
        error = ev.error?.type ?? "error";
      }
    }
  } else {
    try {
      const j = JSON.parse(text);
      model = j.model ?? null; usage = j.usage ?? null; stop_reason = j.stop_reason ?? null; msg_id = j.id ?? null;
      if (j.type === "error") error = j.error?.type ?? "error";
    } catch { /* non-JSON body: ignore */ }
  }
  return { model, usage, stop_reason, error, msg_id };
}

const server = http.createServer((req, res) => {
  const ts_req = new Date().toISOString();
  const headers = { ...req.headers, host: UPSTREAM, "accept-encoding": "identity" };
  delete headers["connection"];
  const up = https.request({ host: UPSTREAM, port: 443, method: req.method, path: req.url, headers }, (ur) => {
    const rl = {};
    for (const [k, v] of Object.entries(ur.headers)) {
      if (k.startsWith("anthropic-ratelimit") || k === "retry-after" || k === "request-id" || k === "x-should-retry") rl[k] = v;
    }
    const resHeaders = { ...ur.headers };
    delete resHeaders["content-encoding"];
    delete resHeaders["content-length"]; // identity + chunked passthrough
    delete resHeaders["transfer-encoding"];
    res.writeHead(ur.statusCode, resHeaders);
    const chunks = [];
    ur.on("data", (c) => { chunks.push(c); res.write(c); });
    ur.on("end", () => {
      res.end();
      const text = Buffer.concat(chunks).toString("utf8");
      const parsed = parseBody(ur.headers["content-type"], text);
      const rec = {
        ts: new Date().toISOString(), ts_req, label: label(), method: req.method, path: req.url.split("?")[0],
        status: ur.statusCode, model: parsed.model, usage: parsed.usage, stop_reason: parsed.stop_reason,
        error: parsed.error, msg_id: parsed.msg_id, body_bytes: text.length, headers: rl,
      };
      fs.appendFileSync(LOG, JSON.stringify(rec) + "\n");
    });
    ur.on("error", (e) => { try { res.end(); } catch {} fs.appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), label: label(), path: req.url, proxy_error: String(e) }) + "\n"); });
  });
  up.on("error", (e) => {
    fs.appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), label: label(), path: req.url, proxy_error: String(e) }) + "\n");
    res.writeHead(502); res.end("proxy upstream error");
  });
  req.pipe(up);
});

server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`proxy listening on 127.0.0.1:${PORT} -> ${UPSTREAM}, log ${LOG}\n`);
});
