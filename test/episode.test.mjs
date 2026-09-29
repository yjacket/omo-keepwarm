import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createController, wireController, EVENT_METHODS, CHILD_WORK_SOURCES } from "../src/episode.mjs";
import { createConfigSource, updateConfig } from "../src/config.mjs";
import { createRecorder } from "../src/records.mjs";
import { createStatus } from "../src/status.mjs";
import { createLedger } from "../src/ledger.mjs";
import { createWarmer } from "../src/warm.mjs";
import { atomicWriteJson, readJsonLines, readJsonSafe } from "../src/fsx.mjs";
import { layout } from "../src/paths.mjs";
import { PING_TIMEOUT_MS } from "../src/policy.mjs";
import { createFakeClock, createFakeCtx, createFakePi, createFakePiAi, models, tmpHome } from "./helpers/fake-host.mjs";

const SEC = 1000;
const MIN = 60 * SEC;
const START = new Date(2026, 5, 15, 9, 0, 0).getTime();
// Schedule tests raise the caps so the worst-case virtual cost never interferes.
const BASE_CONFIG = { v: 1, mode: "shadow", maxUsdPerEpisode: 100, maxUsdPerDay: 1000 };
const ON_VERIFIED = { mode: "on", lanes: { "anthropic-api": { verified: true } } };
const USAGE_50K = { input: 1000, output: 200, cacheRead: 49_000, cacheWrite: 0 };
const identity = (messages) => messages;

// ---- harness ------------------------------------------------------------

const live = [];

afterEach(() => {
  const harnesses = live.splice(0);
  for (const h of harnesses) {
    assert.deepEqual(h.pi.forbiddenCalls, [], "forbidden pi API calls");
    assert.deepEqual(h.ctx.uiCalls, [], "ctx.ui calls");
    if (h.wired) {
      const bas = h.pi.registrations.filter((r) => r.name === "before_agent_start");
      assert.equal(bas.length, 1);
      assert.deepEqual(bas[0].opts, { previewSafe: true });
    }
    for (const r of h.pi.returns) assert.equal(r.value, undefined, `${r.name} handler returned a value`);
  }
  for (const home of new Set(harnesses.map((h) => h.home))) rmSync(home, { recursive: true, force: true });
});

function setup(o = {}) {
  const home = o.home ?? tmpHome();
  const clock = o.clock ?? createFakeClock(START);
  const L = layout(home);
  if (!o.home && o.config !== null) atomicWriteJson(L.config, { ...BASE_CONFIG, ...(o.config ?? {}) });
  const pi = createFakePi({ sessionKind: o.sessionKind ?? "interactive" });
  const ctx = createFakeCtx({ model: o.model ?? models.anthropic5m, ...(o.ctxOpts ?? {}) });
  const piAi = o.piAi ?? createFakePiAi(o.piAiOpts ?? {});
  const now = o.now ?? clock.now;
  const realConfig = createConfigSource({ home, now, statEveryMs: 0 });
  const config = o.wrapConfig ? o.wrapConfig(realConfig) : realConfig;
  const ledger = createLedger({ home, now });
  const warmer = createWarmer({ piAi, convertToLlm: identity, now });
  const controller = createController({
    pi,
    deps: {
      now,
      setTimeout: clock.setTimeout,
      clearTimeout: o.clearTimeout ?? clock.clearTimeout,
      config,
      recorder: (id) => createRecorder({ home, sessionId: id, now }),
      status: (id) => createStatus({ home, sessionId: id, now }),
      ledger,
      warmer,
      piAi,
      home,
      version: "0.1.0+test",
    },
  });
  const wired = wireController(pi, controller);
  let n = 0;

  const h = {
    home, clock, L, pi, ctx, piAi, controller, ledger, wired,
    at: (min) => START + min * MIN,
    snap: () => controller.snapshot(),
    emit: (name, ev = {}) => pi.emit(name, { type: name, ...ev }, ctx),
    bus: (name, data) => pi.events.emit(name, data),
    async to(min) {
      const target = START + min * MIN;
      assert.ok(target >= clock.now(), "harness never moves the clock backwards");
      await clock.advance(target - clock.now());
    },
    // Drains microtasks so an in-flight warm ping (several awaits deep) completes.
    async drain() {
      for (let i = 0; i < 10; i++) await clock.flush();
    },
    payload: () => ({ system: ctx.getSystemPrompt(), tools: [], messages: [...ctx.state.messages] }),
    push(message) {
      ctx.setMessages([...ctx.state.messages, message]);
      return message;
    },
    start: (reason = "startup") => h.emit("session_start", { reason }),
    shutdown: (reason = "quit") => h.emit("session_shutdown", { reason }),
    settle: () => h.emit("agent_settled"),
    beforeAgentStart: (trigger = "prompt", extra = {}) =>
      h.emit("before_agent_start", { prompt: "", trigger, systemPrompt: ctx.getSystemPrompt(), ...extra }),
    // One agent run: agent_start, first message (custom or user), provider request, assistant reply, agent_end.
    async runTurn({ custom, request = true, payload, usage = USAGE_50K, stopReason = "stop", aborted, trigger } = {}) {
      n += 1;
      if (trigger) await h.beforeAgentStart(trigger);
      await h.emit("agent_start");
      const first = h.push(
        custom
          ? { role: "custom", customType: custom, content: `c${n}`, display: false, timestamp: clock.now() }
          : { role: "user", content: `u${n}`, timestamp: clock.now() },
      );
      await h.emit("message_start", { message: first });
      await h.emit("message_end", { message: first });
      if (request) {
        const p = typeof payload === "function" ? payload(h.payload()) : payload ?? h.payload();
        await h.emit("before_provider_request", { payload: p });
      }
      const reply = h.push({ role: "assistant", content: `a${n}`, stopReason, usage, model: ctx.model.id, timestamp: clock.now() });
      await h.emit("message_start", { message: reply });
      await h.emit("message_end", { message: reply });
      await h.emit("agent_end", { messages: [first, reply], ...(aborted ? { aborted: true } : {}) });
    },
    async autoTurn(customType, opts = {}) {
      await h.runTurn({ custom: customType, trigger: "extension", ...opts });
    },
    // Host order for a prompt: input -> before_agent_start -> input_disposition(started).
    async input(source = "interactive", disposition = "started") {
      n += 1;
      const inputId = `sess-1:${n}`;
      await h.emit("input", { inputId, text: "hello", source });
      if (disposition === "started") await h.beforeAgentStart("prompt", { prompt: "hello" });
      await h.emit("input_disposition", { inputId, disposition });
      return inputId;
    },
    async humanTurn({ source = "interactive", settle = true, ...turn } = {}) {
      await h.input(source, "started");
      await h.runTurn(turn);
      if (settle) await h.settle();
    },
    async openEpisode(turn = {}) {
      await h.start();
      await h.humanTurn(turn);
    },
    records(type, episode) {
      const dir = L.recordsDir;
      if (!existsSync(dir)) return [];
      const out = [];
      for (const month of readdirSync(dir).sort()) {
        for (const f of readdirSync(join(dir, month)).sort()) out.push(...readJsonLines(join(dir, month, f)));
      }
      return out.filter((r) => (!type || r.type === type) && (episode === undefined || r.episode === episode));
    },
    ticks: (episode) => h.records("decision", episode).map((d) => [d.action, d.tAwayMin]),
    stops: () => h.records("warm_stop").map((r) => r.reason),
  };
  live.push(h);
  return h;
}

