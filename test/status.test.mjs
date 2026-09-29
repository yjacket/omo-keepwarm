import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createStatus, STALE_AFTER_MS } from "../src/status.mjs";
import { createLedger } from "../src/ledger.mjs";
import { atomicWriteJson, readJsonSafe } from "../src/fsx.mjs";
import { layout } from "../src/paths.mjs";
import { createFakeClock, tmpHome } from "./helpers/fake-host.mjs";

function setup({ mode = "shadow", startMs = new Date(2026, 5, 15, 12, 0).getTime() } = {}) {
  const home = tmpHome();
  const clock = createFakeClock(startMs);
  if (mode !== null) atomicWriteJson(layout(home).config, { v: 1, mode });
  const L = layout(home);
  return {
    home,
    clock,
    L,
    status: (id) => createStatus({ home, sessionId: id, now: clock.now }),
    global: () => readJsonSafe(L.globalStatus),
  };
}

test("session file shape; _global recomputed when the episode opens", () => {
  const { clock, L, status, global } = setup();
  const s = status("s1");
  s.update({ phase: "ARMED", lane: "anthropic-api", mode: "shadow", episode: "s1:1", tAwayMin: 5, nextTickMs: 123 });
  assert.deepEqual(readJsonSafe(L.sessionStatus("s1")), {
    v: 1,
    ts: clock.now(),
    session: "s1",
    phase: "ARMED",
    lane: "anthropic-api",
    mode: "shadow",
    episode: "s1:1",
    tAwayMin: 5,
    nextTickMs: 123,
    self: "active",
    episodeState: null,
  });
  const g = global();
  assert.equal(g.v, 1);
  assert.equal(g.ts, clock.now());
  assert.equal(g.staleAfter, clock.now() + STALE_AFTER_MS);
  assert.equal(g.level, "ok");
  assert.deepEqual(g.detail, {
    mode: "shadow",
    sessions: { count: 1, idle: 1, warming: 1 },
    today: { episodes: 0, humanReturns: 0, wouldWarm: 0, pings: 0, usd: 0 },
    errorsToday: 0,
    lanes: { "anthropic-api": "shadow" },
  });
  // no temp files left behind
  assert.deepEqual(readdirSync(L.statusDir).sort(), ["_global.json", "s1.json"]);
});

test("two session writers -> sessions.count 2", () => {
  const { status, global } = setup();
  status("s1").update({ phase: "BUSY", lane: "claude-subscription", mode: "shadow" });
  const s2 = status("s2");
  s2.update({ phase: "HELD", lane: "codex-subscription", mode: "on" });
  s2.recomputeGlobal();
  const g = global();
  assert.deepEqual(g.detail.sessions, { count: 2, idle: 1, warming: 0 });
  assert.deepEqual(g.detail.lanes, { "claude-subscription": "shadow", "codex-subscription": "on" });
});

test("sessions older than 15 minutes are excluded", async () => {
  const { clock, status, global } = setup();
  const s1 = status("s1");
  const s2 = status("s2");
  s1.update({ phase: "BUSY" });
  await clock.jump(STALE_AFTER_MS);
  s2.update({ phase: "BUSY" });
  s2.recomputeGlobal();
  assert.equal(global().detail.sessions.count, 2, "exactly 15 minutes is still counted");
  await clock.jump(1);
  s2.heartbeat();
  assert.equal(global().detail.sessions.count, 1);
  s1.heartbeat();
  assert.equal(global().detail.sessions.count, 2);
});

test("close deletes the session file when no episodeState", () => {
  const { L, status, global } = setup();
  const s = status("s1");
  s.update({ phase: "HELD" });
  s.recomputeGlobal();
  assert.equal(global().detail.sessions.count, 1);
  s.close();
  assert.equal(existsSync(L.sessionStatus("s1")), false);
  assert.equal(global().detail.sessions.count, 0);
});

