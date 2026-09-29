import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { atomicWriteJson } from "../src/fsx.mjs";
import { layout } from "../src/paths.mjs";
import { STALE_AFTER_MS } from "../src/policy.mjs";
import { createStatus } from "../src/status.mjs";
import { expirySettingFor, parseDuration, run as expiryCli } from "../src/cli/expiry.mjs";
import { run as habitCli } from "../src/cli/habit.mjs";
import { run as statusCli } from "../src/cli/status.mjs";
import { tmpHome } from "./helpers/fake-host.mjs";

const NOW = Date.UTC(2026, 8, 20, 12, 0, 0);

const CLAUDE_DEFAULT = [
  "claude-subscription  TTL 60m · ping every 55m · r 0.025 · habit default (p 0.81, m 10.5m, t90 2h20m)",
  "  formula 5h30m → auto 5h · setting auto",
  "  steps: 0 · 1h · 2h · 3h · 4h · [5h] · 6h · 8h · 12h",
].join("\n");

function home(t) {
  const h = tmpHome();
  t.after(() => rmSync(h, { recursive: true, force: true }));
  return h;
}

async function call(run, h, argv, now = NOW) {
  const o = { out: "", err: "" };
  const io = { stdout: (x) => (o.out += x), stderr: (x) => (o.err += x), env: { OMO_KEEPWARM_HOME: h }, now: () => now, cwd: "." };
  o.code = await run(argv, io);
  return o;
}

const block = (out, label) => out.split("\n\n").find((b) => b.startsWith(`${label}  `))?.trimEnd();

test("expiry prints the exact claude-subscription block with the default habit", async (t) => {
  const h = home(t);
  const o = await call(expiryCli, h, []);
  assert.equal(o.code, 0);
  assert.equal(block(o.out, "claude-subscription"), CLAUDE_DEFAULT);
  const keys = o.out.split("\n\n").map((b) => b.split("  ", 1)[0]);
  assert.deepEqual(keys, ["claude-subscription", "codex-subscription:30m", "anthropic-api:5m", "anthropic-api:1h", "openai-api:30m"]);
  for (const key of keys) {
    const b = block(o.out, key);
    assert.equal(b.split("\n").length, 3, key);
    assert.equal((b.match(/\[/g) ?? []).length, 1, `${key} has exactly one bracket`);
  }
  assert.match(block(o.out, "anthropic-api:5m"), /^anthropic-api:5m {2}TTL 5m · ping every 4\.5m · r 0\.08 /);
  assert.match(block(o.out, "anthropic-api:5m"), /formula 18m → auto 20m · setting auto\n {2}steps: 0 · 10m · 15m · \[20m\] · 30m/);
  assert.match(block(o.out, "anthropic-api:1h"), /TTL 60m · ping every 55m · r 0\.05 /);
  assert.match(block(o.out, "openai-api:30m"), /TTL 30m · ping every 27m · r 0\.08 /);
  assert.equal(existsSync(layout(h).config), false, "showing never writes config");
});

test("expiry set validates against the lane grid", async (t) => {
  const h = home(t);
  const bad = await call(expiryCli, h, ["set", "claude-subscription", "7h"]);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /7h is not a step for claude-subscription/);
  assert.match(bad.err, /steps: 0 · 1h · 2h · 3h · 4h · 5h · 6h · 8h · 12h/);
  assert.equal(existsSync(layout(h).config), false);
  assert.equal((await call(expiryCli, h, ["set", "nope", "4h"])).code, 2);
  assert.equal((await call(expiryCli, h, ["set", "claude-subscription", "abc"])).code, 2);
  assert.equal((await call(expiryCli, h, ["set", "codex-subscription:30m", "45m"])).code, 2);
  assert.equal((await call(expiryCli, h, ["set", "claude-subscription"])).code, 2);
  assert.equal(existsSync(layout(h).config), false);
});

