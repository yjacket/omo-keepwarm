/**
 * Cache warming / idle parking policy v1.0 — 2026-09-19.
 * Pure calculations only: this module never sends requests, writes handoffs,
 * deletes a session, or changes a timer. Wire the returned advice through a
 * lane-specific adapter and an atomic session-generation check.
 *
 * Costs: input-equivalent TOKENS (not K tokens, dollars, or OAuth quota).
 * Times: milliseconds. Forecast is conditional on the user STILL being absent.
 */
export interface Usage {
  input: number;       // Uncached input only; exclude all cached input.
  write5m: number;
  write1h: number;
  read: number;
  output: number;      // Billed MODEL output, including billed thinking.
}
export interface Weights {
  input: number; write5m: number; write1h: number; read: number; output: number;
}
export const RESEARCH_WEIGHTS: Readonly<Weights> = Object.freeze({
  input: 1, write5m: 1.25, write1h: 2, read: 0.1, output: 5,
});
const EPS = 1e-9;
function nonnegative(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be finite and >= 0`);
}
function positive(name: string, value: number): void {
  nonnegative(name, value);
  if (value === 0) throw new RangeError(`${name} must be > 0`);
}
/** Pass each FINAL usage record once. Never add an aggregate and its iterations. */
export function equivalentCost(u: Usage, w: Weights = RESEARCH_WEIGHTS): number {
  let total = 0;
  for (const key of ['input', 'write5m', 'write1h', 'read', 'output'] as const) {
    nonnegative(`usage.${key}`, u[key]); nonnegative(`weights.${key}`, w[key]);
    total += u[key] * w[key];
  }
  return total;
}
export interface CostModel {
  warmEq: number;             // ONE successful warm request, including overhead.
  rawWarmEq: number;          // First genuine resume on the original warm context.
  parkNowEq: number;          // Parent handoff generation, charged even if no return.
  restoreWarmEq: number;      // Child startup + all restoration, shared prefix warm.
  skillRestoreEq: number;     // Set zero when already included in restoreWarmEq.
  sharedLossEq: number;       // Extra child cost if its common prefix has expired.
  coldSharedEq: number;      // Raw resume: only the common prefix still hits.
  coldFullEq: number;        // Raw resume: no reusable cache remains.
  parkQualityEq: number;     // Optional loss penalty PER RESUME; zero is not evidence of no loss.
}
export interface BaselineOptions {
  contextTokens: number;
  sharedTokens?: number;
  readWeight?: number;
  rewriteWeight?: number;
  modelOutputWeight?: number;
  parentFullReads?: number;
  parentOutputTokens?: number;
  restoreWarmEq?: number;
  skillReinjection?: boolean;
  warmOverheadEq?: number;
  parkQualityEq?: number;
}
/** Representative initializer, NOT a fitted model. Replace with measured costs. */
export function baselineCosts(o: BaselineOptions): CostModel {
  positive('contextTokens', o.contextTokens);
  const C = o.contextTokens, S = o.sharedTokens ?? 25_000;
  const r = o.readWeight ?? 0.1, a = o.rewriteWeight ?? 1.25;
  const g = o.modelOutputWeight ?? 5, m = o.parentFullReads ?? 2;
  const Gout = o.parentOutputTokens ?? 3_000;
  const D = o.restoreWarmEq ?? 25_000;
  const overhead = o.warmOverheadEq ?? 0;
  const quality = o.parkQualityEq ?? 0;
  for (const [k, v] of Object.entries({S, r, a, g, m, Gout, D, overhead, quality})) nonnegative(k, v);
  if (S > C) throw new RangeError('sharedTokens cannot exceed contextTokens');
  if (a < r) throw new RangeError('rewriteWeight must be >= readWeight');
  return {
    warmEq: r * C + overhead, rawWarmEq: r * C,
    parkNowEq: m * r * C + g * Gout,
    restoreWarmEq: D, skillRestoreEq: o.skillReinjection ? 11_000 : 0,
    sharedLossEq: (a - r) * S,
    coldSharedEq: r * S + a * (C - S), coldFullEq: a * C,
    parkQualityEq: quality,
  };
}
function validateCosts(c: CostModel): void {
  for (const [key, value] of Object.entries(c)) nonnegative(`costs.${key}`, value);
}
export interface Crossing {
  warmCalls: number;
  crossingAtMs: number;
  preCrossingCostEq: number;
  postCrossingCostEq: number;
}
/**
 * Counterfactual crossover only: do NOT turn crossingAtMs into a PARK command.
 * firstDueMs is relative to now. Return at the EXACT timer deadline wins and
 * cancels that timer; crossing is the cost immediately AFTER a warm ran.
 */
export function crossover(
  parkTotalEq: number, rawWarmEq: number, warmEq: number,
  intervalMs: number, firstDueMs = intervalMs,
): Crossing {
  for (const [k,v] of Object.entries({parkTotalEq, rawWarmEq, warmEq, firstDueMs})) nonnegative(k,v);
  positive('intervalMs', intervalMs);
  const gap = parkTotalEq - rawWarmEq;
  if (gap <= 0) return {warmCalls: 0, crossingAtMs: 0, preCrossingCostEq: rawWarmEq, postCrossingCostEq: rawWarmEq};
  if (warmEq === 0) return {warmCalls: Infinity, crossingAtMs: Infinity, preCrossingCostEq: rawWarmEq, postCrossingCostEq: rawWarmEq};
  const n = Math.max(1, Math.ceil(gap / warmEq - EPS));
  return {warmCalls: n, crossingAtMs: firstDueMs + (n-1)*intervalMs,
    preCrossingCostEq: rawWarmEq + (n-1)*warmEq, postCrossingCostEq: rawWarmEq + n*warmEq};
}
/** Number of timers that run STRICTLY BEFORE a known return time. */
export function warmCallsBeforeReturn(returnAfterMs: number, firstDueMs: number, intervalMs: number): number {
  nonnegative('returnAfterMs', returnAfterMs); nonnegative('firstDueMs', firstDueMs); positive('intervalMs', intervalMs);
  if (returnAfterMs <= firstDueMs) return 0;
  return Math.max(0, Math.ceil((returnAfterMs-firstDueMs)/intervalMs-EPS));
}
export type Action = 'KEEP_WARM' | 'PARK' | 'LET_EXPIRE';
export interface ReturnPoint { afterMs: number; probability: number; }
export interface Forecast {
  returns: readonly ReturnPoint[];
  /** Genuine terminal non-resumption probability, NOT unobserved tail / censoring. */
  neverReturnsProbability: number;
}
export interface PlannerOptions {
  ttlMs: number;
  intervalMs: number;
  remainingTtlMs: number;  // Provider-side effective TTL, not time since response end.
  sharedCachePersists: boolean; // TRUE only if external reuse is supported by evidence.
  allowParking: boolean;  // A quality/safety gate, not a cost claim.
  maxEpochs?: number;
}
export interface CandidateCosts {
  KEEP_WARM: number;
  PARK: number;
  LET_EXPIRE: number;
}
export interface PlanResult {
  action: Action;
  expectedCostEq: number;
  costs: CandidateCosts;
  epochCount: number;
}
function choose(c: CandidateCosts): Action {
  // On a tie prefer no request; otherwise preserve raw context over compression.
  const order: Action[] = ['LET_EXPIRE', 'KEEP_WARM', 'PARK'];
  let best = order[0];
  for (const a of order.slice(1)) if (c[a] < c[best] - 1e-7) best = a;
  return best;
}
/**
 * Finite-scenario dynamic programming. Optimal only within this stated model:
 * - fixed C/lane/costs during this idle spell;
 * - decisions at now, now+interval, ...;
 * - PARK generates parent handoff now, child restoration occurs ONLY on return;
 * - LET_EXPIRE is terminal for this idle spell (no later blind rewarming);
 * - calls treated as atomic; caller must separately enforce arrival/race safety.
 *
 * Forecast must explicitly cover the future, including late return and genuine
 * non-return. Right-censored gaps may NOT be silently mapped to neverReturns.
 */
export function planIdle(c: CostModel, f: Forecast, o: PlannerOptions): PlanResult {
  validateCosts(c);
  positive('ttlMs', o.ttlMs); positive('intervalMs', o.intervalMs);
  if (o.intervalMs >= o.ttlMs) throw new RangeError('intervalMs must be < ttlMs');
  positive('remainingTtlMs', o.remainingTtlMs);
  if (o.remainingTtlMs > o.ttlMs) throw new RangeError('remainingTtlMs exceeds ttlMs');
  nonnegative('neverReturnsProbability', f.neverReturnsProbability);
  const points = [...f.returns].sort((a,b)=>a.afterMs-b.afterMs);
  let sum = f.neverReturnsProbability;
  for (const p of points) {
    positive('return.afterMs', p.afterMs); nonnegative('return.probability', p.probability); sum += p.probability;
  }
  if (Math.abs(sum - 1) > 1e-7) throw new RangeError('forecast probabilities must sum to 1');
  const maxT = points.length ? points[points.length-1].afterMs : 0;
  const lastEpoch = Math.ceil(maxT/o.intervalMs);
  const limit = o.maxEpochs ?? 10_000;
  positive('maxEpochs', limit);
  if (lastEpoch > limit) throw new RangeError('forecast exceeds maxEpochs; coarsen or shorten with an explicit tail scenario');
  const values = new Array<number>(lastEpoch+2).fill(0);
  let root: PlanResult | undefined;
  for (let j=lastEpoch; j>=0; j--) {
    const t = j*o.intervalMs, next = t+o.intervalMs;
    const expiry = t + (j===0 ? o.remainingTtlMs : o.ttlMs-o.intervalMs);
    const future = points.filter(p=>p.afterMs>t);
    const survival = f.neverReturnsProbability + future.reduce((s,p)=>s+p.probability,0);
    if (survival < EPS) { values[j]=0; continue; }
    let expire = 0, restore = 0, immediateWarmResumes = 0;
    let nextSurvival = f.neverReturnsProbability;
    for (const p of future) {
      const afterExpiry = p.afterMs >= expiry; // equality is expired
      const raw = !afterExpiry ? c.rawWarmEq : (o.sharedCachePersists ? c.coldSharedEq : c.coldFullEq);
      expire += p.probability*raw;
      // Parent summarization reads the full shared prefix at the park event.
      const sharedLost = !o.sharedCachePersists && p.afterMs >= t+o.ttlMs;
      restore += p.probability*(c.restoreWarmEq+c.skillRestoreEq+c.parkQualityEq+(sharedLost?c.sharedLossEq:0));
      if (p.afterMs <= next) immediateWarmResumes += p.probability*c.rawWarmEq;
      else nextSurvival += p.probability;
    }
    const candidates: CandidateCosts = {
      LET_EXPIRE: expire/survival,
      PARK: o.allowParking ? c.parkNowEq+restore/survival : Infinity,
      KEEP_WARM: c.warmEq+(immediateWarmResumes+nextSurvival*values[j+1])/survival,
    };
    const action=choose(candidates);
    values[j]=candidates[action];
    if (j===0) root={action,expectedCostEq:values[j],costs:candidates,epochCount:lastEpoch+1};
  }
  // A valid conditional forecast always has survival(0)=1.
  if (!root) throw new Error('empty conditional future');
  return root;
}
export interface GuardState {
  remainingTtlMs: number;
  cacheVerified: boolean;
  busy: boolean;               // Includes model/tool activity and pending writes.
  userRequestPending: boolean;
  parked: boolean;
}
export interface Advice {
  action: 'WAIT' | Action;
  reason: string;
  plan?: PlanResult;
}
/** Pure event guard; the caller still needs an atomic epoch check before acting. */
export function advise(
  s: GuardState, c: CostModel, f: Forecast | undefined,
  o: Omit<PlannerOptions,'remainingTtlMs'>,
): Advice {
  nonnegative('remainingTtlMs', s.remainingTtlMs);
  positive('ttlMs', o.ttlMs); positive('intervalMs', o.intervalMs);
  if (o.intervalMs >= o.ttlMs) throw new RangeError('intervalMs must be < ttlMs');
  if (s.parked) return {action:'WAIT',reason:'already-parked'};
  if (s.userRequestPending || s.busy) return {action:'WAIT',reason:'genuine-work-has-priority'};
  if (!s.cacheVerified || s.remainingTtlMs<=0) return {action:'LET_EXPIRE',reason:'warm-cache-unverified-or-expired'};
  if (s.remainingTtlMs>o.ttlMs-o.intervalMs) return {action:'WAIT',reason:'before-renewal-decision'};
  if (!f) return {action:'LET_EXPIRE',reason:'no-calibrated-forecast-no-unfunded-keepalive'};
  const plan=planIdle(c,f,{...o,remainingTtlMs:s.remainingTtlMs});
  return {action:plan.action,reason:'minimum-prospective-expected-cost',plan};
}
/**
 * Optional bounded waiting heuristic when no return forecast exists.
 * This is a spending limit, NOT an economic optimum and NOT a PARK rule.
 * alreadySpent is used ONLY here; never inject it into planIdle's decision.
 */
export function budgetFallback(
  warmEq: number, alreadySpentEq: number, explicitBudgetEq: number,
): 'KEEP_WARM'|'LET_EXPIRE' {
  for (const [k,v] of Object.entries({warmEq,alreadySpentEq,explicitBudgetEq})) nonnegative(k,v);
  return alreadySpentEq+warmEq < explicitBudgetEq ? 'KEEP_WARM' : 'LET_EXPIRE';
}