test("close keeps the file as detached when episodeState exists", () => {
  const { L, status, global } = setup();
  const s = status("s1");
  s.update({ phase: "ARMED" });
  s.saveEpisode({ episode: "s1:1", seq: 1 });
  s.close();
  const f = readJsonSafe(L.sessionStatus("s1"));
  assert.equal(f.phase, "detached");
  assert.deepEqual(f.episodeState, { episode: "s1:1", seq: 1 });
  assert.deepEqual(global().detail.sessions, { count: 1, idle: 0, warming: 0 });
});

test("saveEpisode/loadEpisode round-trip, including across instances", () => {
  const { status } = setup();
  const a = status("s1");
  assert.equal(a.loadEpisode(), null);
  const ep = { episode: "s1:3", awayStartMs: 1000, segment: 2, tick: 4, markers: [{ kind: "reload", atMs: 5 }] };
  a.saveEpisode(ep);
  assert.deepEqual(a.loadEpisode(), ep);
  a.close();
  const b = status("s1");
  assert.deepEqual(b.loadEpisode(), ep);
  b.update({ phase: "BUSY" });
  assert.deepEqual(b.loadEpisode(), ep, "update keeps the saved episode");
  b.saveEpisode(null);
  assert.equal(b.loadEpisode(), null);
  assert.equal(status("other").loadEpisode(), null);
});

test("broken status files are ignored", () => {
  const { L, status, global } = setup();
  mkdirSync(L.statusDir, { recursive: true });
  writeFileSync(join(L.statusDir, "bad.json"), "{bad");
  writeFileSync(join(L.statusDir, "nots.json"), JSON.stringify({ v: 1, session: "x", phase: "BUSY" }));
  writeFileSync(join(L.statusDir, "null.json"), "null");
  const s1 = status("s1");
  s1.update({ phase: "HELD", lane: "anthropic-api", mode: "on" });
  s1.recomputeGlobal();
  const g = global();
  assert.deepEqual(g.detail.sessions, { count: 1, idle: 1, warming: 0 });
  assert.equal(g.level, "ok");
  assert.equal(g.text, "keepwarm shadow · 1 sessions (1 idle) · today 0 episodes, 0 returns, 0 pings, $0.00");
});

test("level warn when errors logged today", async () => {
  const { clock, L, status, global } = setup();
  const s = status("s1");
  mkdirSync(dirname(L.errorLog), { recursive: true });
  const yesterday = new Date(clock.now() - 86_400_000).toISOString();
  appendFileSync(L.errorLog, `${yesterday} onTick boom\n`);
  s.update({ phase: "BUSY" });
  s.recomputeGlobal();
  assert.equal(global().level, "ok");
  assert.equal(global().detail.errorsToday, 0);
  appendFileSync(L.errorLog, `${new Date(clock.now()).toISOString()} onTick boom\n`);
  s.heartbeat();
  assert.equal(global().level, "warn");
  assert.equal(global().detail.errorsToday, 1);
});

test("level warn when a live session is disabled", () => {
  const { status, global } = setup();
  status("s1").update({ phase: "BUSY" });
  const s2 = status("s2");
  s2.update({ phase: "BUSY" });
  s2.recomputeGlobal();
  assert.equal(global().level, "ok");
  s2.update({ self: "disabled" });
  s2.recomputeGlobal();
  assert.equal(global().level, "warn");
});

