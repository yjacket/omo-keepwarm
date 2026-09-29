// Local mock of POST /v1/messages (Anthropic). QA only.
//
// startMock({ port: 0, logFile, script }) -> { url, requests(), close() }
//
// kind "chat": body.stream === true  -> Anthropic SSE.
// kind "warm": stream absent/false   -> JSON message (content [], usage).
//
// Usage script: first chat cache_creation 25000; later chats cache_read = previous prompt
// tokens and a small creation for the delta; warm cache_read = previous prompt tokens,
// creation 0. The "previous prompt" is the prompt size after the last successful chat/warm.
//
// script (all optional):
//   warm:  { [n]: { status: 429|500|..., cacheCreation: <n>, cacheRead: <n> } }   n = 1-based warm index
//   chat:  { [n]: { status: ... } }                                                n = 1-based chat index
//   firstCreation (25000), deltaCreation (500), model, chatDelayMs
import http from "node:http";
import { appendFileSync, writeFileSync } from "node:fs";

const FIRST_CREATION = 25000;
const DELTA_CREATION = 500;

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function errorBody(status) {
  const type = status === 429 ? "rate_limit_error" : status >= 500 ? "api_error" : "invalid_request_error";
  return { type: "error", error: { type, message: `kw-qa mock injected ${status}` } };
}

export async function startMock({ port = 0, logFile, script = {} } = {}) {
  const log = [];
  let chatCount = 0;
  let warmCount = 0;
  let promptTokens = 0; // size of the prompt prefix the "cache" currently holds

  if (logFile) writeFileSync(logFile, "");

  const record = (entry) => {
    log.push(entry);
    if (logFile) appendFileSync(logFile, JSON.stringify(entry) + "\n");
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0];
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
      } catch {
        body = { unparsable: true };
      }
      if (req.method !== "POST" || path !== "/v1/messages") {
        record({ t: Date.now(), kind: "other", status: 404, method: req.method, path, body });
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "kw-qa mock" } }));
        return;
      }

      const isChat = body?.stream === true;
      const kind = isChat ? "chat" : "warm";
      const n = isChat ? ++chatCount : ++warmCount;
      const step = (isChat ? script.chat : script.warm)?.[n] ?? {};
      const model = script.model ?? body?.model ?? "claude-mock";

      if (step.status && step.status >= 400) {
        record({ t: Date.now(), kind, n, status: step.status, path, body });
        res.writeHead(step.status, { "content-type": "application/json" });
        res.end(JSON.stringify(errorBody(step.status)));
        return;
      }

      let usage;
      if (isChat) {
        const creation = step.cacheCreation ?? (promptTokens === 0 ? (script.firstCreation ?? FIRST_CREATION) : (script.deltaCreation ?? DELTA_CREATION));
        const read = step.cacheRead ?? promptTokens;
        usage = { input_tokens: 10, cache_creation_input_tokens: creation, cache_read_input_tokens: read, output_tokens: 2 };
        promptTokens = read + creation;
      } else {
        usage = {
          input_tokens: 1,
          cache_creation_input_tokens: step.cacheCreation ?? 0,
          cache_read_input_tokens: step.cacheRead ?? promptTokens,
          output_tokens: 0,
        };
      }
      record({ t: Date.now(), kind, n, status: 200, path, body, usage });

      const id = `msg_kwqa_${kind}_${n}`;
      if (!isChat) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id, type: "message", role: "assistant", content: [], model, stop_reason: "end_turn", stop_sequence: null, usage }));
        return;
      }

      const finish = () => {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        sse(res, "message_start", {
          type: "message_start",
          message: {
            id, type: "message", role: "assistant", content: [], model, stop_reason: null, stop_sequence: null,
            usage: { ...usage, output_tokens: 1 },
          },
        });
        sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
        sse(res, "ping", { type: "ping" });
        sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } });
        sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
        sse(res, "message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { ...usage, output_tokens: usage.output_tokens },
        });
        sse(res, "message_stop", { type: "message_stop" });
        res.end();
      };
      if (script.chatDelayMs > 0) setTimeout(finish, script.chatDelayMs);
      else finish();
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const addr = server.address();
  const url = `http://127.0.0.1:${addr.port}`;

  return {
    url,
    requests: () => log.map((e) => ({ ...e })),
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
