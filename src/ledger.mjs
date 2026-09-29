import { appendJsonLine, readJsonLines } from "./fsx.mjs";
import { layout, localDate } from "./paths.mjs";

const DAY_MS = 86_400_000;
// Episodes stop warming within HORIZON_MIN (1440) of an anchor, so an
// episode's spend lives in at most the last few daily files.
const EPISODE_LOOKBACK_DAYS = 3;

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function sumSpend(home, date, { virtual = false, episode } = {}) {
  let total = 0;
  for (const l of readJsonLines(layout(home).spendFile(date))) {
    if (!l || typeof l !== "object") continue;
    if (Boolean(l.virtual) !== Boolean(virtual)) continue;
    if (episode !== undefined && l.episode !== episode) continue;
    total += num(l.usd);
  }
  return total;
}

export function sumDay(home, date) {
  const out = { episodes: 0, humanReturns: 0, wouldWarm: 0, pings: 0, usd: 0 };
  for (const l of readJsonLines(layout(home).dayFile(date))) {
    if (!l || typeof l !== "object") continue;
    for (const k of Object.keys(out)) out[k] += num(l[k]);
  }
  return out;
}

export function createLedger({ home, now = Date.now }) {
  const L = layout(home);
  return {
    spendToday({ virtual = false } = {}) {
      return sumSpend(home, localDate(now()), { virtual });
    },
    spendEpisode(episode, { virtual = false } = {}) {
      const t = now();
      const dates = new Set();
      for (let i = 0; i < EPISODE_LOOKBACK_DAYS; i++) dates.add(localDate(t - i * DAY_MS));
      let total = 0;
      for (const d of dates) total += sumSpend(home, d, { virtual, episode });
      return total;
    },
    recordSpend({ session, episode, usd, virtual = false }) {
      const ms = now();
      appendJsonLine(L.spendFile(localDate(ms)), {
        v: 1,
        ts: new Date(ms).toISOString(),
        session: session ?? null,
        episode: episode ?? null,
        usd: num(usd),
        virtual: Boolean(virtual),
      });
    },
    recordDay({ episodes = 0, humanReturns = 0, wouldWarm = 0, pings = 0, usd = 0 } = {}) {
      const ms = now();
      appendJsonLine(L.dayFile(localDate(ms)), {
        v: 1,
        ts: new Date(ms).toISOString(),
        episodes: num(episodes),
        humanReturns: num(humanReturns),
        wouldWarm: num(wouldWarm),
        pings: num(pings),
        usd: num(usd),
      });
    },
  };
}
