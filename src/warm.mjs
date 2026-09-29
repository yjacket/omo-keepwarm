// Warm adapter: one prompt-cache refresh through the host's pi-ai warmPromptCache,
// built in the same order as senpi's builtin cache-keepalive ping(), with a prefix
// guard in onPayload that stops the request before the network when the prompt
// prefix would not match the one the real session last sent.
// piAi and convertToLlm are injected; this module never imports host packages.
import { createHash } from "node:crypto";
import { MISS_READ_SHARE, PING_TIMEOUT_MS } from "./policy.mjs";

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

export function captureRealPrefix(payload) {
  return prefixDigest(payload);
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
  else if (signal?.aborted || name === "AbortError" || name === "APIUserAbortError" || /\baborted\b/i.test(message)) kind = "aborted";
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

export function createWarmer({ piAi, convertToLlm, now = Date.now } = {}) {
  function available() {
    return typeof piAi?.warmPromptCache === "function" && typeof convertToLlm === "function";
  }

  function builtinActive(ctx, model) {
    return (
      ctx?.getPromptCacheKeepAliveSettings?.()?.enabled === true &&
      model?.api === "anthropic-messages" &&
      piAi?.isAnthropicApiBaseUrl?.(model.baseUrl) === true
    );
  }

  // Expected cost of one warm ping: the whole prefix read from cache. A miss (full rewrite) is bounded to
  // once per episode because the first cache miss stops warming (IS-6, IS-7).
  function projectedCostUsd(model, promptTokens) {
    const c = model?.cost ?? {};
    return (tokens(promptTokens) * (Number(c.cacheRead) || 0)) / 1e6;
  }

  async function ping({ pi, ctx, model, lastMessages = [], expectPrefix, signal } = {}) {
    const started = now();
    if (!available()) {
      return { ok: false, error: { kind: "unsupported", message: "warmPromptCache or convertToLlm unavailable", status: null } };
    }
    try {
      const preparation = await ctx.prepareProviderRequest?.(lastMessages);
      const activeToolNames = new Set(pi.getActiveTools());
      const tools = pi
        .getAllTools()
        .filter((tool) => activeToolNames.has(tool.name))
        .map(({ name, description, parameters }) => ({ name, description, parameters }));
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
        const effective = transformed ?? payload;
        if (expectPrefix && !prefixMatches(expectPrefix, prefixDigest(effective))) throw new PrefixMismatchError();
        return transformed;
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
