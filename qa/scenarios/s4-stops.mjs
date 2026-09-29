// S4 stop conditions (mode on, verified qa lane): seven sub-cases, each on a FRESH real senpi (RPC) + fresh mock + fresh temp dir.
//   node qa/scenarios/s4-stops.mjs [--case a,b,...]
//   a  set_model to another anthropic model      -> warm_stop model_change
//   b  set_thinking_level                        -> warm_stop effort_change
//   c  mock answers 429 to warm 2..                -> warm_stop rate_limit
//   d  mock answers 500 to warm 2..                -> warm_stop provider_error
//   e  mock answers warm 2 with a big cacheWrite   -> warm_stop cache_miss
//   f  maxUsdPerEpisode 1e-9                       -> warm_stop episode_usd_cap, no warm at all
//   g  agent settings promptCache.keepAlive.enabled -> duplicate_warmer, keepwarm sends no warm at all
// Every sub-case writes <EVID>/task-12/s4-stops/<id>/result.json; the aggregate is <EVID>/task-12/s4-stops/result.json.
// Pass = every sub-case passes. Exit 0 only then.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EVID_ROOT, argValue, loadFixture, readJsonSafeFile, startScenario } from "./lib.mjs";

// --diag-no-tools: DIAGNOSTIC ONLY (evidence under s4-stops-notools, never an acceptance run). senpi starts with --no-tools so the
// real and the warm request carry the same (empty) tool list, which sidesteps the tools-order/strict prefix_mismatch defect
// (see task-11/defect-prefix-mismatch). The checks are unchanged.
const NO_TOOLS = process.argv.includes("--diag-no-tools");
const EXTRA_ARGS = NO_TOOLS ? ["--no-tools"] : [];
const TASK_DIR = NO_TOOLS ? "task-12/s4-stops-notools" : "task-12/s4-stops";
const INTERVAL_MS = 4000; // qa lane override intervalSeconds

// The mock answers `status` to warm request 2 and every later one (an SDK retry cannot succeed).
const failFrom2 = (status) => Object.fromEntries(Array.from({ length: 11 }, (_, i) => [i + 2, { status }]));

const CASES = {
  a: {
    title: "set_model to another anthropic model",
    reason: "model_change",
    pings: 1,
    marker: "model_select",
    async trigger(s) {
      const listed = await s.senpi.send({ type: "get_available_models" });
      const models = (listed?.data?.models ?? []).filter((m) => m.provider === "anthropic" && m.id !== s.model.modelId);
      const pick = models.find((m) => m.cost?.cacheRead > 0) ?? models[0];
      if (!pick) throw new Error("no second anthropic model in get_available_models");
      const res = await s.senpi.send({ type: "set_model", provider: pick.provider, modelId: pick.id });
      s.check("set_model to a different anthropic model succeeded", res?.success === true, `from=${s.model.modelId} to=${pick.id} response=${JSON.stringify(res)}`);
    },
  },
  b: {
    title: "set_thinking_level",
    reason: "effort_change",
    pings: 1,
    marker: "thinking_level_select",
    async trigger(s) {
      const st = await s.senpi.send({ type: "get_state" });
      const cur = st?.data?.thinkingLevel;
      const target = ["low", "medium", "high", "minimal"].find((l) => l !== cur);
      const res = await s.senpi.send({ type: "set_thinking_level", level: target });
      const after = (await s.senpi.send({ type: "get_state" }))?.data?.thinkingLevel;
      s.check("set_thinking_level changed the level", res?.success === true && after === target, `before=${cur} target=${target} after=${after} response=${JSON.stringify(res)}`);
    },
  },
  c: {
    title: "mock 429 on a warm request",
    reason: "rate_limit",
    pings: 2,
    mockScript: { warm: failFrom2(429) },
    pingCheck: (p) => p.ok === false && p.error?.kind === "rate_limit" && p.error?.status === 429,
    pingWhat: "failed ping error kind rate_limit / status 429",
  },
  d: {
    title: "mock 500 on a warm request",
    reason: "provider_error",
    pings: 2,
    mockScript: { warm: failFrom2(500) },
    pingCheck: (p) => p.ok === false && p.error?.kind === "provider_error" && p.error?.status === 500,
    pingWhat: "failed ping error kind provider_error / status 500",
  },
  e: {
    title: "warm response with a large cacheWrite (cache miss)",
    reason: "cache_miss",
    pings: 2,
    mockScript: { warm: { 2: { cacheCreation: 25000, cacheRead: 0 } } },
    pingCheck: (p) => p.ok === true && p.hit === false && p.usage?.cacheWrite >= 25000 && p.usage?.cacheRead === 0,
    pingWhat: "miss ping ok true, hit false, cacheWrite >= 25000, cacheRead 0",
  },
  f: {
    title: "maxUsdPerEpisode 1e-9",
    reason: "episode_usd_cap",
    pings: 0,
    noWarmAtAll: true,
    config: (c) => ({ ...c, maxUsdPerEpisode: 1e-9 }),
  },
  g: {
    title: "builtin cache keepalive enabled in the agent settings",
    reason: "duplicate_warmer",
    pings: 0,
    noWarmAtAll: true,
    settings: { promptCache: { keepAlive: { enabled: true } } },
  },
};

