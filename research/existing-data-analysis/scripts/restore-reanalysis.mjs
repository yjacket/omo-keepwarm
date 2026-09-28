// Restore cost, successor caching, system/skill overlap and re-explanation (offline, read-only).
//
// Inputs: the rerun's requests.jsonl and cli/<stepId>.json (paid originals, read only), the
// merged analysis docs/idle-live-results.json at d8a4abd (for cross-checks and T / k_out bound),
// and senpi transcripts of rollover successor sessions (operational usage only, no text kept).
// The contaminated restore run 2 is reported beside, never inside, the clean sums.
// A counterfactual is labelled "hypothetical" and never replaces a measured value.
//
// usage: node restore-reanalysis.mjs --out <dir> --repo <analysis worktree> [--rerun <dir>] [--sessions <dir>]
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { DEFAULTS, parseArgs, msOf, readJsonl, stable, writeOut, round, pct, listFiles } from "./common.mjs"

const args = parseArgs(process.argv.slice(2))
const OUT = args.out
const REPO = args.repo
if (!OUT || !REPO) {
  console.error("usage: node restore-reanalysis.mjs --out <dir> --repo <analysis worktree>")
  process.exit(2)
}
const RERUN = args.rerun ?? DEFAULTS.rerun
const SESS = args.sessions ?? DEFAULTS.sessionsDir
const ASOF = msOf(args.asof ?? DEFAULTS.asof)
const EXCLUDE = new Set(DEFAULTS.excludeSessions)

const analyzer = await import(pathToFileURL(join(REPO, "scripts/idle-live-analyze.mjs")).href)
const { conversionEnds, convertSums, sumRecords } = analyzer
const results = JSON.parse(readFileSync(join(REPO, "docs/idle-live-results.json"), "utf8"))
const T = results.experiments["fable-write-tick"].findings.intersectedT
const kOutUpperBound = results.experiments["output-quota"].findings.kOutUpperBound
const METERS = ["unified-5h", "unified-7d", "unified-7d_oi"]
const ends = Object.fromEntries(METERS.map((m) => [m, conversionEnds({ T: { lo: T.lo, hi: T.hi }, kOut: null, kOutUpperBound, meter: m })]))

const { rows: req } = readJsonl(join(RERUN, "requests.jsonl"))
const u = (r) => {
  const us = r.usage ?? {}
  const cc = us.cache_creation ?? {}
  return { read: us.cache_read_input_tokens ?? 0, write1h: cc.ephemeral_1h_input_tokens ?? 0, write5m: cc.ephemeral_5m_input_tokens ?? 0, input: us.input_tokens ?? 0, output: us.output_tokens ?? 0 }
}
const unitOf = (r) => `${r.experiment}#${r.run ?? r.unit?.index ?? "?"}`
const byUnit = new Map()
for (const r of req) {
  if (!["restore-decomposition", "policy-effect"].includes(r.experiment)) continue
  const k = unitOf(r)
  if (!byUnit.has(k)) byUnit.set(k, [])
  byUnit.get(k).push(r)
}
const UNIT_STATUS = {
  "restore-decomposition#1": "valid (clean, pooled in d8a4abd)",
  "restore-decomposition#2": "contaminated (anomalies_present) - reference only, not pooled",
  "policy-effect#1": "valid (clean pair)",
  "policy-effect#2": "valid (clean pair)",
  "policy-effect#3": "valid (clean pair)",
}
const PARK_ARM = { "restore-decomposition": "park_path", "policy-effect": "shadow_candidate_policy" }
const RAW_ARM = { "restore-decomposition": "raw_path", "policy-effect": "current_policy" }

// ------------------------------------------------------------------ 1. phase sums + cross-check
const phaseTable = {}
for (const [unit, rows] of byUnit) {
  const t = {}
  for (const r of rows) {
    const key = `${r.arm}/${r.phase}`
    t[key] ??= { requests: 0, read: 0, write1h: 0, write5m: 0, input: 0, output: 0 }
    const x = u(r)
    t[key].requests++
    for (const f of ["read", "write1h", "write5m", "input", "output"]) t[key][f] += x[f]
  }
  phaseTable[unit] = { status: UNIT_STATUS[unit] ?? "unknown", phases: t }
}
// equality with the merged analysis for the pooled units
const rr = results.experiments["restore-decomposition"].findings.runs[0]
const rcheck = Object.entries(rr.byArmPhase).flatMap(([arm, phases]) =>
  Object.entries(phases).map(([phase, s]) => {
    const mine = phaseTable["restore-decomposition#1"].phases[`${arm}/${phase}`]
    return { key: `${arm}/${phase}`, equal: !!mine && mine.read === s.cacheRead && mine.write1h === s.cacheWrite1h && mine.output === s.billedModelOutput && mine.requests === s.requests }
  }),
)
const pcheck = results.experiments["policy-effect"].findings.pairs.flatMap((p) =>
  Object.entries(p.arms).map(([arm, a]) => {
    const rows = byUnit.get(`policy-effect#${p.pair}`).filter((r) => r.arm === arm)
    const s = sumRecords(rows)
    return { key: `pair${p.pair}/${arm}`, equal: s.cacheRead === a.totals.cacheRead && s.cacheWrite1h === a.totals.cacheWrite1h && s.billedModelOutput === a.totals.billedModelOutput && s.requests === a.totals.requests }
  }),
)