// pi-ai warmPromptCache order: build params, await onPayload, then the network step.
function networkPiAi(usage = { input: 10, output: 0, cacheRead: 50_000, cacheWrite: 0 }) {
  const base = createFakePiAi();
  const network = [];
  return {
    ...base,
    network,
    async warmPromptCache(model, context, options) {
      base.calls.push({ model, context, options });
      const params = { system: context.systemPrompt, tools: context.tools ?? [], messages: context.messages };
      const transformed = await options.onPayload?.(params, model);
      network.push({ ...(transformed ?? params), max_tokens: 0 });
      return { supported: true, usage };
    },
  };
}

const withHabit = (habit) => (real) => ({
  get: () => real.get(),
  invalid: () => real.invalid(),
  exists: () => real.exists(),
  habit: () => ({ ...habit }),
});

const otherModel = { ...models.anthropic5m, id: "claude-haiku-4-5" };

// ---- opening ------------------------------------------------------------

test("01 human turn then settled opens an episode with awayStart = settle time", async () => {
  const h = setup();
  await h.start();
  await h.humanTurn({ settle: false });
  await h.clock.advance(30 * SEC);
  await h.settle();
  const [session] = h.records("session");
  assert.equal(session.reason, "startup");
  assert.equal(session.mode, "shadow");
  assert.equal(session.sessionKind, "interactive");
  assert.equal(session.uiMode, "interactive");
  assert.equal(session.keepwarmVersion, "0.1.0+test");
  assert.equal(session.restored, false);
  const opens = h.records("episode_open");
  assert.equal(opens.length, 1);
  assert.equal(opens[0].episode, "sess-1:1");
  assert.equal(opens[0].awayStartMs, h.clock.now());
  assert.equal(opens[0].openedBy, "settled");
  assert.equal(opens[0].lane, "anthropic-api");
  assert.equal(opens[0].contextTokens, 50_000);
  assert.equal(opens[0].habit.source, "default");
  const [seg] = h.records("segment_open");
  assert.equal(seg.reason, "episode_open");
  assert.equal(seg.eligible, true);
  assert.equal(seg.anchorMs, h.at(0));
  assert.equal(h.snap().phase, "ARMED");
});

test("02 pending messages at settle keep the session HELD, the next settle opens", async () => {
  const h = setup();
  await h.start();
  await h.humanTurn({ settle: false });
  h.ctx.setPending(true);
  await h.settle();
  assert.equal(h.records("episode_open").length, 0);
  assert.equal(h.snap().phase, "HELD");
  h.ctx.setPending(false);
  await h.to(1);
  await h.settle();
  const [open] = h.records("episode_open");
  assert.equal(open.awayStartMs, h.at(1));
});

test("03 an imminent turn at settle blocks the episode; it opens after that turn settles", async () => {
  const h = setup();
  await h.start();
  await h.humanTurn({ settle: false });
  await h.beforeAgentStart("prompt", { prompt: "next" });
  assert.equal(h.snap().turnImminent.trigger, "prompt");
  await h.settle();
  assert.equal(h.records("episode_open").length, 0);
  assert.equal(h.snap().phase, "HELD");
  assert.equal(h.snap().turnImminent, null);
  await h.to(1);
  await h.runTurn();
  await h.settle();
  const [open] = h.records("episode_open");
  assert.equal(open.awayStartMs, h.at(1));
});

// ---- schedule oracles -----------------------------------------------------

test("04 5m auto: E 20, would_warm at tAway 4.5/9/13.5/18, expire at 22.5, no timers left", async () => {
  const h = setup();
  await h.openEpisode();
  const [open] = h.records("episode_open");
  assert.equal(open.expiry.effectiveMin, 20);
  assert.equal(open.expiry.source, "auto");
  assert.equal(open.maxPings, 6);
  await h.to(25);
  assert.deepEqual(h.ticks(), [
    ["would_warm", 4.5], ["would_warm", 9], ["would_warm", 13.5], ["would_warm", 18], ["expire", 22.5],
  ]);
  assert.ok(h.records("decision").every((d) => typeof d.hazard === "number" && d.r === open.r));
  assert.deepEqual(h.stops(), ["expired"]);
  assert.equal(h.clock.pendingCount(), 0);
  assert.equal(h.snap().phase, "OBSERVING");
});

test("05 30m auto (codex): E 120, would_warm 27..108, expire at 135", async () => {
  const h = setup({ model: models.openaiCodex });
  await h.openEpisode();
  const [open] = h.records("episode_open");
  assert.equal(open.lane, "codex-subscription");
  assert.equal(open.expiry.effectiveMin, 120);
  await h.to(140);
  assert.deepEqual(h.ticks(), [
    ["would_warm", 27], ["would_warm", 54], ["would_warm", 81], ["would_warm", 108], ["expire", 135],
  ]);
  assert.equal(h.clock.pendingCount(), 0);
});

test("06 1h auto (claude subscription): E 300, would_warm 55..275, expire at 330, maxPings 7", async () => {
  const h = setup({ model: models.claudeSdkOauth });
  await h.openEpisode();
  const [open] = h.records("episode_open");
  assert.equal(open.lane, "claude-subscription");
  assert.equal(open.expiry.effectiveMin, 300);
  assert.equal(open.maxPings, 7);
  assert.equal(open.warmPath, "none");
  await h.to(340);
  assert.deepEqual(h.ticks(), [
    ["would_warm", 55], ["would_warm", 110], ["would_warm", 165], ["would_warm", 220], ["would_warm", 275],
    ["expire", 330],
  ]);
  assert.equal(h.clock.pendingCount(), 0);
});

test("07 r 0.04 gives E 30 and r 0.02 gives E 60 on the 5m lane", async () => {
  for (const [r, E, wouldWarm, expireAt] of [[0.04, 30, 6, 31.5], [0.02, 60, 13, 63]]) {
    const h = setup({ config: { lanes: { "anthropic-api": { r } } } });
    await h.openEpisode();
    const [open] = h.records("episode_open");
    assert.equal(open.r, r);
    assert.equal(open.expiry.effectiveMin, E);
    await h.to(expireAt + 1);
    const ticks = h.ticks();
    assert.equal(ticks.filter(([a]) => a === "would_warm").length, wouldWarm);
    assert.deepEqual(ticks.at(-1), ["expire", expireAt]);
  }
});

test("08 1h manual 240: would_warm 55..220 on an unverified lane, expire at 275, hazard recorded", async () => {
  const h = setup({ model: models.claudeSdkOauth, config: { mode: "on", expiry: { "claude-subscription": 240 } } });
  await h.openEpisode();
  const [open] = h.records("episode_open");
  assert.equal(open.expiry.source, "manual");
  assert.equal(open.expiry.requestedMin, 240);
  assert.equal(open.expiry.effectiveMin, 240);
  assert.equal(open.expiry.autoMin, 300);
  await h.to(280);
  assert.deepEqual(h.ticks(), [
    ["would_warm", 55], ["would_warm", 110], ["would_warm", 165], ["would_warm", 220], ["expire", 275],
  ]);
  const decisions = h.records("decision");
  assert.ok(decisions.every((d) => typeof d.hazard === "number" && d.hazard >= 0 && d.hazard <= 1));
  assert.ok(decisions.filter((d) => d.action === "would_warm").every((d) => d.reason === "no_warm_path"));
  assert.equal(h.piAi.calls.length, 0);
});

