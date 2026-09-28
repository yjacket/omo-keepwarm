// Idle episodes and user-return estimates from existing operational logs (offline, read-only).
//
// Source A: rollover extension event log (~/.omo/rollover). It carries the exact signals the
//   idle policy would use: agent_settled{total} (child wake sum), user_input{source} (interactive
//   vs extension-injected), session shutdown reasons (summary.jsonl) and rollover links.
// Source B: senpi main-session transcripts (~/.omo/agent/sessions). Longer window, but no input
//   source label and no shutdown record; typed commands are invisible; pending children are
//   approximated from task spawn/completion records.
//
// Nothing here converts "log ended" into "never returned": an episode whose log stops is
// right-censored at its last observed entry. Automated wakes (goal continuation, task
// completion, monitors, omo-health, stop-hook continuations) are never a user return.
//
// usage: node q-episodes.mjs --out <dir> [--rollover <dir>] [--sessions <dir>] [--asof <iso>]
import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { DEFAULTS, parseArgs, msOf, isoOf, readJsonl, listFiles, stable, writeOut, rng, round, aalenJohansen, pct } from "./common.mjs"

const args = parseArgs(process.argv.slice(2))
const OUT = args.out
if (!OUT) {
  console.error("usage: node q-episodes.mjs --out <dir>")
  process.exit(2)
}
const ROLL = args.rollover ?? DEFAULTS.rolloverDir
const SESS = args.sessions ?? DEFAULTS.sessionsDir
const ASOF = msOf(args.asof ?? DEFAULTS.asof)
const EXCLUDE = new Set(DEFAULTS.excludeSessions)
const GRID_MIN = [5, 30, 60, 120, 240, 480, 1440]
const BOOT = 2000
const SEED = 20260928
const MIN = 60000

const repoOf = (cwd) => String(cwd ?? "").split(/[\\/]/).filter(Boolean).pop() ?? ""
const short = (sid) => String(sid).slice(0, 8)

// ------------------------------------------------------------------ source A
function loadA() {
  const files = listFiles(join(ROLL, "sessions"), { filter: (p) => p.endsWith(".jsonl") })
  const sess = new Map()
  let bad = 0
  let afterAsof = 0
  for (const f of files) {
    const sid = f.split("/").pop().replace(/\.jsonl$/, "")
    const { rows, bad: b } = readJsonl(f)
    bad += b
    const ev = []
    for (const e of rows) {
      const t = msOf(e.t)
      if (t === null) {
        bad++
        continue
      }
      if (t > ASOF) {
        afterAsof++
        continue
      }
      ev.push({ ...e, _ms: t })
    }
    sess.set(sid, ev)
  }
  const { rows: summ, bad: sb } = readJsonl(join(ROLL, "summary.jsonl"))
  const shutBy = new Map()
  for (const s of summ) {
    const t = msOf(s.t)
    if (t === null || t > ASOF) continue
    if (!shutBy.has(s.session)) shutBy.set(s.session, [])
    shutBy.get(s.session).push({ ev: "shutdown", reason: s.reason, _ms: t })
  }
  // One timeline per session: events plus shutdown records (a shutdown sorts before an event at the same ms).
  const timeline = new Map()
  for (const [sid, ev] of sess) {
    const all = [...ev, ...(shutBy.get(sid) ?? [])]
    all.sort((a, b) => a._ms - b._ms || (a.ev === "shutdown" ? -1 : 0) - (b.ev === "shutdown" ? -1 : 0))
    timeline.set(sid, all)
  }
  return { files: files.length, bad: bad + sb, afterAsof, timeline, summaryRows: summ.length }
}

