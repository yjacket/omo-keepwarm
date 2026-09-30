import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createRecorder } from "../src/records.mjs";
import { buildReport, formatMinutes, formatReport } from "../src/report.mjs";
import { run as reportCli } from "../src/cli/report.mjs";
import { tmpHome } from "./helpers/fake-host.mjs";

const NOW = Date.UTC(2026, 8, 20, 12, 0, 0);
const MIN = 60_000;
const DAY = 86_400_000;

function episode(home, e) {
  const { session = "s1", seq, startMs, awayMin, kind, source, lane, contextTokens, r, wouldWarm = 0, pings = 0,
    costUsd = 0, covered = false, cold = false, turns = [], returnWrites = [], returnUsages = [] } = e;
  const id = `${session}:${seq}`;
  const at = (ms) => createRecorder({ home, sessionId: session, now: () => ms });
  at(startMs).write("episode_open", { episode: id, awayStartMs: startMs, lane, contextTokens, r });
  for (const [kindT, src] of turns) at(startMs + MIN).write("turn", { episode: id, segment: 1, kind: kindT, source: src });
  const closeMs = startMs + awayMin * MIN;
  at(closeMs).write("episode_close", {
    episode: id, closedAtMs: closeMs, awayMin, kind, source, wouldWarm, pings, costUsd,
    coveredAtReturn: covered, coldWithoutWarm: cold,
  });
  for (const w of returnWrites) {
    at(closeMs + 1000).write("return_usage", { episode: id, input: 10, output: 5, cacheRead: 0, cacheWrite: w });
  }
  for (const u of returnUsages) {
    at(closeMs + 1000).write("return_usage", { episode: id, input: u.input, output: 5, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite });
  }
}

function fixture(home) {
  const base = NOW - 2 * DAY;
  const claude = { lane: "claude-subscription", contextTokens: 50000, r: 0.025 };
  episode(home, { ...claude, seq: 1, startMs: base, awayMin: 10, kind: "human_return", source: "input:interactive",
    covered: true, cold: true, wouldWarm: 2, turns: [["automated", "goal"]], returnWrites: [40000, 999] });
  episode(home, { ...claude, seq: 2, startMs: base + 3600 * 1000, awayMin: 30, kind: "human_return", source: "input:rpc",
    returnWrites: [1000] });
  episode(home, { ...claude, seq: 3, startMs: base + 7200 * 1000, awayMin: 50, kind: "human_return", source: "input:interactive",
    covered: true, wouldWarm: 1, returnWrites: [500] });
  episode(home, { ...claude, seq: 4, startMs: base + 3 * 3600 * 1000, awayMin: 200, kind: "censored", source: "session_shutdown",
    wouldWarm: 3, turns: [["automated", "task"], ["automated", "task"], ["unattributed", "user_message_without_input"]] });
  episode(home, { session: "s2", seq: 1, lane: "anthropic-api", contextTokens: 30000, r: 0.08, startMs: base, awayMin: 5,
    kind: "human_return", source: "input:interactive", covered: true, cold: true, wouldWarm: 1, pings: 2, costUsd: 0.012,
    returnWrites: [30000] });
  // outside a 7-day window
  episode(home, { ...claude, session: "old", seq: 1, startMs: NOW - 10 * DAY, awayMin: 20, kind: "human_return",
    source: "input:interactive", pings: 9 });
}

test("formatMinutes", () => {
  assert.equal(formatMinutes(0), "0");
  assert.equal(formatMinutes(45), "45m");
  assert.equal(formatMinutes(10.5), "10.5m");
  assert.equal(formatMinutes(60), "1h");
  assert.equal(formatMinutes(720), "12h");
  assert.equal(formatMinutes(140), "2h20m");
  assert.equal(formatMinutes(330), "5h30m");
});

test("buildReport aggregates per lane over the window", (t) => {
  const home = tmpHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  fixture(home);
  const r = buildReport(home, { days: 7, now: () => NOW });
  assert.deepEqual(Object.keys(r.lanes).sort(), ["anthropic-api", "claude-subscription"]);
  const c = r.lanes["claude-subscription"];
  assert.equal(c.episodes, 4);
  assert.deepEqual(c.closeKinds, { human_return: 3, censored: 1 });
  assert.deepEqual(c.closeSources, { "input:interactive": 2, "input:rpc": 1, session_shutdown: 1 });
  assert.deepEqual(c.automatedTurnSources, { goal: 1, task: 2 });
  assert.equal(c.humanReturns, 3);
  assert.deepEqual(c.awayMinQuartiles, { q1: 20, median: 30, q3: 40 });
  assert.equal(c.modeledReturns, 3);
  assert.equal(c.coveredAtReturn, 2);
  assert.ok(Math.abs(c.coveredAtReturnRate - 2 / 3) < 1e-12);
  // No ping was sent, so the measured return usage decides: all three returns rewrote (cacheRead 0).
  assert.equal(c.coldWithoutWarm, 3);
  assert.equal(c.coldEstimated, 0);
  assert.equal(c.returnCacheWrite, 41500, "first return_usage per episode only");
  // (40000 + 500) covered&cold return writes - (2+0+1+3) * 50000 * 0.025
  assert.equal(c.returnWriteAvoided, 40500);
  assert.equal(c.wouldWarmWriteCost, 7500);
  assert.equal(c.savedWriteTokens, 33000);
  assert.equal(c.pings, 0);
  const a = r.lanes["anthropic-api"];
  // Pings were sent, so the return usage shows the warmed state and the estimate stays.
  assert.equal(a.coldWithoutWarm, 1);
  assert.equal(a.coldEstimated, 1);
  assert.ok(Math.abs(a.savedWriteTokens - 27600) < 1e-6);
  assert.equal(a.pings, 2);
  assert.ok(Math.abs(a.costUsd - 0.012) < 1e-12);
  assert.equal(r.total.episodes, 5);
  assert.equal(r.total.pings, 2);
  assert.ok(Math.abs(r.total.savedWriteTokens - 60600) < 1e-6);

  const wide = buildReport(home, { days: 28, now: () => NOW });
  assert.equal(wide.total.episodes, 6);
  assert.equal(wide.total.pings, 11);
});

