import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRecorder, SCHEMA } from "../src/records.mjs";
import { readJsonLines } from "../src/fsx.mjs";
import { layout } from "../src/paths.mjs";
import { createFakeClock, tmpHome } from "./helpers/fake-host.mjs";

const FORBIDDEN = ["content", "text", "apiKey", "headers", "prompt"];

const EXPECTED = {
  session: ["reason", "mode", "sessionKind", "uiMode", "keepwarmVersion", "cwd", "restored"],
  episode_open: [
    "episode", "awayStartMs", "openedBy", "lane", "provider", "api", "model", "thinking",
    "contextTokens", "habit", "r", "expiry", "maxPings", "mode", "warmPath", "verified",
  ],
  segment_open: [
    "episode", "segment", "reason", "anchorMs", "lane", "model", "eligible", "disabledReason", "otherWakeSources",
  ],
  decision: ["episode", "segment", "tick", "tAwayMin", "hazard", "r", "action", "reason", "lateByMs"],
  ping: ["episode", "segment", "tick", "ok", "hit", "usage", "costUsd", "durationMs", "error", "stale"],
  warm_stop: ["episode", "segment", "reason"],
  turn: ["episode", "segment", "kind", "source", "startMs"],
  marker: ["episode", "kind", "atMs"],
  episode_close: [
    "episode", "closedAtMs", "awayMin", "kind", "source", "detail", "segments", "turns", "decisions",
    "wouldWarm", "pings", "costUsd", "virtualUsd", "expired", "coveredAtReturn", "coldWithoutWarm", "markers",
  ],
  return_usage: ["episode", "model", "input", "output", "cacheRead", "cacheWrite", "sinceRealAnchorSec"],
};

function allKeys(v, acc = new Set()) {
  if (Array.isArray(v)) for (const x of v) allKeys(x, acc);
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      acc.add(k);
      allKeys(x, acc);
    }
  }
  return acc;
}

function setup(startMs) {
  const home = tmpHome();
  const clock = createFakeClock(startMs);
  const rec = createRecorder({ home, sessionId: "s1", now: clock.now });
  return { home, clock, rec, file: (ms) => layout(home).recordFile("s1", ms) };
}

test("schema matches the contract for every type", () => {
  assert.deepEqual(SCHEMA, EXPECTED);
});

test("line format: v, ts ISO, type, session, then fields", () => {
  const { rec, clock, file } = setup(new Date(2026, 5, 15, 12, 0, 0).getTime());
  rec.write("warm_stop", { episode: "s1:1", segment: 2, reason: "compacting" });
  const lines = readJsonLines(file(clock.now()));
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0], {
    v: 1,
    ts: new Date(clock.now()).toISOString(),
    type: "warm_stop",
    session: "s1",
    episode: "s1:1",
    segment: 2,
    reason: "compacting",
  });
});

test("every type writes all required fields, null when missing", () => {
  const { rec, clock, file } = setup(new Date(2026, 5, 15, 12, 0, 0).getTime());
  for (const type of Object.keys(EXPECTED)) rec.write(type, {});
  const lines = readJsonLines(file(clock.now()));
  assert.equal(lines.length, Object.keys(EXPECTED).length);
  for (const line of lines) {
    const keys = EXPECTED[line.type];
    assert.deepEqual(Object.keys(line), ["v", "ts", "type", "session", ...keys], line.type);
    for (const k of keys) {
      if (line.type === "episode_close" && k === "markers") assert.deepEqual(line[k], []);
      else assert.equal(line[k], null, `${line.type}.${k}`);
    }
  }
});

test("nested shapes are kept and filled", () => {
  const { rec, clock, file } = setup(new Date(2026, 5, 15, 12, 0, 0).getTime());
  rec.write("episode_open", {
    episode: "s1:1",
    habit: { p: 0.81, mMin: 10.5, t90Min: 140, source: "default" },
    expiry: { formulaMin: 60, autoMin: 60, effectiveMin: 60, source: "auto" },
  });
  rec.write("ping", {
    usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
    error: { kind: "timeout", message: "x" },
  });
  const markers = Array.from({ length: 40 }, (_, i) => ({ kind: "m", atMs: i }));
  rec.write("episode_close", { markers });
  const [open, ping, close] = readJsonLines(file(clock.now()));
  assert.deepEqual(open.habit, { p: 0.81, mMin: 10.5, t90Min: 140, source: "default" });
  assert.deepEqual(open.expiry, { formulaMin: 60, autoMin: 60, requestedMin: null, effectiveMin: 60, source: "auto" });
  assert.deepEqual(ping.usage, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });
  assert.deepEqual(ping.error, { kind: "timeout", message: "x", status: null });
  assert.equal(close.markers.length, 32);
  assert.deepEqual(close.markers[0], { kind: "m", atMs: 8 });
  assert.deepEqual(close.markers[31], { kind: "m", atMs: 39 });
});

test("unknown type throws and writes nothing", () => {
  const { rec, clock, file } = setup(new Date(2026, 5, 15, 12, 0, 0).getTime());
  assert.throws(() => rec.write("bogus", {}), /unknown record type/);
  assert.equal(existsSync(file(clock.now())), false);
});

test("records go to local month folders", async () => {
  const { rec, clock, home } = setup(new Date(2026, 0, 31, 23, 59, 0).getTime());
  rec.write("marker", { kind: "a" });
  await clock.jump(2 * 60_000);
  rec.write("marker", { kind: "b" });
  const dir = layout(home).recordsDir;
  assert.deepEqual(readdirSync(dir).sort(), ["2026-01", "2026-02"]);
  assert.deepEqual(readJsonLines(join(dir, "2026-01", "s1.jsonl")).map((l) => l.kind), ["a"]);
  assert.deepEqual(readJsonLines(join(dir, "2026-02", "s1.jsonl")).map((l) => l.kind), ["b"]);
});

test("no content, text, apiKey, headers or prompt keys ever reach a record", () => {
  const { rec, clock, file } = setup(new Date(2026, 5, 15, 12, 0, 0).getTime());
  const poison = { content: "c", text: "t", apiKey: "k", headers: { a: 1 }, prompt: "p" };
  for (const type of Object.keys(EXPECTED)) {
    rec.write(type, {
      ...poison,
      habit: { ...poison },
      expiry: { ...poison },
      usage: { ...poison },
      error: { ...poison, message: "m" },
      markers: [{ kind: "k", atMs: 1, ...poison }],
    });
  }
  const lines = readJsonLines(file(clock.now()));
  assert.equal(lines.length, Object.keys(EXPECTED).length);
  const keys = allKeys(lines);
  for (const k of FORBIDDEN) assert.equal(keys.has(k), false, k);
});
