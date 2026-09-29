import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import keepwarm from "../extension/keepwarm.mjs";
import { BUS_METHODS, EVENT_METHODS } from "../src/episode.mjs";
import { updateConfig } from "../src/config.mjs";
import { atomicWriteJson, readJsonLines, readJsonSafe } from "../src/fsx.mjs";
import { uninstall } from "../src/install.mjs";
import { layout } from "../src/paths.mjs";
import { HEARTBEAT_MS } from "../src/policy.mjs";
import { createFakeClock, createFakeCtx, createFakePi, createFakePiAi, models, tmpHome } from "./helpers/fake-host.mjs";

const SEC = 1000;
const MIN = 60 * SEC;
const START = new Date(2026, 5, 15, 9, 0, 0).getTime();
const BASE_CONFIG = { v: 1, mode: "shadow", maxUsdPerEpisode: 100, maxUsdPerDay: 1000 };
const USAGE_50K = { input: 1000, output: 200, cacheRead: 49_000, cacheWrite: 0 };
const VERSION = "0.1.0+abcd1234";
const INSTANCES = Symbol.for("omo-keepwarm.instances");
const identity = (messages) => messages;
const table = () => globalThis[INSTANCES];

// ---- harness ------------------------------------------------------------

const live = [];

beforeEach(() => {
  delete globalThis[INSTANCES];
});

afterEach(() => {
  const harnesses = live.splice(0);
  for (const h of harnesses) {
    assert.deepEqual(h.pi.forbiddenCalls, [], "forbidden pi API calls");
    assert.deepEqual(h.ctx.uiCalls, [], "ctx.ui calls");
    for (const r of h.pi.returns) assert.equal(r.value, undefined, `${r.name} handler returned a value`);
    if (!h.expectErrors) assert.equal(existsSync(h.L.errorLog), false, "errors.log stays absent");
  }
  for (const home of new Set(harnesses.map((h) => h.home))) rmSync(home, { recursive: true, force: true });
  delete globalThis[INSTANCES];
});

function boot(o = {}) {
  const home = o.home ?? tmpHome();
  const clock = o.clock ?? createFakeClock(START);
  const L = layout(home);
  if (!o.home && o.config !== null) atomicWriteJson(L.config, { ...BASE_CONFIG, ...(o.config ?? {}) });
  const pi = createFakePi({ sessionKind: o.sessionKind ?? "interactive" });
  const bus = [];
  const busOn = pi.events.on;
  pi.events.on = (name, handler) => {
    bus.push(name);
    return busOn(name, handler);
  };
  const sessionId = o.sessionId ?? "sess-1";
  const ctx = createFakeCtx({ sessionId, mode: o.mode ?? "interactive", model: o.model ?? models.anthropic5m });
  const calibrations = [];
  const deps = {
    home,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    piAi: createFakePiAi(),
    version: o.version === undefined ? VERSION : o.version,
    autoCalibrate: o.autoCalibrate ?? ((args) => void calibrations.push(args)),
  };
  if (o.convertToLlm !== null) deps.convertToLlm = identity;
  const result = keepwarm(pi, deps);
  let n = 0;

  const h = {
    home, clock, L, pi, ctx, bus, calibrations, sessionId, result, expectErrors: false,
    emit: (name, ev = {}) => pi.emit(name, { type: name, ...ev }, ctx),
    start: (reason = "startup") => h.emit("session_start", { reason }),
    shutdown: (reason = "quit") => h.emit("session_shutdown", { reason }),
    settle: () => h.emit("agent_settled"),
    async input(source = "interactive") {
      n += 1;
      const inputId = `${sessionId}:${n}`;
      await h.emit("input", { inputId, text: "hello", source });
      await h.emit("before_agent_start", { prompt: "hello", trigger: "prompt", systemPrompt: ctx.getSystemPrompt() });
      await h.emit("input_disposition", { inputId, disposition: "started" });
    },
    async runTurn({ usage = USAGE_50K } = {}) {
      n += 1;
      await h.emit("agent_start");
      const first = { role: "user", content: `u${n}`, timestamp: clock.now() };
      await h.emit("message_start", { message: first });
      await h.emit("message_end", { message: first });
      const payload = { system: ctx.getSystemPrompt(), tools: [], messages: [first] };
      await h.emit("before_provider_request", { payload });
      const reply = { role: "assistant", content: `a${n}`, stopReason: "stop", usage, model: ctx.model.id, timestamp: clock.now() };
      await h.emit("message_start", { message: reply });
      await h.emit("message_end", { message: reply });
      await h.emit("agent_end", { messages: [first, reply] });
    },
    async humanTurn(source = "interactive") {
      await h.input(source);
      await h.runTurn();
      await h.settle();
    },
    async openEpisode() {
      await h.start();
      await h.humanTurn();
    },
    records(type) {
      const dir = L.recordsDir;
      if (!existsSync(dir)) return [];
      const out = [];
      for (const month of readdirSync(dir).sort()) {
        for (const f of readdirSync(join(dir, month)).sort()) out.push(...readJsonLines(join(dir, month, f)));
      }
      return out.filter((r) => !type || r.type === type);
    },
    status: () => readJsonSafe(L.sessionStatus(sessionId)),
  };
  live.push(h);
  return h;
}