test("expiry set moves the bracket and auto restores it", async (t) => {
  const h = home(t);
  const set = await call(expiryCli, h, ["set", "claude-subscription", "4h"]);
  assert.equal(set.code, 0);
  assert.equal(JSON.parse(readFileSync(layout(h).config, "utf8")).expiry["claude-subscription"], 240);
  const after = block((await call(expiryCli, h, [])).out, "claude-subscription");
  assert.equal(
    after,
    [
      "claude-subscription  TTL 60m · ping every 55m · r 0.025 · habit default (p 0.81, m 10.5m, t90 2h20m)",
      "  formula 5h30m → auto 5h · setting 4h",
      "  steps: 0 · 1h · 2h · 3h · [4h] · 5h · 6h · 8h · 12h",
    ].join("\n"),
  );
  assert.equal((await call(expiryCli, h, ["set", "claude-subscription", "0"])).code, 0);
  assert.match(block((await call(expiryCli, h, [])).out, "claude-subscription"), /steps: \[0\] · 1h/);
  assert.equal((await call(expiryCli, h, ["set", "codex-subscription:30m", "90"])).code, 0);
  assert.match(block((await call(expiryCli, h, [])).out, "codex-subscription:30m"), /setting 1h30m\n {2}steps: 0 · 30m · 1h · \[1h30m\] · 2h/);
  assert.equal((await call(expiryCli, h, ["set", "claude-subscription", "auto"])).code, 0);
  assert.equal(block((await call(expiryCli, h, [])).out, "claude-subscription"), CLAUDE_DEFAULT);
});

test("expiry keys: <id>:<gridClass> for multi-class lanes, exact key wins over bare id", async (t) => {
  const h = home(t);
  const cfg = () => JSON.parse(readFileSync(layout(h).config, "utf8")).expiry;
  // exact key validates against its own grid
  assert.equal((await call(expiryCli, h, ["set", "anthropic-api:5m", "20m"])).code, 0);
  assert.equal(cfg()["anthropic-api:5m"], 20);
  const bad = await call(expiryCli, h, ["set", "anthropic-api:1h", "20m"]);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /anthropic-api:1h steps: 0 · 1h · 2h/);
  // bare id applies to every class, so the value must be a step of each grid
  const bareBad = await call(expiryCli, h, ["set", "anthropic-api", "30m"]);
  assert.equal(bareBad.code, 2);
  assert.match(bareBad.err, /anthropic-api:5m steps: .*\nanthropic-api:1h steps: /);
  assert.equal((await call(expiryCli, h, ["set", "anthropic-api", "2h"])).code, 0);
  assert.equal(cfg()["anthropic-api"], 120);
  let out = (await call(expiryCli, h, [])).out;
  assert.match(block(out, "anthropic-api:5m"), /setting 20m\n {2}steps: 0 · 10m · 15m · \[20m\]/, "exact beats bare");
  assert.match(block(out, "anthropic-api:1h"), /setting 2h\n {2}steps: 0 · 1h · \[2h\] · 3h/, "bare fallback");
  // an exact "auto" still wins over a bare number
  assert.equal((await call(expiryCli, h, ["set", "anthropic-api:1h", "auto"])).code, 0);
  out = (await call(expiryCli, h, [])).out;
  assert.match(block(out, "anthropic-api:1h"), /setting auto\n {2}steps: 0 · 1h · 2h · 3h · \[4h\]/);
  assert.equal((await call(expiryCli, h, ["set", "openai-api:30m", "1h"])).code, 0);
  assert.match(block((await call(expiryCli, h, [])).out, "openai-api:30m"), /setting 1h\n/);
  assert.equal((await call(expiryCli, h, ["set", "anthropic-api:30m", "1h"])).code, 2, "no such class");
});

test("expirySettingFor resolution order", () => {
  const lane = { id: "anthropic-api", gridClass: "1h" };
  assert.equal(expirySettingFor({}, lane), "auto");
  assert.equal(expirySettingFor({ "anthropic-api": 120 }, lane), 120);
  assert.equal(expirySettingFor({ "anthropic-api": 120, "anthropic-api:1h": 240 }, lane), 240);
  assert.equal(expirySettingFor({ "anthropic-api": 120, "anthropic-api:1h": "auto" }, lane), "auto");
  assert.equal(expirySettingFor({ "anthropic-api:5m": 20 }, lane), "auto");
});

