// Gauge-lag feasibility scan over the recorded 5h meter readings (offline, read-only).
//
// Model (same as docs/idle-cost-evidence.md "Gauge lag (D1)"): the header shows
// floor(phase + cumulative charge) in 0.01 ticks, and the charge is linear in the usage fields:
//   cost(call) = cacheRead / R + (cacheWrite1h + cacheWrite5m + uncachedInput) / T + output * w / T
// R = read tokens per tick, T = 1h-write tokens per tick, w = output weight relative to a write token.
// "Visibility" says which calls a header can include:
//   lag L      : the header of call i includes calls 0..i-L
//   delay d s  : the header of call i includes calls that completed at least d s before call i started
// For every (R, T, w) the phase is solved exactly (an interval), so a parameter point is feasible
// for a prefix of calls iff that interval stays nonempty. Nothing here is fitted into a coefficient.
//
// usage: node gauge-lag-scan.mjs --out <dir> [--first <run dir>] [--rerun <run dir>]
import { join } from "node:path"
import { DEFAULTS, parseArgs, msOf, readJsonl, stable, writeOut, round } from "./common.mjs"

const args = parseArgs(process.argv.slice(2))
const OUT = args.out
if (!OUT) {
  console.error("usage: node gauge-lag-scan.mjs --out <dir>")
  process.exit(2)
}
const FIRST = args.first ?? DEFAULTS.firstRun
const RERUN = args.rerun ?? DEFAULTS.rerun

const T_GRID = Array.from({ length: 281 }, (_, i) => 60000 + 500 * i) // 60K..200K
const W_GRID = [0, ...Array.from({ length: 240 }, (_, i) => 0.05 * (12 / 0.05) ** (i / 239))]
const R_PRIOR = [5.39e6, 5.47e6, 5.55e6] // quota-test/2026-09-19 REPORT.md, reported_unverified
const R_WIDE = Array.from({ length: 60 }, (_, i) => 1e6 * 50 ** (i / 59)) // 1M..50M
const T_MEASURED = { lo: 119246.66, hi: 133519.75 } // docs/idle-live-results.md, rerun fable-write-tick

function callsOf(dir) {
  const { rows } = readJsonl(join(dir, "requests.jsonl"))
  const out = []
  for (const r of rows) {
    const m = r?.meters?.["unified-5h"]
    if (r.status !== 200 || !m || !Number.isFinite(m.util)) continue
    const u = r.usage ?? {}
    const cc = u.cache_creation ?? {}
    out.push({
      step: r.stepId,
      experiment: r.experiment,
      tReq: msOf(r.ts_req),
      tEnd: msOf(r.ts),
      ticks: Math.round(m.util * 100),
      reset: m.reset,
      r: u.cache_read_input_tokens ?? 0,
      w: (cc.ephemeral_1h_input_tokens ?? 0) + (cc.ephemeral_5m_input_tokens ?? 0) + (u.input_tokens ?? 0),
      o: u.output_tokens ?? 0,
    })
  }
  return out
}

/** Visible-call counts m[i] for one window. */
function visibility(calls, model) {
  if (model.kind === "lag") return calls.map((_, i) => Math.max(0, i + 1 - model.L))
  return calls.map((c) => calls.filter((x) => x.tEnd <= c.tReq - model.d * 1000).length)
}

/**
 * For each (R,T,w): the length of the longest feasible prefix of `calls` (one window).
 * Returns { prefix: Int32Array over (R,T,w), dims }.
 */
function prefixScan(calls, model, Rs) {
  const K = calls.length
  const m = visibility(calls, model)
  const pr = [0]
  const pw = [0]
  const po = [0]
  for (const c of calls) {
    pr.push(pr[pr.length - 1] + c.r)
    pw.push(pw[pw.length - 1] + c.w)
    po.push(po[po.length - 1] + c.o)
  }
  const dr = m.map((mi) => pr[mi] - pr[m[0]])
  const dw = m.map((mi) => pw[mi] - pw[m[0]])
  const dO = m.map((mi) => po[mi] - po[m[0]])
  const dn = calls.map((c) => c.ticks - calls[0].ticks)
  const prefix = new Int32Array(Rs.length * T_GRID.length * W_GRID.length)
  let idx = 0
  for (const R of Rs)
    for (const T of T_GRID)
      for (const w of W_GRID) {
        let lo = 0
        let hi = 1
        let k = 0
        for (; k < K; k++) {
          const S = dr[k] / R + (dw[k] + dO[k] * w) / T
          const a = dn[k] - S
          const b = dn[k] + 1 - S
          if (a > lo) lo = a
          if (b < hi) hi = b
          if (!(lo < hi)) break
        }
        prefix[idx++] = k
      }
  return { prefix, K }
}