test("09 habit p 0.4 on 5m: T* 4.5 snaps to E 0 -> expiry_zero, no timers", async () => {
  const h = setup({ config: { habit: { p: 0.4, medianMinutes: 10.5, t90Minutes: 140 } } });
  await h.openEpisode();
  const [open] = h.records("episode_open");
  assert.equal(open.habit.source, "manual");
  assert.equal(open.expiry.formulaMin, 4.5);
  assert.equal(open.expiry.effectiveMin, 0);
  assert.equal(open.maxPings, 0);
  const [seg] = h.records("segment_open");
  assert.equal(seg.eligible, false);
  assert.equal(seg.disabledReason, "expiry_zero");
  assert.equal(h.clock.pendingCount(), 0);
  await h.to(30);
  assert.equal(h.records("decision").length, 0);
});

test("10 anchor 60 s before settle: ticks at request start + k*270 s (tAway 3.5/8/12.5/17), expire 21.5", async () => {
  const h = setup();
  await h.start();
  await h.humanTurn({ settle: false });
  await h.clock.advance(60 * SEC);
  await h.settle();
  assert.equal(h.snap().nextTickMs, h.at(0) + 270 * SEC);
  await h.to(25);
  assert.deepEqual(h.ticks(), [
    ["would_warm", 3.5], ["would_warm", 8], ["would_warm", 12.5], ["would_warm", 17], ["expire", 21.5],
  ]);
  assert.deepEqual(
    h.records("decision").map((d) => Date.parse(d.ts)),
    [1, 2, 3, 4, 5].map((k) => h.at(0) + k * 270 * SEC),
  );
});

// ---- provenance -----------------------------------------------------------

test("11 interactive input -> human_return input:interactive at the input time, then no decisions, one return_usage", async () => {
  const h = setup();
  await h.openEpisode();
  const id = h.snap().episode;
  await h.to(6);
  const inputAt = h.clock.now();
  await h.emit("input", { inputId: "back-1", text: "back", source: "interactive" });
  await h.clock.advance(2 * SEC);
  await h.beforeAgentStart("prompt", { prompt: "back" });
  await h.emit("input_disposition", { inputId: "back-1", disposition: "started" });
  const [close] = h.records("episode_close");
  assert.equal(close.episode, id);
  assert.equal(close.kind, "human_return");
  assert.equal(close.source, "input:interactive");
  assert.equal(close.closedAtMs, inputAt);
  assert.equal(close.awayMin, 6);
  assert.equal(close.wouldWarm, 1);
  assert.equal(h.clock.pendingCount(), 0);
  await h.runTurn({ usage: { input: 5, output: 7, cacheRead: 0, cacheWrite: 60_000 } });
  await h.emit("message_end", { message: { role: "assistant", usage: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } } });
  const usage = h.records("return_usage");
  assert.equal(usage.length, 1);
  assert.equal(usage[0].episode, id);
  assert.deepEqual([usage[0].input, usage[0].output, usage[0].cacheRead, usage[0].cacheWrite], [5, 7, 0, 60_000]);
  assert.equal(usage[0].sinceRealAnchorSec, 360);
  assert.equal(usage[0].model, models.anthropic5m.id);
  await h.to(30);
  assert.deepEqual(h.ticks(id), [["would_warm", 4.5]]);
});

test("12 rpc queued input -> human_return input:rpc", async () => {
  const h = setup();
  await h.openEpisode();
  await h.to(2);
  await h.input("rpc", "queued");
  const [close] = h.records("episode_close");
  assert.equal(close.kind, "human_return");
  assert.equal(close.source, "input:rpc");
  assert.equal(close.closedAtMs, h.at(2));
});

test("13 extension input -> turn automated input:extension, episode kept", async () => {
  const h = setup();
  await h.openEpisode();
  const id = h.snap().episode;
  await h.to(2);
  await h.input("extension", "started");
  const [turn] = h.records("turn");
  assert.equal(turn.episode, id);
  assert.equal(turn.kind, "automated");
  assert.equal(turn.source, "input:extension");
  assert.equal(turn.startMs, h.at(2));
  assert.equal(h.snap().phase, "PAUSED");
  await h.runTurn();
  await h.settle();
  assert.equal(h.records("episode_close").length, 0);
  assert.equal(h.snap().episode, id);
  const segs = h.records("segment_open", id);
  assert.deepEqual(segs.map((s) => s.reason), ["episode_open", "after_turn"]);
  assert.equal(segs[1].anchorMs, h.at(2));
  await h.to(7);
  assert.deepEqual(h.records("decision", id).map((d) => [d.segment, d.action, d.tAwayMin]), [[2, "would_warm", 6.5]]);
});

test("14 goal-continuation turn -> automated, new after_turn segment anchored at its request, tAway continuous", async () => {
  const h = setup();
  await h.openEpisode();
  const id = h.snap().episode;
  await h.to(2);
  await h.autoTurn("goal-continuation");
  const [turn] = h.records("turn");
  assert.deepEqual([turn.kind, turn.source, turn.startMs, turn.segment], ["automated", "goal-continuation", h.at(2), 1]);
  await h.to(3);
  await h.settle();
  const segs = h.records("segment_open", id);
  assert.deepEqual(segs.map((s) => [s.segment, s.reason]), [[1, "episode_open"], [2, "after_turn"]]);
  assert.equal(segs[1].anchorMs, h.at(2));
  assert.equal(segs[1].eligible, true);
  await h.to(7);
  assert.deepEqual(h.records("decision").map((d) => [d.episode, d.segment, d.action, d.tAwayMin]), [
    [id, 2, "would_warm", 6.5],
  ]);
  assert.equal(h.records("episode_close").length, 0);
});

test("15 omo-health, restore-digest and todo-owed turns are each automated", async () => {
  const h = setup();
  await h.openEpisode();
  const id = h.snap().episode;
  const kinds = ["omo-health", "senpi-terminal:restore-digest", "senpi.todo-owed"];
  for (const [i, customType] of kinds.entries()) {
    await h.to(i + 1);
    await h.autoTurn(customType);
    await h.settle();
  }
  assert.deepEqual(h.records("turn").map((t) => [t.episode, t.kind, t.source]), kinds.map((k) => [id, "automated", k]));
  assert.equal(h.records("episode_close").length, 0);
  assert.equal(h.records("segment_open", id).length, 4);
  assert.equal(h.snap().phase, "ARMED");
});

test("16 '.' (manual-continue after agent_start) -> human_return manual_continue; environment-context ignored", async () => {
  const h = setup();
  await h.openEpisode();
  const id = h.snap().episode;
  await h.to(1);
  await h.autoTurn("goal-continuation");
  await h.settle();
  await h.to(2);
  await h.beforeAgentStart("extension");
  await h.emit("agent_start");
  const env = h.push({ role: "custom", customType: "environment-context", content: "env", display: false });
  await h.emit("message_start", { message: env });
  assert.equal(h.records("episode_close").length, 0);
  assert.equal(h.snap().phase, "CLASSIFYING");
  const dot = h.push({ role: "custom", customType: "manual-continue", content: "continue", display: false });
  await h.emit("message_start", { message: dot });
  const closes = h.records("episode_close");
  assert.equal(closes.length, 1);
  assert.deepEqual([closes[0].episode, closes[0].kind, closes[0].source], [id, "human_return", "manual_continue"]);
  assert.equal(closes[0].closedAtMs, h.at(2));
  assert.equal(closes[0].turns, 1);
  assert.equal(closes[0].segments, 2);
});

