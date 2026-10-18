// Warm adapter: one prompt-cache refresh through the host's pi-ai warmPromptCache,
// built in the same order as senpi's builtin cache-keepalive ping(), with a prefix
// guard in onPayload that stops the request before the network when the prompt
// prefix would not match the one the real session last sent.
// piAi and convertToLlm are injected; this module never imports host packages.
import { createHash } from "node:crypto";
import { MISS_READ_SHARE, PING_TIMEOUT_MS } from "./policy.mjs";
import { createClaudeForkPinger, createCodexPinger } from "./subscription-warm.mjs";

// Claude Code spawns a subprocess per ping, so its budget is wider than an HTTP request's.
const SUBSCRIPTION_PING_TIMEOUT_MS = 2 * PING_TIMEOUT_MS;

export class PrefixMismatchError extends Error {
  constructor(message = "warm payload prefix does not match the last real request") {
    super(message);
    this.name = "PrefixMismatchError";
  }
}

// ---- prefix digest ------------------------------------------------------

function stripCacheControl(value) {
  if (Array.isArray(value)) return value.map(stripCacheControl);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (key === "cache_control") continue;
      out[key] = stripCacheControl(value[key]);
    }
    return out;
  }
  return value;
}

const sha256 = (value) => createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex");

export function prefixDigest(payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  const head = sha256(stripCacheControl({ system: p.system ?? null, tools: p.tools ?? null }));
  const messages = Array.isArray(p.messages) ? p.messages.map((m) => sha256(stripCacheControl(m))) : [];
  return { head, messages };
}

// Besides the digest, keep what senpi's ToolInfo cannot tell us about the real request: the order the agent loop sent
// the tools in and which tools went out strict (pi-ai derives strict from tool.constrainedSampling, which ToolInfo omits).
export function captureRealPrefix(payload) {
  const tools = Array.isArray(payload?.tools) ? payload.tools : [];
  const prefix = {
    ...prefixDigest(payload),
    toolOrder: tools.map((t) => String(t?.name ?? "")),
    strictTools: tools.filter((t) => t?.strict === true).map((t) => String(t?.name ?? "")),
  };
  // The real request's tools verbatim: senpi's tool-search transform rewrites them after pi-ai builds them
  // (defer_loading, injected catalog tools), which no rebuild from ToolInfo reproduces. Memory only: the
  // property is non-enumerable so it never reaches the saved episode state; a restored prefix falls back to
  // the rebuild below.
  Object.defineProperty(prefix, "tools", { value: tools, enumerable: false });
  // The whole body too, for the Codex ping that re-sends it (same memory-only rule). The input array is copied so a
  // later transform of the live request cannot change what the ping sends.
  const body = Array.isArray(payload?.input) ? { ...payload, input: [...payload.input] } : payload;
  Object.defineProperty(prefix, "payload", { value: body, enumerable: false });
  return prefix;
}

const STRICT_SAMPLING = { type: "json_schema", strict: "prefer" };
// OAuth requests rename tools (pi-ai toClaudeCodeName), so names are matched case-insensitively.
const toolKey = (name) => String(name).toLowerCase();

// The warm request's tools, rebuilt so pi-ai converts them exactly like the last real request: the captured order
// (else the active order, which is what the agent loop sends) and constrainedSampling on the tools that went out strict.
function warmTools(pi, expectPrefix) {
  const infos = new Map(pi.getAllTools().map((t) => [toolKey(t.name), t]));
  const strict = new Set((expectPrefix?.strictTools ?? []).map(toolKey));
  const out = [];
  for (const name of expectPrefix?.toolOrder ?? pi.getActiveTools()) {
    const info = infos.get(toolKey(name));
    if (!info) continue;
    const { name: n, description, parameters } = info;
    out.push(strict.has(toolKey(n)) ? { name: n, description, parameters, constrainedSampling: STRICT_SAMPLING } : { name: n, description, parameters });
  }
  return out;
}

// True when system/tools match and the expected message list is a prefix of the actual one.
export function prefixMatches(expected, actual) {
  if (!expected || !actual || expected.head !== actual.head) return false;
  const exp = expected.messages ?? [];
  const act = actual.messages ?? [];
  if (exp.length > act.length) return false;
  for (let i = 0; i < exp.length; i++) if (exp[i] !== act[i]) return false;
  return true;
}

// ---- errors, usage, cost ------------------------------------------------

const RATE_RE = /rate.?limit|overloaded/i;

function statusOf(err) {
  const s = err?.status ?? err?.statusCode ?? err?.response?.status;
  return typeof s === "number" && Number.isFinite(s) ? s : null;
}

export function classifyError(err, { signal } = {}) {
  const message = String(err?.message ?? err ?? "unknown error").slice(0, 300);
  const status = statusOf(err);
  const name = String(err?.name ?? "");
  let kind;
  if (err instanceof PrefixMismatchError || name === "PrefixMismatchError") kind = "prefix_mismatch";
  else if (err?.kind === "unsupported") kind = "unsupported";
  else if (signal?.aborted || name === "AbortError" || name === "APIUserAbortError") kind = "aborted";
  else if (/timeout/i.test(name) || /timed? ?out/i.test(message)) kind = "timeout";
  else if (status === 429 || RATE_RE.test(message)) kind = "rate_limit";
  else if (status === 401 || status === 403 || err?.kind === "auth") kind = "auth";
  else kind = "provider_error";
  return { kind, message, status };
}

