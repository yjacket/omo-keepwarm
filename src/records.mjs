import { appendJsonLine } from "./fsx.mjs";
import { layout } from "./paths.mjs";

// Nested shapes: only these keys survive; missing ones become null.
const HABIT = ["p", "mMin", "t90Min", "source"];
const EXPIRY = ["formulaMin", "autoMin", "requestedMin", "effectiveMin", "source"];
const USAGE = ["input", "output", "cacheRead", "cacheWrite"];
const ERROR = ["kind", "message", "status"];
const MARKER = ["kind", "atMs"];
const MAX_MARKERS = 32;

export const SCHEMA = {
  session: ["reason", "mode", "sessionKind", "uiMode", "keepwarmVersion", "cwd", "restored"],
  episode_open: [
    "episode", "awayStartMs", "openedBy", "lane", "provider", "api", "model", "thinking",
    "contextTokens", "habit", "r", "expiry", "maxPings", "mode", "warmPath", "verified",
  ],
  segment_open: [
    "episode", "segment", "reason", "anchorMs", "lane", "model", "eligible", "disabledReason", "otherWakeSources",
  ],
  decision: ["episode", "segment", "tick", "tAwayMin", "hazard", "r", "action", "reason", "lateByMs"],
  ping: ["episode", "segment", "tick", "ok", "hit", "usage", "costUsd", "durationMs", "error", "stale"],
  warm_stop: ["episode", "segment", "reason"],
  turn: ["episode", "segment", "kind", "source", "startMs"],
  marker: ["episode", "kind", "atMs"],
  episode_close: [
    "episode", "closedAtMs", "awayMin", "kind", "source", "detail", "segments", "turns", "decisions",
    "wouldWarm", "pings", "costUsd", "virtualUsd", "expired", "coveredAtReturn", "coldWithoutWarm", "markers",
  ],
  return_usage: ["episode", "model", "input", "output", "cacheRead", "cacheWrite", "sinceRealAnchorSec"],
};

const NESTED = {
  episode_open: { habit: HABIT, expiry: EXPIRY },
  ping: { usage: USAGE, error: ERROR },
};

function pick(obj, keys) {
  if (obj === null || obj === undefined || typeof obj !== "object") return null;
  const out = {};
  for (const k of keys) out[k] = obj[k] === undefined ? null : obj[k];
  return out;
}

export function buildRecord(type, fields, { sessionId, ms }) {
  const keys = SCHEMA[type];
  if (!keys) throw new Error(`unknown record type: ${type}`);
  const src = fields ?? {};
  const line = { v: 1, ts: new Date(ms).toISOString(), type, session: sessionId };
  const nested = NESTED[type] ?? {};
  for (const k of keys) {
    const val = src[k];
    if (nested[k]) line[k] = pick(val, nested[k]);
    else if (type === "episode_close" && k === "markers") {
      line[k] = Array.isArray(val) ? val.slice(-MAX_MARKERS).map((m) => pick(m, MARKER)) : [];
    } else line[k] = val === undefined ? null : val;
  }
  return line;
}

export function createRecorder({ home, sessionId, now = Date.now }) {
  const L = layout(home);
  return {
    write(type, fields) {
      const ms = now();
      const line = buildRecord(type, fields, { sessionId, ms });
      appendJsonLine(L.recordFile(sessionId, ms), line);
      return line;
    },
  };
}