function episodesA(A, handover) {
  const { timeline } = A
  let firstUserInput = Infinity
  let lastEvent = -Infinity
  for (const ev of timeline.values())
    for (const e of ev) {
      if (e.ev === "user_input") firstUserInput = Math.min(firstUserInput, e._ms)
      lastEvent = Math.max(lastEvent, e._ms)
    }
  const cwdOf = new Map([...timeline].map(([sid, ev]) => [sid, ev.find((e) => e.cwd)?.cwd ?? null]))
  const instrumentedFrom = (sid) => {
    const ev = timeline.get(sid)
    const c = []
    const ui = ev.find((e) => e.ev === "user_input")
    if (ui) c.push(ui._ms)
    const st = ev.find((e) => e.ev === "session_start" && e._ms >= firstUserInput)
    if (st) c.push(st._ms)
    return c.length ? Math.min(...c) : null
  }
  function scan(sid, i0, t0, chain, machinery0) {
    const ev = timeline.get(sid)
    let machinery = machinery0
    let rollingOver = false
    let prevSignificant = null
    let last = t0
    const flags = []
    for (let j = i0; j < ev.length; j++) {
      const e = ev[j]
      if (e._ms < t0) continue
      switch (e.ev) {
        case "user_input":
          if (e.source === "interactive") return { outcome: "return", t: e._ms, chain, flags }
          machinery = true
          flags.push(`extension_input`)
          break
        case "command":
          // The extension dispatches "/rollover now" itself right after successor_found
          // (tryRollover -> sendUserMessage); only other commands are typed by the user.
          if (e.verb === "now" && prevSignificant === "successor_found") {
            flags.push("self_dispatched:now")
            break
          }
          flags.push(`command:${e.verb ?? ""}`)
          if (!flags.some((f) => f.startsWith("firstCommandMs="))) flags.push(`firstCommandMs=${e._ms}`)
          break
        case "idle_park":
          machinery = true
          flags.push("idle_park")
          break
        case "handoff_requested":
          machinery = true
          flags.push(`handoff_requested:${e.at ?? ""}`)
          break
        case "rollover": {
          const ns = e.newSession
          if (ns && timeline.has(ns)) {
            flags.push("rollover_chain")
            const r = scan(ns, 0, t0, [...chain, ns], true)
            return { ...r, flags: [...flags, ...r.flags] }
          }
          return { outcome: "censored", reason: "successor_log_missing", t: e._ms, chain, flags }
        }
        case "message_end":
          if (!machinery) return { outcome: "censored", reason: "auto_resume", t: e._ms, chain, flags }
          break
        case "agent_settled":
          machinery = false
          break
        case "shutdown": {
          if (e.reason === "reload") {
            flags.push("reload")
            machinery = false
            break
          }
          if (e.reason === "rollover" || rollingOver) {
            // The extension's own handoff: the rollover event (same instant) carries the successor
            // link; shutdown records written while it lands belong to the same handoff.
            if (ev.slice(j + 1).some((x) => x.ev === "rollover" && x.newSession)) {
              rollingOver = true
              flags.push(`shutdown_${e.reason}_during_rollover`)
              break
            }
            return { outcome: "censored", reason: "successor_unlinked", t: e._ms, chain, flags }
          }
          if (ev.slice(j + 1).some((x) => x.ev === "session_start")) {
            flags.push(`reopened_after_${e.reason}`)
            machinery = false
            break
          }
          // The labelled log may stop before a later reopen: the transcript decides.
          const h = handover(sid, e._ms, t0, chain)
          if (h) return { ...h, flags: [...flags, `after_${e.reason}_transcript_handover`] }
          return { outcome: "ended", reason: `shutdown_${e.reason}`, t: e._ms, chain, flags }
        }
        case "session_start":
          if (j > i0) flags.push("restart")
          break
        default:
          break
      }
      if (e.ev !== "wake_source_state" && e.ev !== "shutdown") prevSignificant = e.ev
      last = Math.max(last, e._ms)
    }
    // The extension log for this session stops here (e.g. the extension was uninstalled): the
    // transcript may still show what came next.
    const h = handover(sid, last, t0, chain)
    if (h) return { ...h, flags: [...flags, "log_end_transcript_handover"] }
    return { outcome: "censored", reason: "log_end", t: last, chain, flags }
  }
  const out = []
  const excluded = { temp_cwd_sessions: 0, pending_children: 0, wake_unknown: 0, before_instrumentation: 0, uninstrumented_sessions: 0, excluded_session_ids: 0 }
  for (const [sid, ev] of timeline) {
    if (EXCLUDE.has(sid)) {
      excluded.excluded_session_ids++
      continue
    }
    if (/AppData[\\/]Local[\\/]Temp/i.test(cwdOf.get(sid) ?? "")) {
      excluded.temp_cwd_sessions++
      continue
    }
    const inst = instrumentedFrom(sid)
    if (inst === null) {
      excluded.uninstrumented_sessions++
      continue
    }
    let lastContext = null
    let settledRun = false
    for (let i = 0; i < ev.length; i++) {
      const e = ev[i]
      if (e.ev === "message_end" && Number.isFinite(e.context)) lastContext = e.context
      if (["message_end", "user_input", "command", "session_start"].includes(e.ev)) settledRun = false
      if (e.ev !== "agent_settled") continue
      if (settledRun) continue
      settledRun = true
      if (e._ms < inst) {
        excluded.before_instrumentation++
        continue
      }
      if (e.total === null || e.total === undefined) {
        excluded.wake_unknown++
        continue
      }
      if (e.total !== 0) {
        excluded.pending_children++
        continue
      }
      const r = scan(sid, i + 1, e._ms, [sid], false)
      const cmd = r.flags.find((f) => f.startsWith("firstCommandMs="))
      out.push({
        source: "A",
        session: short(sid),
        repo: repoOf(cwdOf.get(sid)),
        t0: isoOf(e._ms),
        t0Ms: e._ms,
        contextTokens: lastContext,
        outcome: r.outcome,
        reason: r.reason ?? null,
        tMin: round((r.t - e._ms) / MIN, 4),
        firstCommandMin: cmd ? round((Number(cmd.split("=")[1]) - e._ms) / MIN, 4) : null,
        chainLength: r.chain.length,
        flags: [...new Set(r.flags.filter((f) => !f.startsWith("firstCommandMs=")))].sort(),
      })
    }
  }
  return { episodes: out, excluded, window: { from: isoOf(firstUserInput), to: isoOf(lastEvent) }, firstUserInput, lastEvent }
}

