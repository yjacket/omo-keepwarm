// `omo-keepwarm expiry` and `omo-keepwarm expiry set <laneKey> <value>`.
import { createConfigSource, updateConfig, MULTI_CLASS_LANES, expiryKey, expirySettingFor } from "../config.mjs";
import { classifyLane } from "../lanes.mjs";
import { keepwarmHome } from "../paths.mjs";
import { resolveExpiry } from "../policy.mjs";
import { formatMinutes } from "../report.mjs";

// Equivalent of the pi-ai lane checks, kept here because src/ may not import host packages.
function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
const piAi = {
  isAnthropicApiBaseUrl: (url) => hostOf(url) === "api.anthropic.com",
  isOpenAIResponsesPromptCacheModel: (m) =>
    m?.api === "openai-responses" &&
    hostOf(m.baseUrl) === "api.openai.com" &&
    m?.compat?.supportsExplicitPromptCacheMode === true,
  resolvePromptCacheTtlSeconds: (m) =>
    m?.api === "anthropic-messages" && m?.cacheRetention === "long" ? 3600 : undefined,
};

// Lane default descriptors: synthetic models so no real model is needed.
const SONNET_COST = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
export const DESCRIPTOR_MODELS = [
  { api: "claude-sdk-oauth", provider: "claude-sdk", baseUrl: "https://api.anthropic.com" },
  { api: "openai-codex-responses", provider: "openai-codex", baseUrl: "https://chatgpt.com/backend-api" },
  { api: "anthropic-messages", provider: "anthropic", baseUrl: "https://api.anthropic.com", cost: SONNET_COST },
  { api: "anthropic-messages", provider: "anthropic", baseUrl: "https://api.anthropic.com", cacheRetention: "long", cost: SONNET_COST },
  {
    api: "openai-responses", provider: "openai", baseUrl: "https://api.openai.com/v1",
    compat: { supportsExplicitPromptCacheMode: true },
    cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  },
];

// Lanes whose TTL can come in more than one grid class are keyed "<laneId>:<gridClass>";
// single-class lanes keep the bare id.
export { MULTI_CLASS_LANES, expiryKey, expirySettingFor };

export function laneDescriptors(overrides) {
  return DESCRIPTOR_MODELS.map((model) => {
    const lane = classifyLane(model, { piAi, overrides });
    return { key: expiryKey(lane), lane };
  });
}

// "auto" handled by callers. Accepts "90" (minutes), "20m", "4h", "2h20m", "10.5m". NaN if invalid.
export function parseDuration(s) {
  if (typeof s !== "string") return NaN;
  const t = s.trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  const m = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?$/.exec(t);
  if (!m || (m[1] === undefined && m[2] === undefined)) return NaN;
  return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
}

const fmtR = (r) => String(Number(r.toPrecision(3)));
// TTL and ping interval print as plain minutes ("TTL 60m", "ping every 4.5m"), per the output contract.
const plainMin = (sec) => `${Math.round((sec / 60) * 100) / 100}m`;
const steps = (grid, mark) => grid.map((g) => (g === mark ? `[${formatMinutes(g)}]` : formatMinutes(g))).join(" · ");

export function habitText(h) {
  return `habit ${h.source} (p ${fmtR(h.p)}, m ${formatMinutes(h.mMin)}, t90 ${formatMinutes(h.t90Min)})`;
}

function block(key, lane, habit, setting) {
  if (lane.policy !== "decide") return `${key}  policy ${lane.policy} · no expiry`;
  const x = resolveExpiry({ lane, habit, setting });
  const head =
    `${key}  TTL ${plainMin(lane.ttlSec)} · ping every ${plainMin(lane.intervalSec)}` +
    ` · r ${fmtR(lane.r)} · ${habitText(habit)}`;
  let settingText = "auto";
  if (x.source === "manual") {
    settingText = formatMinutes(x.requestedMin);
    if (x.effectiveMin !== x.requestedMin) settingText += ` (snapped to ${formatMinutes(x.effectiveMin)})`;
  } else if (x.source === "auto-invalid-habit") settingText = "auto (invalid habit: expiry 0)";
  return [
    head,
    `  formula ${formatMinutes(x.formulaMin)} → auto ${formatMinutes(x.autoMin)} · setting ${settingText}`,
    `  steps: ${steps(lane.grid, x.effectiveMin)}`,
  ].join("\n");
}

function show(home, now, io) {
  const src = createConfigSource({ home, now });
  const cfg = src.get();
  const habit = src.habit();
  const out = laneDescriptors(cfg.lanes).map(({ key, lane }) =>
    block(key, lane, habit, expirySettingFor(cfg.expiry, lane)),
  );
  io.stdout(out.join("\n\n") + "\n");
  return 0;
}

const USAGE = "usage: omo-keepwarm expiry set <laneId|laneId:gridClass> <auto|0|20m|4h|90>\n";

function set(home, now, args, io) {
  const [key, value] = args;
  if (!key || value === undefined || args.length > 2) {
    io.stderr(USAGE);
    return 2;
  }
  const cfg = createConfigSource({ home, now }).get();
  const decide = laneDescriptors(cfg.lanes).filter((d) => d.lane.policy === "decide");
  // "<id>:<class>" targets that class; bare "<id>" targets every class of the lane.
  const targets = decide.filter((d) => `${d.lane.id}:${d.lane.gridClass}` === key || d.lane.id === key);
  if (targets.length === 0) {
    const keys = [...new Set(decide.flatMap((d) => (d.key === d.lane.id ? [d.key] : [d.key, d.lane.id])))];
    io.stderr(`expiry: unknown lane ${key}; lanes: ${keys.join(", ")}\n`);
    return 2;
  }
  let v;
  if (value.trim().toLowerCase() === "auto") v = "auto";
  else {
    v = parseDuration(value);
    const onGrid = Number.isFinite(v) && targets.every((d) => d.lane.grid.includes(v));
    if (!onGrid) {
      const grids = targets.map((d) => `${d.key} steps: ${steps(d.lane.grid)}`).join("\n");
      io.stderr(`expiry: ${value} is not a step for ${key}\n${grids}\n`);
      return 2;
    }
  }
  updateConfig(home, (c) => {
    c.expiry[key] = v;
  });
  io.stdout(`${key} expiry set to ${v === "auto" ? "auto" : formatMinutes(v)}\n`);
  return 0;
}

export async function run(argv, io) {
  const home = keepwarmHome(io.env);
  const now = io.now ?? Date.now;
  if (argv.length === 0) return show(home, now, io);
  if (argv[0] === "set") return set(home, now, argv.slice(1), io);
  io.stderr(`usage: omo-keepwarm expiry\n${USAGE}`);
  return 2;
}