test("17 a turn without evidence -> turn unattributed, never a return", async () => {
  const h = setup();
  await h.openEpisode();
  const id = h.snap().episode;
  await h.to(1);
  await h.emit("agent_start");
  const reply = h.push({ role: "assistant", content: "x", stopReason: "stop", usage: USAGE_50K, timestamp: h.clock.now() });
  await h.emit("message_start", { message: reply });
  await h.emit("agent_end", { messages: [reply] });
  await h.settle();
  await h.to(2);
  await h.emit("agent_start");
  await h.emit("before_provider_request", { payload: h.payload() });
  await h.emit("agent_end", { messages: [] });
  await h.settle();
  assert.deepEqual(h.records("turn").map((t) => [t.episode, t.kind, t.source]), [
    [id, "unattributed", "assistant_message"],
    [id, "unattributed", "provider_request"],
  ]);
  assert.equal(h.records("episode_close").length, 0);
  assert.equal(h.snap().episode, id);
  assert.equal(h.records("segment_open", id).length, 3);
});

test("18 handled input -> presence marker only, would_warm continues", async () => {
  const h = setup();
  await h.openEpisode();
  const id = h.snap().episode;
  await h.to(2);
  await h.input("interactive", "handled");
  const markers = h.records("marker");
  assert.deepEqual(markers.map((m) => [m.episode, m.kind, m.atMs]), [[id, "input_handled", h.at(2)]]);
  await h.to(10);
  assert.deepEqual(h.ticks(id), [["would_warm", 4.5], ["would_warm", 9]]);
  assert.equal(h.records("episode_close").length, 0);
});

test("19 preview before_agent_start is ignored and the next tick is normal", async () => {
  const h = setup();
  await h.openEpisode();
  await h.to(2);
  await h.beforeAgentStart("prompt", { preview: true });
  assert.equal(h.snap().turnImminent, null);
  await h.to(5);
  assert.deepEqual(h.ticks(), [["would_warm", 4.5]]);
});

// ---- live warming ---------------------------------------------------------

test("20 on + verified: ping request built like the builtin, decision warm, next due = ping start + interval", async () => {
  const h = setup({ config: ON_VERIFIED });
  await h.openEpisode();
  const [open] = h.records("episode_open");
  assert.deepEqual([open.mode, open.warmPath, open.verified], ["on", "warmPromptCache", true]);
  await h.to(4.5);
  await h.drain();
  assert.deepEqual(h.ticks(), [["warm", 4.5]]);
  assert.equal(h.piAi.calls.length, 1);
  const { model, context, options } = h.piAi.calls[0];
  assert.equal(model, models.anthropic5m);
  assert.equal(context.systemPrompt, "system prompt");
  assert.deepEqual(context.messages, h.ctx.state.messages);
  assert.equal(context.tools, undefined);
  assert.equal(options.apiKey, "test-key");
  assert.equal(options.sessionId, "sess-1");
  assert.equal(options.timeoutMs, PING_TIMEOUT_MS);
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(options.signal.aborted, false);
  assert.equal(typeof options.onPayload, "function");
  const [ping] = h.records("ping");
  assert.deepEqual([ping.ok, ping.hit, ping.stale, ping.tick, ping.segment], [true, true, false, 1, 1]);
  const s = h.snap();
  assert.equal(s.phase, "ARMED");
  assert.equal(s.anchorMs, h.at(4.5));
  assert.equal(s.realAnchorMs, h.at(0));
  assert.equal(s.nextTickMs, h.at(4.5) + 270 * SEC);
  assert.ok(h.ledger.spendToday({ virtual: false }) > 0);
  await h.to(9);
  await h.drain();
  assert.deepEqual(h.ticks(), [["warm", 4.5], ["warm", 9]]);
});

test("21 before_provider_request during our own ping leaves anchor and prefix alone", async () => {
  const h = setup({ config: ON_VERIFIED, piAiOpts: { deferred: true } });
  await h.openEpisode();
  await h.to(4.5);
  await h.drain();
  assert.equal(h.snap().phase, "PINGING");
  await h.emit("before_provider_request", { payload: { system: "warm", tools: [], messages: [] } });
  assert.equal(h.snap().anchorMs, h.at(0));
  assert.equal(h.snap().realAnchorMs, h.at(0));
  assert.equal(h.records("marker").length, 0);
  h.piAi.pending[0].resolve();
  await h.drain();
  const [ping] = h.records("ping");
  assert.equal(ping.ok, true, "prefix guard still compares against the real request");
  assert.equal(ping.stale, false);
  assert.equal(h.snap().anchorMs, h.at(4.5));
  assert.equal(h.snap().phase, "ARMED");
});

test("22 model_select at 6 min stops warming; input at 66 min is a human_return with awayMin 66", async () => {
  const h = setup();
  await h.openEpisode();
  await h.to(6);
  h.ctx.setModel(otherModel);
  await h.emit("model_select", { model: otherModel, previousModel: models.anthropic5m, source: "set" });
  assert.deepEqual(h.stops(), ["model_change"]);
  assert.deepEqual(h.records("marker").map((m) => m.kind), ["model_select"]);
  await h.to(66);
  assert.deepEqual(h.ticks(), [["would_warm", 4.5]]);
  await h.input();
  const [close] = h.records("episode_close");
  assert.equal(close.kind, "human_return");
  assert.equal(close.awayMin, 66);
});

test("23 model_select(fallback-revert) right before input still closes as human_return", async () => {
  const h = setup();
  await h.openEpisode();
  await h.to(3);
  await h.emit("model_select", { model: models.anthropic5m, previousModel: otherModel, source: "fallback-revert" });
  await h.input();
  assert.deepEqual(h.stops(), ["model_change"]);
  const [close] = h.records("episode_close");
  assert.deepEqual([close.kind, close.source], ["human_return", "input:interactive"]);
});

test("24 thinking level change -> warm_stop effort_change", async () => {
  const h = setup();
  await h.openEpisode();
  await h.to(2);
  await h.emit("thinking_level_select", { level: "high", previousLevel: "medium" });
  assert.deepEqual(h.stops(), ["effort_change"]);
  assert.deepEqual(h.records("marker").map((m) => m.kind), ["thinking_level_select"]);
  await h.to(10);
  assert.equal(h.records("decision").length, 0);
});

test("25 cache miss (cacheRead 1000, cacheWrite 400000) -> cache_miss after one ping", async () => {
  const h = setup({ config: ON_VERIFIED, piAiOpts: { usage: { input: 10, output: 0, cacheRead: 1000, cacheWrite: 400_000 } } });
  await h.openEpisode();
  await h.to(4.5);
  await h.drain();
  const [ping] = h.records("ping");
  assert.deepEqual([ping.ok, ping.hit], [true, false]);
  assert.ok(ping.costUsd > 1);
  assert.deepEqual(h.stops(), ["cache_miss"]);
  await h.to(20);
  assert.equal(h.piAi.calls.length, 1);
  assert.equal(h.clock.pendingCount(), 0);
});

test("26 provider_error, rate_limit and timeout each stop the segment without re-arming", async () => {
  const cases = [
    ["provider_error", Object.assign(new Error("upstream exploded"), { status: 500 })],
    ["rate_limit", Object.assign(new Error("Too Many Requests"), { status: 429 })],
    ["timeout", Object.assign(new Error("request timed out"), { name: "TimeoutError" })],
  ];
  for (const [kind, error] of cases) {
    const h = setup({ config: ON_VERIFIED, piAiOpts: { error } });
    await h.openEpisode();
    await h.to(4.5);
    await h.drain();
    const [ping] = h.records("ping");
    assert.equal(ping.ok, false);
    assert.equal(ping.error.kind, kind);
    assert.deepEqual(h.stops(), [kind]);
    assert.equal(h.clock.pendingCount(), 0);
    await h.to(20);
    assert.equal(h.piAi.calls.length, 1);
  }
});