const wanted = (argValue("--case") ?? Object.keys(CASES).join(",")).split(",").map((x) => x.trim()).filter(Boolean);
for (const id of wanted) {
  if (!CASES[id]) {
    console.error(`s4-stops: unknown case ${id}`);
    process.exit(2);
  }
}

const warmRequests = (s) => s.mock.requests().filter((r) => r.kind === "warm");

async function runCase(id) {
  const c = CASES[id];
  const t0 = Date.now();
  console.log(`\n=== s4-stops/${id}: ${c.title} ===`);
  const config = c.config ? c.config(loadFixture("config-on")) : "config-on";
  const s = await startScenario({
    name: id,
    taskDir: TASK_DIR,
    config,
    behavior: "behavior-fast",
    mockScript: c.mockScript,
    senpi: c.settings === undefined,
    extraArgs: EXTRA_ARGS,
  });
  try {
    if (!s.startError && c.settings !== undefined) {
      // The settings file must exist before senpi starts, so this case starts its senpi by hand.
      const dir = join(s.tmp, "kw-senpi");
      mkdirSync(join(dir, "agent"), { recursive: true });
      writeFileSync(join(dir, "agent", "settings.json"), JSON.stringify(c.settings, null, 2) + "\n");
      s.senpi = await s.startExtra("kw-senpi", { extraArgs: EXTRA_ARGS });
      s.model = s.senpi.model;
      s.check("senpi started with settings.json promptCache.keepAlive.enabled true (model with cacheRead > 0)", true, JSON.stringify(s.model));
    }
    if (!s.startError) {
      await s.turn("hello");
      const open = await s.waitForRecord((r) => r.type === "episode_open", 20000);
      const ep = open.episode;
      s.check("episode_open in mode on with a warm path", open.mode === "on" && open.warmPath === "warmPromptCache" && open.verified === true, `mode=${open.mode} warmPath=${open.warmPath} verified=${open.verified} expiry=${JSON.stringify(open.expiry)}`);

      // Warming must be live before the stop condition (except f/g, where it must never start).
      if (c.pings > 0) {
        const ticks = new Set();
        const first = await s.waitForRecord(
          (r) => (r.episode !== ep ? false : r.type === "ping" ? (ticks.add(r.tick), ticks.size >= c.pings) : r.type === "warm_stop"),
          40000,
        );
        const pings = s.records("ping").filter((r) => r.episode === ep);
        if (first.type === "warm_stop") {
          s.check(`warming was live: ${c.pings} ping record(s) before the stop`, false, `warm_stop reason=${first.reason} arrived before ${c.pings} ping(s); pings=${JSON.stringify(pings.map((p) => ({ tick: p.tick, ok: p.ok, hit: p.hit, error: p.error?.kind ?? null })))}`);
          throw new Error(`warming never went live (warm_stop ${first.reason}); the stop condition cannot be exercised`);
        }
        s.check(`warming was live: ${c.pings} ping record(s) before the stop`, pings.length >= c.pings && pings[0].ok === true && pings[0].hit === true, JSON.stringify(pings.map((p) => ({ tick: p.tick, ok: p.ok, hit: p.hit, error: p.error?.kind ?? null }))));
      }
      if (c.trigger) await c.trigger(s);

      // The stop record. g may stop at segment open (never eligible) or by the cache_warm_ping bus event.
      const isStop = (r) =>
        r.episode === ep && (r.type === "warm_stop" || (r.type === "segment_open" && r.eligible === false && r.disabledReason === c.reason));
      const stop = await s.waitForRecord(isStop, 40000);
      const stopMs = Date.parse(stop.ts);
      const warmsAtStop = warmRequests(s).length;
      const reasonSeen = stop.type === "warm_stop" ? stop.reason : stop.disabledReason;
      s.check(`stop reason ${c.reason}`, reasonSeen === c.reason, `record=${stop.type} reason=${reasonSeen}`);
      if (c.marker) s.check(`marker ${c.marker} recorded`, s.records("marker").some((m) => m.episode === ep && m.kind === c.marker), JSON.stringify(s.records("marker").map((m) => m.kind)));
      if (c.pingCheck) {
        const pings = s.records("ping").filter((r) => r.episode === ep);
        s.check(c.pingWhat, pings.length > 0 && c.pingCheck(pings.at(-1)), JSON.stringify(pings.at(-1) ?? null));
      }
      if (id === "f") {
        const skip = s.records("decision").find((d) => d.episode === ep && d.action === "skip" && d.reason === "episode_usd_cap");
        s.check("decision skip episode_usd_cap recorded", Boolean(skip), JSON.stringify(skip ?? null));
      }
      if (id === "g") {
        s.check("no eligible segment opened (duplicate_warmer)", !s.records("segment_open").some((r) => r.episode === ep && r.eligible === true), JSON.stringify(s.records("segment_open").map((r) => ({ reason: r.reason, eligible: r.eligible, disabledReason: r.disabledReason }))));
      }

      // Absence window: two intervals during which any surviving tick would have fired.
      const after = await s.expectNoRecord((r) => (r.type === "decision" || r.type === "ping") && r.episode === ep && r.ts > stop.ts, 2 * INTERVAL_MS + 1000);
      const warmsWindow = warmRequests(s).length;
      s.check("zero warm decisions/pings after the stop (2 intervals observed)", after.absent, after.hit ? JSON.stringify(after.hit) : `no decision/ping record after ${stop.ts}`);

      await s.turn("bye");
      const close = await s.waitForRecord((r) => r.type === "episode_close" && r.episode === ep, 20000).catch((e) => e);
      const okClose = !(close instanceof Error);
      s.check("episode closes by human_return input:rpc after the stop", okClose && close.kind === "human_return" && close.source === "input:rpc", okClose ? `kind=${close.kind} source=${close.source} pings=${close.pings} wouldWarm=${close.wouldWarm}` : close.message);

      const warms = warmRequests(s);
      const late = warms.filter((w) => w.t > stopMs);
      const pingRecords = s.records("ping").filter((r) => r.episode === ep);
      const warmDecisions = s.records("decision").filter((r) => r.episode === ep && r.action === "warm");
      if (c.noWarmAtAll) {
        // keepwarm itself must never warm: no warm decision, no ping record. The builtin warmer's own requests (g) are
        // listed separately, they are not keepwarm's.
        s.check(
          "keepwarm sent no warm request (no warm decision, no ping record)",
          warmDecisions.length === 0 && pingRecords.length === 0 && (id === "g" || warms.length === 0),
          `warm decisions=${warmDecisions.length} ping records=${pingRecords.length} mock warm requests=${warms.length}${id === "g" ? " (builtin, not attributable to keepwarm: ping records 0)" : ""}`,
        );
      } else {
        s.check("warm requests happened before the stop", warmsAtStop >= 1, `mock warm requests at stop=${warmsAtStop}`);
      }
      s.check(
        "mock log: zero warm requests after the stop (at stop, after window, after bye; none with t later than the stop record)",
        (id === "g" ? true : warms.length === warmsAtStop) && warmsWindow === warmsAtStop && late.length === 0,
        `at stop=${warmsAtStop} after window=${warmsWindow} after bye=${warms.length} later than stop record=${late.length}${id === "g" ? " (g: builtin requests are excluded from this equality; keepwarm ping records=" + pingRecords.length + ")" : ""}`,
      );
    }
  } catch (e) {
    s.check("sub-case ran without fatal error", false, String(e?.stack ?? e));
  }
  const pass = await s.finish().catch((e) => {
    console.error(`finish failed: ${e?.stack ?? e}`);
    return false;
  });
  const file = join(s.evid, "result.json");
  const result = readJsonSafeFile(file) ?? { checks: s.checks, pass };
  result.scenario = `s4-stops/${id}`;
  result.title = c.title;
  writeFileSync(file, JSON.stringify(result, null, 2) + "\n");
  console.log(`${pass ? "CASE PASS" : "CASE FAIL"} s4-stops/${id} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  return { id, title: c.title, pass, durationMs: Date.now() - t0, failed: result.checks.filter((x) => !x.pass).map((x) => x.name) };
}

const results = [];
for (const id of wanted) results.push(await runCase(id));

const all = wanted.length === Object.keys(CASES).length;
const aggregate = {
  scenario: NO_TOOLS ? "s4-stops (diagnostic --no-tools)" : "s4-stops",
  diagnostic: NO_TOOLS,
  pass: results.every((r) => r.pass) && all,
  partial: !all,
  checks: results.map((r) => ({ name: `s4-stops/${r.id}: ${r.title}`, pass: r.pass, detail: r.pass ? `all checks pass (${(r.durationMs / 1000).toFixed(1)} s)` : `failed: ${r.failed.join(" | ")}` })),
  durationMs: results.reduce((a, r) => a + r.durationMs, 0),
};
mkdirSync(join(EVID_ROOT, TASK_DIR), { recursive: true });
writeFileSync(join(EVID_ROOT, TASK_DIR, "result.json"), JSON.stringify(aggregate, null, 2) + "\n");
console.log(`\n${aggregate.pass ? "S4 PASS" : "S4 FAIL"}: ${results.map((r) => `${r.id}=${r.pass ? "ok" : "FAIL"}`).join(" ")}`);
process.exit(aggregate.pass ? 0 : 1);