// ------------------------------------------------------------------ 2. successor caching pattern
const successorRoles = new Set(["restore_child", "useful_work"])
const S_CLI = 3035
const pattern = {}
for (const [unit, rows] of byUnit) {
  const exp = unit.split("#")[0]
  const seq = (arm, phases) =>
    rows
      .filter((r) => r.arm === arm && phases.has(r.phase))
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((r) => ({ step: r.stepId.split("/").slice(1).join("/"), phase: r.phase, ...u(r) }))
  const park = seq(PARK_ARM[exp], successorRoles)
  const raw = seq(RAW_ARM[exp], new Set(["resume_raw", "useful_work"]))
  const parkReadsOnlyS = park.every((c) => c.read === S_CLI)
  const parkWritesGrow = park.every((c, i) => i === 0 || c.write1h > park[i - 1].write1h)
  const rawReadsGrow = raw.every((c, i) => i === 0 || c.read >= raw[i - 1].read + raw[i - 1].write1h - 64)
  pattern[unit] = {
    status: UNIT_STATUS[unit],
    parkSuccessorCalls: park.length,
    parkSuccessorReadsEqualSystemPromptOnly: parkReadsOnlyS,
    parkSuccessorWritesStrictlyGrow: parkWritesGrow,
    parkSuccessorWrites: park.map((c) => c.write1h),
    rawReadsCoverPreviousPrompt: rawReadsGrow,
    rawWrites: raw.map((c) => c.write1h),
  }
}

// ------------------------------------------------------------------ 3. hypothetical: successor caches its own conversation
function counterfactualRows(rows, exp) {
  const arm = PARK_ARM[exp]
  const succ = rows.filter((r) => r.arm === arm && successorRoles.has(r.phase)).sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  const adj = new Map()
  let prevWrite = null
  for (const r of succ) {
    const x = u(r)
    if (prevWrite !== null) {
      const inc = x.write1h - prevWrite
      if (inc < 0) return null
      adj.set(r.stepId, { read: x.read + prevWrite, write1h: inc })
    }
    prevWrite = x.write1h
  }
  return rows.map((r) => {
    const a = adj.get(r.stepId)
    if (!a || r.arm !== arm) return r
    const usage = { ...(r.usage ?? {}) }
    usage.cache_read_input_tokens = a.read
    usage.cache_creation_input_tokens = a.write1h
    usage.cache_creation = { ...(usage.cache_creation ?? {}), ephemeral_1h_input_tokens: a.write1h, ephemeral_5m_input_tokens: 0 }
    return { ...r, usage }
  })
}
const armEq = (rows, arm, meter) => convertSums(sumRecords(rows.filter((r) => r.arm === arm)), ends[meter])
const diffOf = (cand, cur) => ({ lo: cand.lo - cur.hi, hi: cand.hi - cur.lo })
const pairs = {}
for (const unit of ["policy-effect#1", "policy-effect#2", "policy-effect#3", "restore-decomposition#1", "restore-decomposition#2"]) {
  const rows = byUnit.get(unit)
  const exp = unit.split("#")[0]
  const cf = counterfactualRows(rows, exp)
  pairs[unit] = { status: UNIT_STATUS[unit] }
  for (const m of METERS) {
    const measured = diffOf(armEq(rows, PARK_ARM[exp], m), armEq(rows, RAW_ARM[exp], m))
    const hypo = cf ? diffOf(armEq(cf, PARK_ARM[exp], m), armEq(rows, RAW_ARM[exp], m)) : null
    pairs[unit][m] = { measuredParkMinusRaw: [round(measured.lo, 8), round(measured.hi, 8)], hypotheticalParkMinusRaw: hypo ? [round(hypo.lo, 8), round(hypo.hi, 8)] : null }
  }
}
// Future-work differential V = raw useful_work minus parked useful_work, per resume, at each
// coefficient end (5h meter). Task-specific (6 or 8 identical work steps); scenario input only.
const usefulV = {}
for (const unit of ["restore-decomposition#1", "policy-effect#1", "policy-effect#2", "policy-effect#3", "restore-decomposition#2"]) {
  const rows = byUnit.get(unit)
  const exp = unit.split("#")[0]
  const cf = counterfactualRows(rows, exp)
  const sumPhase = (rs, arm) => convertSums(sumRecords(rs.filter((r) => r.arm === arm && r.phase === "useful_work")), ends["unified-5h"])
  const raw = sumPhase(rows, RAW_ARM[exp])
  const park = sumPhase(rows, PARK_ARM[exp])
  const parkCf = cf ? sumPhase(cf, PARK_ARM[exp]) : null
  usefulV[unit] = {
    status: UNIT_STATUS[unit],
    measured: { low: round(raw.lo - park.lo, 8), high: round(raw.hi - park.hi, 8) },
    hypotheticalSuccessorCaching: parkCf ? { low: round(raw.lo - parkCf.lo, 8), high: round(raw.hi - parkCf.hi, 8) } : null,
  }
}
const cleanPairs = ["policy-effect#1", "policy-effect#2", "policy-effect#3"]
const meanOf = (key, m) => {
  const lo = cleanPairs.reduce((a, p) => a + pairs[p][m][key][0], 0) / cleanPairs.length
  const hi = cleanPairs.reduce((a, p) => a + pairs[p][m][key][1], 0) / cleanPairs.length
  return [round(lo, 8), round(hi, 8)]
}
const pairMeans = Object.fromEntries(METERS.map((m) => [m, { measured: meanOf("measuredParkMinusRaw", m), hypothetical: meanOf("hypotheticalParkMinusRaw", m) }]))

