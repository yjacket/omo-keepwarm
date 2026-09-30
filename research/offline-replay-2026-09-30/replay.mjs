// Offline replay: how much would idle warming have saved on the claude-subscription lane?
// Reads every senpi session JSONL under ~/.omo/agent/sessions. Human return = entry type "message", role "user"
// (automated turns are "custom_message" entries). Hit or miss at return uses keepwarm's own isHit (src/warm.mjs).
// Model: TTL 60 min, a ping every 55 min while away < E = 300 min (auto expiry), ping cost = context x r (0.025).
// Usage: node research/offline-replay-2026-09-30/replay.mjs [since ISO] [until ISO]
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isHit } from "../../src/warm.mjs";

const [sinceArg, untilArg] = process.argv.slice(2);
const since = sinceArg ? Date.parse(sinceArg) : 0;
const until = untilArg ? Date.parse(untilArg) : Number.POSITIVE_INFINITY;
if (Number.isNaN(since) || Number.isNaN(until)) {
  console.error("usage: node replay.mjs [since ISO] [until ISO]");
  process.exit(2);
}

const ROOT = join(homedir(), ".omo", "agent", "sessions");
const API = "claude-sdk-oauth";
const R = 0.025;
const IV = 55;
const E = 300;
const TTL = 60;
const tok = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const usageOf = (m) => ({ input: tok(m.usage?.input), cacheRead: tok(m.usage?.cacheRead), cacheWrite: tok(m.usage?.cacheWrite) });
const ctxOf = (u) => u.input + u.cacheRead + u.cacheWrite;
const pings = (gapMin) => Math.max(0, Math.floor((Math.min(gapMin, E) - 1e-9) / IV));
const buckets = [[0, 5], [5, 30], [30, 60], [60, 120], [120, 300], [300, Number.POSITIVE_INFINITY]];
const B = buckets.map(([a, b]) => ({ range: `${a}-${b === Number.POSITIVE_INFINITY ? "inf" : b}m`, returns: 0, cold: 0, coldWrite: 0 }));
const S = { sessions: 0, humanReturns: 0, msgs: 0, write: 0, read: 0, idleGaps: 0, pings: 0, pingCost: 0, tailPings: 0, tailCost: 0, saved: 0, savedN: 0, first: Number.POSITIVE_INFINITY, last: 0 };

for (const dir of readdirSync(ROOT)) {
  let files;
  try {
    files = readdirSync(join(ROOT, dir));
  } catch {
    continue;
  }
  for (const f of files) {
    if (!f.endsWith(".jsonl")) continue;
    const entries = [];
    for (const line of readFileSync(join(ROOT, dir, f), "utf8").split("\n")) {
      if (!line) continue;
      let j;
      try {
        j = JSON.parse(line);
      } catch {
        continue;
      }
      if (j.type !== "message") continue;
      const t = Date.parse(j.timestamp);
      if (!Number.isFinite(t) || t < since || t >= until) continue;
      entries.push({ t, m: j.message });
    }
    let prev = null;
    let human = null;
    let used = false;
    for (const e of entries) {
      const role = e.m?.role;
      if (role === "user") {
        if (prev) human = { gapMin: (e.t - prev.t) / 60000, prevApi: prev.api };
        continue;
      }
      if (role !== "assistant") continue;
      const api = e.m.api;
      const u = usageOf(e.m);
      if (api === API && ctxOf(u) > 0) {
        used = true;
        S.msgs++;
        S.write += u.cacheWrite;
        S.read += u.cacheRead;
        S.first = Math.min(S.first, e.t);
        S.last = Math.max(S.last, e.t);
        if (prev && prev.api === API) {
          const gap = (e.t - prev.t) / 60000;
          if (gap > IV) {
            S.idleGaps++;
            S.pings += pings(gap);
            S.pingCost += pings(gap) * prev.ctx * R;
          }
        }
        if (human && human.prevApi === API) {
          S.humanReturns++;
          const b = B[buckets.findIndex(([a, z]) => human.gapMin >= a && human.gapMin < z)];
          b.returns++;
          if (!isHit(u)) {
            b.cold++;
            b.coldWrite += u.cacheWrite;
            if (human.gapMin > TTL && human.gapMin <= E) {
              S.saved += u.cacheWrite;
              S.savedN++;
            }
          }
        }
      }
      human = null;
      if (ctxOf(u) > 0 || api === API) prev = { t: e.t, api, ctx: ctxOf(u) };
    }
    if (used) {
      S.sessions++;
      if (prev && prev.api === API) {
        S.tailPings += pings(E);
        S.tailCost += pings(E) * prev.ctx * R;
      }
    }
  }
}

const fmt = (n) => Math.round(n).toLocaleString("en-US");
const iso = (t) => (Number.isFinite(t) && t > 0 ? new Date(t).toISOString() : "-");
const out = [
  `claude-subscription offline replay (TTL ${TTL}m, ping every ${IV}m while away < ${E}m, r ${R}, hit = src/warm.mjs isHit)`,
  `window ${iso(S.first)} .. ${iso(S.last)} · sessions ${S.sessions} · assistant msgs ${S.msgs}`,
  `cache tokens: read ${fmt(S.read)} · write ${fmt(S.write)}`,
  `human returns ${S.humanReturns} by gap since the last request (returns / measured cold / cold write tokens):`,
  ...B.map((b) => `  ${b.range.padEnd(10)}${String(b.returns).padStart(5)} / ${String(b.cold).padStart(4)} / ${fmt(b.coldWrite)}`),
  `warming could have saved (cold returns with ${TTL}m < gap <= ${E}m): ${S.savedN} returns, ${fmt(S.saved)} write tokens`,
  `ping cost inside sessions: ${S.idleGaps} idle gaps > ${IV}m, ${S.pings} pings, ${fmt(S.pingCost)} write-eq tokens`,
  `ping cost after the last request of each session (unknown open time): 0 .. ${S.tailPings} pings, 0 .. ${fmt(S.tailCost)} write-eq tokens`,
  `net saving: ${fmt(S.saved - S.pingCost - S.tailCost)} .. ${fmt(S.saved - S.pingCost)} write-eq tokens`,
  `net share of all cache writes: ${S.write ? ((100 * (S.saved - S.pingCost - S.tailCost)) / S.write).toFixed(1) : "-"}% .. ${S.write ? ((100 * (S.saved - S.pingCost)) / S.write).toFixed(1) : "-"}%`,
];
console.log(out.join("\n"));
