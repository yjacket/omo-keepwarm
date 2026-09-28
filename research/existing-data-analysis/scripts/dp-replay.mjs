// Offline replay of the existing idle DP (planIdle, extension/rollover.ts at d8a4abd) under
// log-estimated return distributions. This is NOT a controlled comparison of the three policies:
// the forecast is a log estimate, the costs are the d8a4abd phase models at both coefficient-range
// ends, and the unobserved tail is an explicit, labelled allocation.
//
// usage: node dp-replay.mjs --out <dir> --repo <analysis worktree> --q <q-summary.json>
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { parseArgs, stable, writeOut, round } from "./common.mjs"

const args = parseArgs(process.argv.slice(2))
if (!args.out || !args.repo || !args.q) {
  console.error("usage: node dp-replay.mjs --out <dir> --repo <analysis worktree> --q <q-summary.json>")
  process.exit(2)
}
const { planIdle } = await import(pathToFileURL(join(args.repo, "extension/rollover.ts")).href)
const results = JSON.parse(readFileSync(join(args.repo, "docs/idle-live-results.json"), "utf8"))
const q = JSON.parse(readFileSync(args.q, "utf8"))
const MIN = 60000
const pa = results.policyAnswer
const models = { low: pa.evaluatedAt.low.costs, high: pa.evaluatedAt.high.costs }
const BASE = { ...pa.options } // ttl 1h, review every 50 min, fresh cache at idle start, shared cache persists
const REVIEW_MS = BASE.intervalMs

/**
 * Forecast from Aalen-Johansen steps: return mass per observed return time up to a horizon,
 * observed ends up to the horizon, and the residual (still open at the horizon) allocated by `tail`.
 */
function forecastFromSteps(est, { tail, endsAsNever = true, horizonMin = Infinity }) {
  const steps = est.steps.filter((s) => s.tMin <= horizonMin)
  const points = []
  let prevF1 = 0
  for (const s of steps) {
    const dF = s.F1 - prevF1
    if (dF > 1e-12) points.push({ afterMs: Math.max(1, Math.round(s.tMin * MIN)), probability: dF })
    prevF1 = s.F1
  }
  const last = steps[steps.length - 1]
  const ends = endsAsNever ? last.F2 : 0
  const residual = Math.max(0, 1 - last.F1 - ends)
  const maxMs = Math.round(Math.min(est.maxFollowUpMin, horizonMin) * MIN)
  let never = ends
  if (tail === "never") never += residual
  else if (tail === "just_after_follow_up") points.push({ afterMs: maxMs + MIN, probability: residual })
  else if (tail === "at_72h") points.push({ afterMs: Math.max(maxMs + MIN, 72 * 60 * MIN), probability: residual })
  // merge identical times and renormalise tiny float drift
  const merged = new Map()
  for (const p of points) merged.set(p.afterMs, (merged.get(p.afterMs) ?? 0) + p.probability)
  const pts = [...merged].map(([afterMs, probability]) => ({ afterMs, probability })).sort((a, b) => a.afterMs - b.afterMs)
  const total = pts.reduce((a, p) => a + p.probability, 0) + never
  return { returns: pts.map((p) => ({ afterMs: p.afterMs, probability: p.probability / total })), neverReturnsProbability: never / total, residualAllocated: residual, observedEnds: ends }
}

/** The same forecast seen at a later review time, given no return and no end so far. */
function conditional(f, atMs) {
  const later = f.returns.filter((p) => p.afterMs > atMs).map((p) => ({ afterMs: p.afterMs - atMs, probability: p.probability }))
  const mass = later.reduce((a, p) => a + p.probability, 0) + f.neverReturnsProbability
  return { returns: later.map((p) => ({ ...p, probability: p.probability / mass })), neverReturnsProbability: f.neverReturnsProbability / mass, survivalAtReview: mass }
}

function plan(f, remainingTtlMs, allowParking, V = null) {
  const out = {}
  for (const end of ["low", "high"]) {
    const costs = V ? { ...models[end], futureWorkDifferentialEq: V[end] } : models[end]
    const r = planIdle(costs, { returns: f.returns, neverReturnsProbability: f.neverReturnsProbability }, { ...BASE, remainingTtlMs, allowParking })
    out[end] = { action: r.action, costs: Object.fromEntries(Object.entries(r.costs).map(([k, v]) => [k, Number.isFinite(v) ? round(v, 8) : String(v)])), notes: r.notes }
  }
  out.action = out.low.action === out.high.action ? out.low.action : "NO_DECISION"
  out.reason = out.low.action === out.high.action ? "both_range_ends_agree" : "coefficient_range_straddles_boundary"
  return out
}

