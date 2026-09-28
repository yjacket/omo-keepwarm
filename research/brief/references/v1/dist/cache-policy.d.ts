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
    input: number;
    write5m: number;
    write1h: number;
    read: number;
    output: number;
}
export interface Weights {
    input: number;
    write5m: number;
    write1h: number;
    read: number;
    output: number;
}
export declare const RESEARCH_WEIGHTS: Readonly<Weights>;
/** Pass each FINAL usage record once. Never add an aggregate and its iterations. */
export declare function equivalentCost(u: Usage, w?: Weights): number;
export interface CostModel {
    warmEq: number;
    rawWarmEq: number;
    parkNowEq: number;
    restoreWarmEq: number;
    skillRestoreEq: number;
    sharedLossEq: number;
    coldSharedEq: number;
    coldFullEq: number;
    parkQualityEq: number;
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
export declare function baselineCosts(o: BaselineOptions): CostModel;
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
export declare function crossover(parkTotalEq: number, rawWarmEq: number, warmEq: number, intervalMs: number, firstDueMs?: number): Crossing;
/** Number of timers that run STRICTLY BEFORE a known return time. */
export declare function warmCallsBeforeReturn(returnAfterMs: number, firstDueMs: number, intervalMs: number): number;
export type Action = 'KEEP_WARM' | 'PARK' | 'LET_EXPIRE';
export interface ReturnPoint {
    afterMs: number;
    probability: number;
}
export interface Forecast {
    returns: readonly ReturnPoint[];
    /** Genuine terminal non-resumption probability, NOT unobserved tail / censoring. */
    neverReturnsProbability: number;
}
export interface PlannerOptions {
    ttlMs: number;
    intervalMs: number;
    remainingTtlMs: number;
    sharedCachePersists: boolean;
    allowParking: boolean;
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
export declare function planIdle(c: CostModel, f: Forecast, o: PlannerOptions): PlanResult;
export interface GuardState {
    remainingTtlMs: number;
    cacheVerified: boolean;
    busy: boolean;
    userRequestPending: boolean;
    parked: boolean;
}
export interface Advice {
    action: 'WAIT' | Action;
    reason: string;
    plan?: PlanResult;
}
/** Pure event guard; the caller still needs an atomic epoch check before acting. */
export declare function advise(s: GuardState, c: CostModel, f: Forecast | undefined, o: Omit<PlannerOptions, 'remainingTtlMs'>): Advice;
/**
 * Optional bounded waiting heuristic when no return forecast exists.
 * This is a spending limit, NOT an economic optimum and NOT a PARK rule.
 * alreadySpent is used ONLY here; never inject it into planIdle's decision.
 */
export declare function budgetFallback(warmEq: number, alreadySpentEq: number, explicitBudgetEq: number): 'KEEP_WARM' | 'LET_EXPIRE';