// ---- end to end ----------------------------------------------------------

test("end to end: settle opens an episode, an rpc input closes it as human_return in the real records file", async () => {
  const h = boot();
  await h.start();
  assert.equal(h.records("episode_open").length, 0);
  await h.humanTurn("interactive");
  const [open] = h.records("episode_open");
  assert.ok(open, "the settle opened an episode");
  assert.equal(open.episode, "sess-1:1");
  assert.equal(open.openedBy, "settled");
  assert.equal(open.mode, "shadow");
  assert.equal(h.status().episode, "sess-1:1");
  assert.ok(existsSync(h.L.globalStatus), "opening an episode recomputes _global");

  await h.clock.advance(MIN);
  await h.input("rpc");
  const [close] = h.records("episode_close");
  assert.equal(close.episode, "sess-1:1");
  assert.equal(close.kind, "human_return");
  assert.equal(close.source, "input:rpc");
  assert.ok(existsSync(h.L.recordFile("sess-1", START)), "the record lives at records/<month>/<session>.jsonl under the temp home");
  await h.runTurn();
  assert.equal(h.records("return_usage").length, 1);
  assert.equal(h.status().episode, null);
});

test("mode on with an unavailable warmer still runs the shadow decision", async () => {
  const h = boot({ config: { mode: "on", lanes: { "anthropic-api": { verified: true } } }, convertToLlm: null });
  await h.openEpisode();
  await h.clock.advance(4.5 * MIN);
  const decisions = h.records("decision");
  assert.deepEqual(decisions.map((d) => [d.action, d.reason]), [["would_warm", "warmer_unavailable"]]);
  assert.equal(h.records("ping").length, 0);
});

// ---- registration --------------------------------------------------------

test("every host event is registered, before_agent_start with previewSafe, and both bus events", () => {
  const h = boot();
  assert.deepEqual(h.pi.registrations.map((r) => r.name).sort(), Object.keys(EVENT_METHODS).sort());
  for (const r of h.pi.registrations) {
    if (r.name === "before_agent_start") assert.deepEqual(r.opts, { previewSafe: true });
    else assert.equal(r.opts, undefined, `${r.name} carries no options`);
  }
  assert.deepEqual([...h.bus].sort(), Object.keys(BUS_METHODS).sort());
  assert.equal(h.result, undefined);
});

test("a worker session registers nothing and writes nothing", async () => {
  const h = boot({ sessionKind: "worker", config: null });
  assert.equal(h.pi.registrations.length, 0);
  assert.equal(h.bus.length, 0);
  await h.start();
  await h.humanTurn();
  await h.shutdown();
  assert.deepEqual(readdirSync(h.home), []);
  assert.equal(table(), undefined, "no instance table is even created");
  assert.equal(h.clock.pendingCount(), 0);
});

for (const mode of ["print", "json"]) {
  test(`${mode} mode goes inert at session_start and writes nothing`, async () => {
    const h = boot({ mode });
    await h.start();
    await h.humanTurn();
    await h.clock.advance(10 * MIN);
    await h.shutdown();
    assert.deepEqual(readdirSync(h.home), ["config.json"]);
    assert.equal(table()?.has(h.sessionId) ?? false, false);
    assert.equal(h.clock.pendingCount(), 0, "no heartbeat, no calibration");
    assert.equal(h.calibrations.length, 0);
  });
}

// ---- duplicate instance --------------------------------------------------

