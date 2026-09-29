// Return-hazard expiry rule, quantized steps and expiry resolution.
// Reference: research/existing-data-analysis/scripts/expiry-charts.py

export const Z90 = 1.2816;
export const HORIZON_MIN = 1440;
export const GUARD_MS = 5000;
export const MIN_CONTEXT_TOKENS = 20000;
export const OPEN_EPS = 1e-6;
export const MISS_READ_SHARE = 0.5;
export const STALE_INPUT_MS = 600000;
export const PING_TIMEOUT_MS = 30000;
export const HEARTBEAT_MS = 300000;
export const STALE_AFTER_MS = 900000;

const TWO_OVER_SQRT_PI = 2 / Math.sqrt(Math.PI);

// erf via the all-positive series erf(x) = 2/sqrt(pi) * exp(-x^2) * sum 2^n x^(2n+1) / (2n+1)!!
// (no cancellation, so accuracy stays near double precision; |x| >= 6 saturates to +-1).
export function erf(x) {
  if (Number.isNaN(x)) return NaN;
  const ax = Math.abs(x);
  if (ax >= 6) return x < 0 ? -1 : 1;
  const x2 = ax * ax;
  let term = ax;
  let sum = ax;
  for (let n = 1; n < 500; n++) {
    term *= (2 * x2) / (2 * n + 1);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  const v = TWO_OVER_SQRT_PI * Math.exp(-x2) * sum;
  return x < 0 ? -v : v;
}

export function phi(z) {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function returnCdf(tMin, { p, mMin, t90Min }) {
  if (!(tMin > 0)) return 0;
  const s = (Math.log(t90Min) - Math.log(mMin)) / Z90;
  return p * clamp01(phi((Math.log(tMin) - Math.log(mMin)) / s));
}

export function hazard(tMin, ivMin, habit) {
  const open = 1 - returnCdf(tMin, habit);
  if (open <= OPEN_EPS) return 0;
  const h = clamp01((returnCdf(tMin + ivMin, habit) - returnCdf(tMin, habit)) / open);
  return Number.isFinite(h) ? h : 0;
}

export function habitValid(h) {
  if (!h) return false;
  const { p, mMin, t90Min } = h;
  return (
    Number.isFinite(p) && Number.isFinite(mMin) && Number.isFinite(t90Min) &&
    p > 0 && p <= 1 && mMin > 0 && mMin < t90Min
  );
}

export function tStarMinutes({ intervalMin, r, habit }) {
  if (!(intervalMin > 0) || !Number.isFinite(intervalMin)) return HORIZON_MIN;
  for (let k = 1; k * intervalMin <= HORIZON_MIN; k++) {
    const t = k * intervalMin;
    if (hazard(t, intervalMin, habit) < r) return t;
  }
  return HORIZON_MIN;
}

// Nearest grid value; ties go to the smaller value (grid is ascending).
export function snap(min, grid) {
  let best = grid[0];
  let bestDist = Math.abs(min - best);
  for (let i = 1; i < grid.length; i++) {
    const d = Math.abs(min - grid[i]);
    if (d < bestDist) {
      best = grid[i];
      bestDist = d;
    }
  }
  return best;
}

export function resolveExpiry({ lane, habit, setting }) {
  if (!lane || lane.policy !== "decide") return null;
  const valid = habitValid(habit);
  const formulaMin = valid
    ? tStarMinutes({ intervalMin: lane.intervalSec / 60, r: lane.r, habit })
    : null;
  const autoMin = valid ? snap(formulaMin, lane.grid) : null;
  if (typeof setting === "number" && Number.isFinite(setting)) {
    return {
      formulaMin,
      autoMin,
      requestedMin: setting,
      effectiveMin: snap(setting, lane.grid),
      source: "manual",
    };
  }
  if (!valid) {
    return { formulaMin: null, autoMin: null, requestedMin: null, effectiveMin: 0, source: "auto-invalid-habit" };
  }
  return { formulaMin, autoMin, requestedMin: null, effectiveMin: autoMin, source: "auto" };
}

export function maxPings(E, ivMin) {
  if (!(E > 0)) return 0;
  return Math.ceil(E / ivMin) + 1;
}