test("report CLI: text, --json and --days validation", async (t) => {
  const home = tmpHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  fixture(home);
  const mk = () => {
    const o = { out: "", err: "" };
    return { o, io: { stdout: (x) => (o.out += x), stderr: (x) => (o.err += x), env: { OMO_KEEPWARM_HOME: home }, now: () => NOW, cwd: "." } };
  };
  const text = mk();
  assert.equal(await reportCli([], text.io), 0);
  assert.match(text.o.out, /^keepwarm report · last 7 days · 5 episodes/);
  assert.match(text.o.out, /claude-subscription {2}4 episodes · 3 human returns/);
  assert.match(text.o.out, /q1 20m · median 30m · q3 40m/);
  assert.match(text.o.out, /anthropic-api[^\n]*\n(?:[^\n]*\n){4} {2}covered at return 100% \(1\/1\) · cold without warm 1 \(est\. 1\) · /);
  assert.equal(text.o.out, formatReport(buildReport(home, { days: 7, now: () => NOW })));
  const json = mk();
  assert.equal(await reportCli(["--json", "--days", "28"], json.io), 0);
  assert.equal(JSON.parse(json.o.out).total.episodes, 6);
  const bad = mk();
  assert.equal(await reportCli(["--days", "x"], bad.io), 2);
  const empty = tmpHome();
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  const e = mk();
  e.io.env = { OMO_KEEPWARM_HOME: empty };
  assert.equal(await reportCli([], e.io), 0);
  assert.equal(e.o.out, "keepwarm report · last 7 days · 0 episodes\n");
});

test("cache facts only on modeled lanes, and a measured hit overrides the TTL estimate", (t) => {
  const home = tmpHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const base = NOW - DAY;
  // An observe lane (r null) whose provider reports no cache at all, like kiro-lb.
  const other = { session: "k", lane: "other", contextTokens: 150000, r: null, kind: "human_return", source: "input:interactive" };
  episode(home, { ...other, seq: 1, startMs: base, awayMin: 6, covered: false, cold: true,
    returnUsages: [{ input: 155565, cacheRead: 0, cacheWrite: 0 }] });
  episode(home, { ...other, seq: 2, startMs: base + 10 * MIN, awayMin: 3, covered: true,
    returnUsages: [{ input: 181822, cacheRead: 0, cacheWrite: 0 }] });
  // The estimate says cold (3600.25 s after the last request), the return request read the whole prefix.
  episode(home, { session: "c", seq: 1, lane: "claude-subscription", contextTokens: 450000, r: 0.025, startMs: base,
    awayMin: 1, kind: "human_return", source: "input:interactive", covered: true, cold: true, wouldWarm: 1,
    returnUsages: [{ input: 2, cacheRead: 450542, cacheWrite: 149 }] });
  const r = buildReport(home, { days: 7, now: () => NOW });
  const o = r.lanes.other;
  assert.equal(o.humanReturns, 2);
  assert.equal(o.modeledReturns, 0);
  assert.equal(o.coveredAtReturn, 0);
  assert.equal(o.coveredAtReturnRate, null);
  assert.equal(o.coldWithoutWarm, 0);
  const c = r.lanes["claude-subscription"];
  assert.equal(c.coveredAtReturnRate, 1);
  assert.equal(c.coldWithoutWarm, 0);
  assert.equal(c.coldEstimated, 0);
  assert.equal(c.returnWriteAvoided, 0);
  assert.equal(c.wouldWarmWriteCost, 11250);
  assert.equal(c.savedWriteTokens, -11250);
  assert.equal(r.total.modeledReturns, 1);
  assert.equal(r.total.coveredAtReturnRate, 1);
  const text = formatReport(r);
  assert.match(text, /\nother {2}2 episodes · 2 human returns\n(?:[^\n]*\n){4} {2}covered at return - · cold without warm - · return cacheWrite 0\n/);
  assert.match(text, /\nclaude-subscription {2}1 episodes[^\n]*\n(?:[^\n]*\n){4} {2}covered at return 100% \(1\/1\) · cold without warm 0 · /);
  assert.match(text, / {2}counterfactual saving -11250 write-eq tokens = return writes avoided 0 - would-warm cost 11250 \(would-warm 1\)\n/);
});
