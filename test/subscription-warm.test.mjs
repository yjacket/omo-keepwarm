import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PING_TEXT,
  claudeAuthEnv,
  codexPingBody,
  createClaudeForkPinger,
  createCodexPinger,
  findCodexApiFile,
  findSenpiRoot,
} from "../src/subscription-warm.mjs";
import { createWarmer } from "../src/warm.mjs";

const NOW = 1_800_000_000_000;
const ROOT = "C:/bun/node_modules/@code-yeongyu/senpi";

test("findSenpiRoot takes the senpi package the CLI was started from, or the override", () => {
  const exists = (p) => p.replace(/\\/g, "/").startsWith(ROOT);
  assert.equal(findSenpiRoot({ argv: ["bun", `${ROOT}/dist/bundle/cli.js`, "--resume"], env: {}, exists }), ROOT);
  assert.equal(findSenpiRoot({ argv: ["bun", "C:\\bun\\node_modules\\@code-yeongyu\\senpi\\dist\\bundle\\cli.js"], env: {}, exists }), ROOT);
  assert.equal(findSenpiRoot({ argv: ["node", "test.mjs"], env: { OMO_KEEPWARM_SENPI_ROOT: ROOT }, exists }), ROOT);
  assert.equal(findSenpiRoot({ argv: ["node", "test.mjs"], env: {}, exists }), null);
  assert.equal(findSenpiRoot({ argv: ["bun", `${ROOT}/dist/bundle/cli.js`], env: {}, exists: () => false }), null);
});

test("findCodexApiFile finds pi-ai nested under senpi or beside it in a global node_modules", () => {
  const rel = "@earendil-works/pi-ai/dist/api/openai-codex-responses.js";
  const norm = (p) => p.replace(/\\/g, "/");
  const beside = new Set([`C:/bun/node_modules/${rel}`]);
  assert.equal(norm(findCodexApiFile(ROOT, (p) => beside.has(norm(p)))), `C:/bun/node_modules/${rel}`);
  const nested = new Set([`${ROOT}/node_modules/${rel}`, `C:/bun/node_modules/${rel}`]);
  assert.equal(norm(findCodexApiFile(ROOT, (p) => nested.has(norm(p)))), `${ROOT}/node_modules/${rel}`);
  assert.equal(findCodexApiFile(ROOT, () => false), null);
});

test("codexPingBody stores nothing, drops the response chain and appends one user item", () => {
  const payload = { model: "m", store: true, previous_response_id: "resp_1", prompt_cache_key: "k", input: [{ role: "user", content: "u" }] };
  const body = codexPingBody(payload);
  assert.equal(body.store, false);
  assert.equal("previous_response_id" in body, false);
  assert.equal(body.prompt_cache_key, "k");
  assert.deepEqual(body.input, [{ role: "user", content: "u" }, { role: "user", content: [{ type: "input_text", text: PING_TEXT }] }]);
  assert.equal(payload.input.length, 1, "the captured body is not mutated");
  assert.equal(payload.previous_response_id, "resp_1");
});

const stripManaged = (env) => {
  const out = { ...env };
  delete out.CLAUDE_CODE_OAUTH_TOKEN;
  for (const k of Object.keys(out)) if (k.startsWith("SENPI_")) delete out[k];
  return out;
};
const accounts = (expires) => () => ({ "anthropic-subscription": { accounts: [{ name: "default", access: "tok", expires }] } });

test("claudeAuthEnv injects the bound account token on the oauth-slots lane", () => {
  const out = claudeAuthEnv({
    settings: {}, accountName: "default", env: { PATH: "p", CLAUDE_CODE_OAUTH_TOKEN: "old", SENPI_X: "1" },
    now: () => NOW, readAuth: accounts(NOW + 60 * 60_000), stripManaged,
  });
  assert.equal(out.lane, "oauth-slots");
  assert.deepEqual(out.env, { PATH: "p", CLAUDE_CODE_OAUTH_TOKEN: "tok" });
});

test("claudeAuthEnv never refreshes: a token within 5 minutes of expiry skips the ping", () => {
  assert.throws(
    () => claudeAuthEnv({ settings: {}, accountName: "default", env: {}, now: () => NOW, readAuth: accounts(NOW + 4 * 60_000), stripManaged }),
    (e) => e.kind === "auth",
  );
  assert.throws(
    () => claudeAuthEnv({ settings: {}, accountName: "other", env: {}, now: () => NOW, readAuth: accounts(NOW + 60 * 60_000), stripManaged }),
    (e) => e.kind === "auth",
  );
});

