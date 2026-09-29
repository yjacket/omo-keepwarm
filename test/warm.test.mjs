import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createWarmer,
  prefixDigest,
  captureRealPrefix,
  prefixMatches,
  PrefixMismatchError,
} from "../src/warm.mjs";
import { createFakePiAi, createFakeCtx, createFakePi, createFakeClock, models } from "./helpers/fake-host.mjs";

const convertToLlm = (msgs) => msgs.map((m) => ({ llm: true, role: m.role, content: m.content }));
const msgs = [
  { role: "user", content: "hi" },
  { role: "assistant", content: "hello" },
];

function setup({ piAi = createFakePiAi(), ctxOpts = {}, clock = createFakeClock() } = {}) {
  const pi = createFakePi();
  pi.tools.all = [
    { name: "read", description: "Read", parameters: { type: "object" }, execute() {} },
    { name: "bash", description: "Bash", parameters: { type: "object" }, execute() {} },
    { name: "hidden", description: "Hidden", parameters: {} },
  ];
  pi.tools.active = ["read", "bash"];
  const ctx = createFakeCtx(ctxOpts);
  const warmer = createWarmer({ piAi, convertToLlm, now: clock.now });
  return { pi, ctx, piAi, warmer, clock };
}

// Mirrors pi-ai warmPromptCache ordering: build params, await onPayload, then the network step.
function networkPiAi({ payload, usage = { input: 10, output: 0, cacheRead: 50_000, cacheWrite: 0 } } = {}) {
  const base = createFakePiAi();
  const network = [];
  return {
    ...base,
    network,
    async warmPromptCache(model, context, options) {
      let params = payload ?? { system: context.systemPrompt, tools: context.tools ?? [], messages: context.messages };
      const transformed = await options.onPayload?.(params, model, { model, headers: options.headers });
      if (transformed !== undefined) params = transformed;
      network.push({ ...params, max_tokens: 0 });
      return { supported: true, usage };
    },
  };
}

function errWith(message, extra = {}) {
  return Object.assign(new Error(message), extra);
}

// ---- request construction ---------------------------------------------

test("request construction mirrors builtin keepalive ping()", async () => {
  const { pi, ctx, piAi, warmer } = setup({ ctxOpts: { model: models.anthropic1h, sessionId: "s-42", systemPrompt: "SYS" } });
  const extra = { role: "user", content: "prepared" };
  ctx.prepareProviderRequest = async (m) => {
    ctx.prepareCalls.push(m);
    return {
      messages: [...m, extra],
      transformHeaders: async (h) => ({ ...h, "x-prepared": "1" }),
      transformPayload: async (p) => p,
    };
  };
  ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "k-1", headers: { "x-auth": "a" } });
  const ac = new AbortController();
  const res = await warmer.ping({ pi, ctx, model: models.anthropic1h, lastMessages: msgs, signal: ac.signal });
  assert.equal(res.ok, true);
  assert.equal(piAi.calls.length, 1);
  const { model, context, options } = piAi.calls[0];
  assert.equal(model, models.anthropic1h);
  assert.deepEqual(ctx.prepareCalls, [msgs]);
  assert.equal(context.systemPrompt, "SYS");
  assert.deepEqual(context.messages, convertToLlm([...msgs, extra]));
  assert.deepEqual(context.tools, [
    { name: "read", description: "Read", parameters: { type: "object" } },
    { name: "bash", description: "Bash", parameters: { type: "object" } },
  ]);
  assert.equal(options.apiKey, "k-1");
  assert.deepEqual(options.headers, { "x-auth": "a", "x-prepared": "1" });
  assert.equal(options.sessionId, "s-42");
  assert.equal(options.cacheRetention, "long");
  assert.equal(options.timeoutMs, 30000);
  assert.equal(options.signal, ac.signal);
  assert.equal(typeof options.onPayload, "function");
});

test("no active tools omits the tools key; missing prepareProviderRequest uses lastMessages and auth headers", async () => {
  const { pi, ctx, piAi, warmer } = setup();
  pi.tools.active = [];
  ctx.prepareProviderRequest = undefined;
  ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "k", headers: { h: "1" } });
  const res = await warmer.ping({ pi, ctx, model: models.anthropic5m, lastMessages: msgs });
  assert.equal(res.ok, true);
  const { context, options } = piAi.calls[0];
  assert.equal("tools" in context, false);
  assert.deepEqual(context.messages, convertToLlm(msgs));
  assert.deepEqual(options.headers, { h: "1" });
  assert.equal(options.cacheRetention, undefined);
});

