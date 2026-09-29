import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---- clock -------------------------------------------------------------

export function createFakeClock(startMs = 1_700_000_000_000) {
  let t = startMs;
  let seq = 0;
  const timers = new Map();

  const add = (fn, ms, every) => {
    const id = ++seq;
    const delay = Math.max(0, Number(ms) || 0);
    const handle = { id, unref() { return handle; }, ref() { return handle; }, hasRef: () => false };
    timers.set(id, { id, at: t + delay, fn, every: every ? Math.max(1, delay) : 0, handle });
    return handle;
  };
  const del = (h) => {
    if (h && typeof h === "object") timers.delete(h.id);
  };

  async function flush() {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }

  function nextDue(limit) {
    let best;
    for (const tm of timers.values()) {
      if (tm.at <= limit && (!best || tm.at < best.at || (tm.at === best.at && tm.id < best.id))) best = tm;
    }
    return best;
  }

  async function runDue(limit) {
    for (;;) {
      const tm = nextDue(limit);
      if (!tm) return;
      if (tm.at > t) t = tm.at;
      if (tm.every) tm.at = t + tm.every;
      else timers.delete(tm.id);
      tm.fn();
      await flush();
    }
  }

  return {
    now: () => t,
    setTimeout: (fn, ms) => add(fn, ms, false),
    clearTimeout: del,
    setInterval: (fn, ms) => add(fn, ms, true),
    clearInterval: del,
    async advance(ms) {
      const target = t + ms;
      await runDue(target);
      t = target;
      await flush();
    },
    async jump(ms) {
      t += ms;
      await runDue(t);
    },
    flush,
    pendingCount: () => timers.size,
  };
}

// ---- pi ----------------------------------------------------------------

const FORBIDDEN = [
  "sendMessage",
  "sendUserMessage",
  "appendEntry",
  "exec",
  "setModel",
  "setThinkingLevel",
  "setActiveTools",
  "registerTool",
  "registerCommand",
];

export function createFakePi({ sessionKind = "interactive" } = {}) {
  const handlers = new Map();
  const registrations = [];
  const returns = [];
  const forbiddenCalls = [];
  const busHandlers = new Map();

  const pi = {
    sessionKind,
    registrations,
    returns,
    forbiddenCalls,
    on(name, h, opts) {
      registrations.push({ name, opts });
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(h);
    },
    async emit(name, ev, ctx) {
      const out = [];
      for (const h of handlers.get(name) ?? []) {
        const value = await h(ev, ctx);
        returns.push({ name, value });
        out.push(value);
      }
      return out;
    },
    handlerCount: (name) => (handlers.get(name) ?? []).length,
    events: {
      on(name, h) {
        if (!busHandlers.has(name)) busHandlers.set(name, []);
        busHandlers.get(name).push(h);
        return () => busHandlers.get(name).splice(busHandlers.get(name).indexOf(h) >>> 0, 1);
      },
      emit(name, data) {
        for (const h of busHandlers.get(name) ?? []) h(data);
      },
    },
    tools: { all: [], active: [] },
    getAllTools() {
      return pi.tools.all;
    },
    getActiveTools() {
      return pi.tools.active;
    },
  };
  for (const name of FORBIDDEN) {
    pi[name] = (...args) => {
      forbiddenCalls.push({ name, args });
    };
  }
  return pi;
}

// ---- models ------------------------------------------------------------