test("claudeAuthEnv: ambient keeps the host login, config-dir is not supported", () => {
  const ambient = claudeAuthEnv({ settings: {}, accountName: "x", env: { A: "1", SENPI_Y: "2" }, now: () => NOW, readAuth: () => ({}), stripManaged });
  assert.deepEqual(ambient, { lane: "ambient", env: { A: "1" } });
  assert.throws(
    () => claudeAuthEnv({ settings: { tokenInjection: "config-dir" }, accountName: "default", env: {}, now: () => NOW, readAuth: accounts(NOW + 3_600_000), stripManaged }),
    (e) => e.kind === "unsupported",
  );
});

// Fake of the running senpi's anthropic-subscription modules, recording the query it is asked to run.
function fakeSenpi({ binding = { sdkSessionId: "sdk-1", accountName: "default", modelId: "claude-opus-5-5" }, result } = {}) {
  const queries = [];
  const modules = {
    config: { getAgentDir: () => "unused" },
    bindingStore: { readStoredBinding: async (file) => (file === "/s/session.jsonl" ? binding : undefined) },
    boundary: {
      loadClaudeAgentSdk: async () => {},
      getSdkBoundary: () => ({
        query: (input) => {
          queries.push(input);
          const messages = [{ type: "system", subtype: "init" }, result ?? { type: "result", is_error: false, usage: { input_tokens: 4, output_tokens: 2, cache_read_input_tokens: 23_000, cache_creation_input_tokens: 10 } }];
          return {
            close: () => {},
            async *[Symbol.asyncIterator]() {
              yield* messages;
            },
          };
        },
      }),
    },
    settings: { loadAnthropicSubscriptionProviderSettingsFromDisk: () => ({}) },
    authEnv: { stripManagedAuthEnvironment: stripManaged },
    tools: { resolveSdkTools: () => ({ sdkTools: ["Read"], customTools: [{ name: "todo" }] }) },
    customTools: { buildCustomToolServers: async (tools) => (tools.length ? { "custom-tools": { type: "sdk" } } : undefined) },
    executable: { defaultExecutableDeps: () => ({}), resolveClaudeCodeRun: () => ({ executable: "claude.exe" }) },
    options: {
      buildAnthropicSubscriptionQueryOptions: (input) => ({
        model: input.model.id, tools: input.tools, pathToClaudeCodeExecutable: input.pathToClaudeCodeExecutable,
        env: { CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "off" }, extraArgs: { "strict-mcp-config": null }, authLane: input.authLane,
      }),
    },
  };
  return { queries, load: async () => modules };
}

function claudeCtx({ status = "ready", modelId = "claude-opus-5-5", file = "/s/session.jsonl" } = {}) {
  return {
    sessionManager: { getSessionFile: () => file },
    getPromptCachePrefixRequest: async () => (status === "ready"
      ? { status, request: { model: { id: modelId }, context: { systemPrompt: "s", tools: [], messages: [] }, options: { reasoning: "medium" } } }
      : { status, reason: "preview handler not preview-safe" }),
  };
}

test("claude fork ping resumes the bound SDK session as a non-persisted fork with the session's own options", async () => {
  const senpi = fakeSenpi();
  const pinger = createClaudeForkPinger({ senpiRoot: ROOT, load: senpi.load, env: { PATH: "p" }, now: () => NOW, readAuth: accounts(NOW + 3_600_000) });
  const usage = await pinger.ping({ ctx: claudeCtx() });
  assert.deepEqual(usage, { input: 4, output: 2, cacheRead: 23_000, cacheWrite: 10 });
  assert.equal(senpi.queries.length, 1);
  const { prompt, options } = senpi.queries[0];
  assert.equal(prompt, PING_TEXT);
  assert.equal(options.resume, "sdk-1");
  assert.equal(options.forkSession, true);
  assert.equal(options.persistSession, false);
  assert.equal(options.maxTurns, 1);
  assert.equal(options.model, "claude-opus-5-5");
  assert.equal(options.authLane, "oauth-slots");
  assert.deepEqual(options.mcpServers, { "custom-tools": { type: "sdk" } });
  assert.deepEqual(options.extraArgs, { "strict-mcp-config": null, "replay-user-messages": "" });
  assert.deepEqual(options.env, { PATH: "p", CLAUDE_CODE_OAUTH_TOKEN: "tok", CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "off" });
});