// ---- onPayload / prefix guard ------------------------------------------

test("onPayload applies transformPayload before the network step", async () => {
  const piAi = networkPiAi();
  const { pi, ctx, warmer } = setup({ piAi });
  ctx.prepareProviderRequest = async (m) => ({
    messages: m,
    transformHeaders: async (h) => h,
    transformPayload: async (p) => ({ ...p, metadata: { user_id: "u" } }),
  });
  const res = await warmer.ping({ pi, ctx, model: models.anthropic5m, lastMessages: msgs });
  assert.equal(res.ok, true);
  assert.equal(piAi.network.length, 1);
  assert.deepEqual(piAi.network[0].metadata, { user_id: "u" });
});

test("expectPrefix equal to the real prefix passes; network step runs", async () => {
  const piAi = networkPiAi();
  const { pi, ctx, warmer } = setup({ piAi, ctxOpts: { systemPrompt: "SYS" } });
  // The real request had the same system/tools and the same message prefix.
  const real = { system: "SYS", tools: [], messages: convertToLlm(msgs.slice(0, 1)) };
  pi.tools.active = [];
  const res = await warmer.ping({ pi, ctx, model: models.anthropic5m, lastMessages: msgs, expectPrefix: captureRealPrefix(real) });
  assert.equal(res.ok, true);
  assert.equal(piAi.network.length, 1);
});

test("expectPrefix mismatch throws PrefixMismatchError in onPayload and the network step never runs", async () => {
  const piAi = networkPiAi();
  const { pi, ctx, warmer } = setup({ piAi, ctxOpts: { systemPrompt: "SYS" } });
  pi.tools.active = [];
  const real = { system: "OTHER SYSTEM", tools: [], messages: convertToLlm(msgs) };
  const res = await warmer.ping({ pi, ctx, model: models.anthropic5m, lastMessages: msgs, expectPrefix: captureRealPrefix(real) });
  assert.equal(res.ok, false);
  assert.equal(res.error.kind, "prefix_mismatch");
  assert.equal(piAi.network.length, 0);
});

test("guard compares the transformed payload", async () => {
  const piAi = networkPiAi();
  const { pi, ctx, warmer } = setup({ piAi, ctxOpts: { systemPrompt: "SYS" } });
  pi.tools.active = [];
  ctx.prepareProviderRequest = async (m) => ({
    messages: m,
    transformHeaders: async (h) => h,
    transformPayload: async (p) => ({ ...p, system: "SYS+billing" }),
  });
  const real = { system: "SYS+billing", tools: [], messages: convertToLlm(msgs) };
  const res = await warmer.ping({ pi, ctx, model: models.anthropic5m, lastMessages: msgs, expectPrefix: captureRealPrefix(real) });
  assert.equal(res.ok, true);
  assert.equal(piAi.network.length, 1);
});

// ---- error classification ----------------------------------------------

const errorCases = [
  ["429 status", errWith("Too Many Requests", { status: 429 }), "rate_limit", 429],
  ["rate limit text", errWith("rate_limit_error: slow down"), "rate_limit", null],
  ["overloaded text", errWith("Overloaded", { status: 529 }), "rate_limit", 529],
  ["timeout", errWith("Request timed out.", { name: "APIConnectionTimeoutError" }), "timeout", null],
  ["aborted", errWith("Request was aborted.", { name: "APIUserAbortError" }), "aborted", null],
  ["401", errWith("invalid x-api-key", { status: 401 }), "auth", 401],
  ["403", errWith("forbidden", { status: 403 }), "auth", 403],
  ["500", errWith("internal server error", { status: 500 }), "provider_error", 500],
];

for (const [label, error, kind, status] of errorCases) {
  test(`error classification: ${label} -> ${kind}`, async () => {
    const { pi, ctx, warmer } = setup({ piAi: createFakePiAi({ error }) });
    const res = await warmer.ping({ pi, ctx, model: models.anthropic5m, lastMessages: msgs });
    assert.equal(res.ok, false);
    assert.equal(res.error.kind, kind);
    assert.equal(res.error.status, status);
    assert.equal(typeof res.error.message, "string");
  });
}

test("error classification: aborted signal wins over the error text", async () => {
  const ac = new AbortController();
  ac.abort();
  const { pi, ctx, warmer } = setup({ piAi: createFakePiAi({ error: errWith("socket closed") }) });
  const res = await warmer.ping({ pi, ctx, model: models.anthropic5m, lastMessages: msgs, signal: ac.signal });
  assert.equal(res.error.kind, "aborted");
});

