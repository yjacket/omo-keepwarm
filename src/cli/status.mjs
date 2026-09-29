// `omo-keepwarm status [--json]`: reads status/_global.json and live session files.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { readJsonSafe } from "../fsx.mjs";
import { keepwarmHome, layout } from "../paths.mjs";
import { STALE_AFTER_MS } from "../policy.mjs";

function liveSessions(home, nowMs) {
  const dir = layout(home).statusDir;
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names.sort()) {
    if (!n.endsWith(".json") || n === "_global.json" || n.startsWith(".")) continue;
    const s = readJsonSafe(join(dir, n));
    if (!s || typeof s !== "object" || typeof s.ts !== "number" || nowMs - s.ts > STALE_AFTER_MS) continue;
    out.push(s);
  }
  return out;
}

function sessionLine(s) {
  const lane = typeof s.lane === "string" ? s.lane : s.lane?.id ?? "-";
  const parts = [`  ${s.session}`, s.phase ?? "-", `lane ${lane}`, `mode ${s.mode ?? "-"}`];
  if (s.episode) parts.push(`episode ${s.episode}`);
  if (typeof s.tAwayMin === "number") parts.push(`away ${Math.round(s.tAwayMin)}m`);
  if (s.self === "disabled") parts.push("DISABLED");
  return parts.join(" · ");
}

export async function run(argv, io) {
  const json = argv.includes("--json");
  const home = keepwarmHome(io.env);
  const nowMs = (io.now ?? Date.now)();
  const g = readJsonSafe(layout(home).globalStatus);
  if (!g || typeof g !== "object") {
    io.stdout(json ? JSON.stringify({ state: "not_running" }) + "\n" : "keepwarm: not running (no snapshot)\n");
    return 0;
  }
  const staleAfter = typeof g.staleAfter === "number" ? g.staleAfter : NaN;
  if (!(nowMs <= staleAfter)) {
    const since = Number.isFinite(staleAfter) ? new Date(staleAfter).toISOString() : "unknown";
    io.stdout(
      json
        ? JSON.stringify({ state: "stale", staleSince: since, global: g }) + "\n"
        : `keepwarm: unknown (stale since ${since})\n`,
    );
    return 0;
  }
  const sessions = liveSessions(home, nowMs);
  if (json) {
    io.stdout(JSON.stringify({ state: "ok", global: g, sessions }) + "\n");
    return 0;
  }
  const lines = [g.text ?? "keepwarm", ...sessions.map(sessionLine)];
  io.stdout(lines.join("\n") + "\n");
  return 0;
}
