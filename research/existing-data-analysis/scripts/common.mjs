// Shared helpers for the offline idle existing-data analysis.
// Read-only over every input: nothing here writes outside the caller-supplied output path.
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HOME = homedir().replaceAll("\\", "/")

export const DEFAULTS = Object.freeze({
  rolloverDir: `${HOME}/.omo/rollover`,
  sessionsDir: `${HOME}/.omo/agent/sessions`,
  omoHealthReceipts: `${HOME}/.omo-health/receipts`,
  firstRun: "C:/dev/omo/omo-rollover-wt/idle-rerun-w1/.omo/ulw-execute/evidence/idle-live-run/live/20260925-161302",
  rerun: "C:/dev/omo/omo-rollover-wt/idle-rerun-w1/.omo/ulw-execute/evidence/idle-live-run/rerun/20260927-052028",
  quota0919: fileURLToPath(new URL("../../quota-2026-09-19", import.meta.url)).replaceAll("\\", "/"),
  // The analysing session itself: its observation is still open, so it is never an input.
  excludeSessions: ["01a0e42b-24f8-7226-a4f6-04c2b45cf607"],
  // As-of cut: the analysing session's start. Entries after it are ignored so a live session
  // appending to its log cannot change a rerun.
  asof: "2026-09-27T18:40:27.896Z",
})

export function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith("--")) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith("--")) out[key] = true
    else {
      out[key] = next
      i++
    }
  }
  return out
}

export const msOf = (iso) => {
  const v = Date.parse(iso)
  return Number.isFinite(v) ? v : null
}
export const isoOf = (ms) => (ms === null || ms === undefined ? null : new Date(ms).toISOString())

/** Tolerant JSONL reader: returns { rows, bad } and never throws on a malformed line. */
export function readJsonl(path) {
  const text = readFileSync(path, "utf8")
  const rows = []
  let bad = 0
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      bad++
    }
  }
  return { rows, bad }
}

export function sha256File(path, limitBytes = null) {
  const buf = readFileSync(path)
  const view = limitBytes === null ? buf : buf.subarray(0, limitBytes)
  return createHash("sha256").update(view).digest("hex")
}

export function listFiles(dir, { recursive = false, filter = () => true } = {}) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name).replaceAll("\\", "/")
    const st = statSync(p)
    if (st.isDirectory()) {
      if (recursive) out.push(...listFiles(p, { recursive, filter }))
    } else if (filter(p)) out.push(p)
  }
  return out.sort()
}

/** Deterministic JSON: sorted keys, fixed float formatting left to JSON. */
export function stable(value, indent = 2) {
  const norm = (v) => {
    if (Array.isArray(v)) return v.map(norm)
    if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])]))
    return v
  }
  return JSON.stringify(norm(value), null, indent) + "\n"
}

export function writeOut(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

/** mulberry32: seeded PRNG so every bootstrap rerun is byte-identical. */
export function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const round = (x, d = 6) => (x === null || x === undefined || !Number.isFinite(x) ? x : Number(x.toFixed(d)))

/**
 * Aalen-Johansen cumulative incidence for competing risks.
 * items: [{ t (minutes), status: 0 censored | 1 event of interest | 2 competing end }]
 * Ties: events are processed before censorings at the same time.
 * Returns the step function as arrays plus a query helper.
 */
export function aalenJohansen(items) {
  const sorted = [...items].sort((a, b) => a.t - b.t || (a.status === 0) - (b.status === 0))
  const times = [...new Set(sorted.map((x) => x.t))].sort((a, b) => a - b)
  let atRisk = sorted.length
  let S = 1
  let F1 = 0
  let F2 = 0
  let S1km = 1
  const steps = [] // { t, F1, F2, S, F1km, atRiskBefore, d1, d2, c }
  let idx = 0
  for (const t of times) {
    let d1 = 0
    let d2 = 0
    let c = 0
    while (idx < sorted.length && sorted[idx].t === t) {
      const s = sorted[idx].status
      if (s === 1) d1++
      else if (s === 2) d2++
      else c++
      idx++
    }
    const n = atRisk
    if (n > 0 && d1 + d2 > 0) {
      F1 += (S * d1) / n
      F2 += (S * d2) / n
      S *= 1 - (d1 + d2) / n
      S1km *= 1 - d1 / n
    }
    steps.push({ t, F1, F2, S, F1km: 1 - S1km, atRiskBefore: n, d1, d2, c })
    atRisk -= d1 + d2 + c
  }
  const at = (t) => {
    let last = { F1: 0, F2: 0, S: 1, F1km: 0 }
    for (const s of steps) {
      if (s.t <= t) last = s
      else break
    }
    const atRisk = sorted.filter((x) => x.t >= t).length
    return { F1: last.F1, F2: last.F2, S: last.S, F1km: last.F1km, atRisk }
  }
  const maxT = sorted.length ? sorted[sorted.length - 1].t : 0
  return { steps, at, n: sorted.length, maxT }
}

/** Percentile (linear interpolation) of a numeric array. */
export function pct(arr, p) {
  const a = [...arr].filter(Number.isFinite).sort((x, y) => x - y)
  if (!a.length) return null
  const pos = (a.length - 1) * p
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return a[lo] + (a[hi] - a[lo]) * (pos - lo)
}