test("text is exact, today sums day ledger and real spend", () => {
  const { home, clock, status, global } = setup({ mode: "on" });
  const ledger = createLedger({ home, now: clock.now });
  ledger.recordDay({ episodes: 2, humanReturns: 1, wouldWarm: 4, pings: 3, usd: 0.5 });
  ledger.recordDay({ episodes: 1, humanReturns: 1, wouldWarm: 0, pings: 2, usd: 0.1 });
  ledger.recordSpend({ session: "s1", episode: "s1:1", usd: 0.125, virtual: false });
  ledger.recordSpend({ session: "s1", episode: "s1:1", usd: 0.5, virtual: false });
  ledger.recordSpend({ session: "s1", episode: "s1:1", usd: 9, virtual: true });
  status("s1").update({ phase: "ARMED", lane: "anthropic-api", mode: "on" });
  const s2 = status("s2");
  s2.update({ phase: "BUSY", lane: "github-copilot", mode: "observe" });
  s2.recomputeGlobal();
  const g = global();
  assert.equal(g.text, "keepwarm on · 2 sessions (1 idle) · today 3 episodes, 2 returns, 5 pings, $0.63");
  assert.deepEqual(g.detail.today, { episodes: 3, humanReturns: 2, wouldWarm: 4, pings: 5, usd: 0.625 });
  assert.deepEqual(g.detail.lanes, { "anthropic-api": "on", "github-copilot": "observe" });
});

test("mode is off without config.json and shadow for a bad mode", () => {
  const a = setup({ mode: null });
  const sa = a.status("s1");
  sa.update({ phase: "BUSY" });
  sa.recomputeGlobal();
  assert.equal(a.global().detail.mode, "off");
  assert.match(a.global().text, /^keepwarm off · /);
  const b = setup({ mode: "loud" });
  const sb = b.status("s1");
  sb.update({ phase: "BUSY" });
  sb.recomputeGlobal();
  assert.equal(b.global().detail.mode, "shadow");
});

// ---- debounced writes, recomputeGlobal contract (review N3/N4) ----------------

function debounced(opts = {}) {
  const env = setup(opts);
  const make = (id, debounceMs = 1000) =>
    createStatus({
      home: env.home,
      sessionId: id,
      now: env.clock.now,
      debounceMs,
      setTimeout: env.clock.setTimeout,
      clearTimeout: env.clock.clearTimeout,
    });
  return { ...env, make };
}

test("update with debounceMs holds the file until the timer fires; rapid updates make one write with the last values", async () => {
  const { clock, L, make } = debounced();
  const s = make("s1");
  const t0 = clock.now();
  s.update({ phase: "HELD", tAwayMin: 1 });
  await clock.advance(400);
  s.update({ phase: "ARMED", tAwayMin: 2 });
  s.update({ phase: "ARMED", tAwayMin: 3 });
  s.update({ phase: "PINGING", tAwayMin: 4 });
  s.update({ phase: "OBSERVING", tAwayMin: 5 });
  assert.equal(existsSync(L.sessionStatus("s1")), false, "nothing written before the timer");
  assert.equal(clock.pendingCount(), 1, "one timer, not one per update");
  await clock.advance(599);
  assert.equal(existsSync(L.sessionStatus("s1")), false, "still held 1ms before the deadline");
  await clock.advance(1);
  const f = readJsonSafe(L.sessionStatus("s1"));
  assert.equal(f.phase, "OBSERVING");
  assert.equal(f.tAwayMin, 5);
  assert.equal(f.ts, t0 + 1000, "written once, when the timer fired");
  assert.equal(clock.pendingCount(), 0);
  await clock.advance(5000);
  assert.equal(readJsonSafe(L.sessionStatus("s1")).ts, t0 + 1000, "no further writes");
  s.update({ phase: "BUSY" });
  assert.equal(clock.pendingCount(), 1, "a new update after the fire schedules again");
});

test("the debounce timer is unref'd", () => {
  const { clock, make } = debounced();
  let unrefs = 0;
  const s = createStatus({
    home: tmpHome(),
    sessionId: "s1",
    now: clock.now,
    debounceMs: 1000,
    setTimeout: (fn, ms) => {
      const h = clock.setTimeout(fn, ms);
      h.unref = () => {
        unrefs++;
        return h;
      };
      return h;
    },
    clearTimeout: clock.clearTimeout,
  });
  s.update({ phase: "BUSY" });
  assert.equal(unrefs, 1);
  s.close();
  void make;
});