// ------------------------------------------------------------------ source B
const WAKE = new Set([
  "omo-senpi:wake",
  "goal-continuation",
  "senpi-monitor:notification",
  "senpi-terminal:notification",
  "senpi-codemode:notification",
  "omo-health",
  "compaction.post-compact-restoration",
])
const EXT_PREFIX = ["[rollover]", "This session was parked", "Session rollover for"]
const TERM = new Set(["completed", "error", "failed", "cancelled", "canceled", "aborted", "timeout", "timed_out", "lost", "killed", "done"])

const textOf = (msg) => {
  const c = msg?.content
  if (typeof c === "string") return c
  if (!Array.isArray(c)) return ""
  return c.map((p) => (p && p.type === "text" ? p.text ?? "" : "")).join("\n")
}

function loadB() {
  const files = []
  for (const d of listDirs(SESS)) for (const f of listFiles(d, { filter: (p) => p.endsWith(".jsonl") })) files.push(f)
  const byPath = new Map()
  let bad = 0
  let excludedFiles = 0
  for (const f of files) {
    const sid = f.split("/").pop().replace(/\.jsonl$/, "").split("_").slice(1).join("_")
    if (EXCLUDE.has(sid)) {
      excludedFiles++
      continue
    }
    const { rows, bad: b } = readJsonl(f)
    bad += b
    const header = rows[0]?.type === "session" ? rows[0] : null
    if (!header || msOf(header.timestamp) > ASOF) continue
    const es = []
    for (const o of rows.slice(1)) {
      const t = msOf(o.timestamp)
      if (t === null || t > ASOF) continue
      es.push({ ...o, _ms: t })
    }
    byPath.set(norm(f), { sid, path: f, header, es })
  }
  const children = new Map()
  for (const [p, s] of byPath) {
    const parent = s.header.parentSession ? norm(s.header.parentSession) : null
    if (parent && byPath.has(parent)) {
      if (!children.has(parent)) children.set(parent, [])
      children.get(parent).push(p)
    }
  }
  for (const list of children.values()) list.sort((a, b) => msOf(byPath.get(a).header.timestamp) - msOf(byPath.get(b).header.timestamp))
  return { files: files.length, excludedFiles, bad, byPath, children }
}
function listDirs(dir) {
  return readdirSyncSafe(dir).map((n) => `${dir}/${n}`).filter((p) => isDir(p)).sort()
}
const readdirSyncSafe = (d) => {
  try {
    return readdirSync(d)
  } catch {
    return []
  }
}
const isDir = (p) => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}
const norm = (p) => String(p).replaceAll("\\", "/").toLowerCase()