export const models = {
  claudeSdkOauth: {
    id: "claude-opus-4-7",
    provider: "claude-sdk",
    api: "claude-sdk-oauth",
    baseUrl: "https://api.anthropic.com",
    cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  },
  openaiCodex: {
    id: "gpt-5-codex",
    provider: "openai-codex",
    api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api",
    cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  },
  anthropic5m: {
    id: "claude-sonnet-4-5",
    provider: "anthropic",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
  anthropic1h: {
    id: "claude-sonnet-4-5",
    provider: "anthropic",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    cacheRetention: "long",
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
  githubCopilot: {
    id: "claude-sonnet-4-5",
    provider: "github-copilot",
    api: "anthropic-messages",
    baseUrl: "https://api.githubcopilot.com",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  kiroLb: {
    id: "claude-sonnet-4-5",
    provider: "kiro-lb",
    api: "anthropic-messages",
    baseUrl: "http://127.0.0.1:8100",
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
  devinAgent: {
    id: "devin-agent",
    provider: "devin",
    api: "devin-agent",
    baseUrl: "https://api.devin.ai",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  openaiResponses: {
    id: "gpt-5",
    provider: "openai",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    compat: { supportsExplicitPromptCacheMode: true },
    cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  },
};

// ---- ctx ---------------------------------------------------------------

export function createFakeCtx(opts = {}) {
  const s = {
    sessionId: opts.sessionId ?? "sess-1",
    model: opts.model ?? models.anthropic5m,
    idle: opts.idle ?? true,
    pending: opts.pending ?? false,
    compacting: opts.compacting ?? false,
    systemPrompt: opts.systemPrompt ?? "system prompt",
    messages: opts.messages ?? [],
    mode: opts.mode ?? "interactive",
    keepAlive: opts.keepAlive ?? { enabled: false },
    contextTokens: opts.contextTokens ?? 50_000,
    sessionFile: opts.sessionFile ?? null,
  };
  const uiCalls = [];
  const prepareCalls = [];
  const ui = new Proxy(
    {},
    {
      get: (_t, name) => (...args) => {
        uiCalls.push({ name: String(name), args });
      },
    },
  );
  return {
    uiCalls,
    prepareCalls,
    state: s,
    ui,
    get model() {
      return s.model;
    },
    get mode() {
      return s.mode;
    },
    get sessionId() {
      return s.sessionId;
    },
    setModel: (m) => void (s.model = m),
    setIdle: (v) => void (s.idle = v),
    setPending: (v) => void (s.pending = v),
    setCompacting: (v) => void (s.compacting = v),
    setSystemPrompt: (v) => void (s.systemPrompt = v),
    setMessages: (v) => void (s.messages = v),
    setMode: (v) => void (s.mode = v),
    setKeepAlive: (v) => void (s.keepAlive = v),
    setContextTokens: (v) => void (s.contextTokens = v),
    isIdle: () => s.idle,
    hasPendingMessages: () => s.pending,
    isCompacting: () => s.compacting,
    getSystemPrompt: () => s.systemPrompt,
    getContextUsage: () => ({ tokens: s.contextTokens }),
    getPromptCacheKeepAliveSettings: () => s.keepAlive,
    async prepareProviderRequest(messages) {
      prepareCalls.push(messages);
      return {
        messages,
        transformHeaders: async (h) => h,
        transformPayload: async (p) => p,
      };
    },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {} }),
    },
    sessionManager: {
      getSessionId: () => s.sessionId,
      getSessionFile: () => s.sessionFile,
      buildSessionContext: () => ({ messages: s.messages }),
    },
  };
}

// ---- pi-ai -------------------------------------------------------------

export function createFakePiAi({ supported = true, usage, error, deferred = false, payload } = {}) {
  const calls = [];
  const pending = [];
  const defaultUsage = { input: 10, output: 1, cacheRead: 50_000, cacheWrite: 0 };

  return {
    calls,
    pending,
    warmPromptCache(model, context, options) {
      const call = { model, context, options };
      calls.push(call);
      const run = async () => {
        if (options?.onPayload) {
          await options.onPayload(
            payload ?? { system: context?.systemPrompt, tools: context?.tools ?? [], messages: context?.messages ?? [] },
            model,
          );
        }
      };
      if (deferred) {
        return new Promise((resolve, reject) => {
          pending.push({
            resolve: (v) => run().then(() => resolve(v ?? { supported, usage: usage ?? defaultUsage }), reject),
            reject,
          });
        });
      }
      return run().then(() => {
        if (error) throw error;
        return { supported, usage: usage ?? defaultUsage };
      });
    },
    isAnthropicApiBaseUrl: (url) => typeof url === "string" && /^https:\/\/api\.anthropic\.com/.test(url),
    isOpenAIResponsesPromptCacheModel: (m) =>
      m?.api === "openai-responses" && m?.compat?.supportsExplicitPromptCacheMode === true,
    resolvePromptCacheTtlSeconds: (m) => (m?.cacheRetention === "long" ? 3600 : undefined),
  };
}

// ---- tmp ---------------------------------------------------------------

// Every home made here is removed when the test file's process exits, so no test leaves a directory
// behind even when it never asks for cleanup. cleanupTmpHomes() removes them earlier on demand.
const madeHomes = [];
let sweepRegistered = false;

export function cleanupTmpHomes() {
  for (const dir of madeHomes.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}

export function tmpHome() {
  if (!sweepRegistered) {
    sweepRegistered = true;
    process.once("exit", cleanupTmpHomes);
  }
  const dir = mkdtempSync(join(tmpdir(), "omo-keepwarm-test-"));
  madeHomes.push(dir);
  return dir;
}