// ------------------------------------------------------------------ 4. re-explanation (R2) and prompt parity
const cliDir = join(RERUN, "cli")
const cliOf = (stepId) => {
  const p = join(cliDir, `${stepId.replaceAll("/", "_")}.json`)
  try {
    const d = JSON.parse(readFileSync(p, "utf8"))
    return typeof d.result === "string" ? d.result : (d.stdoutJson?.result ?? null)
  } catch {
    return null
  }
}
const ASKS_AGAIN = /(missing|resend|re-send|paste|did not survive|didn't survive|not included|only the note|no file path|cannot scan|can't scan|need (the|one of))/i
const reexplain = {}
for (const [unit, rows] of byUnit) {
  const r2 = rows.find((r) => r.role === "r2")
  if (!r2) continue
  const text = cliOf(r2.stepId)
  const exp = unit.split("#")[0]
  const work = (arm) => rows.filter((r) => r.arm === arm && r.role === "work").sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((r) => r.promptSha256)
  const pw = work(PARK_ARM[exp])
  const rw = work(RAW_ARM[exp])
  reexplain[unit] = {
    status: UNIT_STATUS[unit],
    r2AsksForDataAgain: text === null ? null : ASKS_AGAIN.test(text),
    r2Usage: u(r2),
    workPromptsIdenticalAcrossArms: pw.length === rw.length && pw.every((h, i) => h === rw[i]),
    workSteps: pw.length,
  }
}
const analyzerR2 = { "restore-decomposition#1": rr.quality.park_path.reexplainNeeded?.value ?? null }
for (const p of results.experiments["policy-effect"].findings.pairs) analyzerR2[`policy-effect#${p.pair}`] = p.arms.shadow_candidate_policy.quality?.reexplainNeeded?.value ?? null

// ------------------------------------------------------------------ 5. system prompt size in the CLI experiment
const reads = req.filter((r) => r.status === 200).map((r) => u(r).read)
const cliSystemOnlyCalls = reads.filter((x) => x === S_CLI).length

