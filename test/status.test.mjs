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

test("session file shape and _global recomputed on update", () => {
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
  status("s2").update({ phase: "HELD", lane: "codex-subscription", mode: "on" });
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
  status("s1").update({ phase: "HELD", lane: "anthropic-api", mode: "on" });
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
  assert.equal(global().level, "ok");
  s2.update({ self: "disabled" });
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
  status("s2").update({ phase: "BUSY", lane: "github-copilot", mode: "observe" });
  const g = global();
  assert.equal(g.text, "keepwarm on · 2 sessions (1 idle) · today 3 episodes, 2 returns, 5 pings, $0.63");
  assert.deepEqual(g.detail.today, { episodes: 3, humanReturns: 2, wouldWarm: 4, pings: 5, usd: 0.625 });
  assert.deepEqual(g.detail.lanes, { "anthropic-api": "on", "github-copilot": "observe" });
});

test("mode is off without config.json and shadow for a bad mode", () => {
  const a = setup({ mode: null });
  a.status("s1").update({ phase: "BUSY" });
  assert.equal(a.global().detail.mode, "off");
  assert.match(a.global().text, /^keepwarm off · /);
  const b = setup({ mode: "loud" });
  b.status("s1").update({ phase: "BUSY" });
  assert.equal(b.global().detail.mode, "shadow");
});
