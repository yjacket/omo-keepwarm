import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson, readJsonSafe } from "./fsx.mjs";
import { layout, localDate } from "./paths.mjs";
import { sumDay, sumSpend } from "./ledger.mjs";
import { STALE_AFTER_MS } from "./policy.mjs";

const MODES = new Set(["off", "shadow", "on"]);
const LANE_VALUES = new Set(["on", "shadow", "observe", "off"]);
const LANE_RANK = { off: 0, observe: 1, shadow: 2, on: 3 };
// Controller phases in which the human is not driving the session (an open episode that is armed,
// pinging, observing, paused or held; CLASSIFYING and BUSY are a turn in progress).
export const IDLE_PHASES = new Set(["HELD", "ARMED", "PINGING", "OBSERVING", "PAUSED"]);
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

// Another session may be renaming over _global.json at the same moment (Windows); the next writer wins.
const GLOBAL_BUSY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

export function createStatus({
  home,
  sessionId,
  now = Date.now,
  debounceMs = 0,
  setTimeout: setTimer = globalThis.setTimeout,
  clearTimeout: clearTimer = globalThis.clearTimeout,
  canWrite = () => true,
}) {
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
  let timer = null;
  let pending = false;
  let dead = false; // abandoned: the config file is gone or mode is off, nothing may be written any more

  function writeSession() {
    if (dead) return;
    const { episodeState, ...rest } = state;
    atomicWriteJson(file, { v: 1, ts: now(), session: sessionId, ...rest, episodeState });
  }

  function cancelPending() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    pending = false;
  }

  /** Write the session file now, including everything merged so far, and drop any scheduled write. */
  function writeNow() {
    cancelPending();
    writeSession();
  }

  function schedule() {
    pending = true;
    if (timer !== null) return;
    timer = setTimer(() => {
      timer = null;
      if (!pending) return;
      pending = false;
      // Unattended write: dropped when the config file is gone (the home was purged in the meantime).
      if (!canWrite()) return;
      try {
        writeSession();
      } catch {
        // A timer has no caller to report to: stay dirty so the next flush, saveEpisode or heartbeat retries and throws there.
        pending = true;
      }
    }, debounceMs);
    timer?.unref?.();
  }

  function recomputeGlobal() {
    if (dead) return;
    try {
      atomicWriteJson(L.globalStatus, computeGlobal(home, now()));
    } catch (err) {
      if (!GLOBAL_BUSY_CODES.has(err?.code)) throw err;
    }
  }

  function flush() {
    if (pending) writeNow();
  }

  return {
    update(partial = {}) {
      const wasOpen = state.episode != null;
      for (const [k, v] of Object.entries(partial)) {
        if (k === "v" || k === "ts" || k === "session" || k === "episodeState") continue;
        state[k] = v;
      }
      if ((state.episode != null) !== wasOpen) {
        writeNow();
        recomputeGlobal();
      } else if (debounceMs > 0) {
        schedule();
      } else {
        writeSession();
      }
    },
    saveEpisode(episodeState) {
      state.episodeState = episodeState ?? null;
      writeNow();
    },
    loadEpisode() {
      const s = readJsonSafe(file);
      return s && typeof s === "object" && s.session === sessionId ? s.episodeState ?? null : null;
    },
    flush,
    recomputeGlobal,
    heartbeat() {
      writeNow();
      recomputeGlobal();
    },
    /** Drops the pending write and the saved episode without touching the disk; every later call is a no-op. */
    abandon() {
      dead = true;
      cancelPending();
      state.episodeState = null;
    },
    close() {
      if (dead) return;
      flush();
      cancelPending();
      if (state.episodeState) {
        state.phase = "detached";
        writeSession();
      } else {
        rmSync(file, { force: true });
      }
      recomputeGlobal();
    },
  };
}