test("debounceMs 0 writes the session file immediately and schedules nothing", () => {
  const { clock, L, make } = debounced();
  const s = make("s1", 0);
  s.update({ phase: "BUSY" });
  assert.equal(readJsonSafe(L.sessionStatus("s1")).phase, "BUSY");
  assert.equal(clock.pendingCount(), 0);
});

test("update never rewrites _global.json unless the episode opens or closes", () => {
  const { L, global, make } = debounced();
  const s = make("s1", 0);
  s.update({ phase: "BUSY" });
  assert.equal(existsSync(L.globalStatus), false, "plain update does not create _global");
  s.heartbeat();
  const sentinel = { sentinel: true };
  atomicWriteJson(L.globalStatus, sentinel);
  s.update({ phase: "HELD", lane: "anthropic-api", mode: "shadow" });
  s.update({ tAwayMin: 3, nextTickMs: 99, self: "disabled" });
  s.update({ episode: undefined });
  assert.deepEqual(global(), sentinel, "updates that keep the episode closed leave _global alone");
  s.update({ episode: "s1:1" });
  assert.notDeepEqual(global(), sentinel, "opening an episode recomputes _global");
  assert.equal(global().detail.sessions.count, 1);
  atomicWriteJson(L.globalStatus, sentinel);
  s.update({ episode: "s1:1", phase: "ARMED" });
  s.update({ episode: "s1:2" });
  assert.deepEqual(global(), sentinel, "changing between two open episodes is not an open/close");
  s.update({ episode: null });
  assert.notDeepEqual(global(), sentinel, "closing the episode recomputes _global");
  assert.equal(global().detail.sessions.count, 1);
});

test("episode open and close flush the pending write immediately and recompute _global", async () => {
  const { clock, L, global, make } = debounced();
  const s = make("s1");
  s.update({ phase: "HELD", lane: "anthropic-api", mode: "shadow" });
  assert.equal(existsSync(L.sessionStatus("s1")), false);
  s.update({ episode: "s1:1", phase: "ARMED" });
  assert.equal(readJsonSafe(L.sessionStatus("s1")).phase, "ARMED", "flushed with the earlier pending values");
  assert.equal(readJsonSafe(L.sessionStatus("s1")).episode, "s1:1");
  assert.equal(clock.pendingCount(), 0, "timer cancelled");
  assert.deepEqual(global().detail.sessions, { count: 1, idle: 1, warming: 1 });
  s.update({ phase: "OBSERVING" });
  s.update({ episode: null });
  assert.equal(readJsonSafe(L.sessionStatus("s1")).phase, "OBSERVING");
  assert.equal(readJsonSafe(L.sessionStatus("s1")).episode, null);
  assert.deepEqual(global().detail.sessions, { count: 1, idle: 1, warming: 0 });
});

test("saveEpisode writes synchronously with pending state and cancels the timer", async () => {
  const { clock, L, make } = debounced();
  const s = make("s1");
  s.update({ phase: "ARMED", lane: "anthropic-api" });
  assert.equal(existsSync(L.sessionStatus("s1")), false);
  const ep = { episode: "s1:1", seq: 1 };
  s.saveEpisode(ep);
  const f = readJsonSafe(L.sessionStatus("s1"));
  assert.equal(f.phase, "ARMED", "pending merged state is included");
  assert.equal(f.lane, "anthropic-api");
  assert.deepEqual(f.episodeState, ep);
  assert.equal(clock.pendingCount(), 0);
  const ts = f.ts;
  await clock.advance(5000);
  assert.equal(readJsonSafe(L.sessionStatus("s1")).ts, ts, "the cancelled timer never writes again");
  assert.deepEqual(s.loadEpisode(), ep);
});