test("27 prefix mismatch stops in onPayload before the network step", async () => {
  const piAi = networkPiAi();
  const h = setup({ config: ON_VERIFIED, piAi });
  await h.openEpisode({ payload: (base) => ({ ...base, system: [{ type: "text", text: "host-rewritten system" }] }) });
  await h.to(4.5);
  await h.drain();
  assert.equal(piAi.calls.length, 1);
  assert.equal(piAi.network.length, 0);
  const [ping] = h.records("ping");
  assert.equal(ping.error.kind, "prefix_mismatch");
  assert.deepEqual(h.stops(), ["prefix_mismatch"]);
  assert.equal(h.clock.pendingCount(), 0);
});

test("28 small_context: 19999 tokens disables the segment, 20000 is eligible", async () => {
  for (const [cacheRead, eligible] of [[18_999, false], [19_000, true]]) {
    const h = setup();
    await h.openEpisode({ usage: { input: 1000, output: 5, cacheRead, cacheWrite: 0 } });
    const [seg] = h.records("segment_open");
    assert.equal(seg.eligible, eligible);
    assert.equal(seg.disabledReason, eligible ? null : "small_context");
  }
});

test("29 system prompt change -> prefix_change at the next tick", async () => {
  const h = setup();
  await h.openEpisode();
  await h.to(2);
  h.ctx.setSystemPrompt("system prompt v2");
  await h.to(5);
  assert.deepEqual(h.records("decision").map((d) => [d.action, d.reason]), [["skip", "prefix_change"]]);
  assert.deepEqual(h.stops(), ["prefix_change"]);
});

test("30 accepted session_compact -> prefix_change (rejected compaction is ignored)", async () => {
  const h = setup();
  await h.openEpisode();
  await h.to(1);
  await h.emit("session_compact", { accepted: false, reason: "manual", requestId: "r1", rejectionCause: "cancelled-by-extension" });
  assert.deepEqual(h.stops(), []);
  await h.emit("session_compact", { accepted: true, reason: "manual", requestId: "r2", fromExtension: false });
  assert.deepEqual(h.stops(), ["prefix_change"]);
});

test("31 cache_warm_ping on the bus -> duplicate_warmer", async () => {
  const h = setup();
  await h.openEpisode();
  await h.to(1);
  h.bus("cache_warm_ping", { iteration: 1, cachedTokens: 50_000, ttlSeconds: 300, estimatedCostUsd: 0.01 });
  assert.deepEqual(h.stops(), ["duplicate_warmer"]);
  assert.equal(h.clock.pendingCount(), 0);
});

test("32 builtin keepalive enabled later is caught at the tick -> duplicate_warmer, no piAi call", async () => {
  const h = setup({ config: ON_VERIFIED });
  await h.openEpisode();
  assert.equal(h.records("segment_open")[0].eligible, true);
  h.ctx.setKeepAlive({ enabled: true });
  await h.to(4.5);
  await h.drain();
  assert.deepEqual(h.records("decision").map((d) => [d.action, d.reason]), [["skip", "duplicate_warmer"]]);
  assert.deepEqual(h.stops(), ["duplicate_warmer"]);
  assert.equal(h.piAi.calls.length, 0);
});

// ---- child work -----------------------------------------------------------

test("33 child work before settle: episode opens PAUSED; drained -> children_drained segment", async () => {
  const h = setup();
  await h.start();
  await h.humanTurn({ settle: false });
  h.bus("wake_source_state", { source: "senpi-task", activeCount: 1 });
  await h.settle();
  assert.equal(h.records("episode_open").length, 1);
  assert.deepEqual([h.snap().phase, h.snap().pauseReason], ["PAUSED", "child_work"]);
  assert.equal(h.clock.pendingCount(), 0);
  await h.to(2);
  assert.equal(h.records("decision").length, 0);
  h.bus("wake_source_state", { source: "senpi-task", activeCount: 0 });
  const segs = h.records("segment_open");
  assert.deepEqual(segs.map((s) => s.reason), ["episode_open", "children_drained"]);
  assert.equal(h.snap().phase, "ARMED");
  await h.to(5);
  assert.deepEqual(h.records("decision").map((d) => [d.segment, d.action, d.tAwayMin]), [[2, "would_warm", 4.5]]);
});

test("34 child work appearing right before a tick -> skip child_work_active + PAUSED, no warm_stop", async () => {
  const h = setup();
  await h.openEpisode();
  await h.to(4);
  h.bus("wake_source_state", { source: "omo-dag", activeCount: 1 });
  await h.to(4.5);
  assert.deepEqual(h.records("decision").map((d) => [d.action, d.reason]), [["skip", "child_work_active"]]);
  assert.deepEqual(h.stops(), []);
  assert.deepEqual([h.snap().phase, h.snap().pauseReason], ["PAUSED", "child_work"]);
  await h.to(4.6);
  h.bus("wake_source_state", { source: "omo-dag", activeCount: 0 });
  assert.deepEqual(h.records("segment_open").map((s) => s.reason), ["episode_open", "children_drained"]);
});

// ---- reload and shutdown --------------------------------------------------

test("35 reload: save on shutdown, restore on session_start(reload), same episode id, marker reload, no return", async () => {
  const h1 = setup();
  await h1.openEpisode();
  const id = h1.snap().episode;
  await h1.to(5);
  await h1.shutdown("reload");
  assert.equal(h1.records("episode_close").length, 0);
  const saved = readJsonSafe(h1.L.sessionStatus("sess-1"));
  assert.equal(saved.phase, "detached");
  assert.equal(saved.episodeState.episode.id, id);

  const h2 = setup({ home: h1.home, clock: h1.clock, ctxOpts: { messages: h1.ctx.state.messages } });
  await h2.start("reload");
  assert.equal(h2.records("session").at(-1).restored, true);
  assert.equal(h2.snap().episode, id);
  assert.deepEqual(h2.records("marker").map((m) => [m.episode, m.kind]), [[id, "reload"]]);
  const segs = h2.records("segment_open", id);
  assert.deepEqual(segs.map((s) => [s.segment, s.reason]), [[1, "episode_open"], [2, "reload"]]);
  assert.equal(h2.records("episode_close").length, 0);
  await h2.to(10);
  assert.deepEqual(h2.records("decision", id).map((d) => [d.segment, d.action, d.tAwayMin]), [
    [1, "would_warm", 4.5], [2, "would_warm", 9],
  ]);
  await h2.input();
  const closes = h2.records("episode_close");
  assert.equal(closes.length, 1);
  assert.deepEqual([closes[0].episode, closes[0].kind, closes[0].wouldWarm, closes[0].segments], [id, "human_return", 2, 2]);
  assert.deepEqual(closes[0].markers.map((m) => m.kind), ["reload"]);
});

test("36 restore failure (status file gone) -> censored reload/restore_failed, a new episode continues", async () => {
  const h1 = setup();
  await h1.openEpisode();
  await h1.to(2);
  await h1.shutdown("reload");
  rmSync(h1.L.sessionStatus("sess-1"), { force: true });

  const h2 = setup({ home: h1.home, clock: h1.clock, ctxOpts: { messages: h1.ctx.state.messages } });
  await h2.start("reload");
  assert.equal(h2.records("session").at(-1).restored, false);
  const [close] = h2.records("episode_close");
  assert.deepEqual([close.episode, close.kind, close.source, close.detail], ["sess-1:1", "censored", "reload", "restore_failed"]);
  const opens = h2.records("episode_open");
  assert.equal(opens.length, 2);
  assert.deepEqual([opens[1].episode, opens[1].openedBy, opens[1].awayStartMs], ["sess-1:2", "restore_failed", h2.at(0)]);
  assert.equal(h2.records("episode_close").filter((c) => c.kind === "human_return").length, 0);
});

