import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { atomicWriteJson } from "../src/fsx.mjs";
import { layout } from "../src/paths.mjs";
import { Z90, phi } from "../src/policy.mjs";
import { createRecorder } from "../src/records.mjs";
import { createConfigSource } from "../src/config.mjs";
import { estimate, loadEpisodes, maybeAutoCalibrate, statusOf } from "../src/calibrate.mjs";
import { run as calibrateCli } from "../src/cli/calibrate.mjs";
import { tmpHome } from "./helpers/fake-host.mjs";

const NOW = Date.UTC(2026, 8, 20, 12, 0, 0);
const MIN = 60_000;
const TRUE = { mMin: 10.5, t90Min: 140 };

function invPhi(q) {
  let lo = -10;
  let hi = 10;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (phi(mid) < q) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function writeEpisode(home, { session = "s1", seq, startMs, awayMin, kind, source = "input:interactive", detail = null, lane = "claude-subscription" }) {
  const episode = `${session}:${seq}`;
  createRecorder({ home, sessionId: session, now: () => startMs }).write("episode_open", {
    episode, awayStartMs: startMs, openedBy: "settled", lane, provider: "claude-sdk", api: "claude-sdk-oauth",
    model: "opus", contextTokens: 50000, habit: { p: 0.81, ...TRUE, source: "default" }, r: 0.025, mode: "shadow",
  });
  createRecorder({ home, sessionId: session, now: () => startMs + awayMin * MIN }).write("episode_close", {
    episode, closedAtMs: startMs + awayMin * MIN, awayMin, kind, source, detail, segments: 1, turns: 0, decisions: 0,
    wouldWarm: 0, pings: 0, costUsd: 0, virtualUsd: 0, expired: false, coveredAtReturn: false, coldWithoutWarm: false,
  });
}

// Deterministic competing-risks sample (lognormal quantiles, no randomness):
// - nReturns human returns ~ lognormal(TRUE.mMin, TRUE.t90Min)
// - nEnded context ends (session_shutdown quit|new|resume|fork) ~ lognormal(median 60m, t90 600m)
// - independent censoring: every 2nd subject of each group gets a censoring time from a fixed
//   schedule unrelated to its event time; if it comes first the close is reload/restore_failed.
// True return CIF = nReturns / (nReturns + nEnded) * lognormal CDF.
const ENDED = ["quit", "new", "resume", "fork"];
function synthetic(home, { nReturns, nEnded = 0, censor = true }) {
  const quant = (i, n, m, t90) => Math.exp(Math.log(m) + ((Math.log(t90) - Math.log(m)) / Z90) * invPhi((i - 0.5) / n));
  let seq = 0;
  const startOf = (i) => NOW - 20 * 86_400_000 + i * 60 * MIN;
  const emit = (j, t, event) => {
    const c = censor && j % 2 === 0 ? 1 + ((j * 37) % 97) : Infinity; // 1..97 min, scrambled by j
    const base = { seq: ++seq, startMs: startOf(seq) };
    if (c < t) {
      const other = j % 8 === 0
        ? { kind: "censored", source: "session_shutdown", detail: "reload" }
        : { kind: "censored", source: "restore_failed" };
      writeEpisode(home, { ...base, awayMin: c, ...other });
    } else writeEpisode(home, { ...base, awayMin: Math.round(t * 100) / 100, ...event });
  };
  for (let i = 1; i <= nReturns; i++) emit(i, quant(i, nReturns, TRUE.mMin, TRUE.t90Min), { kind: "human_return" });
  for (let i = 1; i <= nEnded; i++) {
    emit(i, quant(i, nEnded, 60, 600), { kind: "censored", source: "session_shutdown", detail: ENDED[i % 4] });
  }
}

const cliIo = (home) => {
  const o = { out: "", err: "" };
  return {
    o,
    io: { stdout: (x) => (o.out += x), stderr: (x) => (o.err += x), env: { OMO_KEEPWARM_HOME: home }, now: () => NOW, cwd: "." },
  };
};

const within = (actual, expected, tol = 0.1) =>
  assert.ok(Math.abs(actual - expected) <= tol * expected, `${actual} not within ${tol * 100}% of ${expected}`);

// Return CIF at the horizon for synthetic({ nReturns: 200, nEnded: 100 }).
const S_TRUE = (Math.log(TRUE.t90Min) - Math.log(TRUE.mMin)) / Z90;
const P_TRUE = (200 / 300) * phi(Math.log(1440 / TRUE.mMin) / S_TRUE);

test("Aalen-Johansen on 200 returns + 100 context ends + independent censoring recovers p, m, t90 within 10%", (t) => {
  const home = tmpHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  synthetic(home, { nReturns: 200, nEnded: 100 });
  const eps = loadEpisodes(home, { sinceDays: 28, now: NOW });
  assert.equal(eps.length, 300);
  const est = estimate(eps);
  assert.equal(est.episodes, 300);
  assert.equal(est.humanReturns + est.competingEnds + est.censored, 300);
  assert.ok(est.humanReturns > 120 && est.competingEnds > 40 && est.censored >= 40, JSON.stringify(est));
  within(est.p, P_TRUE);
  within(est.mMin, TRUE.mMin);
  within(est.t90Min, TRUE.t90Min);
  assert.equal(est.pTruncatedAtMin, null);
  assert.ok(est.fit >= 0 && est.fit < 0.05, `fit ${est.fit}`);
  assert.equal(est.mMin * 2, Math.round(est.mMin * 2), "m on 0.5 minute grid");
});

test("statusOf: return = 1, session_shutdown quit|new|resume|fork = 2, everything else censored", () => {
  assert.equal(statusOf({ kind: "human_return", source: "input:interactive" }), 1);
  for (const detail of ["quit", "new", "resume", "fork"]) {
    assert.equal(statusOf({ kind: "censored", source: "session_shutdown", detail }), 2, detail);
  }
  for (const e of [
    { kind: "censored", source: "session_shutdown", detail: "reload" },
    { kind: "censored", source: "restore_failed" },
    { kind: "censored", source: "child_work" },
    { kind: "censored", source: "config_off" },
    { kind: null, source: null },
  ]) assert.equal(statusOf(e), 0, JSON.stringify(e));
});

test("competing ends are not censorings: relabeling them as censored inflates p", () => {
  const eps = [
    { awayMin: 10, kind: "human_return" },
    { awayMin: 20, kind: "censored", source: "session_shutdown", detail: "quit" },
    { awayMin: 30, kind: "human_return" },
    { awayMin: 40, kind: "censored", source: "session_shutdown", detail: "new" },
  ];
  // AJ: F1(10) = 1/4, S = 3/4; end at 20 -> S = 1/2; F1(30) = 1/4 + (1/2)(1/2) = 1/2
  assert.ok(Math.abs(estimate(eps).p - 0.5) < 1e-12);
  const asCensored = eps.map((e) => (e.kind === "censored" ? { ...e, detail: "reload" } : e));
  // ends treated as censorings (plain KM): S = 3/4, then 3/4 * 1/2 -> F = 5/8
  assert.ok(Math.abs(estimate(asCensored).p - 0.625) < 1e-12);
});

test("estimate: p falls back to the last F and records pTruncatedAtMin when observation stops early", () => {
  const eps = [10, 20, 30, 40].map((awayMin) => ({ awayMin, kind: "human_return" }));
  eps.push({ awayMin: 100, kind: "censored", source: "restore_failed" });
  const est = estimate(eps);
  // no competing ends, 5 at risk: F = 0.2, 0.4, 0.6, 0.8 -> F(last) = 0.8
  assert.ok(Math.abs(est.p - 0.8) < 1e-12, String(est.p));
  assert.equal(est.pTruncatedAtMin, 100);
  assert.equal(est.mMin, 20);
  assert.equal(est.t90Min, 40);
});

test("loadEpisodes pairs open/close, drops out-of-window episodes, and optionally keeps still-open ones", (t) => {
  const home = tmpHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeEpisode(home, { seq: 1, startMs: NOW - 2 * 86_400_000, awayMin: 30, kind: "human_return" });
  writeEpisode(home, { seq: 2, startMs: NOW - 40 * 86_400_000, awayMin: 30, kind: "human_return" });
  createRecorder({ home, sessionId: "s1", now: () => NOW - 60 * MIN }).write("episode_open", {
    episode: "s1:3", awayStartMs: NOW - 60 * MIN, lane: "claude-subscription",
  });
  createRecorder({ home, sessionId: "s1", now: () => NOW - 15 * MIN }).write("decision", {
    episode: "s1:3", segment: 1, tick: 1, action: "would_warm",
  });
  const eps = loadEpisodes(home, { sinceDays: 28, now: NOW });
  assert.deepEqual(eps.map((e) => e.episode), ["s1:1"]);
  assert.equal(eps[0].lane, "claude-subscription");
  assert.equal(eps[0].awayMin, 30);
  // still-open observation: right-censored at its last record (45 minutes after awayStart)
  const withOpen = loadEpisodes(home, { sinceDays: 28, now: NOW, includeOpen: true });
  assert.deepEqual(withOpen.map((e) => e.episode), ["s1:1", "s1:3"]);
  assert.equal(withOpen[1].awayMin, 45);
  assert.equal(withOpen[1].kind, null);
  const est = estimate(withOpen);
  assert.equal(est.censored, 1);
  assert.equal(est.humanReturns, 1);
});

test("29 human returns: calibrate --write exits 2 and writes nothing; auto-calibrate skips", async (t) => {
  const home = tmpHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  synthetic(home, { nReturns: 29, nEnded: 5, censor: false });
  const { o, io } = cliIo(home);
  assert.equal(await calibrateCli(["--write"], io), 2);
  assert.match(o.out, /human returns 29 /);
  assert.equal(existsSync(layout(home).behavior), false);
  const r = maybeAutoCalibrate({ home, now: () => NOW });
  assert.equal(r.action, "skip");
  assert.equal(existsSync(layout(home).behavior), false);
});

test("calibrate --write with enough returns writes behavior.json that config reads as observed", async (t) => {
  const home = tmpHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  synthetic(home, { nReturns: 200, nEnded: 100 });
  const expected = estimate(loadEpisodes(home, { sinceDays: 28, now: NOW, includeOpen: true }));
  const { io } = cliIo(home);
  assert.equal(await calibrateCli([], io), 0);
  assert.equal(existsSync(layout(home).behavior), false, "no --write, no file");
  assert.equal(await calibrateCli(["--write"], io), 0);
  const b = JSON.parse(readFileSync(layout(home).behavior, "utf8"));
  assert.equal(b.v, 1);
  assert.equal(b.source, "observed");
  assert.equal(b.windowDays, 28);
  assert.equal(b.humanReturns, expected.humanReturns);
  assert.equal(b.episodes, 300);
  assert.equal(b.p, expected.p);
  assert.equal(b.mMin, expected.mMin);
  assert.equal(b.t90Min, expected.t90Min);
  assert.equal(Date.parse(b.updatedAt), NOW);
  const h = createConfigSource({ home, now: () => NOW }).habit();
  assert.equal(h.source, "observed");
  assert.equal(h.p, b.p);
  const j = cliIo(home);
  assert.equal(await calibrateCli(["--json", "--min-returns", "300"], j.io), 2);
  assert.equal(JSON.parse(j.o.out).usable, false);
});

test("maybeAutoCalibrate: writes when missing, skips within 24h, rewrites after 24h", (t) => {
  const home = tmpHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  synthetic(home, { nReturns: 200, nEnded: 100 });
  const file = layout(home).behavior;
  const first = maybeAutoCalibrate({ home, now: () => NOW });
  assert.equal(first.action, "write");
  const b = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(b).sort(), ["episodes", "fit", "humanReturns", "mMin", "p", "source", "t90Min", "updatedAt", "v", "windowDays"]);
  const before = readFileSync(file, "utf8");
  const mtime = statSync(file).mtimeMs;
  assert.equal(maybeAutoCalibrate({ home, now: () => NOW + 23 * 60 * MIN }).action, "skip");
  assert.equal(readFileSync(file, "utf8"), before);
  assert.equal(statSync(file).mtimeMs, mtime);
  const later = NOW + 25 * 60 * MIN;
  assert.equal(maybeAutoCalibrate({ home, now: () => later }).action, "write");
  assert.equal(Date.parse(JSON.parse(readFileSync(file, "utf8")).updatedAt), later);
});

test("maybeAutoCalibrate skips when habit is manual and never edits config", (t) => {
  const home = tmpHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  synthetic(home, { nReturns: 200, nEnded: 100 });
  const cfg = { v: 1, mode: "shadow", habit: { p: 0.5, medianMinutes: 20, t90Minutes: 200 } };
  atomicWriteJson(layout(home).config, cfg);
  const before = readFileSync(layout(home).config, "utf8");
  const r = maybeAutoCalibrate({ home, now: () => NOW });
  assert.equal(r.action, "skip");
  assert.equal(r.reason, "manual-habit");
  assert.equal(existsSync(layout(home).behavior), false);
  assert.equal(readFileSync(layout(home).config, "utf8"), before);
});