test("parseDuration", () => {
  assert.equal(parseDuration("90"), 90);
  assert.equal(parseDuration("20m"), 20);
  assert.equal(parseDuration("4h"), 240);
  assert.equal(parseDuration("2h20m"), 140);
  assert.equal(parseDuration("10.5m"), 10.5);
  for (const bad of ["", "h", "4x", "-5", "1h-2m"]) assert.ok(Number.isNaN(parseDuration(bad)), bad);
});

test("habit show, set validation, set, and auto", async (t) => {
  const h = home(t);
  const show = await call(habitCli, h, []);
  assert.equal(show.code, 0);
  assert.match(show.out, /^habit default \(p 0\.81, m 10\.5m, t90 2h20m\)\nsetting auto\n/);

  for (const argv of [
    ["set", "--return-rate", "1.5", "--median", "10m", "--t90", "2h"],
    ["set", "--return-rate", "0", "--median", "10m", "--t90", "2h"],
    ["set", "--return-rate", "0.7", "--median", "3h", "--t90", "2h"],
    ["set", "--return-rate", "0.7", "--median", "zz", "--t90", "2h"],
    ["set", "--return-rate", "0.7", "--median", "10m"],
    ["set", "--return-rate", "0.7", "--median", "10m", "--t90", "2h", "--bogus", "1"],
    ["bogus"],
  ]) {
    const o = await call(habitCli, h, argv);
    assert.equal(o.code, 2, argv.join(" "));
  }
  assert.equal(existsSync(layout(h).config), false, "invalid input never writes");

  const ok = await call(habitCli, h, ["set", "--return-rate", "0.7", "--median", "20m", "--t90", "3h"]);
  assert.equal(ok.code, 0);
  assert.deepEqual(JSON.parse(readFileSync(layout(h).config, "utf8")).habit, { p: 0.7, medianMinutes: 20, t90Minutes: 180 });
  assert.match(ok.out, /^habit manual \(p 0\.7, m 20m, t90 3h\)\nsetting manual/);
  assert.match((await call(expiryCli, h, [])).out, /habit manual \(p 0\.7, m 20m, t90 3h\)/);

  const auto = await call(habitCli, h, ["auto"]);
  assert.equal(auto.code, 0);
  assert.equal(JSON.parse(readFileSync(layout(h).config, "utf8")).habit, "auto");
  assert.equal(block((await call(expiryCli, h, [])).out, "claude-subscription"), CLAUDE_DEFAULT);
});

test("status: no snapshot", async (t) => {
  const h = home(t);
  const o = await call(statusCli, h, []);
  assert.equal(o.code, 0);
  assert.equal(o.out, "keepwarm: not running (no snapshot)\n");
  const j = await call(statusCli, h, ["--json"]);
  assert.equal(JSON.parse(j.out).state, "not_running");
});

test("status: stale snapshot", async (t) => {
  const h = home(t);
  const ts = NOW - 2 * STALE_AFTER_MS;
  atomicWriteJson(layout(h).globalStatus, { v: 1, ts, staleAfter: ts + STALE_AFTER_MS, level: "ok", text: "keepwarm shadow" });
  const o = await call(statusCli, h, []);
  assert.equal(o.code, 0);
  assert.equal(o.out, `keepwarm: unknown (stale since ${new Date(ts + STALE_AFTER_MS).toISOString()})\n`);
});

test("status: live snapshot prints text and sessions", async (t) => {
  const h = home(t);
  atomicWriteJson(layout(h).config, { v: 1, mode: "shadow" });
  const st = createStatus({ home: h, sessionId: "sess-a", now: () => NOW });
  st.update({ phase: "ARMED", lane: "claude-subscription", mode: "shadow", episode: "sess-a:1", tAwayMin: 12 });
  const o = await call(statusCli, h, [], NOW + 60_000);
  assert.equal(o.code, 0);
  const [first, second] = o.out.trimEnd().split("\n");
  assert.equal(first, "keepwarm shadow · 1 sessions (1 idle) · today 0 episodes, 0 returns, 0 pings, $0.00");
  assert.equal(second, "  sess-a · ARMED · lane claude-subscription · mode shadow · episode sess-a:1 · away 12m");
  const j = JSON.parse((await call(statusCli, h, ["--json"], NOW + 60_000)).out);
  assert.equal(j.state, "ok");
  assert.equal(j.sessions.length, 1);
  assert.equal(j.global.detail.sessions.count, 1);
});