test("37 shutdown quit/new/resume/fork -> censored close with the reason, status file removed", async () => {
  for (const reason of ["quit", "new", "resume", "fork"]) {
    const h = setup();
    await h.openEpisode();
    await h.to(3);
    await h.shutdown(reason);
    const [close] = h.records("episode_close");
    assert.deepEqual([close.kind, close.source, close.detail, close.awayMin], ["censored", "session_shutdown", reason, 3]);
    assert.equal(close.coveredAtReturn, null);
    assert.equal(existsSync(h.L.sessionStatus("sess-1")), false);
    assert.equal(h.clock.pendingCount(), 0);
  }
});

// ---- late ticks and clocks ------------------------------------------------

test("38 1h lane after a 3 h sleep -> late_tick, no ping; the later input is a return including the sleep", async () => {
  const h = setup({ model: models.claudeSdkOauth });
  await h.openEpisode();
  await h.clock.jump(180 * MIN);
  assert.deepEqual(h.records("decision").map((d) => [d.action, d.reason, d.lateByMs]), [["skip", "late_tick", 125 * MIN]]);
  assert.deepEqual(h.stops(), ["late_tick"]);
  assert.equal(h.records("decision").filter((d) => d.action === "would_warm").length, 0);
  await h.input();
  const [close] = h.records("episode_close");
  assert.deepEqual([close.kind, close.awayMin], ["human_return", 180]);
});

test("39 5m tick 20 s late is normal, 26 s late is late_tick", async () => {
  const h = setup();
  await h.openEpisode();
  await h.clock.jump(270 * SEC + 20 * SEC);
  await h.clock.jump(270 * SEC + 26 * SEC);
  assert.deepEqual(h.records("decision").map((d) => [d.action, d.reason, d.lateByMs]), [
    ["would_warm", "shadow", 20 * SEC],
    ["skip", "late_tick", 26 * SEC],
  ]);
  assert.deepEqual(h.stops(), ["late_tick"]);
});

test("40 input during a ping aborts it; the late result is recorded stale and nothing re-arms", async () => {
  const h = setup({ config: ON_VERIFIED, piAiOpts: { deferred: true } });
  await h.openEpisode();
  await h.to(4.5);
  await h.drain();
  assert.equal(h.snap().phase, "PINGING");
  await h.input();
  assert.equal(h.piAi.calls[0].options.signal.aborted, true);
  assert.equal(h.records("episode_close")[0].kind, "human_return");
  h.piAi.pending[0].resolve();
  await h.drain();
  const [ping] = h.records("ping");
  assert.equal(ping.stale, true);
  assert.equal(h.clock.pendingCount(), 0);
  assert.equal(h.snap().phase, "BUSY");
});

test("41 a stale timer from episode 1 never records a decision after episode 2 opens", async () => {
  // clearTimeout is a no-op here, so only the generation token can stop the old tick.
  const h = setup({ clearTimeout: () => {} });
  await h.openEpisode();
  const first = h.snap().episode;
  await h.to(1);
  await h.input();
  await h.runTurn();
  await h.to(2);
  await h.settle();
  const second = h.snap().episode;
  assert.notEqual(first, second);
  await h.to(12);
  assert.deepEqual(h.ticks(first), []);
  assert.deepEqual(h.ticks(second), [["would_warm", 3.5], ["would_warm", 8]]);
});

// ---- caps -----------------------------------------------------------------

test("42 request cap: pingsSent >= maxPings -> episode_request_cap", async () => {
  // Each ping is at least one interval after the previous, so ceil(E/iv)+1 is a safety bound
  // that normal scheduling never reaches; a restored state carries the count.
  const h1 = setup();
  await h1.openEpisode();
  await h1.to(5);
  await h1.shutdown("reload");
  const file = h1.L.sessionStatus("sess-1");
  const s = readJsonSafe(file);
  s.episodeState.episode.pingsSent = s.episodeState.episode.maxPings;
  atomicWriteJson(file, s);
  const h2 = setup({ home: h1.home, clock: h1.clock, ctxOpts: { messages: h1.ctx.state.messages } });
  await h2.start("reload");
  await h2.to(10);
  assert.deepEqual(h2.records("decision").map((d) => [d.action, d.reason]).at(-1), ["skip", "episode_request_cap"]);
  assert.deepEqual(h2.stops(), ["episode_request_cap"]);
});

test("43 episode USD cap -> episode_usd_cap", async () => {
  const h = setup({ config: { ...ON_VERIFIED, maxUsdPerEpisode: 0.02 } });
  await h.openEpisode();
  await h.to(4.5);
  await h.drain();
  await h.to(9);
  await h.drain();
  assert.deepEqual(h.records("decision").map((d) => [d.action, d.reason]), [["warm", null], ["skip", "episode_usd_cap"]]);
  assert.deepEqual(h.stops(), ["episode_usd_cap"]);
  assert.equal(h.piAi.calls.length, 1);
});

test("44 daily USD cap counts other sessions' real spend -> daily_cap", async () => {
  const h = setup({ config: { ...ON_VERIFIED, maxUsdPerDay: 3 } });
  h.ledger.recordSpend({ session: "other", episode: "other:1", usd: 2.99, virtual: false });
  h.ledger.recordSpend({ session: "other", episode: "other:1", usd: 500, virtual: true });
  await h.openEpisode();
  await h.to(4.5);
  await h.drain();
  assert.deepEqual(h.records("decision").map((d) => [d.action, d.reason]), [["skip", "daily_cap"]]);
  assert.equal(h.piAi.calls.length, 0);
});

test("45 shadow applies the USD caps to the virtual ledger on warm-path lanes only", async () => {
  // Expected cost per ping = 50K x cacheRead 0.3 $/M = $0.015.
  const h = setup({ config: { maxUsdPerEpisode: 0.02 } });
  await h.openEpisode();
  await h.to(10);
  assert.deepEqual(h.records("decision").map((d) => [d.action, d.reason]), [["would_warm", "shadow"], ["skip", "episode_usd_cap"]]);
  const id = h.records("episode_open")[0].episode;
  assert.equal(h.ledger.spendEpisode(id, { virtual: true }), 0.015);
  assert.equal(h.ledger.spendToday({ virtual: false }), 0);

  // No warm path (claude-sdk-oauth): nothing can be spent, so only the request cap applies; virtual cost is still kept.
  const s = setup({ model: models.claudeSdkOauth, config: { maxUsdPerEpisode: 0.02, maxUsdPerDay: 0.02 } });
  await s.openEpisode();
  await s.to(111);
  assert.deepEqual(s.records("decision").map((d) => [d.action, d.reason]), [["would_warm", "shadow"], ["would_warm", "shadow"]]);
  assert.deepEqual(s.stops(), []);
  assert.equal(s.ledger.spendEpisode(s.records("episode_open")[0].episode, { virtual: true }), 0.15);
});

