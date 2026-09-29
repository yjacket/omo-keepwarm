import { statSync } from "node:fs";
import { atomicWriteJson, readJsonSafe } from "./fsx.mjs";
import { layout } from "./paths.mjs";

export const DEFAULTS = {
  v: 1,
  mode: "shadow",
  maxUsdPerEpisode: 0.5,
  maxUsdPerDay: 3,
  expiry: {},
  habit: "auto",
  lanes: {},
};

export const DEFAULT_HABIT = { p: 0.81, mMin: 10.5, t90Min: 140, source: "default" };

const MODES = new Set(["off", "shadow", "on"]);
const MIN_HUMAN_RETURNS = 30;
const MAX_BEHAVIOR_AGE_MS = 28 * 24 * 60 * 60 * 1000;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

function habitParamsValid(p, m, t90) {
  return isNum(p) && isNum(m) && isNum(t90) && p > 0 && p <= 1 && m > 0 && m < t90;
}

function cloneDefaults() {
  return { ...DEFAULTS, expiry: {}, lanes: {} };
}

// Returns { config, invalid }. Unknown keys of `raw` are kept; known keys are validated.
function validate(raw) {
  const invalid = [];
  const config = cloneDefaults();
  if (!isObj(raw)) return { config, invalid: ["file"] };
  Object.assign(config, raw);

  if (raw.v !== 1) {
    if ("v" in raw) invalid.push("v");
    config.v = 1;
  }

  if (!("mode" in raw)) config.mode = DEFAULTS.mode;
  else if (typeof raw.mode !== "string" || !MODES.has(raw.mode)) {
    invalid.push("mode");
    config.mode = DEFAULTS.mode;
  }

  for (const key of ["maxUsdPerEpisode", "maxUsdPerDay"]) {
    if (!(key in raw)) config[key] = DEFAULTS[key];
    else if (!isNum(raw[key]) || raw[key] < 0) {
      invalid.push(key);
      config[key] = DEFAULTS[key];
    }
  }

  config.expiry = {};
  if ("expiry" in raw) {
    if (!isObj(raw.expiry)) invalid.push("expiry");
    else {
      for (const [lane, val] of Object.entries(raw.expiry)) {
        if (val === "auto" || (isNum(val) && val >= 0)) config.expiry[lane] = val;
        else invalid.push(`expiry.${lane}`);
      }
    }
  }

  if (!("habit" in raw)) config.habit = "auto";
  else if (raw.habit !== "auto") {
    const h = raw.habit;
    if (isObj(h) && habitParamsValid(h.p, h.medianMinutes, h.t90Minutes)) {
      config.habit = { ...h };
    } else {
      invalid.push("habit");
      config.habit = "auto";
    }
  }

  config.lanes = {};
  if ("lanes" in raw) {
    if (!isObj(raw.lanes)) invalid.push("lanes");
    else {
      for (const [lane, val] of Object.entries(raw.lanes)) {
        if (isObj(val)) config.lanes[lane] = val;
        else invalid.push(`lanes.${lane}`);
      }
    }
  }

  return { config, invalid };
}

function mtimeOf(file) {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

export function createConfigSource({ home, now = Date.now, statEveryMs = 5000 } = {}) {
  const files = layout(home);
  let lastCheck;
  let cfgMtime;
  let behMtime;
  let cfg = { ...cloneDefaults(), mode: "off" };
  let invalidList = [];
  let present = false;
  let behavior;

  function refresh() {
    const t = now();
    if (lastCheck !== undefined && t - lastCheck < statEveryMs) return;
    lastCheck = t;

    const cm = mtimeOf(files.config);
    if (cm !== cfgMtime) {
      cfgMtime = cm;
      present = cm !== undefined;
      if (!present) {
        cfg = { ...cloneDefaults(), mode: "off" };
        invalidList = [];
      } else {
        const raw = readJsonSafe(files.config);
        const res = validate(raw);
        cfg = res.config;
        invalidList = res.invalid;
      }
    }

    const bm = mtimeOf(files.behavior);
    if (bm !== behMtime) {
      behMtime = bm;
      behavior = bm === undefined ? undefined : readJsonSafe(files.behavior);
    }
  }

  function observedHabit() {
    const b = behavior;
    if (!isObj(b) || b.v !== 1) return undefined;
    if (!habitParamsValid(b.p, b.mMin, b.t90Min)) return undefined;
    if (!isNum(b.humanReturns) || b.humanReturns < MIN_HUMAN_RETURNS) return undefined;
    const updated = typeof b.updatedAt === "number" ? b.updatedAt : Date.parse(b.updatedAt);
    if (!Number.isFinite(updated) || now() - updated > MAX_BEHAVIOR_AGE_MS) return undefined;
    return { p: b.p, mMin: b.mMin, t90Min: b.t90Min, source: "observed" };
  }

  return {
    get() {
      refresh();
      return cfg;
    },
    habit() {
      refresh();
      if (isObj(cfg.habit)) {
        return { p: cfg.habit.p, mMin: cfg.habit.medianMinutes, t90Min: cfg.habit.t90Minutes, source: "manual" };
      }
      return observedHabit() ?? { ...DEFAULT_HABIT };
    },
    invalid() {
      refresh();
      return [...invalidList];
    },
    exists() {
      refresh();
      return present;
    },
  };
}

// mutator receives a copy of the current config (unknown keys included) and may mutate it
// or return a replacement. The result is validated and written atomically.
export function updateConfig(home, mutator) {
  const file = layout(home).config;
  const raw = readJsonSafe(file);
  const base = isObj(raw) ? validate(raw).config : cloneDefaults();
  const draft = structuredClone(base);
  const next = mutator(draft) ?? draft;
  const { config } = validate(next);
  atomicWriteJson(file, config);
  return config;
}

// Lanes whose TTL (and therefore grid) can come in more than one class keep their expiry
// setting per class: "<laneId>:<gridClass>". Single-class lanes use the bare lane id.
export const MULTI_CLASS_LANES = new Set(["anthropic-api", "openai-api", "codex-subscription"]);

export function expiryKey(lane) {
  return MULTI_CLASS_LANES.has(lane.id) ? `${lane.id}:${lane.gridClass}` : lane.id;
}

// config.expiry lookup: exact "<id>:<class>" first, then bare "<id>"; "auto" when neither is set.
export function expirySettingFor(expiry, lane) {
  const e = expiry ?? {};
  const exact = `${lane.id}:${lane.gridClass}`;
  const v = Object.hasOwn(e, exact) ? e[exact] : Object.hasOwn(e, lane.id) ? e[lane.id] : "auto";
  return typeof v === "number" && Number.isFinite(v) ? v : "auto";
}