test("flush writes a pending update and is a no-op otherwise", async () => {
  const { clock, L, make } = debounced();
  const s = make("s1");
  s.flush();
  assert.equal(existsSync(L.sessionStatus("s1")), false, "nothing pending: nothing written");
  s.update({ phase: "HELD" });
  s.flush();
  assert.equal(readJsonSafe(L.sessionStatus("s1")).phase, "HELD");
  assert.equal(clock.pendingCount(), 0);
  const ts = readJsonSafe(L.sessionStatus("s1")).ts;
  await clock.jump(10);
  s.flush();
  assert.equal(readJsonSafe(L.sessionStatus("s1")).ts, ts, "second flush writes nothing");
});

test("heartbeat writes the session file and _global, cancelling a pending write", () => {
  const { clock, L, global, make } = debounced();
  const s = make("s1");
  s.update({ phase: "HELD", lane: "codex-subscription", mode: "on" });
  assert.equal(existsSync(L.sessionStatus("s1")), false);
  s.heartbeat();
  assert.equal(readJsonSafe(L.sessionStatus("s1")).phase, "HELD");
  assert.equal(clock.pendingCount(), 0);
  assert.deepEqual(global().detail.sessions, { count: 1, idle: 1, warming: 0 });
  assert.deepEqual(global().detail.lanes, { "codex-subscription": "on" });
});

test("close flushes, keeps a detached file when episodeState exists, recomputes _global and clears the timer", async () => {
  const { clock, L, global, make } = debounced();
  const s = make("s1");
  s.saveEpisode({ episode: "s1:1", seq: 1 });
  s.update({ lane: "anthropic-api", mode: "on", tAwayMin: 7 });
  assert.equal(clock.pendingCount(), 1);
  s.close();
  assert.equal(clock.pendingCount(), 0);
  const f = readJsonSafe(L.sessionStatus("s1"));
  assert.equal(f.phase, "detached");
  assert.equal(f.tAwayMin, 7, "the pending update was flushed, not dropped");
  assert.deepEqual(f.episodeState, { episode: "s1:1", seq: 1 });
  assert.deepEqual(global().detail.sessions, { count: 1, idle: 0, warming: 0 });
  await clock.advance(5000);
  assert.equal(readJsonSafe(L.sessionStatus("s1")).phase, "detached");
});

test("close without episodeState removes the file, leaves no timer and does not resurrect it", async () => {
  const { clock, L, global, make } = debounced();
  const s = make("s1");
  s.update({ phase: "HELD" });
  s.heartbeat();
  s.update({ phase: "BUSY" });
  assert.equal(clock.pendingCount(), 1);
  s.close();
  assert.equal(clock.pendingCount(), 0);
  assert.equal(existsSync(L.sessionStatus("s1")), false);
  assert.equal(global().detail.sessions.count, 0);
  await clock.advance(5000);
  assert.equal(existsSync(L.sessionStatus("s1")), false);
});

test("recomputeGlobal ignores an EPERM/EBUSY/EACCES failure of the _global write but rethrows other errors", () => {
  const { L, make } = debounced();
  const s = make("s1", 0);
  s.update({ phase: "HELD" });
  // A directory where _global.json should go: renaming a file onto it fails with EPERM on Windows (EISDIR elsewhere).
  mkdirSync(L.globalStatus, { recursive: true });
  if (process.platform === "win32") {
    assert.doesNotThrow(() => s.recomputeGlobal());
    assert.doesNotThrow(() => s.heartbeat());
  } else {
    assert.throws(() => s.recomputeGlobal(), (e) => e.code === "EISDIR");
  }
  assert.equal(readJsonSafe(L.sessionStatus("s1")).phase, "HELD", "the session file is unaffected");
  assert.deepEqual(readdirSync(L.statusDir).filter((n) => n.startsWith(".tmp-")), [], "no temp file left behind");

  // A regular file where the status folder should be: ensureDir fails with EEXIST/ENOTDIR, which must propagate.
  const other = debounced();
  const o = other.make("s2", 0);
  writeFileSync(other.L.statusDir, "not a folder");
  assert.throws(() => o.recomputeGlobal(), (e) => e.code === "EEXIST" || e.code === "ENOTDIR");
});
