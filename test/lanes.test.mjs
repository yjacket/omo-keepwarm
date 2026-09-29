import { test } from "node:test";
import assert from "node:assert/strict";

import { GRIDS, gridClassForTtl, classifyLane } from "../src/lanes.mjs";

// Tiny fake of the pi-ai helpers the classifier consults.
const piAi = {
  isAnthropicApiBaseUrl(url) {
    try {
      return new URL(url).hostname === "api.anthropic.com";
    } catch {
      return false;
    }
  },
  isOpenAIResponsesPromptCacheModel(model) {
    return model?.api === "openai-responses" && model?.provider === "openai";
  },
  resolvePromptCacheTtlSeconds(model) {
    return model?.ttlHint;
  },
};

const M = {
  claudeSub: { provider: "anthropic", api: "claude-sdk-oauth", id: "claude-opus-4", baseUrl: "https://api.anthropic.com" },
  codexSub: { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.6", baseUrl: "https://chatgpt.com/backend-api" },
  copilot: { provider: "github-copilot", api: "openai-completions", id: "gpt-4.1", baseUrl: "https://api.githubcopilot.com" },
  devin: { provider: "devin", api: "devin-agent", id: "devin", baseUrl: "https://api.devin.ai" },
  anthropic5m: {
    provider: "anthropic", api: "anthropic-messages", id: "claude-sonnet", baseUrl: "https://api.anthropic.com/v1",
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
  anthropic1h: {
    provider: "anthropic", api: "anthropic-messages", id: "claude-sonnet", baseUrl: "https://api.anthropic.com/v1",
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, ttlHint: 3600,
  },
  openai: {
    provider: "openai", api: "openai-responses", id: "gpt-5", baseUrl: "https://api.openai.com/v1",
    cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  },
  other: { provider: "acme", api: "openai-completions", id: "mystery", baseUrl: "https://llm.acme.example/v1" },
};

const claudeSubWhy =
  "claude-sdk-oauth runs through the Claude Agent SDK; pi-ai warmPromptCache returns supported:false and an SDK query would append to the SDK session";

test("GRIDS and gridClassForTtl", () => {
  assert.deepEqual(GRIDS["5m"], [0, 10, 15, 20, 30, 45, 60, 90, 120]);
  assert.deepEqual(GRIDS["30m"], [0, 30, 60, 90, 120, 180, 240, 360]);
  assert.deepEqual(GRIDS["1h"], [0, 60, 120, 180, 240, 300, 360, 480, 720]);
  assert.equal(gridClassForTtl(300), "5m");
  assert.equal(gridClassForTtl(600), "5m");
  assert.equal(gridClassForTtl(601), "30m");
  assert.equal(gridClassForTtl(2400), "30m");
  assert.equal(gridClassForTtl(2401), "1h");
  assert.equal(gridClassForTtl(3600), "1h");
});

test("claude-subscription", () => {
  assert.deepEqual(classifyLane(M.claudeSub, { piAi }), {
    id: "claude-subscription", ttlSec: 3600, intervalSec: 3300, r: 0.025, gridClass: "1h", grid: GRIDS["1h"],
    policy: "decide", warmPath: "none", warmPathReason: claudeSubWhy, verified: false, economics: "token",
    minContextTokens: 20000,
  });
});

test("codex-subscription", () => {
  assert.deepEqual(classifyLane(M.codexSub, { piAi }), {
    id: "codex-subscription", ttlSec: 1800, intervalSec: 1620, r: 0.08, gridClass: "30m", grid: GRIDS["30m"],
    policy: "decide", warmPath: "none", warmPathReason: "no prompt-cache warmer is registered for openai-codex-responses",
    verified: false, economics: "token", minContextTokens: 20000,
  });
});

test("codex-subscription follows the pi-ai TTL when the model has no extended cache", () => {
  const lane = classifyLane({ ...M.codexSub, ttlHint: 300 }, { piAi });
  assert.equal(lane.ttlSec, 300);
  assert.equal(lane.intervalSec, 270);
  assert.equal(lane.gridClass, "5m");
  assert.deepEqual(lane.grid, GRIDS["5m"]);
  assert.equal(lane.policy, "decide");
});

test("github-copilot", () => {
  assert.deepEqual(classifyLane(M.copilot, { piAi }), {
    id: "github-copilot", ttlSec: 300, intervalSec: 270, r: null, gridClass: "5m", grid: GRIDS["5m"],
    policy: "observe", warmPath: "none", warmPathReason: "request-billed", verified: false, economics: "request",
    minContextTokens: 20000,
  });
});

test("devin", () => {
  assert.deepEqual(classifyLane(M.devin, { piAi }), {
    id: "devin", ttlSec: 300, intervalSec: 270, r: null, gridClass: "5m", grid: GRIDS["5m"],
    policy: "observe", warmPath: "none", warmPathReason: "no warm primitive; cache-write fields always 0",
    verified: false, economics: "unknown", minContextTokens: 20000,
  });
});

test("anthropic-api 5-minute", () => {
  const lane = classifyLane(M.anthropic5m, { piAi });
  assert.equal(lane.id, "anthropic-api");
  assert.equal(lane.ttlSec, 300);
  assert.equal(lane.intervalSec, 270);
  assert.equal(lane.r, 0.3 / 3.75);
  assert.equal(lane.gridClass, "5m");
  assert.deepEqual(lane.grid, GRIDS["5m"]);
  assert.equal(lane.policy, "decide");
  assert.equal(lane.warmPath, "warmPromptCache");
  assert.equal(lane.warmPathReason, "5-minute read renewal unmeasured; no local usage");
  assert.equal(lane.verified, false);
  assert.equal(lane.economics, "token");
  assert.equal(lane.minContextTokens, 20000);
});

test("anthropic-api 1-hour uses the x1.6 write price", () => {
  const lane = classifyLane(M.anthropic1h, { piAi });
  assert.equal(lane.id, "anthropic-api");
  assert.equal(lane.ttlSec, 3600);
  assert.equal(lane.intervalSec, 3300);
  assert.equal(lane.r, 0.3 / (3.75 * 1.6));
  assert.equal(lane.gridClass, "1h");
  assert.deepEqual(lane.grid, GRIDS["1h"]);
  assert.equal(lane.policy, "decide");
});

test("anthropic-api falls back to r 0.08 on zero or non-finite ratio", () => {
  for (const cost of [undefined, { cacheRead: 0, cacheWrite: 3.75 }, { cacheRead: 0.3, cacheWrite: 0 }, { cacheRead: NaN, cacheWrite: 3 }]) {
    const lane = classifyLane({ ...M.anthropic5m, cost }, { piAi });
    assert.equal(lane.r, 0.08);
    assert.equal(lane.policy, "decide");
  }
});

test("anthropic-messages on a non-first-party host is other", () => {
  const lane = classifyLane({ ...M.anthropic5m, baseUrl: "https://proxy.example.com/v1" }, { piAi });
  assert.equal(lane.id, "other");
  assert.equal(lane.policy, "observe");
});

test("openai-api", () => {
  const lane = classifyLane(M.openai, { piAi });
  assert.equal(lane.id, "openai-api");
  assert.equal(lane.ttlSec, 1800);
  assert.equal(lane.intervalSec, 1620);
  assert.equal(lane.r, 0.08);
  assert.equal(lane.gridClass, "30m");
  assert.equal(lane.policy, "decide");
  assert.equal(lane.warmPath, "warmPromptCache");
  assert.equal(lane.economics, "token");
  assert.equal(lane.verified, false);

  const priced = classifyLane({ ...M.openai, cost: { cacheRead: 0.125, cacheWrite: 1.25 }, ttlHint: 3600 }, { piAi });
  assert.equal(priced.r, 0.1);
  assert.equal(priced.ttlSec, 3600);
  assert.equal(priced.intervalSec, 3240);
  assert.equal(priced.gridClass, "1h");
});

test("other", () => {
  assert.deepEqual(classifyLane(M.other, { piAi }), {
    id: "other", ttlSec: 300, intervalSec: 270, r: null, gridClass: "5m", grid: GRIDS["5m"],
    policy: "observe", warmPath: "none", warmPathReason: "unknown lane or non-first-party host",
    verified: false, economics: "unknown", minContextTokens: 20000,
  });
  assert.equal(classifyLane({ ...M.other, ttlHint: 1800 }, { piAi }).ttlSec, 1800);
});

test("missing piAi: anthropic and openai models fall to other", () => {
  assert.equal(classifyLane(M.anthropic5m, {}).id, "other");
  assert.equal(classifyLane(M.openai, { piAi: undefined }).id, "other");
  assert.equal(classifyLane(M.openai).id, "other");
  assert.equal(classifyLane(M.claudeSub, {}).id, "claude-subscription");
  assert.equal(classifyLane(M.copilot).id, "github-copilot");
});

test("classification order: subscription api wins over copilot provider", () => {
  assert.equal(classifyLane({ ...M.claudeSub, provider: "github-copilot" }, { piAi }).id, "claude-subscription");
  assert.equal(classifyLane({ ...M.devin, provider: "github-copilot" }, { piAi }).id, "github-copilot");
});

test("overrides apply valid fields", () => {
  const overrides = {
    "claude-subscription": {
      ttlSeconds: 3600, intervalSeconds: 3000, r: 0.05, minContextTokens: 50000, verified: true,
      grid: [0, 45, 90, 180],
    },
  };
  const lane = classifyLane(M.claudeSub, { piAi, overrides });
  assert.equal(lane.intervalSec, 3000);
  assert.equal(lane.r, 0.05);
  assert.equal(lane.minContextTokens, 50000);
  assert.equal(lane.verified, true);
  assert.deepEqual(lane.grid, [0, 45, 90, 180]);
  assert.equal(lane.policy, "decide");
});

test("overrides: malformed values are ignored", () => {
  const overrides = {
    "claude-subscription": {
      ttlSeconds: "3600", intervalSeconds: -5, r: "0.5", minContextTokens: 0, verified: "yes",
      grid: [5, 10, 20],
    },
  };
  const lane = classifyLane(M.claudeSub, { piAi, overrides });
  assert.deepEqual(lane, classifyLane(M.claudeSub, { piAi }));
});

test("overrides: grid validation", () => {
  const bad = [
    [], [0], [0, 10, 10], [0, 30, 20], [0, "10"], [0, NaN], [0, Infinity], [10, 20], "0,10", null, { 0: 0 },
  ];
  // [0] is a valid grid (only the zero step); everything else here is malformed.
  for (const grid of bad) {
    const lane = classifyLane(M.claudeSub, { piAi, overrides: { "claude-subscription": { grid } } });
    if (Array.isArray(grid) && grid.length === 1 && grid[0] === 0) {
      assert.deepEqual(lane.grid, [0]);
    } else {
      assert.deepEqual(lane.grid, GRIDS["1h"], `grid ${JSON.stringify(grid)} should be ignored`);
    }
  }
  const ok = classifyLane(M.claudeSub, { piAi, overrides: { "claude-subscription": { grid: [0, 15, 30] } } });
  assert.deepEqual(ok.grid, [0, 15, 30]);
});

test("overrides only touch the matching lane id and never mutate GRIDS", () => {
  const overrides = { "codex-subscription": { r: 0.2, grid: [0, 5] } };
  assert.equal(classifyLane(M.claudeSub, { piAi, overrides }).r, 0.025);
  const codex = classifyLane(M.codexSub, { piAi, overrides });
  assert.equal(codex.r, 0.2);
  codex.grid.push(999);
  assert.deepEqual(GRIDS["30m"], [0, 30, 60, 90, 120, 180, 240, 360]);
  const plain = classifyLane(M.claudeSub, { piAi });
  plain.grid.push(999);
  assert.deepEqual(GRIDS["1h"], [0, 60, 120, 180, 240, 300, 360, 480, 720]);
});

test("overrides ttl recomputes the grid class", () => {
  const lane = classifyLane(M.claudeSub, { piAi, overrides: { "claude-subscription": { ttlSeconds: 1800, intervalSeconds: 1620 } } });
  assert.equal(lane.gridClass, "30m");
  assert.deepEqual(lane.grid, GRIDS["30m"]);
});

test("invalid lane: interval too close to ttl", () => {
  const at = (intervalSeconds) =>
    classifyLane(M.claudeSub, { piAi, overrides: { "claude-subscription": { intervalSeconds } } }).policy;
  assert.equal(at(3595), "invalid"); // ttl - interval == 5s
  assert.equal(at(3600), "invalid");
  assert.equal(at(4000), "invalid");
  assert.equal(at(3594), "decide");
});

test("invalid lane: r outside (0,1) on a decide lane", () => {
  const at = (r) => classifyLane(M.claudeSub, { piAi, overrides: { "claude-subscription": { r } } }).policy;
  assert.equal(at(0), "invalid");
  assert.equal(at(1), "invalid");
  assert.equal(at(1.5), "invalid");
  assert.equal(at(-0.1), "invalid");
  assert.equal(at(0.5), "decide");
  // observe lanes keep r null and stay observe
  assert.equal(classifyLane(M.copilot, { piAi }).policy, "observe");
  // priced anthropic model whose read price exceeds write price gives r >= 1
  const lane = classifyLane({ ...M.anthropic5m, cost: { cacheRead: 5, cacheWrite: 3.75 } }, { piAi });
  assert.equal(lane.policy, "invalid");
});