const tokens = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

function normalizeUsage(u) {
  return { input: tokens(u?.input), output: tokens(u?.output), cacheRead: tokens(u?.cacheRead), cacheWrite: tokens(u?.cacheWrite) };
}

export function isHit(usage) {
  const total = usage.input + usage.cacheRead + usage.cacheWrite;
  return total > 0 && usage.cacheRead >= MISS_READ_SHARE * total;
}

export function costUsd(model, usage) {
  const c = model?.cost ?? {};
  const rate = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return (
    (usage.cacheRead * rate(c.cacheRead) +
      usage.cacheWrite * rate(c.cacheWrite) +
      usage.input * rate(c.input) +
      usage.output * rate(c.output)) /
    1e6
  );
}

// ---- warmer -------------------------------------------------------------

export function createWarmer({
  piAi,
  convertToLlm,
  now = Date.now,
  claude = createClaudeForkPinger({ now }),
  codex = createCodexPinger(),
} = {}) {
  function available(warmPath = "warmPromptCache") {
    if (warmPath === "claude-sdk-fork") return claude.available();
    if (warmPath === "codex-sse") return codex.available();
    return typeof piAi?.warmPromptCache === "function" && typeof convertToLlm === "function";
  }

  // One trace-free subscription ping; the outcome has the same shape as the warmPromptCache path.
  async function subscriptionPing({ ctx, model, expectPrefix, signal, warmPath }) {
    const started = now();
    const timeout = AbortSignal.timeout(SUBSCRIPTION_PING_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const raw = warmPath === "claude-sdk-fork"
        ? await claude.ping({ ctx, signal: combined })
        : await codex.ping({ ctx, model, payload: expectPrefix?.payload, signal: combined, timeoutMs: PING_TIMEOUT_MS });
      const usage = normalizeUsage(raw);
      return { ok: true, hit: isHit(usage), usage, costUsd: costUsd(model, usage), durationMs: now() - started };
    } catch (err) {
      if (timeout.aborted && !signal?.aborted) return { ok: false, error: { kind: "timeout", message: String(err?.message ?? err).slice(0, 300), status: null } };
      return { ok: false, error: classifyError(err, { signal }) };
    }
  }

  function builtinActive(ctx, model) {
    return (
      ctx?.getPromptCacheKeepAliveSettings?.()?.enabled === true &&
      model?.api === "anthropic-messages" &&
      piAi?.isAnthropicApiBaseUrl?.(model.baseUrl) === true
    );
  }

  // Expected cost of one warm ping: the whole prefix read from cache. A miss (full rewrite) stops the
  // segment, and every ping is pre-checked against the caps with this cost, so the overshoot past a
  // cap stays at most one rewrite (IS-6, IS-7).
  function projectedCostUsd(model, promptTokens) {
    const c = model?.cost ?? {};
    return (tokens(promptTokens) * (Number(c.cacheRead) || 0)) / 1e6;
  }

  async function ping({ pi, ctx, model, lastMessages = [], expectPrefix, signal, warmPath = "warmPromptCache" } = {}) {
    if (warmPath === "claude-sdk-fork" || warmPath === "codex-sse") {
      return subscriptionPing({ ctx, model, expectPrefix, signal, warmPath });
    }
    const started = now();
    if (!available()) {
      return { ok: false, error: { kind: "unsupported", message: "warmPromptCache or convertToLlm unavailable", status: null } };
    }
    try {
      const preparation = await ctx.prepareProviderRequest?.(lastMessages);
      const tools = warmTools(pi, expectPrefix);
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth?.ok) {
        const e = new Error(String(auth?.error ?? "auth unavailable"));
        e.kind = "auth";
        throw e;
      }
      const authHeaders = auth.headers ?? {};
      const headers = preparation ? await preparation.transformHeaders(authHeaders) : authHeaders;
      const onPayload = async (payload) => {
        const transformed = preparation ? await preparation.transformPayload(payload) : undefined;
        let effective = transformed ?? payload;
        if (Array.isArray(expectPrefix?.tools)) effective = { ...effective, tools: expectPrefix.tools };
        if (expectPrefix && !prefixMatches(expectPrefix, prefixDigest(effective))) throw new PrefixMismatchError();
        return effective === payload ? undefined : effective;
      };
      const result = await piAi.warmPromptCache(
        model,
        {
          systemPrompt: ctx.getSystemPrompt(),
          messages: convertToLlm(preparation?.messages ?? lastMessages),
          ...(tools.length ? { tools } : {}),
        },
        {
          apiKey: auth.apiKey,
          headers,
          sessionId: ctx.sessionManager.getSessionId(),
          cacheRetention: model.cacheRetention,
          onPayload,
          signal,
          timeoutMs: PING_TIMEOUT_MS,
        },
      );
      if (!result?.supported) {
        return { ok: false, error: { kind: "unsupported", message: "warmPromptCache returned supported:false", status: null } };
      }
      const usage = normalizeUsage(result.usage);
      return { ok: true, hit: isHit(usage), usage, costUsd: costUsd(model, usage), durationMs: now() - started };
    } catch (err) {
      return { ok: false, error: classifyError(err, { signal }) };
    }
  }

  return { available, builtinActive, projectedCostUsd, ping };
}
