// Computes p/mMin/t90Min so that, with the QA lane override
//   anthropic-api { ttlSeconds 12, intervalSeconds 4, grid [0, 0.2, 0.4, 0.6], minContextTokens 1000 }
// the auto expiry snaps to 0.4 or 0.6 minutes (>= 2 would_warm ticks at 4 s, expire within 40 s).
// Writes qa/fixtures/behavior-fast.json and prints the chosen values plus T*.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveExpiry } from "../src/policy.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const GRID = [0, 0.2, 0.4, 0.6];
const INTERVAL_SEC = 4;
// cost.cacheRead / cost.cacheWrite of the anthropic models we may select (0.08 for 4.x sonnet/opus/haiku-4.5 class);
// require the result to hold over a band of r so the pick is not model-cost dependent.
const R_BAND = [0.06, 0.08, 0.1, 0.12];

function autoFor(habit, r) {
  const lane = { policy: "decide", intervalSec: INTERVAL_SEC, r, grid: GRID };
  return resolveExpiry({ lane, habit, setting: "auto" });
}

const good = (m) => m === 0.4 || m === 0.6;

const candidates = [];
for (let p = 0.5; p <= 0.951; p += 0.05) {
  for (let mMin = 0.05; mMin <= 1.0001; mMin += 0.05) {
    for (const ratio of [1.5, 2, 3, 4, 6, 8]) {
      const habit = { p: Math.round(p * 100) / 100, mMin: Math.round(mMin * 100) / 100, t90Min: Math.round(mMin * ratio * 100) / 100 };
      if (!(habit.mMin < habit.t90Min)) continue;
      const results = R_BAND.map((r) => autoFor(habit, r));
      if (!results.every((x) => x && x.source === "auto" && good(x.autoMin))) continue;
      // margin: distance of every formulaMin from the nearest snap boundary (0.3, 0.5, 0.7)
      const margin = Math.min(...results.map((x) => Math.min(...[0.3, 0.5, 0.7].map((b) => Math.abs(x.formulaMin - b)))));
      candidates.push({ habit, margin, results });
    }
  }
}

if (candidates.length === 0) {
  console.error("tune-fast-habit: no candidate found");
  process.exit(1);
}
candidates.sort((a, b) => b.margin - a.margin);
const best = candidates[0];
const main = autoFor(best.habit, 0.08);

const behavior = {
  v: 1,
  p: best.habit.p,
  mMin: best.habit.mMin,
  t90Min: best.habit.t90Min,
  humanReturns: 30,
  updatedAt: Date.now(),
  source: "observed",
};
const file = join(here, "fixtures", "behavior-fast.json");
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify(behavior, null, 2) + "\n");

console.log(`candidates: ${candidates.length}`);
console.log(`chosen: p=${behavior.p} mMin=${behavior.mMin} t90Min=${behavior.t90Min} (margin ${best.margin.toFixed(4)} min)`);
for (let i = 0; i < R_BAND.length; i++) {
  const x = best.results[i];
  console.log(`  r=${R_BAND[i]}: T*=${x.formulaMin.toFixed(4)} min -> snapped ${x.autoMin} min (${x.autoMin * 60} s)`);
}
console.log(`T* (r=0.08) = ${main.formulaMin.toFixed(4)} min, effective expiry ${main.effectiveMin} min = ${main.effectiveMin * 60} s`);
console.log(`wrote ${file}`);