function kindB(o) {
  if (o.type === "message") {
    const r = o.message?.role
    if (r === "assistant") return `assistant:${o.message?.stopReason}`
    if (r === "user") return EXT_PREFIX.some((p) => textOf(o.message).trimStart().startsWith(p)) ? "user:ext" : "user:human"
    return r ?? "other"
  }
  if (o.type === "custom_message") return WAKE.has(o.customType) ? `wake:${o.customType}` : "attach"
  if (o.type === "custom") {
    if (o.customType === "goal-cache-warmup" && o.data?.phase === "resumed") return "wake:goal-cache-warmup"
    return "hb"
  }
  return "other"
}

function taskIds(d, out) {
  if (Array.isArray(d)) for (const v of d) taskIds(v, out)
  else if (d && typeof d === "object") {
    if (typeof d.task_id === "string" && d.task_id && typeof d.status === "string") out.push([d.task_id, d.status])
    for (const v of Object.values(d)) taskIds(v, out)
  }
  return out
}
function taskTimeline(es) {
  const evs = []
  for (const o of es) {
    if (o.type === "message" && o.message?.role === "toolResult" && ["task", "task_send", "task_cancel"].includes(o.message.toolName)) {
      for (const [id, st] of taskIds(o.message.details ?? {}, [])) {
        if (["running", "pending", "queued"].includes(st)) evs.push([o._ms, id, 1])
        else if (TERM.has(st)) evs.push([o._ms, id, 0])
      }
    }
    if (o.type === "custom_message" && o.customType === "omo-senpi:wake")
      for (const [id, st] of taskIds(o.details ?? [], [])) if (TERM.has(st)) evs.push([o._ms, id, 0])
  }
  return evs.sort((a, b) => a[0] - b[0])
}
const outstandingAt = (evs, t) => {
  const state = new Map()
  for (const [m, id, k] of evs) {
    if (m > t) break
    state.set(id, k)
  }
  let n = 0
  for (const v of state.values()) n += v
  return n
}

/** Scan transcript entries from index i0 for the first trigger after an idle start t0. */
function scanB(B, key, i0, t0, chain) {
  const { byPath, children } = B
  const { es } = byPath.get(key)
  let ext = false
  let last = t0
  for (let j = i0; j < es.length; j++) {
    const o = es[j]
    const k = kindB(o)
    if (k === "user:human") return { outcome: "return", t: o._ms, chain }
    if (k === "user:ext") {
      ext = true
      last = Math.max(last, o._ms)
      continue
    }
    if (k.startsWith("wake:")) return { outcome: "censored", reason: `auto_resume:${k.slice(5)}`, t: o._ms, chain }
    if (k.startsWith("assistant:")) {
      if (ext) {
        if (k === "assistant:stop") ext = false
        last = Math.max(last, o._ms)
        continue
      }
      return { outcome: "censored", reason: "auto_resume:assistant_without_trigger", t: o._ms, chain }
    }
    last = Math.max(last, o._ms)
  }
  const kids = children.get(key)
  if (ext && kids?.length) return scanB(B, kids[0], 0, t0, [...chain, byPath.get(kids[0]).sid])
  return { outcome: "censored", reason: "file_end", t: last, chain }
}

