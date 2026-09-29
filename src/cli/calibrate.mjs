// `omo-keepwarm calibrate [--write] [--json] [--min-returns 30]`.
import { atomicWriteJson } from "../fsx.mjs";
import { keepwarmHome, layout } from "../paths.mjs";
import {
  MIN_HUMAN_RETURNS,
  WINDOW_DAYS,
  behaviorRecord,
  estimate,
  estimateUsable,
  loadEpisodes,
} from "../calibrate.mjs";
import { formatMinutes } from "../report.mjs";

const USAGE = "usage: omo-keepwarm calibrate [--write] [--json] [--min-returns 30]\n";

export async function run(argv, io) {
  let write = false;
  let json = false;
  let minReturns = MIN_HUMAN_RETURNS;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write") write = true;
    else if (a === "--json") json = true;
    else if (a === "--min-returns" || a.startsWith("--min-returns=")) {
      const v = Number(a === "--min-returns" ? argv[++i] : a.slice(14));
      if (!(Number.isInteger(v) && v > 0)) {
        io.stderr(`calibrate: --min-returns must be a positive integer\n${USAGE}`);
        return 2;
      }
      minReturns = v;
    } else {
      io.stderr(`calibrate: unknown argument ${a}\n${USAGE}`);
      return 2;
    }
  }
  const home = keepwarmHome(io.env);
  const nowMs = (io.now ?? Date.now)();
  const est = estimate(loadEpisodes(home, { sinceDays: WINDOW_DAYS, now: nowMs, includeOpen: true }));
  const usable = estimateUsable(est, minReturns);
  let written = false;
  if (usable && write) {
    atomicWriteJson(layout(home).behavior, behaviorRecord(est, nowMs));
    written = true;
  }
  if (json) {
    io.stdout(JSON.stringify({ ...est, minReturns, usable, written }) + "\n");
  } else {
    const p = est.p === null ? "-" : String(Number(est.p.toPrecision(3)));
    const lines = [
      `episodes ${est.episodes} · human returns ${est.humanReturns} · context ended ${est.competingEnds} · censored ${est.censored} (window ${WINDOW_DAYS} days, Aalen-Johansen)`,
      `p ${p} · m ${formatMinutes(est.mMin)} · t90 ${formatMinutes(est.t90Min)}` +
        (est.fit === null ? "" : ` · fit ${est.fit.toFixed(3)}`) +
        (est.pTruncatedAtMin === null ? "" : ` · p truncated at ${formatMinutes(est.pTruncatedAtMin)}`),
    ];
    if (!usable) lines.push(`not enough data: need ${minReturns} human returns and a valid estimate; nothing written`);
    else if (written) lines.push(`wrote ${layout(home).behavior}`);
    io.stdout(lines.join("\n") + "\n");
  }
  return usable ? 0 : 2;
}