function region(scan, Rs, needPrefix) {
  let n = 0
  const T = [Infinity, -Infinity]
  const W = [Infinity, -Infinity]
  const R = [Infinity, -Infinity]
  const K = [Infinity, -Infinity] // implied ticks per output token, w / T
  const KM = [Infinity, -Infinity] // the same, only where T lies in the measured write range
  let idx = 0
  for (const r of Rs)
    for (const t of T_GRID)
      for (const w of W_GRID) {
        if (scan.prefix[idx++] >= needPrefix) {
          n++
          T[0] = Math.min(T[0], t)
          T[1] = Math.max(T[1], t)
          W[0] = Math.min(W[0], w)
          W[1] = Math.max(W[1], w)
          R[0] = Math.min(R[0], r)
          R[1] = Math.max(R[1], r)
          K[0] = Math.min(K[0], w / t)
          K[1] = Math.max(K[1], w / t)
          if (t >= T_MEASURED.lo - 500 && t <= T_MEASURED.hi + 500) {
            KM[0] = Math.min(KM[0], w / t)
            KM[1] = Math.max(KM[1], w / t)
          }
        }
      }
  const sci = (x) => (Number.isFinite(x) ? Number(x.toExponential(4)) : null)
  return n
    ? { cells: n, T, w: W.map((x) => round(x, 3)), R: R.map((x) => round(x, 0)), impliedTicksPerOutputToken: K.map(sci), impliedTicksPerOutputTokenAtMeasuredT: KM.map(sci) }
    : { cells: 0 }
}

function maxPrefix(scan) {
  let best = 0
  for (const v of scan.prefix) if (v > best) best = v
  return best
}

/** Joint feasibility over several windows (independent phase per window). */
function jointFeasible(windows, model, Rs) {
  const scans = windows.map((w) => prefixScan(w, model, Rs))
  const n = scans[0].prefix.length
  const ok = new Uint8Array(n).fill(1)
  scans.forEach((s) => {
    for (let i = 0; i < n; i++) if (s.prefix[i] < s.K) ok[i] = 0
  })
  let cells = 0
  for (const v of ok) cells += v
  return { feasibleCells: cells }
}

const windowsOf = (calls) => {
  const by = new Map()
  for (const c of calls) {
    if (!by.has(c.reset)) by.set(c.reset, [])
    by.get(c.reset).push(c)
  }
  return [...by.values()].filter((w) => w.length >= 2)
}
const describeModel = (m) => (m.kind === "lag" ? `lag${m.L}` : `delay${m.d}s`)

// ------------------------------------------------------------------ first run (reproduces D1)
const c1 = callsOf(FIRST)
const w1 = windowsOf(c1)
const firstRun = { calls: c1.length, windows: w1.length, models: {} }
for (const L of [0, 1, 2]) {
  const model = { kind: "lag", L }
  // one window in this run; if more, the region is reported per the largest window
  const main = w1.reduce((a, b) => (b.length > a.length ? b : a))
  const s = prefixScan(main, model, R_PRIOR)
  firstRun.models[describeModel(model)] = { windowCalls: main.length, jointAllWindows: jointFeasible(w1, model, R_PRIOR), region: region(s, R_PRIOR, main.length) }
}

