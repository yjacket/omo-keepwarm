// Lane classification table: which cache economics a model runs under.
import { GUARD_MS, MIN_CONTEXT_TOKENS } from "./policy.mjs";

export const GRIDS = {
  "5m": [0, 10, 15, 20, 30, 45, 60, 90, 120],
  "30m": [0, 30, 60, 90, 120, 180, 240, 360],
  "1h": [0, 60, 120, 180, 240, 300, 360, 480, 720],
};

export function gridClassForTtl(ttlSec) {
  if (ttlSec <= 600) return "5m";
  if (ttlSec <= 2400) return "30m";
  return "1h";
}

const DEFAULT_R = 0.08;

function costRatio(model, denominatorMultiplier = 1) {
  const cost = model?.cost;
  const r = cost ? cost.cacheRead / (cost.cacheWrite * denominatorMultiplier) : NaN;
  return Number.isFinite(r) && r !== 0 ? r : DEFAULT_R;
}

function base(id, ttlSec, intervalSec, r, policy, warmPath, warmPathReason, economics, verified = false) {
  return { id, ttlSec, intervalSec, r, policy, warmPath, warmPathReason, verified, economics };
}

function classify(model, piAi) {
  if (model?.api === "claude-sdk-oauth") {
    return base(
      "claude-subscription", 3600, 3300, 0.025, "decide", "claude-sdk-fork",
      "forked SDK resume without persistence; measured 2026-10-16: reads 98-100% and renews the 1h cache, transcript untouched",
      "token", true,
    );
  }
  if (model?.api === "openai-codex-responses") {
    // pi-ai reports 1800 s for extended-cache models, but the subscription backend rejects prompt_cache_options and
    // keeps the cache best-effort: measured 2026-10-16 it survived 25 min and was gone at 30. Other models: 300 s.
    const extended = (piAi?.resolvePromptCacheTtlSeconds?.(model) ?? 1800) === 1800;
    return extended
      ? base(
        "codex-subscription", 1500, 900, 0.08, "decide", "codex-sse",
        "store:false re-send under the same prompt_cache_key; measured 2026-10-16: 15-minute pings kept the cache past 45 min",
        "token", true,
      )
      : base(
        "codex-subscription", 300, 270, 0.08, "decide", "codex-sse",
        "store:false re-send under the same prompt_cache_key; 5-minute cache unmeasured", "token",
      );
  }
  if (model?.provider === "github-copilot") {
    return base("github-copilot", 300, 270, null, "observe", "none", "request-billed", "request");
  }
  if (model?.api === "devin-agent") {
    return base("devin", 300, 270, null, "observe", "none", "no warm primitive; cache-write fields always 0", "unknown");
  }
  if (model?.api === "anthropic-messages" && piAi?.isAnthropicApiBaseUrl?.(model.baseUrl)) {
    const ttl = piAi.resolvePromptCacheTtlSeconds?.(model) ?? 300;
    return base(
      "anthropic-api", ttl, ttl === 3600 ? 3300 : 270, costRatio(model, ttl === 3600 ? 1.6 : 1),
      "decide", "warmPromptCache", "5-minute read renewal unmeasured; no local usage", "token",
    );
  }
  if (piAi?.isOpenAIResponsesPromptCacheModel?.(model)) {
    const ttl = piAi.resolvePromptCacheTtlSeconds?.(model) ?? 1800;
    return base(
      "openai-api", ttl, Math.round(ttl * 0.9), costRatio(model),
      "decide", "warmPromptCache", "read renewal unmeasured; no local usage", "token",
    );
  }
  const ttl = piAi?.resolvePromptCacheTtlSeconds?.(model) ?? 300;
  return base("other", ttl, 270, null, "observe", "none", "unknown lane or non-first-party host", "unknown");
}

const isPositive = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;

function validGrid(g) {
  if (!Array.isArray(g) || g.length === 0 || g[0] !== 0) return false;
  for (let i = 0; i < g.length; i++) {
    if (typeof g[i] !== "number" || !Number.isFinite(g[i])) return false;
    if (i > 0 && !(g[i] > g[i - 1])) return false;
  }
  return true;
}

export function classifyLane(model, { piAi, overrides } = {}) {
  const lane = classify(model, piAi);
  const o = overrides?.[lane.id];
  let grid;
  let minContextTokens = MIN_CONTEXT_TOKENS;
  if (o && typeof o === "object") {
    if (isPositive(o.ttlSeconds)) lane.ttlSec = o.ttlSeconds;
    if (isPositive(o.intervalSeconds)) lane.intervalSec = o.intervalSeconds;
    if (typeof o.r === "number" && Number.isFinite(o.r)) lane.r = o.r;
    if (isPositive(o.minContextTokens)) minContextTokens = o.minContextTokens;
    if (typeof o.verified === "boolean") lane.verified = o.verified;
    if (validGrid(o.grid)) grid = [...o.grid];
  }
  lane.gridClass = gridClassForTtl(lane.ttlSec);
  lane.grid = grid ?? [...GRIDS[lane.gridClass]];
  lane.minContextTokens = minContextTokens;
  const rBad = lane.policy === "decide" && !(lane.r > 0 && lane.r < 1);
  if (lane.ttlSec - lane.intervalSec <= GUARD_MS / 1000 || rBad) lane.policy = "invalid";
  const { id, ttlSec, intervalSec, r, gridClass, policy, warmPath, warmPathReason, verified, economics } = lane;
  return { id, ttlSec, intervalSec, r, gridClass, grid: lane.grid, policy, warmPath, warmPathReason, verified, economics, minContextTokens };
}
