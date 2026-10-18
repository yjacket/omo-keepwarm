// Trace-free warm pings for the subscription lanes, until senpi ships its own (senpi#2454).
//
// claude-sdk-fork: the session's Claude Code session (id from senpi's binding sidecar) is resumed with
//   forkSession + persistSession:false, so the ping reads the cached prefix but writes no transcript. The query
//   options are built by the running senpi's own anthropic-subscription modules (dist/core), so the system prompt,
//   tools, thinking and executable match the real turn and follow senpi updates.
// codex-sse: the last real request body is re-sent over SSE with store:false, no previous_response_id and one
//   extra user item, under the same prompt_cache_key. Nothing is stored server-side and no chain is extended.
//
// Measured 2026-10-16 (research note in docs/senpi-upstream-요구.md): fork pings read 98-100% and renewed the 1h
// cache; Codex pings every 15 min kept a cache that otherwise expired between 25 and 30 min.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export const PING_TEXT = "Keep-alive ping from omo-keepwarm. Reply with just: OK";
const TOKEN_MARGIN_MS = 5 * 60_000;
const SUB = "dist/core/extensions/builtin/anthropic-subscription";

// The senpi install this process runs: the CLI entry senpi was started with, else an explicit override.
export function findSenpiRoot({ argv = process.argv, env = process.env, exists = existsSync } = {}) {
  const candidates = [];
  if (env.OMO_KEEPWARM_SENPI_ROOT) candidates.push(env.OMO_KEEPWARM_SENPI_ROOT);
  for (const arg of argv.slice(1)) {
    const norm = String(arg).replace(/\\/g, "/");
    const at = norm.indexOf("/@code-yeongyu/senpi/");
    if (at !== -1) candidates.push(norm.slice(0, at + "/@code-yeongyu/senpi".length));
  }
  return candidates.find((root) => exists(join(root, SUB, "options.js"))) ?? null;
}

async function loadSenpiModules(root) {
  const load = (name) => import(pathToFileURL(join(root, SUB, name)).href);
  const [config, options, tools, customTools, executable, settings, boundary, bindingStore, authEnv] = await Promise.all([
    import(pathToFileURL(join(root, "dist", "config.js")).href),
    load("options.js"),
    load("tools.js"),
    load("custom-tools.js"),
    load("executable.js"),
    load("settings.js"),
    load("sdk-boundary.js"),
    load("session-binding-store.js"),
    load("auth-environment.js"),
  ]);
  return { config, options, tools, customTools, executable, settings, boundary, bindingStore, authEnv };
}

// The pi-ai Codex request module next to the running senpi (pi-ai's public index has no streamSimple). Looked up
// like Node's node_modules search: Bun's createRequire().resolve() does not return a path for it inside senpi.
export function findCodexApiFile(root, exists = existsSync) {
  const rel = join("@earendil-works", "pi-ai", "dist", "api", "openai-codex-responses.js");
  for (let dir = root; ; dir = dirname(dir)) {
    const nested = join(dir, "node_modules", rel);
    if (exists(nested)) return nested;
    // A global install keeps senpi and pi-ai side by side: <node_modules>/@code-yeongyu/senpi and <node_modules>/@earendil-works.
    if (dir.replace(/\\/g, "/").endsWith("/node_modules") && exists(join(dir, rel))) return join(dir, rel);
    if (dirname(dir) === dir) return null;
  }
}

async function loadCodexApi(root) {
  const file = findCodexApiFile(root);
  if (!file) throw unsupported("pi-ai Codex module not found next to senpi");
  return import(pathToFileURL(file).href);
}

function unsupported(message) {
  const e = new Error(message);
  e.kind = "unsupported";
  return e;
}

function authError(message) {
  const e = new Error(message);
  e.kind = "auth";
  return e;
}

// Token of the account the session is bound to. Never refreshed here: a refresh rotates the stored token
// under senpi's feet, so a token close to expiry skips the ping instead.
export function claudeAuthEnv({ settings, accountName, env, now, readAuth, stripManaged }) {
  const credential = readAuth()?.["anthropic-subscription"];
  const accounts = Array.isArray(credential?.accounts) ? credential.accounts : [];
  const lane = settings.tokenInjection ?? (accounts.length > 0 ? "oauth-slots" : "ambient");
  if (lane === "ambient") {
    const out = { ...env };
    for (const name of Object.keys(out)) if (name.startsWith("SENPI_")) delete out[name];
    return { lane, env: out };
  }
  if (lane !== "oauth-slots") throw unsupported(`auth lane ${lane} is not supported`);
  const account = accounts.find((a) => a?.name === accountName);
  if (!account?.access) throw authError(`no stored token for account ${accountName}`);
  if (!(Number(account.expires) > now() + TOKEN_MARGIN_MS)) throw authError("account token expires within 5 minutes");
  return { lane, env: { ...stripManaged(env), CLAUDE_CODE_OAUTH_TOKEN: account.access } };
}

function claudeUsage(u) {
  const n = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  return { input: n(u?.input_tokens), output: n(u?.output_tokens), cacheRead: n(u?.cache_read_input_tokens), cacheWrite: n(u?.cache_creation_input_tokens) };
}