// ------------------------------------------------------------------ rerun
const c2 = callsOf(RERUN)
const w2 = windowsOf(c2)
const fresh = w2.reduce((a, b) => (b.length > a.length ? b : a))
const gaps = fresh.slice(1).map((c, i) => (c.tReq - fresh[i].tEnd) / 1000)
const rerun = {
  calls: c2.length,
  windows: w2.map((w) => w.length),
  freshWindowCalls: fresh.length,
  interCallGapSeconds: { min: round(Math.min(...gaps), 1), median: round([...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)], 1), max: round(Math.max(...gaps), 1) },
  models: {},
}
const models = [
  ...[0, 1, 2].map((L) => ({ kind: "lag", L })),
  ...[0, 2, 5, 10, 15, 30, 60, 120].map((d) => ({ kind: "delay", d })),
]
for (const model of models) {
  const entry = {}
  for (const [label, Rs] of [
    ["priorR", R_PRIOR],
    ["wideR", model.kind === "lag" ? R_WIDE : null],
  ]) {
    if (!Rs) continue
    const s = prefixScan(fresh, model, Rs)
    const best = maxPrefix(s)
    entry[label] = {
      feasibleAllCalls: best >= fresh.length,
      maxFeasiblePrefix: best,
      breaksAt: best < fresh.length ? fresh[best].step : null,
      regionAtMaxPrefix: region(s, Rs, best),
    }
  }
  rerun.models[describeModel(model)] = entry
}

// Contiguous segments: maximal runs of one experiment; preflight settle PINGs join the run they
// sit in. Each segment gets its own phase, prior R.
const segments = []
for (const c of fresh) {
  const label = c.experiment === "preflight" && segments.length ? segments[segments.length - 1].label : c.experiment
  if (!segments.length || segments[segments.length - 1].label !== label) segments.push({ label, calls: [] })
  segments[segments.length - 1].calls.push(c)
}
const spans = {}
const seen = {}
for (const seg of segments) {
  seen[seg.label] = (seen[seg.label] ?? 0) + 1
  const key = `${seg.label}#${seen[seg.label]}`
  spans[key] = { calls: seg.calls.length, first: seg.calls[0].step, last: seg.calls[seg.calls.length - 1].step }
  for (const L of [0, 1, 2]) {
    const s = prefixScan(seg.calls, { kind: "lag", L }, R_PRIOR)
    spans[key][`lag${L}`] = { ...region(s, R_PRIOR, seg.calls.length), maxFeasiblePrefix: maxPrefix(s) }
  }
}
rerun.experimentSegmentsPriorR = spans

// Where lag 1 stops fitting: the calls just before the break (usage and header ticks only).
const lag1Break = rerun.models.lag1.priorR.maxFeasiblePrefix
rerun.lag1BreakContext = fresh.slice(Math.max(0, lag1Break - 6), lag1Break + 1).map((c, i, arr) => ({
  step: c.step,
  gapBeforeS: i === 0 ? null : round((c.tReq - arr[i - 1].tEnd) / 1000, 1),
  read: c.r,
  write: c.w,
  output: c.o,
  headerTicks: c.ticks,
}))

// Direct lag-0 contradictions at the measured write coefficient: a call whose own 1h write alone
// is at least one tick (write >= T_hi) but whose own header did not move, while the next header did.
const direct = []
for (let i = 1; i + 1 < fresh.length; i++) {
  const c = fresh[i]
  if (c.w >= T_MEASURED.hi && c.ticks === fresh[i - 1].ticks && fresh[i + 1].ticks > c.ticks)
    direct.push({ step: c.step, write1hPlusInput: c.w, ownHeaderDelta: 0, nextStep: fresh[i + 1].step, nextHeaderDelta: fresh[i + 1].ticks - c.ticks, gapToNextS: round((fresh[i + 1].tReq - c.tEnd) / 1000, 1) })
}
rerun.bigWriteOwnHeaderUnchanged = { rule: `write >= ${T_MEASURED.hi} tokens (>= 1 tick at the measured T upper end) and own header unchanged`, count: direct.length, pairs: direct }

const result = {
  v: "idle-existing-data-analysis/gauge-lag-scan/1",
  model: "floor(phase + sum of visible linear charges); phase solved exactly per window",
  grids: { T: [T_GRID[0], T_GRID[T_GRID.length - 1], 500], w: [0, 0.05, 12, "geometric 240 + zero"], Rprior: R_PRIOR, Rwide: [R_WIDE[0], R_WIDE[R_WIDE.length - 1], "geometric 60"] },
  measuredT: T_MEASURED,
  firstRun,
  rerun,
  reading: [
    "A feasible region is a set of (R, T, w) the readings cannot rule out under that visibility model; it is not a measurement.",
    "No region here is promoted to a coefficient: several models fit the same prefixes.",
  ],
}
writeOut(join(OUT, "gauge-lag-scan.json"), stable(result))
console.log(`gauge scan: first run ${c1.length} calls, rerun ${c2.length} calls; wrote ${OUT}`)