/** A-to-B handover: the first transcript trigger strictly after afterMs in the same session, or null. */
function makeHandover(B) {
  const keyBySid = new Map([...B.byPath].map(([k, s]) => [s.sid, k]))
  return (sid, afterMs, t0, chain) => {
    const key = keyBySid.get(sid)
    if (!key) return null
    const es = B.byPath.get(key).es
    const i = es.findIndex((o) => o._ms > afterMs && kindB(o) !== "hb" && kindB(o) !== "attach")
    if (i < 0) return null
    return scanB(B, key, i, t0, chain)
  }
}

function episodesB(B, periodOf) {
  const { byPath } = B
  const scan = (key, i0, t0, chain) => scanB(B, key, i0, t0, chain)
  const out = []
  const excluded = { pending_children: 0 }
  for (const [key, s] of byPath) {
    const tl = taskTimeline(s.es)
    for (let i = 0; i < s.es.length; i++) {
      const o = s.es[i]
      const k = kindB(o)
      if (!k.startsWith("assistant:") || k === "assistant:toolUse") continue
      const stop = k.slice("assistant:".length)
      const pending = outstandingAt(tl, o._ms)
      if (pending > 0) {
        excluded.pending_children++
        continue
      }
      const r = scan(key, i + 1, o._ms, [s.sid])
      out.push({
        source: "B",
        session: short(s.sid),
        repo: repoOf(s.header.cwd),
        t0: isoOf(o._ms),
        t0Ms: o._ms,
        stopReason: stop,
        period: periodOf(o._ms),
        outcome: r.outcome,
        reason: r.reason ?? null,
        tMin: round((r.t - o._ms) / MIN, 4),
        chainLength: r.chain.length,
      })
    }
  }
  return { episodes: out, excluded }
}

// ------------------------------------------------------------------ estimation
const statusOf = (ep, { endsAsCompeting = true } = {}) => (ep.outcome === "return" ? 1 : ep.outcome === "ended" ? (endsAsCompeting ? 2 : 0) : 0)

function estimate(eps, opts = {}) {
  const items = eps.map((e) => ({ t: e.tMin, status: statusOf(e, opts), cluster: e.session }))
  const aj = aalenJohansen(items)
  const grid = Object.fromEntries(GRID_MIN.map((m) => [m, aj.at(m)]))
  // cluster bootstrap over the session where each episode started
  const clusters = new Map()
  for (const it of items) {
    if (!clusters.has(it.cluster)) clusters.set(it.cluster, [])
    clusters.get(it.cluster).push(it)
  }
  const keys = [...clusters.keys()].sort()
  const draw = rng(SEED)
  const boot = Object.fromEntries(GRID_MIN.map((m) => [m, []]))
  for (let b = 0; b < BOOT && keys.length; b++) {
    const sample = []
    for (let i = 0; i < keys.length; i++) sample.push(...clusters.get(keys[Math.floor(draw() * keys.length)]))
    const a = aalenJohansen(sample)
    for (const m of GRID_MIN) boot[m].push(a.at(m).F1)
  }
  const counts = { n: items.length, returns: items.filter((x) => x.status === 1).length, competingEnds: items.filter((x) => x.status === 2).length, censored: items.filter((x) => x.status === 0).length, sessions: keys.length }
  return {
    counts,
    maxFollowUpMin: round(aj.maxT, 2),
    lastReturnMin: round(Math.max(0, ...items.filter((x) => x.status === 1).map((x) => x.t)), 2),
    grid: Object.fromEntries(
      GRID_MIN.map((m) => [
        m,
        {
          returnCIF: round(grid[m].F1, 4),
          returnCIF_bootstrap95: [round(pct(boot[m], 0.025), 4), round(pct(boot[m], 0.975), 4)],
          endedCIF: round(grid[m].F2, 4),
          stillOpen: round(grid[m].S, 4),
          returnKM_endsCensored: round(grid[m].F1km, 4),
          atRisk: grid[m].atRisk,
        },
      ]),
    ),
    steps: aj.steps.filter((s) => s.d1 + s.d2 > 0).map((s) => ({ tMin: round(s.t, 4), d1: s.d1, d2: s.d2, atRisk: s.atRiskBefore, F1: round(s.F1, 6), F2: round(s.F2, 6), S: round(s.S, 6) })),
  }
}