test("a duplicate instance for the same session registers handlers but does nothing and never frees the owner's token", async () => {
  const a = boot();
  const b = boot({ home: a.home, clock: createFakeClock(START) });
  assert.equal(b.pi.registrations.length, a.pi.registrations.length, "the duplicate still registers");
  await a.start();
  await b.start();
  const owner = table().get("sess-1");
  await a.humanTurn();
  const linesBefore = a.records().length;
  const statusBefore = readFileSync(a.L.sessionStatus("sess-1"), "utf8");
  await b.humanTurn();
  await b.clock.advance(HEARTBEAT_MS * 2);
  await b.shutdown();
  assert.equal(a.records().length, linesBefore, "the duplicate wrote no record");
  assert.equal(readFileSync(a.L.sessionStatus("sess-1"), "utf8"), statusBefore, "the duplicate wrote no status");
  assert.equal(b.clock.pendingCount(), 0, "the duplicate armed nothing");
  assert.equal(b.calibrations.length, 0);
  assert.equal(existsSync(b.L.loadedMarker(VERSION)), true, "the marker comes from the owner");
  assert.equal(table().get("sess-1"), owner, "the duplicate's shutdown left the owner's token");
  await a.shutdown();
  assert.equal(table().has("sess-1"), false);
  const c = boot({ home: a.home, clock: createFakeClock(START) });
  await c.start();
  assert.ok(table().has("sess-1"), "the session can be claimed again after release");
  await c.shutdown();
});

// ---- isolation and safe disable ------------------------------------------

test("a throwing handler is isolated: other handlers run, the error is logged, the host sees no rejection", async () => {
  const h = boot();
  h.expectErrors = true;
  const seen = [];
  h.pi.on("agent_settled", () => void seen.push("other extension"));
  await h.start();
  const pending = h.ctx.hasPendingMessages;
  h.ctx.hasPendingMessages = () => {
    throw new Error("boom");
  };
  await assert.doesNotReject(h.settle());
  assert.deepEqual(seen, ["other extension"]);
  assert.match(readFileSync(h.L.errorLog, "utf8"), /agent_settled boom/);
  assert.equal(h.records("episode_open").length, 0);
  h.ctx.hasPendingMessages = pending;
  await h.settle();
  assert.equal(h.records("episode_open").length, 1, "the extension keeps working after an isolated error");
  assert.equal(h.pi.returns.every((r) => r.value === undefined), true);
});

test("a timer callback error is routed to the error log", async () => {
  const h = boot({
    autoCalibrate: () => {
      throw new Error("calibrate boom");
    },
  });
  h.expectErrors = true;
  await h.start();
  await h.clock.advance(60 * SEC);
  assert.match(readFileSync(h.L.errorLog, "utf8"), /autoCalibrate calibrate boom/);
});

test("a stale generation disables the extension: status self disabled, controller stopped, everything released", async () => {
  const h = boot();
  h.expectErrors = true;
  await h.openEpisode();
  assert.ok(h.clock.pendingCount() >= 3, "tick, heartbeat and calibration are pending");
  const idle = h.ctx.isIdle;
  h.ctx.isIdle = () => {
    throw new Error("stale extension generation");
  };
  await assert.doesNotReject(h.settle());
  assert.equal(h.status().self, "disabled", "written immediately, without waiting for the debounce");
  assert.equal(h.clock.pendingCount(), 0, "tick, heartbeat, debounce and calibration are all cleared");
  assert.equal(table().has("sess-1"), false, "the token is released");
  assert.match(readFileSync(h.L.errorLog, "utf8"), /agent_settled stale extension generation/);

  h.ctx.isIdle = idle;
  const linesBefore = h.records().length;
  await h.input("interactive");
  await h.runTurn();
  await h.clock.advance(30 * MIN);
  assert.equal(h.records().length, linesBefore, "a stopped controller writes nothing");
  assert.equal(h.clock.pendingCount(), 0);
  assert.equal(h.calibrations.length, 0);
});

// ---- marker, calibration, heartbeat --------------------------------------

test("the loaded marker is written at the first session_start of a runtime with a version", async () => {
  const h = boot();
  assert.equal(existsSync(h.L.loadedMarker(VERSION)), false);
  await h.start();
  assert.equal(existsSync(h.L.loadedMarker(VERSION)), true);
});

test("the session status carries keepwarmVersion, which install's pruneReleases keeps", async () => {
  const h = boot();
  await h.start();
  await h.clock.advance(SEC);
  assert.equal(readJsonSafe(h.L.sessionStatus(h.sessionId))?.keepwarmVersion, VERSION);
});

test("no version, no marker", async () => {
  const h = boot({ version: null });
  await h.start();
  assert.equal(existsSync(h.L.appDir), false);
});

