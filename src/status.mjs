import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson, readJsonSafe } from "./fsx.mjs";
import { layout, localDate } from "./paths.mjs";
import { sumDay, sumSpend } from "./ledger.mjs";

export const STALE_AFTER_MS = 900000;

const MODES = new Set(["off", "shadow", "on"]);
const LANE_VALUES = new Set(["on", "shadow", "observe", "off"]);
const LANE_RANK = { off: 0, observe: 1, shadow: 2, on: 3 };
// Phases in which the human is not driving the session.
const IDLE_PHASES = new Set(["HELD", "ARMED", "PINGING", "OBSERVING", "EXPIRED"]);
const WARMING_PHASES = new Set(["ARMED", "PINGING"]);

function configMode(home) {
  const cfg = readJsonSafe(layout(home).config);
  if (cfg === undefined) return "off";
  const m = cfg && typeof cfg === "object" ? cfg.mode : undefined;
  return MODES.has(m) ? m : "shadow";
}

function liveSessions(home, nowMs) {
  const dir = layout(home).statusDir;
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    if (!n.endsWith(".json") || n === "_global.json" || n.startsWith(".")) continue;
    const s = readJsonSafe(join(dir, n));
    if (!s || typeof s !== "object" || typeof s.ts !== "number" || !Number.isFinite(s.ts)) continue;
    if (nowMs - s.ts > STALE_AFTER_MS) continue;
    out.push(s);
  }
  return out;
}

function errorsToday(home, today) {
  let text;
  try {
    text = readFileSync(layout(home).errorLog, "utf8");
  } catch {
    return 0;
  }
  let n = 0;
  for (const line of text.split("\n")) {
    const ms = Date.parse(line.split(" ", 1)[0]);
    if (Number.isFinite(ms) && localDate(ms) === today) n++;
  }
  return n;
}

function laneEntry(s) {
  const id = typeof s.lane === "string" ? s.lane : s.lane?.id;
  if (typeof id !== "string" || !id) return undefined;
  const policy = typeof s.lane === "object" ? s.lane?.policy : undefined;
  if (policy === "observe") return [id, "observe"];
  if (policy === "invalid") return [id, "off"];
  return [id, LANE_VALUES.has(s.mode) ? s.mode : "off"];
}

export function computeGlobal(home, nowMs) {
  const today = localDate(nowMs);
  const mode = configMode(home);
  const sessions = liveSessions(home, nowMs);
  const day = sumDay(home, today);
  const usd = sumSpend(home, today, { virtual: false });
  const errors = errorsToday(home, today);
  const lanes = {};
  for (const s of sessions) {
    const e = laneEntry(s);
    if (!e) continue;
    const [id, v] = e;
    if (lanes[id] === undefined || LANE_RANK[v] > LANE_RANK[lanes[id]]) lanes[id] = v;
  }
  const count = sessions.length;
  const idle = sessions.filter((s) => IDLE_PHASES.has(s.phase)).length;
  const warming = sessions.filter((s) => WARMING_PHASES.has(s.phase)).length;
  const disabled = sessions.some((s) => s.self === "disabled");
  const level = errors > 0 || disabled ? "warn" : "ok";
  const text =
    `keepwarm ${mode} · ${count} sessions (${idle} idle) · ` +
    `today ${day.episodes} episodes, ${day.humanReturns} returns, ${day.pings} pings, $${usd.toFixed(2)}`;
  return {
    v: 1,
    ts: nowMs,
    staleAfter: nowMs + STALE_AFTER_MS,
    level,
    text,
    detail: {
      mode,
      sessions: { count, idle, warming },
      today: { episodes: day.episodes, humanReturns: day.humanReturns, wouldWarm: day.wouldWarm, pings: day.pings, usd },
      errorsToday: errors,
      lanes,
    },
  };
}

export function createStatus({ home, sessionId, now = Date.now }) {
  const L = layout(home);
  const file = L.sessionStatus(sessionId);
  const prior = readJsonSafe(file);
  const state = {
    phase: null,
    lane: null,
    mode: null,
    episode: null,
    tAwayMin: null,
    nextTickMs: null,
    self: "active",
    episodeState: prior && typeof prior === "object" ? prior.episodeState ?? null : null,
  };

  function writeGlobal() {
    atomicWriteJson(L.globalStatus, computeGlobal(home, now()));
  }

  function write() {
    const { episodeState, ...rest } = state;
    atomicWriteJson(file, { v: 1, ts: now(), session: sessionId, ...rest, episodeState });
    writeGlobal();
  }

  return {
    update(partial = {}) {
      for (const [k, v] of Object.entries(partial)) {
        if (k === "v" || k === "ts" || k === "session" || k === "episodeState") continue;
        state[k] = v;
      }
      write();
    },
    saveEpisode(episodeState) {
      state.episodeState = episodeState ?? null;
      write();
    },
    loadEpisode() {
      const s = readJsonSafe(file);
      return s && typeof s === "object" && s.session === sessionId ? s.episodeState ?? null : null;
    },
    heartbeat() {
      write();
    },
    close() {
      if (state.episodeState) {
        state.phase = "detached";
        write();
        return;
      }
      rmSync(file, { force: true });
      writeGlobal();
    },
  };
}
