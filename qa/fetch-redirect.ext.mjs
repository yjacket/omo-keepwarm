// QA-only senpi extension (never install). Loaded with `-e`.
//  - wraps globalThis.fetch: api.anthropic.com -> KW_QA_MOCK_URL (path + body kept),
//    localhost/127.0.0.1 pass through, anything else is logged to KW_QA_BLOCK_LOG and rejected.
//  - input handler: exact text "kw-qa-ext-input" -> { action: "handled" }, then on the next tick
//    pi.sendUserMessage("kw qa extension input").
//  - if KW_QA_EXT_LOG is set, appends JSONL of input / input_disposition events seen.
import { appendFileSync } from "node:fs";

const ANTHROPIC = "https://api.anthropic.com";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const MARK = Symbol.for("kw-qa.fetch-wrapped");

function appendLine(file, obj) {
  if (!file) return;
  try {
    appendFileSync(file, JSON.stringify(obj) + "\n");
  } catch {
    // never let QA logging break the host
  }
}

function urlOf(input) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input?.url ?? String(input);
}

function installFetchWrap() {
  const original = globalThis.fetch;
  if (typeof original !== "function" || original[MARK]) return;
  const wrapped = async function kwQaFetch(input, init) {
    const raw = urlOf(input);
    let u;
    try {
      u = new URL(raw);
    } catch {
      appendLine(process.env.KW_QA_BLOCK_LOG, { t: Date.now(), url: raw, reason: "unparsable" });
      throw new TypeError("kw-qa: blocked outbound");
    }
    if (LOCAL_HOSTS.has(u.hostname)) return original(input, init);
    if (u.origin === ANTHROPIC && process.env.KW_QA_MOCK_URL) {
      const target = process.env.KW_QA_MOCK_URL.replace(/\/+$/, "") + u.pathname + u.search;
      if (typeof input === "string" || input instanceof URL) return original(target, init);
      // Request object: re-issue against the mock keeping method/headers/body.
      return original(new Request(target, input), init);
    }
    appendLine(process.env.KW_QA_BLOCK_LOG, { t: Date.now(), url: raw, method: init?.method ?? input?.method ?? "GET" });
    throw new TypeError("kw-qa: blocked outbound");
  };
  wrapped[MARK] = true;
  globalThis.fetch = wrapped;
}

installFetchWrap();

export default function kwQaHelper(pi) {
  installFetchWrap();
  const extLog = () => process.env.KW_QA_EXT_LOG;

  pi.on("input", (event) => {
    appendLine(extLog(), { t: Date.now(), type: "input", inputId: event.inputId, text: event.text, source: event.source });
    if (event.text === "kw-qa-ext-input") {
      setTimeout(() => {
        try {
          pi.sendUserMessage("kw qa extension input");
        } catch (err) {
          appendLine(extLog(), { t: Date.now(), type: "sendUserMessage_error", message: String(err?.message ?? err) });
        }
      }, 0);
      return { action: "handled" };
    }
    return { action: "continue" };
  });

  pi.on("input_disposition", (event) => {
    appendLine(extLog(), { t: Date.now(), type: "input_disposition", inputId: event.inputId, disposition: event.disposition });
  });
}