const candidates = [
  { id: "A_labelled_P2_endsCompeting", label: "log estimate (rollover log, input-source labelled, 2026-09-17..23)", est: q.A.estimate_endsCompeting, endsAsNever: true },
  { id: "A_labelled_P2_endsCensored", label: "log estimate, observed context ends treated as censored (could still return)", est: q.A.estimate_endsCensored, endsAsNever: false },
  { id: "A_labelled_P2_context>=100K", label: "log estimate, idle starts with context >= 100K only", est: q.A.contextAtLeast100K.estimate, endsAsNever: true },
  { id: "A_labelled_P2_commandAsReturn", label: "log estimate, a typed /rollover command counts as return", est: q.A.estimate_commandAsReturn, endsAsNever: true },
  { id: "B_transcript_P1", label: "log estimate from transcripts, 2026-09-01..17 (estimation-period candidate; no shutdown record, ends censored)", est: q.B.periods.P1.estimate, endsAsNever: false },
]
const tails = ["never", "just_after_follow_up", "at_72h"]
const horizons = [Infinity, 1440, 240]
const runs = []
for (const c of candidates) {
  if (!c.est) continue
  for (const horizonMin of horizons)
  for (const tail of tails) {
    const f = forecastFromSteps(c.est, { tail, endsAsNever: c.endsAsNever, horizonMin })
    const atReview = conditional(f, REVIEW_MS)
    const row = {
      candidate: c.id,
      label: c.label,
      sourceKind: "log_estimate",
      horizonMin: Number.isFinite(horizonMin) ? horizonMin : "full_follow_up",
      tailAllocation: tail,
      tailAllocationKind: "assumption",
      residualAllocated: round(f.residualAllocated, 4),
      observedEndsAsNever: round(f.observedEnds, 4),
      atIdleStart: { remainingTtlMin: BASE.remainingTtlMs / MIN, parkingAllowed: plan(f, BASE.remainingTtlMs, true), parkingNotAllowed: plan(f, BASE.remainingTtlMs, false) },
      atFirstReview: {
        reviewMin: REVIEW_MS / MIN,
        remainingTtlMin: (BASE.ttlMs - REVIEW_MS) / MIN,
        noReturnNoEndSoFar: round(atReview.survivalAtReview, 4),
        returnWithinNextHourGivenOpen: round(atReview.returns.filter((p) => p.afterMs <= 60 * MIN).reduce((a, p) => a + p.probability, 0), 4),
        parkingAllowed: plan(atReview, BASE.ttlMs - REVIEW_MS, true),
        parkingNotAllowed: plan(atReview, BASE.ttlMs - REVIEW_MS, false),
      },
    }
    runs.push(row)
  }
}
// V scenarios on the primary candidate: the useful-work differential of the restore unit, measured
// (successor conversation re-written every call) and hypothetical (successor caches it).
const restore = args.restore ? JSON.parse(readFileSync(args.restore, "utf8")) : null
const vRuns = []
if (restore) {
  const vUnit = restore.futureWorkDifferentialV.perUnit["restore-decomposition#1"]
  const primary = candidates[0]
  const f = forecastFromSteps(primary.est, { tail: "never", endsAsNever: true, horizonMin: 1440 })
  const atReview = conditional(f, REVIEW_MS)
  for (const [label, V, kind] of [
    ["V0_baseline", { low: 0, high: 0 }, "baseline"],
    ["V_measured_restore_run1", vUnit.measured, "measured_one_unit"],
    ["V_hypothetical_successor_caching", vUnit.hypotheticalSuccessorCaching, "hypothetical"],
  ]) {
    if (!V) continue
    vRuns.push({ candidate: primary.id, horizonMin: 1440, tailAllocation: "never", vScenario: label, vKind: kind, V, atFirstReview: plan(atReview, BASE.ttlMs - REVIEW_MS, true, V) })
  }
}
// Output-coefficient scenario: rebuild the d8a4abd cost models through the analyzer's own
// conversion, first with its published output range (must reproduce the stored models), then with
// the model-conditional range the joint-phase scan finds inside the output-quota segment.
const outputScenario = {}
if (args.gauge && args.rerun) {
  const analyzer = await import(pathToFileURL(join(args.repo, "scripts/idle-live-analyze.mjs")).href)
  const { conversionEnds, convertSums, buildIdleCostModel, sumRecords } = analyzer
  const gauge = JSON.parse(readFileSync(args.gauge, "utf8"))
  const T = results.experiments["fable-write-tick"].findings.intersectedT
  const kOutUB = results.experiments["output-quota"].findings.kOutUpperBound
  const run = results.experiments["restore-decomposition"].findings.runs[0]
  const reqRows = readFileSync(join(args.rerun, "requests.jsonl"), "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
  const warmRows = reqRows.filter((r) => r.experiment === "policy-effect" && r.phase === "warm")
  const warmTotal = sumRecords(warmRows)
  const warm = Object.fromEntries(Object.entries(warmTotal).map(([k, v]) => [k, typeof v === "number" ? v / warmRows.length : v]))
  const build = (ends) => {
    const pick = (s) => convertSums(s, ends)
    const parts = { warm: pick(warm), ctxCreate: pick(run.phases.ctx_create), parkParent: pick(run.phases.park_parent), restoreChild: pick(run.phases.restore_child), resumeRaw: pick(run.phases.resume_raw) }
    const at = (end) => buildIdleCostModel(Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v[end]])))
    return { low: at("lo"), high: at("hi") }
  }
  const published = build(conversionEnds({ T: { lo: T.lo, hi: T.hi }, kOut: null, kOutUpperBound: kOutUB, meter: "unified-5h" }))
  const reproduces = ["low", "high"].every((end) => Object.keys(models[end]).every((k) => Math.abs(models[end][k] - published[end][k]) < 1e-12))
  const seg = gauge.rerun.experimentSegmentsPriorR["output-quota#1"]
  const ranges = ["lag0", "lag1", "lag2"].map((l) => seg[l].impliedTicksPerOutputTokenAtMeasuredT).filter((r) => r && r[0] !== null)
  const kOut = { lo: Math.min(...ranges.map((r) => r[0])), hi: Math.max(...ranges.map((r) => r[1])) }
  const condModels = build(conversionEnds({ T: { lo: T.lo, hi: T.hi }, kOut, kOutUpperBound: null, meter: "unified-5h" }))
  const f = forecastFromSteps(candidates[0].est, { tail: "never", endsAsNever: true, horizonMin: 1440 })
  const atReview = conditional(f, REVIEW_MS)
  const planWith = (m) => {
    const o = {}
    for (const end of ["low", "high"]) {
      const r = planIdle(m[end], { returns: atReview.returns, neverReturnsProbability: atReview.neverReturnsProbability }, { ...BASE, remainingTtlMs: BASE.ttlMs - REVIEW_MS, allowParking: true })
      o[end] = { action: r.action, costs: Object.fromEntries(Object.entries(r.costs).map(([k, v]) => [k, round(v, 8)])) }
    }
    o.action = o.low.action === o.high.action ? o.low.action : "NO_DECISION"
    return o
  }
  Object.assign(outputScenario, {
    label: "model-conditional (linear floor meter, any per-call lag 0-2, read prior); not a measured coefficient",
    publishedModelsReproduced: reproduces,
    kOutTicksPerOutputToken: kOut,
    models: condModels,
    atFirstReview_parkingAllowed: planWith(condModels),
  })
}
const summarise = (key, sub) => {
  const acts = {}
  for (const r of runs) {
    const a = r[key][sub].action
    acts[a] = (acts[a] ?? 0) + 1
  }
  return acts
}
const out = {
  v: "idle-existing-data-analysis/dp-replay/1",
  engine: "planIdle from extension/rollover.ts (d8a4abd), unchanged",
  plannerOptions: BASE,
  costModels: { source: "docs/idle-live-results.json policyAnswer.evaluatedAt.{low,high}.costs (d8a4abd)", ...models, notes: ["skillRestoreEq, sharedLossEq, parkQualityEq are 0 baselines (not measured)", "futureWorkDifferentialEq V = 0", "context of the experiment (~146K tokens), one model, 1h lane"] },
  notAControlledComparison: true,
  qualityGates: "not applied here: parking admissibility (quality loss, resume delay) is an operator decision; see parkingNotAllowed rows",
  runs,
  vScenarios: vRuns,
  outputCoefficientScenario: outputScenario,
  actionCounts: {
    atIdleStart_parkingAllowed: summarise("atIdleStart", "parkingAllowed"),
    atIdleStart_parkingNotAllowed: summarise("atIdleStart", "parkingNotAllowed"),
    atFirstReview_parkingAllowed: summarise("atFirstReview", "parkingAllowed"),
    atFirstReview_parkingNotAllowed: summarise("atFirstReview", "parkingNotAllowed"),
  },
}
writeOut(join(args.out, "dp-replay.json"), stable(out))
console.log(`dp replay: ${runs.length} scenario rows; wrote ${args.out}`)