// ------------------------------------------------------------------ run
const B = loadB()
const A = loadA()
const EA = episodesA(A, makeHandover(B))
const periodOf = (t) => (t < EA.firstUserInput ? "P1" : t <= EA.lastEvent ? "P2" : "P3")
const EB = episodesB(B, periodOf)

// Cross-validation on the overlap: pair each A episode with the B idle start of the same session within 15 s.
function crossValidate() {
  const bBy = new Map()
  for (const b of EB.episodes) {
    if (!bBy.has(b.session)) bBy.set(b.session, [])
    bBy.get(b.session).push(b)
  }
  const table = {}
  const durDiff = []
  let unmatched = 0
  for (const a of EA.episodes) {
    const c = (bBy.get(a.session) ?? []).filter((b) => Math.abs(b.t0Ms - a.t0Ms) < 15000)
    if (!c.length) {
      unmatched++
      continue
    }
    const b = c.reduce((x, y) => (Math.abs(y.t0Ms - a.t0Ms) < Math.abs(x.t0Ms - a.t0Ms) ? y : x))
    const key = `A:${a.outcome}${a.reason ? `(${a.reason})` : ""} | B:${b.outcome}`
    table[key] = (table[key] ?? 0) + 1
    if (a.outcome === "return" && b.outcome === "return") durDiff.push(Math.abs(a.tMin - b.tMin))
  }
  const bothReturn = durDiff.length
  return {
    pairedOn: "same session id, idle start within 15 s",
    unmatchedAEpisodes: unmatched,
    outcomeTable: table,
    bothReturn,
    returnTimeAbsDiffMin: { median: round(pct(durDiff, 0.5), 4), p90: round(pct(durDiff, 0.9), 4), max: round(Math.max(0, ...durDiff), 2), over1min: durDiff.filter((d) => d > 1).length },
    bExtraInP2: EB.episodes.filter((b) => b.period === "P2" && b.stopReason === "stop").length - Object.values(table).reduce((x, y) => x + y, 0),
  }
}

const primaryB = (p) => EB.episodes.filter((e) => e.period === p && e.stopReason === "stop")
const byOutcome = (eps) => {
  const o = {}
  for (const e of eps) {
    const k = `${e.outcome}${e.reason ? `:${e.reason}` : ""}`
    o[k] = (o[k] ?? 0) + 1
  }
  return o
}
const A_big = EA.episodes.filter((e) => Number.isFinite(e.contextTokens) && e.contextTokens >= 100000)
const repoCounts = (eps) => {
  const o = {}
  for (const e of eps) o[e.repo] = (o[e.repo] ?? 0) + 1
  return o
}
const countBy = (eps, keyOf) => {
  const m = {}
  for (const e of eps) {
    const k = keyOf(e)
    m[k] = (m[k] ?? 0) + 1
  }
  return m
}
const sessionShare = (eps) => {
  const c = Object.values(countBy(eps, (e) => e.session)).sort((a, b) => b - a)
  const top = c.slice(0, 5).reduce((a, b) => a + b, 0)
  return { sessions: c.length, top5Share: round(top / Math.max(1, eps.length), 3) }
}
const flagCounts = (eps) => {
  const o = {}
  for (const e of eps) for (const f of e.flags ?? []) o[f.split(":")[0]] = (o[f.split(":")[0]] ?? 0) + 1
  return o
}
const hourHistogram = (eps) => {
  const h = Array(24).fill(0)
  for (const e of eps) h[(new Date(e.t0Ms).getUTCHours() + 9) % 24]++
  return h
}