test("error classification: auth not ok -> auth, no warm call", async () => {
  const { pi, ctx, piAi, warmer } = setup();
  ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: false, error: "no credentials" });
  const res = await warmer.ping({ pi, ctx, model: models.anthropic5m, lastMessages: msgs });
  assert.equal(res.ok, false);
  assert.equal(res.error.kind, "auth");
  assert.equal(res.error.message, "no credentials");
  assert.equal(piAi.calls.length, 0);
});

test("error classification: PrefixMismatchError -> prefix_mismatch", async () => {
  const { pi, ctx, warmer } = setup({ piAi: createFakePiAi({ error: new PrefixMismatchError() }) });
  const res = await warmer.ping({ pi, ctx, model: models.anthropic5m, lastMessages: msgs });
  assert.equal(res.error.kind, "prefix_mismatch");
});

test("supported:false -> unsupported", async () => {
  const { pi, ctx, warmer } = setup({ piAi: createFakePiAi({ supported: false }) });
  const res = await warmer.ping({ pi, ctx, model: models.claudeSdkOauth, lastMessages: msgs });
  assert.deepEqual(res.ok, false);
  assert.equal(res.error.kind, "unsupported");
});

test("unavailable warmer returns unsupported without touching the host", async () => {
  const pi = createFakePi();
  const ctx = createFakeCtx();
  const warmer = createWarmer({ piAi: {}, convertToLlm });
  const res = await warmer.ping({ pi, ctx, model: models.anthropic5m, lastMessages: msgs });
  assert.equal(res.error.kind, "unsupported");
  assert.equal(ctx.prepareCalls.length, 0);
});

// ---- hit, cost ----------------------------------------------------------