// ------------------------------------------------------------------ 6. operational successor sessions (senpi transcripts)
const sessionFiles = []
for (const d of readdirSync(SESS)) {
  const p = `${SESS}/${d}`
  if (statSync(p).isDirectory()) sessionFiles.push(...listFiles(p, { filter: (f) => f.endsWith(".jsonl") }))
}
const successors = []
for (const f of sessionFiles) {
  const sid = f.split("/").pop().replace(/\.jsonl$/, "").split("_").slice(1).join("_")
  if (EXCLUDE.has(sid)) continue
  const { rows } = readJsonl(f)
  const h = rows[0]
  if (h?.type !== "session" || !h.parentSession || msOf(h.timestamp) > ASOF) continue
  const kickoff = rows.find((o) => o.type === "message" && o.message?.role === "user")
  const kickText = (() => {
    const c = kickoff?.message?.content
    if (typeof c === "string") return c
    return Array.isArray(c) ? c.map((p) => (p?.type === "text" ? p.text : "")).join("") : ""
  })()
  const isRolloverSuccessor = /^(This session was parked|Session rollover for|\[rollover\])/.test(kickText.trimStart())
  const calls = []
  let skillReads = 0
  let skillChars = 0
  const pendingSkill = new Set()
  for (const o of rows) {
    if (o.type !== "message") continue
    const m = o.message
    if (m.role === "assistant") {
      if (calls.length < 10 && m.usage) calls.push({ provider: m.provider, read: m.usage.cacheRead ?? 0, write: m.usage.cacheWrite ?? 0, input: m.usage.input ?? 0 })
      if (calls.length <= 15)
        for (const p of m.content ?? []) if (p?.type === "toolCall" && p.name === "read" && /SKILL\.md$/i.test(String(p.arguments?.path ?? p.arguments?.file_path ?? ""))) pendingSkill.add(p.id)
    }
    if (m.role === "toolResult" && pendingSkill.has(m.toolCallId)) {
      skillReads++
      skillChars += (Array.isArray(m.content) ? m.content.map((p) => p?.text ?? "").join("") : String(m.content ?? "")).length
      pendingSkill.delete(m.toolCallId)
    }
  }
  const usable = calls.filter((c) => c.read + c.write + c.input > 0)
  let hits = 0
  let misses = 0
  for (let i = 1; i < usable.length; i++) {
    const prevPrompt = usable[i - 1].read + usable[i - 1].write
    if (usable[i].read >= 0.9 * prevPrompt) hits++
    else misses++
  }
  successors.push({
    session: sid.slice(0, 8),
    rolloverSuccessor: isRolloverSuccessor,
    providers: [...new Set(usable.map((c) => c.provider))].sort(),
    firstCall: usable[0] ? { read: usable[0].read, write: usable[0].write, input: usable[0].input } : null,
    followingCallsConversationHit: hits,
    followingCallsPartialOrMiss: misses,
    skillFileReadsInFirst15Turns: skillReads,
    skillFileChars: skillChars,
  })
}
const rollSucc = successors.filter((s) => s.rolloverSuccessor)
const claudeLane = rollSucc.filter((s) => s.providers.some((p) => /claude|anthropic/.test(p)))
const firstPrefix = claudeLane.filter((s) => s.firstCall).map((s) => s.firstCall.read + s.firstCall.write)

const out = {
  v: "idle-existing-data-analysis/restore-reanalysis/1",
  conversion: { meterEnds: "conversionEnds({T measured, kOutUpperBound}) from scripts/idle-live-analyze.mjs at d8a4abd", T, kOutUpperBound },
  phaseSums: phaseTable,
  crossCheckAgainstMergedAnalysis: { restoreRun1: rcheck, policyPairs: pcheck, allEqual: [...rcheck, ...pcheck].every((x) => x.equal) },
  successorCachePattern: pattern,
  hypotheticalSuccessorCaching: {
    label: "hypothetical",
    assumption: "each successor call after the first reads the previous successor prompt from cache and writes only its increment, as the raw path already does in the same run",
    perUnit: pairs,
    cleanPairMeans: pairMeans,
    note: "measured values are the d8a4abd method recomputed; the hypothetical never replaces them",
  },
  futureWorkDifferentialV: { meter: "unified-5h", definition: "raw useful_work minus parked useful_work, per resume; >0 favours PARK", perUnit: usefulV },
  reexplanation: { perUnit: reexplain, analyzerReexplainNeeded: analyzerR2, keywordRule: String(ASKS_AGAIN) },
  systemPrompt: { cliSystemPromptTokens: S_CLI, callsReadingOnlyTheSystemPrompt: cliSystemOnlyCalls, paidCalls: reads.length },
  operationalSuccessors: {
    source: "senpi transcripts, usage fields only",
    successorSessions: successors.length,
    rolloverSuccessors: rollSucc.length,
    rolloverSuccessorsOnClaudeLanes: claudeLane.length,
    followingCallsConversationHit: claudeLane.reduce((a, s) => a + s.followingCallsConversationHit, 0),
    followingCallsPartialOrMiss: claudeLane.reduce((a, s) => a + s.followingCallsPartialOrMiss, 0),
    firstCallPrefixTokens: { n: firstPrefix.length, min: Math.min(...firstPrefix), median: pct(firstPrefix, 0.5), max: Math.max(...firstPrefix) },
    firstCallCachedRead: { median: pct(claudeLane.filter((s) => s.firstCall).map((s) => s.firstCall.read), 0.5) },
    skillFileReads: { sessionsWithAny: rollSucc.filter((s) => s.skillFileReadsInFirst15Turns > 0).length, reads: rollSucc.reduce((a, s) => a + s.skillFileReadsInFirst15Turns, 0), chars: rollSucc.reduce((a, s) => a + s.skillFileChars, 0) },
    perSession: successors,
  },
}
writeOut(join(OUT, "restore-reanalysis.json"), stable(out))
console.log(`restore reanalysis: ${byUnit.size} units, ${successors.length} successor sessions; wrote ${OUT}`)
