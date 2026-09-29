// Habit calibration: Aalen-Johansen over away durations from keepwarm records.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson, readJsonLines, readJsonSafe } from "./fsx.mjs";
import { layout } from "./paths.mjs";
import { HORIZON_MIN, returnCdf } from "./policy.mjs";

const DAY_MS = 86_400_000;
const AUTO_MAX_AGE_MS = DAY_MS;
export const MIN_HUMAN_RETURNS = 30;
export const WINDOW_DAYS = 28;
const FIT_POINTS = [5, 30, 60, 120];
const STEP_MIN = 0.5;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

export function laneIdOf(lane) {
  if (typeof lane === "string") return lane;
  return isObj(lane) && typeof lane.id === "string" ? lane.id : null;
}

function listFiles(dir, suffix) {
  try {
    return readdirSync(dir).filter((n) => n.endsWith(suffix)).map((n) => join(dir, n));
  } catch {
    return [];
  }
}

// Pairs episode_open with episode_close from records/<YYYY-MM>/*.jsonl.
// Each episode also carries its turn records and its first return_usage record.
// includeOpen: also return episodes without a close, right-censored at their last record
// (close null, kind null, awayMin = last record ts - awayStartMs).
export function loadEpisodes(home, { sinceDays = WINDOW_DAYS, now = Date.now, includeOpen = false } = {}) {
  const nowMs = typeof now === "function" ? now() : now;
  const since = nowMs - sinceDays * DAY_MS;
  const dir = layout(home).recordsDir;
  let months;
  try {
    months = readdirSync(dir).filter((n) => /^\d{4}-\d{2}$/.test(n)).sort();
  } catch {
    return [];
  }
  const byId = new Map();
  const get = (id) => {
    let e = byId.get(id);
    if (!e) byId.set(id, (e = { episode: id, open: null, close: null, turns: [], returnUsage: null, lastMs: -Infinity }));
    return e;
  };
  for (const m of months) {
    for (const file of listFiles(join(dir, m), ".jsonl")) {
      for (const rec of readJsonLines(file)) {
        if (!isObj(rec) || rec.v !== 1 || typeof rec.episode !== "string") continue;
        const tsMs = Date.parse(rec.ts);
        if (Number.isFinite(tsMs)) {
          const g = get(rec.episode);
          if (tsMs > g.lastMs) g.lastMs = tsMs;
        }
        if (rec.type === "episode_open") get(rec.episode).open = rec;
        else if (rec.type === "episode_close") get(rec.episode).close = rec;
        else if (rec.type === "turn") get(rec.episode).turns.push(rec);
        else if (rec.type === "return_usage") {
          const e = get(rec.episode);
          if (!e.returnUsage) e.returnUsage = rec;
        }
      }
    }
  }
  const out = [];
  for (const e of byId.values()) {
    if (!e.open || (!e.close && !includeOpen)) continue;
    const startMs = isNum(e.open.awayStartMs) ? e.open.awayStartMs : Date.parse(e.open.ts);
    if (!(startMs >= since) || startMs > nowMs) continue;
    out.push({
      episode: e.episode,
      session: e.open.session,
      lane: laneIdOf(e.open.lane),
      awayStartMs: startMs,
      awayMin: e.close ? e.close.awayMin : Math.max(0, (e.lastMs - startMs) / 60_000),
      kind: e.close ? e.close.kind : null,
      source: e.close ? e.close.source : null,
      detail: e.close ? e.close.detail : null,
      open: e.open,
      close: e.close,
      turns: e.turns,
      returnUsage: e.returnUsage,
    });
  }
  out.sort((a, b) => a.awayStartMs - b.awayStartMs);
  return out;
}

// Status for competing-risks estimation:
// 1 = human return, 2 = context ended (session_shutdown quit|new|resume|fork), 0 = censored
// (every other close reason, and still-open observation).
const ENDED_DETAILS = new Set(["quit", "new", "resume", "fork"]);
export function statusOf(e) {
  if (e?.kind === "human_return") return 1;
  if (e?.kind === "censored" && e.source === "session_shutdown" && ENDED_DETAILS.has(e.detail)) return 2;
  return 0;
}