test("claude fork ping refuses without a binding, a ready prefix, or the bound model", async () => {
  const make = (senpi) => createClaudeForkPinger({ senpiRoot: ROOT, load: senpi.load, env: {}, now: () => NOW, readAuth: accounts(NOW + 3_600_000) });
  const unsupported = (e) => e.kind === "unsupported";
  await assert.rejects(make(fakeSenpi({ binding: null })).ping({ ctx: claudeCtx() }), unsupported);
  await assert.rejects(make(fakeSenpi()).ping({ ctx: claudeCtx({ status: "skipped" }) }), unsupported);
  await assert.rejects(make(fakeSenpi()).ping({ ctx: claudeCtx({ modelId: "claude-sonnet-5" }) }), unsupported);
  await assert.rejects(make(fakeSenpi()).ping({ ctx: claudeCtx({ file: null }) }), unsupported);
  await assert.rejects(
    createClaudeForkPinger({ senpiRoot: null }).ping({ ctx: claudeCtx() }),
    unsupported,
  );
});

test("claude fork ping turns an SDK error result into a thrown error", async () => {
  const senpi = fakeSenpi({ result: { type: "result", is_error: true, result: "rate limited" } });
  const pinger = createClaudeForkPinger({ senpiRoot: ROOT, load: senpi.load, env: {}, now: () => NOW, readAuth: accounts(NOW + 3_600_000) });
  await assert.rejects(pinger.ping({ ctx: claudeCtx() }), /rate limited/);
});

function fakeCodexApi(final) {
  const calls = [];
  return {
    calls,
    load: async () => ({
      streamSimple(model, context, options) {
        calls.push({ model, context, options, body: options.onPayload({ placeholder: true }, model) });
        return (async function* () {
          yield { type: "start" };
          yield final.stopReason === "error" ? { type: "error", error: final } : { type: "done", message: final };
        })();
      },
    }),
  };
}

const codexCtx = { modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "codex-key", headers: { h: "1" } }) } };

test("codex ping sends the rebuilt body over SSE under the captured prompt_cache_key", async () => {
  const api = fakeCodexApi({ stopReason: "stop", usage: { input: 240, output: 5, cacheRead: 11_776, cacheWrite: 0 } });
  const pinger = createCodexPinger({ senpiRoot: ROOT, load: api.load });
  const payload = { model: "gpt-5.6-sol", prompt_cache_key: "k1", previous_response_id: "r", input: [{ role: "user", content: "u" }] };
  const usage = await pinger.ping({ ctx: codexCtx, model: { id: "gpt-5.6-sol" }, payload, timeoutMs: 30_000 });
  assert.deepEqual(usage, { input: 240, output: 5, cacheRead: 11_776, cacheWrite: 0 });
  const [call] = api.calls;
  assert.equal(call.options.transport, "sse");
  assert.equal(call.options.sessionId, "k1");
  assert.equal(call.options.apiKey, "codex-key");
  assert.deepEqual(call.options.headers, { h: "1" });
  assert.deepEqual(call.body, codexPingBody(payload));
});

test("codex ping refuses without a captured request and throws on a provider error", async () => {
  const ok = createCodexPinger({ senpiRoot: ROOT, load: fakeCodexApi({ stopReason: "stop", usage: {} }).load });
  await assert.rejects(ok.ping({ ctx: codexCtx, model: {}, payload: null }), (e) => e.kind === "unsupported");
  await assert.rejects(ok.ping({ ctx: codexCtx, model: {}, payload: { input: [] } }), (e) => e.kind === "unsupported");
  const failing = createCodexPinger({ senpiRoot: ROOT, load: fakeCodexApi({ stopReason: "error", errorMessage: "429 rate limit" }).load });
  await assert.rejects(failing.ping({ ctx: codexCtx, model: {}, payload: { prompt_cache_key: "k", input: [] } }), /rate limit/);
});

test("warmer routes subscription paths to their pingers and classifies the outcome", async () => {
  const hit = { available: () => true, ping: async () => ({ input: 10, output: 2, cacheRead: 9_000, cacheWrite: 0 }) };
  const miss = { available: () => true, ping: async () => ({ input: 10, output: 2, cacheRead: 100, cacheWrite: 9_000 }) };
  const refuse = { available: () => true, ping: async () => { throw Object.assign(new Error("no binding"), { kind: "unsupported" }); } };
  const model = { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const run = (claude, codex, warmPath) => createWarmer({ now: () => NOW, claude, codex }).ping({ ctx: {}, model, warmPath, expectPrefix: { payload: {} } });
  assert.deepEqual((await run(hit, miss, "claude-sdk-fork")).hit, true);
  assert.deepEqual((await run(hit, miss, "codex-sse")).hit, false);
  assert.deepEqual((await run(refuse, hit, "claude-sdk-fork")).error.kind, "unsupported");
  const w = createWarmer({ claude: { available: () => false }, codex: { available: () => true } });
  assert.equal(w.available("claude-sdk-fork"), false);
  assert.equal(w.available("codex-sse"), true);
  assert.equal(w.available("warmPromptCache"), false);
});