test("hit: cacheRead >= half of input+cacheRead+cacheWrite", async () => {
  const cases = [
    [{ input: 10, output: 0, cacheRead: 50_000, cacheWrite: 0 }, true],
    [{ input: 0, output: 0, cacheRead: 500, cacheWrite: 500 }, true],
    [{ input: 0, output: 0, cacheRead: 499, cacheWrite: 501 }, false],
    [{ input: 10, output: 0, cacheRead: 0, cacheWrite: 50_000 }, false],
    [{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, false],
  ];
  for (const [usage, hit] of cases) {
    const { pi, ctx, warmer } = setup({ piAi: createFakePiAi({ usage }) });
    const res = await warmer.ping({ pi, ctx, model: models.anthropic5m, lastMessages: msgs });
    assert.equal(res.ok, true);
    assert.equal(res.hit, hit, JSON.stringify(usage));
    assert.deepEqual(res.usage, usage);
  }
});

test("cost uses cacheRead, cacheWrite, input and output rates; durationMs from injected clock", async () => {
  const clock = createFakeClock(1000);
  const usage = { input: 100, output: 2, cacheRead: 40_000, cacheWrite: 1_000 };
  const piAi = createFakePiAi({ usage });
  const inner = piAi.warmPromptCache;
  piAi.warmPromptCache = async (...args) => {
    const r = await inner(...args);
    await clock.advance(1234);
    return r;
  };
  const { pi, ctx, warmer } = setup({ piAi, clock });
  const res = await warmer.ping({ pi, ctx, model: models.anthropic5m, lastMessages: msgs });
  // anthropic5m cost: input 3, output 15, cacheRead 0.3, cacheWrite 3.75 (USD/M)
  const expected = (40_000 * 0.3 + 1_000 * 3.75 + 100 * 3 + 2 * 15) / 1e6;
  assert.ok(Math.abs(res.costUsd - expected) < 1e-12);
  assert.equal(res.durationMs, 1234);
});

test("projectedCostUsd = promptTokens * cacheRead / 1e6 (expected cost of a hit)", () => {
  const warmer = createWarmer({ piAi: createFakePiAi(), convertToLlm });
  assert.ok(Math.abs(warmer.projectedCostUsd(models.anthropic5m, 100_000) - 0.03) < 1e-12);
  assert.ok(Math.abs(warmer.projectedCostUsd(models.openaiCodex, 100_000) - 0.0125) < 1e-12);
  assert.equal(warmer.projectedCostUsd(models.githubCopilot, 100_000), 0);
});

// ---- builtinActive, available ------------------------------------------

test("builtinActive requires enabled setting, anthropic-messages api and first-party base URL", () => {
  const warmer = createWarmer({ piAi: createFakePiAi(), convertToLlm });
  const on = createFakeCtx({ keepAlive: { enabled: true } });
  const off = createFakeCtx({ keepAlive: { enabled: false } });
  assert.equal(warmer.builtinActive(on, models.anthropic5m), true);
  assert.equal(warmer.builtinActive(off, models.anthropic5m), false);
  assert.equal(warmer.builtinActive(on, models.claudeSdkOauth), false);
  assert.equal(warmer.builtinActive(on, models.kiroLb), false);
  const noSettings = createFakeCtx();
  noSettings.getPromptCacheKeepAliveSettings = undefined;
  assert.equal(warmer.builtinActive(noSettings, models.anthropic5m), false);
});

test("available() requires warmPromptCache and convertToLlm functions", () => {
  assert.equal(createWarmer({ piAi: createFakePiAi(), convertToLlm }).available(), true);
  assert.equal(createWarmer({ piAi: createFakePiAi() }).available(), false);
  assert.equal(createWarmer({ piAi: {}, convertToLlm }).available(), false);
  assert.equal(createWarmer({ convertToLlm }).available(), false);
});

// ---- prefixDigest / captureRealPrefix ----------------------------------

const payloadA = {
  model: "claude-sonnet-4-5",
  system: [{ type: "text", text: "SYS", cache_control: { type: "ephemeral" } }],
  tools: [{ name: "read", input_schema: { type: "object" } }],
  messages: [
    { role: "user", content: [{ type: "text", text: "one" }] },
    { role: "assistant", content: [{ type: "text", text: "two", cache_control: { type: "ephemeral" } }] },
  ],
};

test("prefixDigest ignores cache_control differences", () => {
  const noCc = structuredClone(payloadA);
  delete noCc.system[0].cache_control;
  delete noCc.messages[1].content[0].cache_control;
  noCc.tools[0].cache_control = { type: "ephemeral", ttl: "1h" };
  assert.deepEqual(prefixDigest(noCc), prefixDigest(payloadA));
  assert.equal(prefixMatches(captureRealPrefix(payloadA), prefixDigest(noCc)), true);
});

test("appending messages keeps the prefix; cache_control moving to the new tail is ignored", () => {
  const longer = structuredClone(payloadA);
  delete longer.messages[1].content[0].cache_control;
  longer.messages.push({ role: "user", content: [{ type: "text", text: "three", cache_control: { type: "ephemeral" } }] });
  const real = captureRealPrefix(payloadA);
  const now = prefixDigest(longer);
  assert.equal(now.messages.length, 3);
  assert.equal(prefixMatches(real, now), true);
  // The reverse (fewer messages than expected) is not a prefix.
  assert.equal(prefixMatches(now, real), false);
});

test("system change, tools change or edited message is a mismatch", () => {
  const real = captureRealPrefix(payloadA);
  const sys = structuredClone(payloadA);
  sys.system[0].text = "SYS changed";
  assert.equal(prefixMatches(real, prefixDigest(sys)), false);
  const tools = structuredClone(payloadA);
  tools.tools.push({ name: "bash", input_schema: {} });
  assert.equal(prefixMatches(real, prefixDigest(tools)), false);
  const edited = structuredClone(payloadA);
  edited.messages[0].content[0].text = "uno";
  assert.equal(prefixMatches(real, prefixDigest(edited)), false);
});

test("prefixDigest is total on odd payloads", () => {
  assert.deepEqual(prefixDigest(undefined).messages, []);
  assert.equal(typeof prefixDigest({}).head, "string");
  assert.equal(prefixMatches(undefined, prefixDigest({})), false);
});

// ---- host safety ---------------------------------------------------------

test("ping never calls forbidden pi APIs", async () => {
  const { pi, ctx, warmer } = setup();
  await warmer.ping({ pi, ctx, model: models.anthropic5m, lastMessages: msgs });
  const bad = setup({ piAi: createFakePiAi({ error: errWith("boom", { status: 500 }) }) });
  await bad.warmer.ping({ pi: bad.pi, ctx: bad.ctx, model: models.anthropic5m, lastMessages: msgs });
  assert.deepEqual(pi.forbiddenCalls, []);
  assert.deepEqual(bad.pi.forbiddenCalls, []);
  assert.deepEqual(ctx.uiCalls, []);
});