test("autoCalibrate is scheduled once, 60 s after session_start and not before", async () => {
  const h = boot();
  await h.start();
  await h.clock.advance(60 * SEC - 1);
  assert.equal(h.calibrations.length, 0);
  await h.clock.advance(1);
  assert.equal(h.calibrations.length, 1);
  assert.equal(h.calibrations[0].home, h.home);
  assert.equal(typeof h.calibrations[0].now, "function");
  await h.clock.advance(10 * MIN);
  assert.equal(h.calibrations.length, 1);
});

test("autoCalibrate does not run when the config mode is off", async () => {
  const h = boot({ config: { mode: "off" } });
  await h.start();
  await h.clock.advance(61 * SEC);
  assert.equal(h.calibrations.length, 0);
});

test("shutdown before the 60 s mark cancels the calibration", async () => {
  const h = boot();
  await h.start();
  await h.clock.advance(30 * SEC);
  await h.shutdown();
  await h.clock.advance(5 * MIN);
  assert.equal(h.calibrations.length, 0);
});

test("the heartbeat recomputes _global every HEARTBEAT_MS and not before", async () => {
  const h = boot();
  await h.start();
  assert.equal(existsSync(h.L.globalStatus), false, "no episode, no _global yet");
  const ts = h.status().ts;
  await h.clock.advance(HEARTBEAT_MS - 1);
  assert.equal(existsSync(h.L.globalStatus), false);
  await h.clock.advance(1);
  assert.equal(existsSync(h.L.globalStatus), true);
  assert.ok(h.status().ts > ts, "the session status is refreshed too");
});

// ---- purge and mode off (IS-13) ---------------------------------------------

function purgeHome(h) {
  const agent = tmpHome();
  const env = {
    OMO_KEEPWARM_HOME: h.home,
    OMO_CODING_AGENT_DIR: agent,
    SENPI_CODING_AGENT_DIR: agent,
    OMO_HEALTH_HOME: join(agent, "health"),
  };
  const res = uninstall({ env, purge: true, force: true });
  assert.equal(res.purged, true);
  assert.equal(existsSync(h.home), false);
}

test("uninstall --purge with an open episode: ticks, heartbeats and events write nothing and the home stays absent", async () => {
  const h = boot();
  await h.openEpisode();
  assert.ok(h.clock.pendingCount() >= 3);
  purgeHome(h);
  await h.clock.advance(65 * MIN);
  assert.equal(existsSync(h.home), false, "no tick, heartbeat or calibration recreated the home");
  await h.input("interactive");
  await h.runTurn();
  await h.settle();
  await h.clock.advance(HEARTBEAT_MS * 2);
  await h.shutdown();
  assert.equal(existsSync(h.home), false);
  assert.equal(h.clock.pendingCount(), 0, "the heartbeat and the debounce are stopped");
  assert.equal(h.calibrations.length, 0);
});

test("an input right after --purge does not close the episode nor recreate the home", async () => {
  const h = boot();
  await h.openEpisode();
  purgeHome(h);
  await h.input("interactive");
  assert.equal(existsSync(h.home), false);
  await h.runTurn();
  await h.settle();
  await h.clock.advance(HEARTBEAT_MS * 2);
  assert.equal(existsSync(h.home), false);
});

test("a pending status debounce is dropped, not written, when the home is purged", async () => {
  const h = boot();
  await h.openEpisode();
  await h.emit("agent_start");
  assert.equal(h.status().phase, "ARMED", "the CLASSIFYING update is only debounced");
  purgeHome(h);
  await h.clock.advance(SEC);
  assert.equal(existsSync(h.home), false);
});