// Aalen-Johansen cumulative incidence of human return (status 1) with competing end (status 2).
// Ties: events before censorings. Returns [{ t, F }] at each time where F changes.
function aalenJohansen(obs) {
  const sorted = [...obs].sort((a, b) => a.t - b.t || (a.status === 0) - (b.status === 0));
  let atRisk = sorted.length;
  let S = 1;
  let F1 = 0;
  const steps = [];
  let i = 0;
  while (i < sorted.length) {
    const t = sorted[i].t;
    let d1 = 0;
    let d2 = 0;
    let n = 0;
    while (i < sorted.length && sorted[i].t === t) {
      if (sorted[i].status === 1) d1++;
      else if (sorted[i].status === 2) d2++;
      n++;
      i++;
    }
    if (atRisk > 0 && d1 + d2 > 0) {
      F1 += (S * d1) / atRisk;
      S *= 1 - (d1 + d2) / atRisk;
      if (d1 > 0) steps.push({ t, F: F1 });
    }
    atRisk -= n;
  }
  return steps;
}

function stepAt(steps, t) {
  let F = 0;
  for (const s of steps) {
    if (s.t > t) break;
    F = s.F;
  }
  return F;
}

export function estimate(episodes) {
  const obs = [];
  const counts = [0, 0, 0];
  for (const e of episodes ?? []) {
    if (!isNum(e?.awayMin) || e.awayMin < 0) continue;
    const status = statusOf(e);
    counts[status]++;
    obs.push({ t: e.awayMin, status });
  }
  const result = {
    p: null,
    mMin: null,
    t90Min: null,
    pTruncatedAtMin: null,
    fit: null,
    humanReturns: counts[1],
    competingEnds: counts[2],
    censored: counts[0],
    episodes: obs.length,
  };
  const steps = aalenJohansen(obs);
  if (steps.length === 0) return result;

  const lastObs = Math.max(...obs.map((o) => o.t));
  const p = stepAt(steps, HORIZON_MIN);
  if (lastObs < HORIZON_MIN) result.pTruncatedAtMin = lastObs;
  if (!(p > 0)) return result;
  result.p = p;

  const limit = Math.min(HORIZON_MIN, lastObs);
  for (let k = 1; k * STEP_MIN <= limit + STEP_MIN; k++) {
    const t = k * STEP_MIN;
    const G = stepAt(steps, t) / p;
    if (result.mMin === null && G >= 0.5 - 1e-12) result.mMin = t;
    if (result.t90Min === null && G >= 0.9 - 1e-12) {
      result.t90Min = t;
      break;
    }
  }
  if (result.mMin !== null && result.t90Min !== null && result.mMin < result.t90Min) {
    const habit = { p, mMin: result.mMin, t90Min: result.t90Min };
    result.fit = Math.max(...FIT_POINTS.map((t) => Math.abs(returnCdf(t, habit) - stepAt(steps, t))));
  }
  return result;
}

export function estimateUsable(est, minReturns = MIN_HUMAN_RETURNS) {
  return (
    est.humanReturns >= minReturns &&
    isNum(est.p) && est.p > 0 && est.p <= 1 &&
    isNum(est.mMin) && isNum(est.t90Min) && est.mMin > 0 && est.mMin < est.t90Min
  );
}

export function behaviorRecord(est, nowMs) {
  return {
    v: 1,
    p: est.p,
    mMin: est.mMin,
    t90Min: est.t90Min,
    humanReturns: est.humanReturns,
    episodes: est.episodes,
    windowDays: WINDOW_DAYS,
    fit: est.fit,
    updatedAt: new Date(nowMs).toISOString(),
    source: "observed",
  };
}

// Writes behavior.json when habit is "auto", the file is missing or older than 24h,
// and there are at least 30 human returns. Never touches config.json.
export function maybeAutoCalibrate({ home, now = Date.now }) {
  const nowMs = typeof now === "function" ? now() : now;
  const L = layout(home);
  const cfg = readJsonSafe(L.config);
  if (isObj(cfg) && isObj(cfg.habit)) return { action: "skip", reason: "manual-habit" };
  const prev = readJsonSafe(L.behavior);
  if (isObj(prev)) {
    const updated = typeof prev.updatedAt === "number" ? prev.updatedAt : Date.parse(prev.updatedAt);
    if (Number.isFinite(updated) && nowMs - updated < AUTO_MAX_AGE_MS) return { action: "skip", reason: "fresh" };
  }
  const est = estimate(loadEpisodes(home, { sinceDays: WINDOW_DAYS, now: nowMs, includeOpen: true }));
  if (!estimateUsable(est)) return { action: "skip", reason: "insufficient", estimate: est };
  const rec = behaviorRecord(est, nowMs);
  atomicWriteJson(L.behavior, rec);
  return { action: "write", behavior: rec };
}