test("46 invalid habit: auto -> E 0; manual expiry -> warm proceeds with hazard null", async () => {
  const bad = { p: 1.3, mMin: 10.5, t90Min: 140, source: "manual" };
  const a = setup({ wrapConfig: withHabit(bad) });
  await a.openEpisode();
  const [openA] = a.records("episode_open");
  assert.deepEqual([openA.expiry.source, openA.expiry.effectiveMin], ["auto-invalid-habit", 0]);
  assert.equal(a.records("segment_open")[0].disabledReason, "expiry_zero");

  const b = setup({ config: { ...ON_VERIFIED, expiry: { "anthropic-api:5m": 20 } }, wrapConfig: withHabit(bad) });
  await b.openEpisode();
  const [openB] = b.records("episode_open");
  assert.deepEqual([openB.expiry.source, openB.expiry.effectiveMin, openB.expiry.formulaMin], ["manual", 20, null]);
  await b.to(4.5);
  await b.drain();
  const [d] = b.records("decision");
  assert.deepEqual([d.action, d.hazard], ["warm", null]);
  assert.equal(b.records("ping")[0].ok, true);
});

test("47 lane_off (github-copilot): only the episode and the return are recorded", async () => {
  const h = setup({ model: models.githubCopilot });
  await h.openEpisode();
  const [open] = h.records("episode_open");
  assert.deepEqual([open.lane, open.expiry, open.maxPings], ["github-copilot", null, 0]);
  const [seg] = h.records("segment_open");
  assert.deepEqual([seg.eligible, seg.disabledReason], [false, "lane_off"]);
  assert.equal(h.clock.pendingCount(), 0);
  await h.to(30);
  await h.input();
  assert.deepEqual(h.records().map((r) => r.type), ["session", "episode_open", "segment_open", "episode_close"]);
  assert.equal(h.records("episode_close")[0].kind, "human_return");
});

test("48 willRetry agent_end is ignored: no episode, and its error does not stick", async () => {
  const h = setup();
  await h.start();
  await h.input();
  await h.emit("agent_start");
  const failed = h.push({ role: "assistant", content: "", stopReason: "error", usage: USAGE_50K, timestamp: h.clock.now() });
  await h.emit("agent_end", { messages: [failed], willRetry: true });
  assert.equal(h.snap().episode, null);
  assert.equal(h.records("episode_open").length, 0);
  await h.emit("before_provider_request", { payload: h.payload() });
  const ok = h.push({ role: "assistant", content: "ok", stopReason: "stop", usage: USAGE_50K, timestamp: h.clock.now() });
  await h.emit("agent_end", { messages: [ok] });
  await h.settle();
  const [seg] = h.records("segment_open");
  assert.equal(seg.eligible, true);
});

test("49 clock going backwards -> clock_anomaly", async () => {
  const clock = createFakeClock(START);
  let offset = 0;
  const h = setup({ clock, now: () => clock.now() + offset });
  await h.openEpisode();
  offset = -10 * MIN;
  await h.to(4.5);
  assert.deepEqual(h.records("decision").map((d) => [d.action, d.reason]), [["skip", "clock_anomaly"]]);
  assert.deepEqual(h.stops(), ["clock_anomaly"]);
});

// ---- inert sessions -------------------------------------------------------

test("50 worker session: no handlers, no files", async () => {
  const h = setup({ sessionKind: "worker" });
  assert.equal(h.wired, false);
  assert.equal(h.pi.registrations.length, 0);
  for (const name of Object.keys(EVENT_METHODS)) assert.equal(h.pi.handlerCount(name), 0);
  // Even events delivered straight to the controller leave it inert.
  const c = h.controller;
  assert.equal(c.onSessionStart({ type: "session_start", reason: "startup" }, h.ctx), undefined);
  c.onInput({ inputId: "w1", source: "interactive" }, h.ctx);
  c.onAgentSettled({}, h.ctx);
  assert.equal(h.snap().phase, "INERT");
  assert.equal(existsSync(h.L.recordsDir), false);
  assert.equal(existsSync(h.L.statusDir), false);
});

test("51 print and json modes are inert", async () => {
  for (const mode of ["print", "json"]) {
    const h = setup({ ctxOpts: { mode } });
    await h.openEpisode();
    await h.to(10);
    await h.shutdown("quit");
    assert.equal(existsSync(h.L.recordsDir), false);
    assert.equal(existsSync(h.L.statusDir), false);
    assert.equal(h.clock.pendingCount(), 0);
  }
});

test("52 no config file -> inert; once created, the next settle starts recording", async () => {
  const h = setup({ config: null });
  await h.openEpisode();
  assert.equal(h.snap().phase, "INERT");
  assert.equal(existsSync(h.L.recordsDir), false);
  assert.equal(existsSync(h.L.statusDir), false);
  atomicWriteJson(h.L.config, BASE_CONFIG);
  await h.to(1);
  await h.humanTurn();
  assert.deepEqual(h.records().map((r) => r.type), ["session", "episode_open", "segment_open"]);
  assert.equal(h.records("episode_open")[0].awayStartMs, h.at(1));
  assert.equal(h.records("segment_open")[0].eligible, true);
});

test("53 mode on -> off switch -> config_off at the next tick", async () => {
  const h = setup({ config: { mode: "on" } });
  await h.openEpisode();
  await h.to(5);
  updateConfig(h.home, (c) => {
    c.mode = "off";
  });
  await h.to(10);
  assert.deepEqual(h.records("decision").map((d) => [d.action, d.reason]), [["would_warm", "unverified"], ["skip", "config_off"]]);
  assert.deepEqual(h.stops(), ["config_off"]);
});

// ---- segment eligibility --------------------------------------------------

test("54 cache_cold_at_open when now >= anchor + ttl - 5 s", async () => {
  for (const [lateSec, eligible] of [[295, false], [294, true]]) {
    const h = setup();
    await h.start();
    await h.humanTurn({ settle: false });
    await h.clock.advance(lateSec * SEC);
    await h.settle();
    const [seg] = h.records("segment_open");
    assert.equal(seg.eligible, eligible);
    assert.equal(seg.disabledReason, eligible ? null : "cache_cold_at_open");
  }
});

test("55 last turn error/aborted disables the segment", async () => {
  const e = setup();
  await e.openEpisode({ stopReason: "error" });
  assert.equal(e.records("segment_open")[0].disabledReason, "last_turn_error");
  const a = setup();
  await a.openEpisode({ aborted: true });
  assert.equal(a.records("segment_open")[0].disabledReason, "last_turn_aborted");
  assert.equal(a.clock.pendingCount(), 0);
});

test("56 session_shutdown while PINGING aborts the ping and the records stay well-formed", async () => {
  const h = setup({ config: ON_VERIFIED, piAiOpts: { deferred: true } });
  await h.openEpisode();
  await h.to(4.5);
  await h.drain();
  assert.equal(h.snap().phase, "PINGING");
  await h.shutdown("quit");
  assert.equal(h.piAi.calls[0].options.signal.aborted, true);
  h.piAi.pending[0].resolve();
  await h.drain();
  const types = h.records().map((r) => r.type);
  assert.deepEqual(types.slice(-3), ["decision", "episode_close", "ping"]);
  assert.equal(h.records("episode_close")[0].kind, "censored");
  assert.equal(h.records("ping")[0].stale, true);
  assert.ok(h.records().every((r) => r.v === 1 && r.session === "sess-1" && typeof r.ts === "string"));
  assert.equal(existsSync(h.L.sessionStatus("sess-1")), false);
  assert.equal(h.clock.pendingCount(), 0);
});