export function createClaudeForkPinger({
  senpiRoot = findSenpiRoot(),
  load = loadSenpiModules,
  env = process.env,
  cwd = () => process.cwd(),
  now = Date.now,
  readAuth,
} = {}) {
  let modules = null;

  async function ping({ ctx, signal }) {
    if (!senpiRoot) throw unsupported("senpi install not found");
    modules ??= await load(senpiRoot);
    const m = modules;
    const sessionFile = ctx.sessionManager.getSessionFile?.();
    if (!sessionFile) throw unsupported("session has no file");
    const binding = await m.bindingStore.readStoredBinding(sessionFile);
    if (!binding) throw unsupported("no Claude SDK session binding");
    const prefix = await ctx.getPromptCachePrefixRequest?.({ signal });
    if (prefix?.status !== "ready") throw unsupported(`prompt prefix ${prefix?.reason ?? "unavailable"}`);
    const { model, context, options: streamOptions } = prefix.request;
    if (model.id !== binding.modelId) throw unsupported("model differs from the bound SDK session");

    await m.boundary.loadClaudeAgentSdk();
    const providerSettings = m.settings.loadAnthropicSubscriptionProviderSettingsFromDisk(cwd());
    const auth = claudeAuthEnv({
      settings: providerSettings,
      accountName: binding.accountName,
      env,
      now,
      readAuth: readAuth ?? (() => JSON.parse(readFileSync(join(m.config.getAgentDir(), "auth.json"), "utf8"))),
      stripManaged: m.authEnv.stripManagedAuthEnvironment,
    });
    const resolved = m.tools.resolveSdkTools(context);
    const mcpServers = await m.customTools.buildCustomToolServers(resolved.customTools);
    const executable = m.executable.resolveClaudeCodeRun(m.executable.defaultExecutableDeps()).executable;
    const queryOptions = m.options.buildAnthropicSubscriptionQueryOptions({
      model,
      context,
      streamOptions,
      providerSettings,
      authLane: auth.lane,
      tools: resolved.sdkTools,
      pathToClaudeCodeExecutable: executable,
    });
    if (mcpServers) queryOptions.mcpServers = mcpServers;
    // Same shape as senpi's resident session (session-registry getOrCreate), plus the fork that keeps it trace-free.
    const options = {
      ...queryOptions,
      env: { ...auth.env, ...queryOptions.env },
      extraArgs: { ...queryOptions.extraArgs, "replay-user-messages": "" },
      resume: binding.sdkSessionId,
      forkSession: true,
      persistSession: false,
      maxTurns: 1,
    };
    const query = m.boundary.getSdkBoundary().query({ prompt: PING_TEXT, options });
    const onAbort = () => query.close?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    let result = null;
    try {
      for await (const message of query) if (message?.type === "result") result = message;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      query.close?.();
    }
    if (!result) throw new Error("SDK query ended without a result");
    if (result.is_error) throw new Error(`SDK result error: ${String(result.result ?? result.subtype ?? "unknown").slice(0, 200)}`);
    return claudeUsage(result.usage);
  }

  return { available: () => senpiRoot !== null, ping };
}

// ---- Codex ----------------------------------------------------------------

// The last real request body with one user item added; nothing stored, no response chain.
export function codexPingBody(payload) {
  const { previous_response_id: _drop, ...rest } = payload;
  const input = Array.isArray(rest.input) ? rest.input : [];
  return {
    ...rest,
    store: false,
    input: [...input, { role: "user", content: [{ type: "input_text", text: PING_TEXT }] }],
  };
}

export function createCodexPinger({ senpiRoot = findSenpiRoot(), load = loadCodexApi } = {}) {
  let api = null;

  function available() {
    return senpiRoot !== null;
  }

  async function ping({ ctx, model, payload, signal, timeoutMs }) {
    if (!senpiRoot) throw unsupported("senpi install not found");
    api ??= await load(senpiRoot);
    if (!payload || typeof payload !== "object" || typeof payload.prompt_cache_key !== "string") {
      throw unsupported("no captured Codex request");
    }
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth?.ok) throw authError(String(auth?.error ?? "auth unavailable"));
    const body = codexPingBody(payload);
    const stream = api.streamSimple(model, { systemPrompt: "", messages: [] }, {
      apiKey: auth.apiKey,
      headers: auth.headers,
      sessionId: payload.prompt_cache_key,
      transport: "sse",
      onPayload: () => body,
      signal,
      timeoutMs,
    });
    let final = null;
    for await (const ev of stream) {
      if (ev?.type === "done") final = ev.message;
      if (ev?.type === "error") final = ev.error;
    }
    if (!final) throw new Error("Codex stream ended without a message");
    if (final.stopReason === "error" || final.stopReason === "aborted") {
      const e = new Error(String(final.errorMessage ?? final.stopReason));
      if (final.stopReason === "aborted") e.name = "AbortError";
      throw e;
    }
    return final.usage ?? {};
  }

  return { available, ping };
}
