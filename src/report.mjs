// Episode report over keepwarm records, plus shared minute formatting.
import { loadEpisodes } from "./calibrate.mjs";

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const num = (v) => (isNum(v) ? v : 0);

// 0 -> "0", <60 -> "Nm", multiple of 60 -> "Nh", otherwise "NhMm".
export function formatMinutes(min) {
  if (!isNum(min)) return "-";
  if (min === 0) return "0";
  const neg = min < 0 ? "-" : "";
  const a = Math.abs(min);
  const trim = (v) => String(Math.round(v * 100) / 100);
  if (a < 60) return `${neg}${trim(a)}m`;
  const h = Math.floor(a / 60);
  const m = a - h * 60;
  return m === 0 ? `${neg}${h}h` : `${neg}${h}h${trim(m)}m`;
}

// Linear-interpolated quantile (type 7) of an ascending array.
function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function bump(map, key) {
  const k = key === null || key === undefined ? "(none)" : String(key);
  map[k] = (map[k] ?? 0) + 1;
}

function emptyLane() {
  return {
    episodes: 0,
    closeKinds: {},
    closeSources: {},
    automatedTurnSources: {},
    humanReturns: 0,
    awayMinQuartiles: null,
    coveredAtReturn: 0,
    coveredAtReturnRate: null,
    coldWithoutWarm: 0,
    returnCacheWrite: 0,
    savedWriteTokens: 0,
    wouldWarm: 0,
    pings: 0,
    costUsd: 0,
    _away: [],
    _saved: 0,
    _spent: 0,
  };
}

export function buildReport(home, { days = 7, now = Date.now } = {}) {
  const nowMs = typeof now === "function" ? now() : now;
  const episodes = loadEpisodes(home, { sinceDays: days, now: nowMs });
  const lanes = {};
  const total = emptyLane();
  for (const e of episodes) {
    const id = e.lane ?? "(unknown)";
    const L = (lanes[id] ??= emptyLane());
    const c = e.close;
    const o = e.open;
    const returnWrite = num(e.returnUsage?.cacheWrite);
    const covered = c.coveredAtReturn === true;
    const cold = c.coldWithoutWarm === true;
    const human = c.kind === "human_return";
    const saved = human && covered && cold ? returnWrite : 0;
    const spent = num(c.wouldWarm) * num(o.contextTokens) * num(o.r);
    for (const T of [L, total]) {
      T.episodes++;
      bump(T.closeKinds, c.kind);
      bump(T.closeSources, c.source);
      for (const t of e.turns) if (t.kind === "automated") bump(T.automatedTurnSources, t.source);
      if (human) {
        T.humanReturns++;
        if (isNum(c.awayMin)) T._away.push(c.awayMin);
        if (covered) T.coveredAtReturn++;
        if (e.returnUsage) T.returnCacheWrite += returnWrite;
      }
      if (cold) T.coldWithoutWarm++;
      T._saved += saved;
      T._spent += spent;
      T.wouldWarm += num(c.wouldWarm);
      T.pings += num(c.pings);
      T.costUsd += num(c.costUsd);
    }
  }
  const finish = (T) => {
    const away = T._away.sort((a, b) => a - b);
    T.awayMinQuartiles = away.length
      ? { q1: quantile(away, 0.25), median: quantile(away, 0.5), q3: quantile(away, 0.75) }
      : null;
    T.coveredAtReturnRate = T.humanReturns ? T.coveredAtReturn / T.humanReturns : null;
    T.savedWriteTokens = T._saved - T._spent;
    delete T._away;
    delete T._saved;
    delete T._spent;
    return T;
  };
  for (const id of Object.keys(lanes)) finish(lanes[id]);
  finish(total);
  return { v: 1, days, generatedAt: new Date(nowMs).toISOString(), lanes, total };
}

function dist(map) {
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return entries.length ? entries.map(([k, v]) => `${k} ${v}`).join(", ") : "-";
}

function laneBlock(name, T) {
  const q = T.awayMinQuartiles;
  const rate = T.coveredAtReturnRate === null ? "-" : `${Math.round(T.coveredAtReturnRate * 100)}%`;
  return [
    `${name}  ${T.episodes} episodes · ${T.humanReturns} human returns`,
    `  close kinds: ${dist(T.closeKinds)}`,
    `  close sources: ${dist(T.closeSources)}`,
    `  automated turns: ${dist(T.automatedTurnSources)}`,
    `  away (human returns): ${q ? `q1 ${formatMinutes(q.q1)} · median ${formatMinutes(q.median)} · q3 ${formatMinutes(q.q3)}` : "-"}`,
    `  covered at return ${rate} (${T.coveredAtReturn}/${T.humanReturns}) · cold without warm ${T.coldWithoutWarm} · return cacheWrite ${Math.round(T.returnCacheWrite)}`,
    `  counterfactual saving ${Math.round(T.savedWriteTokens)} write-eq tokens (would-warm ${T.wouldWarm})`,
    `  pings ${T.pings} · $${T.costUsd.toFixed(4)}`,
  ].join("\n");
}

export function formatReport(r) {
  const head = `keepwarm report · last ${r.days} days · ${r.total.episodes} episodes`;
  if (r.total.episodes === 0) return `${head}\n`;
  const blocks = Object.keys(r.lanes).sort().map((id) => laneBlock(id, r.lanes[id]));
  blocks.push(laneBlock("total", r.total));
  return `${head}\n\n${blocks.join("\n\n")}\n`;
}