test("57 coveredAtReturn / coldWithoutWarm at the return", async () => {
  const cases = [
    // [return minute, covered, cold]: virtual ping at 4.5 keeps it covered while the real cache went cold
    [6, true, true],
    // return before the first tick: warm either way
    [2, true, false],
    // after expire at 22.5 (last virtual ping at 18): neither covered nor warm
    [30, false, true],
  ];
  for (const [minute, covered, cold] of cases) {
    const h = setup();
    await h.openEpisode();
    await h.to(minute);
    await h.input();
    const [close] = h.records("episode_close");
    assert.deepEqual([close.coveredAtReturn, close.coldWithoutWarm], [covered, cold], `return at ${minute}`);
  }
});

test("58 an extension-started turn (no input_disposition) settles and the new segment arms", async () => {
  const h = setup();
  await h.openEpisode();
  await h.to(1);
  await h.beforeAgentStart("extension");
  assert.equal(h.snap().turnImminent.trigger, "extension");
  await h.emit("agent_start");
  assert.equal(h.snap().turnImminent, null);
  assert.equal(h.snap().phase, "CLASSIFYING");
  const msg = h.push({ role: "custom", customType: "goal-continuation", content: "go", display: false });
  await h.emit("message_start", { message: msg });
  await h.emit("before_provider_request", { payload: h.payload() });
  const reply = h.push({ role: "assistant", content: "done", stopReason: "stop", usage: USAGE_50K, timestamp: h.clock.now() });
  await h.emit("agent_end", { messages: [msg, reply] });
  await h.settle();
  assert.equal(h.snap().phase, "ARMED");
  assert.equal(h.snap().segment, 2);
  await h.to(6);
  assert.deepEqual(h.records("decision").map((d) => [d.segment, d.action, d.tAwayMin]), [[2, "would_warm", 5.5]]);
});

test("59 ping messages are the full buildSessionContext history and pass the prefix guard", async () => {
  const history = [
    { role: "user", content: "old-1", timestamp: START - 30 * MIN },
    { role: "assistant", content: "old-a1", stopReason: "stop", usage: USAGE_50K, timestamp: START - 29 * MIN },
    { role: "user", content: "old-2", timestamp: START - 20 * MIN },
    { role: "assistant", content: "old-a2", stopReason: "stop", usage: USAGE_50K, timestamp: START - 19 * MIN },
  ];
  const h = setup({ config: ON_VERIFIED, ctxOpts: { messages: history } });
  await h.openEpisode();
  await h.to(1);
  await h.input();
  await h.runTurn();
  await h.settle();
  await h.to(5.5);
  await h.drain();
  assert.equal(h.piAi.calls.length, 1);
  const { context } = h.piAi.calls[0];
  assert.equal(context.messages.length, 8);
  assert.deepEqual(context.messages, h.ctx.state.messages);
  assert.deepEqual(h.ctx.prepareCalls[0], h.ctx.state.messages);
  const [ping] = h.records("ping");
  assert.deepEqual([ping.ok, ping.hit, ping.episode], [true, true, "sess-1:2"]);
});

test("60 on + verified but no captured prefix -> no_prefix, piAi never called", async () => {
  const h = setup({ config: null });
  await h.start();
  await h.humanTurn({ settle: false });
  atomicWriteJson(h.L.config, { ...BASE_CONFIG, ...ON_VERIFIED });
  await h.settle();
  const [open] = h.records("episode_open");
  assert.deepEqual([open.mode, open.verified], ["on", true]);
  assert.equal(h.records("segment_open")[0].eligible, true);
  assert.equal(h.snap().hasPrefix, false);
  await h.to(4.5);
  await h.drain();
  assert.deepEqual(h.records("decision").map((d) => [d.action, d.reason]), [["skip", "no_prefix"]]);
  assert.deepEqual(h.stops(), ["no_prefix"]);
  assert.equal(h.piAi.calls.length, 0);
});

test("61 a started disposition in HELD does not open; that human turn's settle does", async () => {
  const h = setup();
  await h.start();
  await h.humanTurn({ settle: false });
  h.ctx.setPending(true);
  await h.settle();
  assert.equal(h.snap().phase, "HELD");
  h.ctx.setPending(false);
  await h.to(1);
  await h.input("interactive", "started");
  assert.equal(h.records("episode_open").length, 0);
  assert.equal(h.snap().humanTurnPending, true);
  await h.runTurn();
  assert.equal(h.snap().phase, "BUSY");
  await h.to(2);
  await h.settle();
  const [open] = h.records("episode_open");
  assert.equal(open.awayStartMs, h.at(2));
});

test("62 foreign request while ARMED is only a marker; during an automated turn the anchor moves", async () => {
  const h = setup();
  await h.openEpisode();
  await h.to(2);
  await h.emit("before_provider_request", { payload: { system: "side channel", tools: [], messages: [] } });
  assert.deepEqual(h.records("marker").map((m) => [m.kind, m.atMs]), [["foreign_provider_request", h.at(2)]]);
  assert.deepEqual([h.snap().anchorMs, h.snap().realAnchorMs, h.snap().phase], [h.at(0), h.at(0), "ARMED"]);
  await h.to(4.5);
  assert.deepEqual(h.ticks(), [["would_warm", 4.5]]);
  await h.to(6);
  await h.autoTurn("goal-continuation");
  assert.deepEqual([h.snap().anchorMs, h.snap().realAnchorMs], [h.at(6), h.at(6)]);
});

test("63 terminal monitor wake source does not pause; senpi-task and senpi-task-member do", async () => {
  assert.deepEqual(CHILD_WORK_SOURCES, ["senpi-task", "senpi-task-member", "omo-dag"]);
  const h = setup();
  await h.openEpisode();
  await h.to(1);
  h.bus("wake_source_state", { source: "terminal-monitors", activeCount: 1, monitors: [] });
  h.bus("wake_source_state", { source: "", activeCount: 3 });
  h.bus("wake_source_state", { source: "senpi-task", activeCount: "2" });
  assert.equal(h.snap().childWork, 0);
  await h.to(4.5);
  assert.equal(h.snap().phase, "ARMED");
  await h.to(5);
  h.bus("wake_source_state", { source: "senpi-task", activeCount: 1 });
  await h.to(9);
  assert.deepEqual([h.snap().phase, h.snap().pauseReason], ["PAUSED", "child_work"]);
  h.bus("wake_source_state", { source: "senpi-task", activeCount: 0 });
  assert.equal(h.snap().phase, "ARMED");
  assert.deepEqual(
    h.records("segment_open").map((s) => [s.reason, s.otherWakeSources]),
    [["episode_open", []], ["children_drained", ["terminal-monitors"]]],
  );
  h.bus("wake_source_state", { source: "senpi-task-member", activeCount: 1 });
  await h.clock.advance(SEC);
  assert.deepEqual(h.records("decision").map((d) => [d.action, d.reason]), [
    ["would_warm", "shadow"],
    ["skip", "child_work_active"],
    ["skip", "child_work_active"],
  ]);
  assert.deepEqual(h.stops(), []);
});

test("64 halt cancels the armed tick, writes nothing more and ignores later events", async () => {
  const h = setup();
  await h.openEpisode();
  assert.equal(h.snap().phase, "ARMED");
  assert.equal(h.clock.pendingCount(), 1);
  const before = h.records().length;
  h.controller.halt();
  assert.equal(h.clock.pendingCount(), 0);
  assert.equal(h.snap().phase, "INERT");
  await h.to(30);
  await h.settle();
  await h.input("interactive", "started");
  assert.equal(h.snap().phase, "INERT");
  await h.shutdown("quit");
  assert.equal(h.records().length, before);
});