test("mode off with an open episode: one config_off close, then the session status is never touched again", async () => {
  const h = boot();
  await h.openEpisode();
  await h.clock.advance(MIN);
  updateConfig(h.home, (c) => {
    c.mode = "off";
  });
  await h.clock.advance(4 * MIN);
  assert.deepEqual(h.records("episode_close").map((r) => [r.kind, r.source, r.detail]), [["censored", "config", "config_off"]]);
  const status = readFileSync(h.L.sessionStatus("sess-1"), "utf8");
  const global = readFileSync(h.L.globalStatus, "utf8");
  const lines = h.records().length;
  const ts = h.status().ts;
  await h.clock.advance(HEARTBEAT_MS * 2);
  assert.equal(h.status().ts, ts, "no heartbeat write");
  await h.input("interactive");
  await h.runTurn();
  await h.settle();
  await h.clock.advance(HEARTBEAT_MS * 2);
  assert.equal(readFileSync(h.L.sessionStatus("sess-1"), "utf8"), status);
  assert.equal(readFileSync(h.L.globalStatus, "utf8"), global);
  assert.equal(h.records().length, lines);
  assert.equal(h.clock.pendingCount(), 0, "the heartbeat is stopped");

  // Back to shadow: the next settle re-activates and the heartbeat restarts.
  updateConfig(h.home, (c) => {
    c.mode = "shadow";
  });
  await h.clock.advance(MIN);
  // The host history carries the last assistant message, which re-activation uses as the anchor.
  h.ctx.setMessages([{ role: "assistant", content: "a", stopReason: "stop", usage: USAGE_50K, timestamp: h.clock.now() }]);
  await h.humanTurn();
  assert.equal(h.records("episode_open").length, 2);
  assert.ok(h.clock.pendingCount() >= 2, "tick and heartbeat are back");
  const ts2 = h.status().ts;
  await h.clock.advance(HEARTBEAT_MS);
  assert.ok(h.status().ts > ts2, "the heartbeat writes again");
});

test("an unexpected error in the tick is logged to errors.log and stops warming with internal_error", async () => {
  const h = boot({ config: { mode: "on", lanes: { "anthropic-api": { verified: true } } } });
  h.expectErrors = true;
  await h.openEpisode();
  h.ctx.sessionManager.buildSessionContext = () => {
    throw new Error("history boom");
  };
  await h.clock.advance(5 * MIN);
  assert.match(readFileSync(h.L.errorLog, "utf8"), /timer history boom/);
  assert.deepEqual(h.records("warm_stop").map((r) => r.reason), ["internal_error"]);
  assert.equal(h.status().phase, "OBSERVING");
});

// ---- shutdown ------------------------------------------------------------

test("shutdown closes the episode, clears every timer of this extension and releases the token", async () => {
  const h = boot();
  await h.openEpisode();
  assert.ok(h.clock.pendingCount() >= 3);
  assert.ok(table().has("sess-1"));
  await h.shutdown("quit");
  const [close] = h.records("episode_close");
  assert.deepEqual([close.kind, close.source, close.detail], ["censored", "session_shutdown", "quit"]);
  assert.equal(existsSync(h.L.sessionStatus("sess-1")), false);
  assert.equal(h.clock.pendingCount(), 0);
  assert.equal(table().has("sess-1"), false);
  await h.clock.advance(HEARTBEAT_MS * 2);
  assert.equal(h.calibrations.length, 0);
});

test("when the controller's shutdown throws, the pending status write is still flushed and everything released", async () => {
  const h = boot();
  h.expectErrors = true;
  await h.openEpisode();
  await h.emit("agent_start");
  assert.equal(h.status().phase, "ARMED", "the CLASSIFYING update is only debounced");
  const ev = {
    type: "session_shutdown",
    get reason() {
      throw new Error("shutdown boom");
    },
  };
  await assert.doesNotReject(h.pi.emit("session_shutdown", ev, h.ctx));
  assert.equal(h.status().phase, "CLASSIFYING", "flushed by the extension's teardown");
  assert.equal(h.clock.pendingCount(), 0);
  assert.equal(table().has("sess-1"), false);
  assert.match(readFileSync(h.L.errorLog, "utf8"), /session_shutdown shutdown boom/);
});

test("reload shutdown saves the episode synchronously and a new instance restores it", async () => {
  const a = boot();
  await a.openEpisode();
  const episode = a.records("episode_open")[0].episode;
  const done = a.shutdown("reload");
  assert.equal(a.status().episodeState?.episode?.id, episode, "saved before the handler could yield");
  await done;
  assert.equal(a.status().phase, "detached");
  assert.equal(a.status().episodeState.episode.id, episode);
  assert.equal(a.records("episode_close").length, 0, "a reload does not close the episode");
  assert.equal(a.clock.pendingCount(), 0);
  assert.equal(table().has("sess-1"), false);

  const b = boot({ home: a.home, clock: a.clock });
  await b.start("reload");
  assert.deepEqual(b.records("session").map((s) => [s.reason, s.restored]), [["startup", false], ["reload", true]]);
  assert.ok(b.records("segment_open").some((s) => s.reason === "reload" && s.episode === episode));
  assert.equal(b.records("episode_open").length, 1, "no second episode was opened");
  await b.input("rpc");
  const [close] = b.records("episode_close");
  assert.equal(close.episode, episode);
  assert.equal(close.kind, "human_return");
  await b.shutdown();
});