const summary = {
  v: "idle-existing-data-analysis/q-episodes/1",
  asof: isoOf(ASOF),
  gridMinutes: GRID_MIN,
  bootstrap: { resamples: BOOT, seed: SEED, unit: "session where the idle episode started", interval: "2.5-97.5 percentile; not a calibrated forecast interval" },
  definitions: {
    idleStartA: "agent_settled with child wake sum total == 0 (senpi-task + omo-dag), first of a run of settles with no activity between",
    idleStartB: "assistant message with stopReason stop (primary) / error / aborted, no outstanding task id at that time",
    returnA: "user_input with source interactive (typed or rpc input); typed /rollover commands are neutral and scanning continues",
    returnB: "role=user message that is not a rollover-extension injection",
    notReturn: "extension input, goal continuation, task completion wake, monitor/terminal/codemode notification, omo-health message, stop-hook or retry continuation",
    endedA: "session_shutdown reason quit/new/resume/fork with no later session_start of the same session (user ended or left this context); competing event, not proof the task is finished",
    censored: "automated resume (competing activity), log end, missing successor log; right-censored at the last observed entry",
    periods: { P1: `< ${EA.window.from}`, P2: `${EA.window.from} .. ${EA.window.to} (rollover log with input-source labels)`, P3: `> ${EA.window.to} .. asof` },
  },
  inputs: {
    A: { files: A.files, summaryRows: A.summaryRows, malformedLines: A.bad, entriesAfterAsof: A.afterAsof, labelledWindow: EA.window },
    B: { files: B.files, excludedFiles: B.excludedFiles, malformedLines: B.bad, sessionsParsed: B.byPath.size },
  },
  A: {
    exclusions: EA.excluded,
    outcomes: byOutcome(EA.episodes),
    flags: flagCounts(EA.episodes),
    repos: repoCounts(EA.episodes),
    concentration: sessionShare(EA.episodes),
    idleStartHourKST: hourHistogram(EA.episodes),
    estimate_endsCompeting: estimate(EA.episodes, { endsAsCompeting: true }),
    estimate_endsCensored: estimate(EA.episodes, { endsAsCompeting: false }),
    // Sensitivity: a typed /rollover command (not the extension's own "/rollover now") counts as
    // the user's return (presence), at its own time.
    estimate_commandAsReturn: estimate(
      EA.episodes.map((e) => (e.firstCommandMin !== null && e.firstCommandMin <= e.tMin ? { ...e, outcome: "return", tMin: e.firstCommandMin } : e)),
      { endsAsCompeting: true },
    ),
    episodesWithTypedCommand: EA.episodes.filter((e) => e.firstCommandMin !== null).length,
    contextAtLeast100K: { n: A_big.length, outcomes: byOutcome(A_big), estimate: A_big.length ? estimate(A_big, { endsAsCompeting: true }) : null },
    contextTokensAtIdle: { median: pct(EA.episodes.map((e) => e.contextTokens).filter(Number.isFinite), 0.5), p90: pct(EA.episodes.map((e) => e.contextTokens).filter(Number.isFinite), 0.9) },
  },
  B: {
    exclusions: EB.excluded,
    stopReasons: countBy(EB.episodes, (e) => `${e.period}:${e.stopReason}`),
    periods: Object.fromEntries(
      ["P1", "P2", "P3"].map((p) => {
        const eps = primaryB(p)
        return [p, { outcomes: byOutcome(eps), repos: repoCounts(eps), concentration: sessionShare(eps), estimate: estimate(eps, { endsAsCompeting: false }) }]
      }),
    ),
    errorStops: Object.fromEntries(["P1", "P2", "P3"].map((p) => [p, byOutcome(EB.episodes.filter((e) => e.period === p && e.stopReason === "error"))])),
  },
  crossValidationP2: crossValidate(),
}

writeOut(join(OUT, "q-summary.json"), stable(summary))
const strip = (e) => {
  const { t0Ms, ...rest } = e
  void t0Ms
  return rest
}
writeOut(join(OUT, "q-episodes-A.jsonl"), EA.episodes.map((e) => JSON.stringify(strip(e))).join("\n") + "\n")
writeOut(join(OUT, "q-episodes-B.jsonl"), EB.episodes.map((e) => JSON.stringify(strip(e))).join("\n") + "\n")
console.log(`A episodes ${EA.episodes.length}, B episodes ${EB.episodes.length}; wrote ${OUT}`)
