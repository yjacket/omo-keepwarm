// Away-episode state machine.
//
// An away episode runs from the first settle after a human-started turn until the next human
// input. Automated turns (goal continuation, child notifications, omo-health, restore digests,
// extension input) stay inside the episode and split it into cache segments.
//
// Two clocks:
//   - return hazard and expiry use tAway = now - awayStart;
//   - ticks fire at anchor + interval, where anchor is the start of the last real provider
//     request of the session (automated turns included) or of the last warm/virtual ping.
//
// Cancellation: `gen` is bumped by every transition that leaves ARMED/PINGING; every timer
// callback and every await compares the generation it captured, so a stale tick or a late
// ping result can never act on a newer state.
import { readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { GUARD_MS, habitValid, hazard, maxPings, resolveExpiry } from "./policy.mjs";
import { classifyLane } from "./lanes.mjs";
import { createProvenance } from "./provenance.mjs";
import { expirySettingFor } from "./config.mjs";
import { captureRealPrefix } from "./warm.mjs";
import { readJsonLines } from "./fsx.mjs";
import { layout } from "./paths.mjs";

// Wake sources whose active work ends in a notification turn that rewrites the cache.
export const CHILD_WORK_SOURCES = ["senpi-task", "senpi-task-member", "omo-dag"];
const CLOCK_SKEW_MS = 1000;
const MAX_MARKERS = 32;

// Host event name -> controller method.
export const EVENT_METHODS = {
  session_start: "onSessionStart",
  session_shutdown: "onSessionShutdown",
  input: "onInput",
  input_disposition: "onInputDisposition",
  before_agent_start: "onBeforeAgentStart",
  agent_start: "onAgentStart",
  message_start: "onMessageStart",
  message_end: "onMessageEnd",
  before_provider_request: "onBeforeProviderRequest",
  agent_end: "onAgentEnd",
  agent_settled: "onAgentSettled",
  model_select: "onModelSelect",
  thinking_level_select: "onThinkingLevelSelect",
  session_compact: "onSessionCompact",
  session_tree: "onSessionTree",
  session_parked: "onSessionParked",
  session_resumed: "onSessionResumed",
  user_bash: "onUserBash",
  session_abort: "onSessionAbort",
};

// pi.events bus name -> controller method.
export const BUS_METHODS = {
  wake_source_state: "onWakeSourceState",
  cache_warm_ping: "onCacheWarmPing",
};

// Registers every controller handler on `pi`. Worker sessions get no handlers. `wrap(name, fn)`
// is the isolation wrapper (safe.wrap in the extension). Handlers pass the controller's return
// value through, and every controller method returns undefined.
export function wireController(pi, controller, { wrap = (_name, fn) => fn } = {}) {
  if (pi?.sessionKind === "worker") return false;
  for (const [event, method] of Object.entries(EVENT_METHODS)) {
    const handler = wrap(event, (ev, ctx) => controller[method](ev, ctx));
    if (event === "before_agent_start") pi.on(event, handler, { previewSafe: true });
    else pi.on(event, handler);
  }
  for (const [event, method] of Object.entries(BUS_METHODS)) {
    pi.events?.on(event, wrap(event, (data) => controller[method](data)));
  }
  return true;
}

// The single point where a provenance verdict becomes a controller decision.
function verdictKind(verdict) {
  return verdict.kind;
}

const finite = (v) => typeof v === "number" && Number.isFinite(v);
const tokenCount = (v) => (finite(v) && v > 0 ? v : 0);
const modelKeyOf = (m) => (m ? `${m.provider}/${m.id}` : null);
const laneKeyOf = (l) => JSON.stringify([l.id, l.ttlSec, l.intervalSec, l.policy, l.warmPath, l.verified]);

// sha256 over model, thinking level, system prompt and sorted active tool names.
export function defaultFingerprint(ctx, thinkingLevel, activeToolNames) {
  const tools = [...(activeToolNames ?? [])].map(String).sort();
  const parts = [modelKeyOf(ctx?.model), thinkingLevel ?? null, ctx?.getSystemPrompt?.() ?? null, tools];
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function isWakeSourceState(data) {
  return (
    data !== null && typeof data === "object" &&
    typeof data.source === "string" && data.source.length > 0 &&
    finite(data.activeCount)
  );
}

// deps = { now, setTimeout, clearTimeout, config, recorder, status, ledger, warmer, piAi,
//          lanesFor?, fingerprint?, home?, version?, onError? }
// recorder and status may be objects or factories (sessionId) => object; factories are called
// at session_start once the session id is known. home enables episode-id continuity and the
// restore-failure trace (both read this session's record files). onError receives errors from
// timer-driven work; without it such errors surface as unhandled rejections.
export function createController({ pi, deps }) {
  const { now, config, ledger, warmer, piAi } = deps;
  const setTimer = deps.setTimeout;
  const clearTimer = deps.clearTimeout;
  const lanesFor = deps.lanesFor ?? ((model) => classifyLane(model, { piAi, overrides: config.get().lanes }));
  const fingerprintOf = deps.fingerprint ?? ((ctx) => defaultFingerprint(ctx, thinking, pi?.getActiveTools?.()));
  const reportError = deps.onError ?? ((err) => {
    throw err;
  });
  const provenance = createProvenance({ now });

  let phase = "DETACHED";
  let pauseReason = null; // PAUSED only: "automated_turn" | "child_work" | "held"
  let inertForGood = false; // worker / print / json
  let activated = false; // recorder and status exist, session record written
  let gen = 0;
  let timer = null;
  let nextTickMs = null;
  let pingAbort = null;
  let ctxRef = null;
  let sessionId = null;
  let startReason = null;
  let recorder = null;
  let status = null;
  let mode = null;
  let seq = 0;
  let ep = null;
  let anchorMs = null; // last real request start, or last virtual/real ping
  let realAnchorMs = null; // last real request start of the session itself
  let lastRealPrefix = null; // prefix digest of the anchor request (null when unknown)
  let lastTurn = null; // { stopReason, usage }
  let lastFingerprint = null;
  let thinking = null;
  let seenWarmPing = false;
  let humanTurnPending = false;
  let preclassified = false; // the next agent_start was already classified by its disposition
  let turnStartMs = null;
  let returnUsage = null; // { episode, sinceRealAnchorSec } until the next assistant message_end
  const wake = new Map();
  let wakeKnown = false;

  const active = () => phase !== "DETACHED" && phase !== "INERT";

  function setPhase(next, reason = null) {
    phase = next;
    pauseReason = next === "PAUSED" ? reason : null;
  }

  function childWork() {
    let n = 0;
    for (const source of CHILD_WORK_SOURCES) n += wake.get(source) ?? 0;
    return n;
  }

  // Active wake sources that do not pause warming; recorded by name only (IS-3).
  function otherWakeSources() {
    return [...wake.keys()].filter((source) => !CHILD_WORK_SOURCES.includes(source)).sort();
  }

  function canOpen(ctx = ctxRef) {
    return (
      ctx.isIdle() &&
      !ctx.hasPendingMessages() &&
      provenance.pendingInputCount() === 0 &&
      !provenance.turnImminent()
    );
  }

  function contextTokens(ctx) {
    const u = lastTurn?.usage;
    if (u) {
      const t = tokenCount(u.input) + tokenCount(u.cacheRead) + tokenCount(u.cacheWrite);
      if (t > 0) return t;
    }
    const t = ctx?.getContextUsage?.()?.tokens;
    return finite(t) ? t : null;
  }

  function invalidate() {
    gen += 1;
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    nextTickMs = null;
    if (pingAbort) {
      pingAbort.abort();
      pingAbort = null;
    }
  }

  function serialize() {
    return {
      v: 1,
      session: sessionId,
      seq,
      episode: ep,
      anchorMs,
      realAnchorMs,
      lastRealPrefix,
      lastTurn,
      lastFingerprint,
      seenWarmPing,
    };
  }

  function publish(save) {
    if (!status) return;
    const lane = ep?.lane ?? (ctxRef?.model ? lanesFor(ctxRef.model) : null);
    status.update({
      phase,
      lane: lane ? { id: lane.id, policy: lane.policy } : null,
      mode,
      episode: ep?.id ?? null,
      tAwayMin: ep ? (now() - ep.awayStartMs) / 60000 : null,
      nextTickMs,
    });
    if (save) status.saveEpisode(ep ? serialize() : null);
  }

  function addMarker(kind, atMs = now()) {
    if (!ep) return;
    ep.markers.push({ kind, atMs });
    if (ep.markers.length > MAX_MARKERS) ep.markers.shift();
    recorder.write("marker", { episode: ep.id, kind, atMs });
  }

  function recordTurn(kind, source, startMs) {
    ep.turns += 1;
    recorder.write("turn", { episode: ep.id, segment: ep.segment, kind, source, startMs });
  }

  // ---- session history -------------------------------------------------

  // Highest episode seq of this session and the last episode_open without a close.
  function scanRecords() {
    const out = { maxSeq: 0, open: null };
    if (!deps.home || !sessionId) return out;
    const dir = layout(deps.home).recordsDir;
    let months;
    try {
      months = readdirSync(dir).sort();
    } catch (err) {
      if (err?.code === "ENOENT") return out;
      throw err;
    }
    const prefix = `${sessionId}:`;
    const open = new Map();
    for (const month of months) {
      for (const line of readJsonLines(join(dir, month, `${sessionId}.jsonl`))) {
        const id = line?.episode;
        if (typeof id !== "string" || !id.startsWith(prefix)) continue;
        const n = Number(id.slice(prefix.length));
        if (Number.isInteger(n) && n > out.maxSeq) out.maxSeq = n;
        if (line.type === "episode_open") open.set(id, line);
        else if (line.type === "episode_close") open.delete(id);
      }
    }
    const last = [...open.values()].at(-1);
    if (last) out.open = { id: last.episode, awayStartMs: last.awayStartMs };
    return out;
  }

  // Anchor and last turn estimated from the persisted history (no provider request seen yet).
  function estimateFromHistory(ctx) {
    const messages = ctx?.sessionManager?.buildSessionContext?.()?.messages ?? [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m?.role !== "assistant") continue;
      if (finite(m.timestamp)) anchorMs = realAnchorMs = m.timestamp;
      lastTurn = { stopReason: m.stopReason ?? null, usage: m.usage ?? null };
      return;
    }
  }

  function restorable(saved) {
    const e = saved?.episode;
    return (
      saved?.v === 1 && saved.session === sessionId && e !== null && typeof e === "object" &&
      typeof e.id === "string" && finite(e.awayStartMs) && finite(e.segment) &&
      e.lane !== null && typeof e.lane === "object" && typeof e.lane.id === "string" &&
      e.seg !== null && typeof e.seg === "object" && Array.isArray(e.markers)
    );
  }

  function activate(ctx, atStart) {
    activated = true;
    recorder = typeof deps.recorder === "function" ? deps.recorder(sessionId) : deps.recorder;
    status = typeof deps.status === "function" ? deps.status(sessionId) : deps.status;
    const scan = scanRecords();
    seq = scan.maxSeq;
    estimateFromHistory(ctx);
    const reload = atStart && startReason === "reload";
    const saved = reload ? status.loadEpisode() : null;
    const restore = restorable(saved);
    recorder.write("session", {
      reason: startReason,
      mode,
      sessionKind: pi?.sessionKind ?? null,
      uiMode: ctx?.mode ?? null,
      keepwarmVersion: deps.version ?? null,
      cwd: ctx?.cwd ?? null,
      restored: restore,
    });
    if (restore) {
      restoreEpisode(saved, ctx);
      return;
    }
    setPhase(ctx.isIdle() ? "HELD" : "BUSY");
    if (reload) {
      const trace = typeof saved?.episode?.id === "string"
        ? { id: saved.episode.id, awayStartMs: saved.episode.awayStartMs }
        : scan.open;
      if (trace) {
        closeTrace(trace);
        if (canOpen(ctx)) {
          openEpisode(ctx, finite(trace.awayStartMs) ? trace.awayStartMs : now(), "restore_failed");
          return;
        }
      }
    }
    publish(true);
  }

  // Censored close for an episode known only from a trace (its counters are unknown).
  function closeTrace(trace) {
    const at = now();
    recorder.write("episode_close", {
      episode: trace.id,
      closedAtMs: at,
      awayMin: finite(trace.awayStartMs) ? (at - trace.awayStartMs) / 60000 : null,
      kind: "censored",
      source: "reload",
      detail: "restore_failed",
      markers: [],
    });
    ledger.recordDay({ episodes: 1 });
  }

  function restoreEpisode(saved, ctx) {
    ep = saved.episode;
    if (finite(saved.seq) && saved.seq > seq) seq = saved.seq;
    anchorMs = finite(saved.anchorMs) ? saved.anchorMs : null;
    realAnchorMs = finite(saved.realAnchorMs) ? saved.realAnchorMs : null;
    lastRealPrefix = saved.lastRealPrefix ?? null;
    lastTurn = saved.lastTurn ?? lastTurn;
    lastFingerprint = saved.lastFingerprint ?? null;
    seenWarmPing = saved.seenWarmPing === true;
    ctxRef = ctx;
    addMarker("reload");
    // The saved segment keys stay, so a prompt/model/effort change across the reload is caught
    // by the next tick (prefix_change, model_change, effort_change).
    openSegment("reload", { keepSegmentKeys: true });
  }

  // ---- episodes and segments -------------------------------------------

  function openEpisode(ctx, awayStartMs, openedBy) {
    const cfg = config.get();
    mode = cfg.mode;
    const model = ctx.model;
    const lane = lanesFor(model);
    const habit = config.habit();
    const expiry = resolveExpiry({ lane, habit, setting: expirySettingFor(cfg.expiry, lane) });
    const E = expiry ? expiry.effectiveMin : 0;
    const ivMin = lane.intervalSec / 60;
    seq += 1;
    ep = {
      id: `${sessionId}:${seq}`,
      awayStartMs,
      lane,
      laneKey: laneKeyOf(lane),
      habit,
      expiry,
      E,
      ivMin,
      maxPings: maxPings(E, ivMin),
      mode: cfg.mode,
      segment: 0,
      tick: 0,
      seg: null,
      pingsSent: 0,
      pings: 0,
      turns: 0,
      decisions: 0,
      wouldWarm: 0,
      costUsd: 0,
      virtualUsd: 0,
      expired: false,
      markers: [],
    };
    humanTurnPending = false;
    returnUsage = null;
    recorder.write("episode_open", {
      episode: ep.id,
      awayStartMs,
      openedBy,
      lane: lane.id,
      provider: model?.provider ?? null,
      api: model?.api ?? null,
      model: model?.id ?? null,
      thinking,
      contextTokens: contextTokens(ctx),
      habit,
      r: lane.r,
      expiry,
      maxPings: ep.maxPings,
      mode: cfg.mode,
      warmPath: lane.warmPath,
      verified: lane.verified,
    });
    openSegment("episode_open");
  }

  // First failing eligibility rule, or null.
  function segmentDisabledReason(ctx) {
    const lane = ep.lane;
    if (lane.policy === "observe") return "lane_off";
    if (lane.policy !== "decide") return "lane_invalid";
    if (!(ep.E > 0)) return "expiry_zero";
    if (ep.expired) return "expired";
    if (lastTurn?.stopReason === "error") return "last_turn_error";
    if (lastTurn?.stopReason === "aborted") return "last_turn_aborted";
    if (anchorMs === null) return "no_refresh_anchor";
    if (now() >= anchorMs + lane.ttlSec * 1000 - GUARD_MS) return "cache_cold_at_open";
    const tokens = contextTokens(ctx);
    if (tokens === null) return "context_unknown";
    if (tokens < lane.minContextTokens) return "small_context";
    if (warmer.builtinActive(ctx, ctx.model) || seenWarmPing) return "duplicate_warmer";
    return null;
  }

  function openSegment(reason, { keepSegmentKeys = false } = {}) {
    invalidate();
    const ctx = ctxRef;
    ep.segment += 1;
    ep.tick = 0;
    if (!keepSegmentKeys || !ep.seg) {
      ep.seg = { modelKey: modelKeyOf(ctx.model), thinking, fingerprint: lastFingerprint ?? fingerprintOf(ctx) };
    }
    const disabledReason = segmentDisabledReason(ctx);
    ep.seg.eligible = disabledReason === null;
    ep.seg.disabledReason = disabledReason;
    recorder.write("segment_open", {
      episode: ep.id,
      segment: ep.segment,
      reason,
      anchorMs,
      lane: ep.lane.id,
      model: ep.seg.modelKey,
      eligible: disabledReason === null,
      disabledReason,
      otherWakeSources: otherWakeSources(),
    });
    if (childWork() > 0) setPhase("PAUSED", "child_work");
    else if (disabledReason !== null) setPhase("OBSERVING");
    else if (!canOpen(ctx)) setPhase("PAUSED", "held");
    else schedule(anchorMs + ep.lane.intervalSec * 1000);
    publish(true);
  }

  // New segment after a pause, when the session is free again.
  function resume(reason) {
    if (canOpen()) openSegment(reason);
    else {
      setPhase("PAUSED", "held");
      publish(false);
    }
  }

  function schedule(dueAtMs) {
    const g = gen;
    nextTickMs = dueAtMs;
    timer = setTimer(() => {
      runTick(g, dueAtMs).catch(reportError);
    }, Math.max(0, dueAtMs - now()));
    timer?.unref?.();
    setPhase("ARMED");
  }

  function warmStop(reason) {
    invalidate();
    recorder.write("warm_stop", { episode: ep.id, segment: ep.segment, reason });
    setPhase("OBSERVING");
    publish(true);
  }

  // Event-driven stop: only while warming is live.
  function stopIfWarming(reason) {
    if (phase === "ARMED" || phase === "PINGING") warmStop(reason);
  }

  function closeEpisode({ kind, source, detail = null, atMs }) {
    invalidate();
    const e = ep;
    const ttlMs = e.lane.ttlSec * 1000;
    const human = kind === "human_return";
    recorder.write("episode_close", {
      episode: e.id,
      closedAtMs: atMs,
      awayMin: (atMs - e.awayStartMs) / 60000,
      kind,
      source,
      detail,
      segments: e.segment,
      turns: e.turns,
      decisions: e.decisions,
      wouldWarm: e.wouldWarm,
      pings: e.pings,
      costUsd: e.costUsd,
      virtualUsd: e.virtualUsd,
      expired: e.expired,
      coveredAtReturn: human && anchorMs !== null ? atMs - anchorMs < ttlMs : null,
      coldWithoutWarm: human && realAnchorMs !== null ? atMs - realAnchorMs >= ttlMs : null,
      markers: e.markers,
    });
    ledger.recordDay({
      episodes: 1,
      humanReturns: human ? 1 : 0,
      wouldWarm: e.wouldWarm,
      pings: e.pings,
      usd: e.costUsd,
    });
    ep = null;
    if (human) {
      humanTurnPending = true;
      returnUsage = {
        episode: e.id,
        sinceRealAnchorSec: realAnchorMs === null ? null : (atMs - realAnchorMs) / 1000,
      };
    }
    setPhase("BUSY");
    publish(true);
  }

  // Applies a provenance verdict for the turn now running inside the episode.
  function classifyTurn(verdict) {
    const kind = verdictKind(verdict);
    if (kind === "none") return;
    const startMs = turnStartMs ?? now();
    if (kind === "human_return") {
      closeEpisode({ kind: "human_return", source: verdict.source, atMs: startMs });
      return;
    }
    recordTurn(kind, verdict.source, startMs);
    setPhase("PAUSED", "automated_turn");
    publish(false);
  }

  // ---- tick ------------------------------------------------------------

  function pauseReasonAt(ctx) {
    if (!ctx.isIdle()) return "agent_busy";
    if (ctx.hasPendingMessages()) return "pending_messages";
    if (childWork() > 0) return "child_work_active";
    if (provenance.pendingInputCount() > 0 || provenance.turnImminent()) return "input_pending";
    return null;
  }

  function stopReasonAt(ctx, cfg, real, tokens) {
    if (ctx.isCompacting?.()) return "compacting";
    if (modelKeyOf(ctx.model) !== ep.seg.modelKey) return "model_change";
    if (thinking !== ep.seg.thinking) return "effort_change";
    if (laneKeyOf(lanesFor(ctx.model)) !== ep.laneKey) return "lane_change";
    if (fingerprintOf(ctx) !== ep.seg.fingerprint) return "prefix_change";
    if (tokens === null) return "context_unknown";
    if (tokens < ep.lane.minContextTokens) return "small_context";
    if (ep.pingsSent >= ep.maxPings) return "episode_request_cap";
    // USD caps guard money that can be spent: only lanes with a warm path (real ledger in on, virtual in shadow).
    if (ep.lane.warmPath === "warmPromptCache") {
      const projected = warmer.projectedCostUsd(ctx.model, tokens);
      const virtual = !real;
      if (ledger.spendEpisode(ep.id, { virtual }) + projected > cfg.maxUsdPerEpisode) return "episode_usd_cap";
      if (ledger.spendToday({ virtual }) + projected > cfg.maxUsdPerDay) return "daily_cap";
    }
    if (warmer.builtinActive(ctx, ctx.model) || seenWarmPing) return "duplicate_warmer";
    if (cfg.mode !== ep.mode) return "config_off";
    return null;
  }

  async function runTick(g, dueAtMs) {
    if (g !== gen || phase !== "ARMED" || !ep) return;
    timer = null;
    nextTickMs = null;
    const ctx = ctxRef;
    const lane = ep.lane;
    const firedAt = now();
    ep.tick += 1;
    const lateByMs = firedAt - dueAtMs;
    const tAwayMin = (firedAt - ep.awayStartMs) / 60000;
    const h = habitValid(ep.habit) ? hazard(tAwayMin, ep.ivMin, ep.habit) : null;
    const decide = (action, reason) => {
      ep.decisions += 1;
      recorder.write("decision", {
        episode: ep.id,
        segment: ep.segment,
        tick: ep.tick,
        tAwayMin,
        hazard: h,
        r: lane.r,
        action,
        reason,
        lateByMs,
      });
    };
    const stop = (reason) => {
      decide("skip", reason);
      warmStop(reason);
    };

    if (lateByMs < -CLOCK_SKEW_MS || tAwayMin < 0) return stop("clock_anomaly");
    if (lateByMs > lane.ttlSec * 1000 - lane.intervalSec * 1000 - GUARD_MS) return stop("late_tick");
    if (tAwayMin >= ep.E) {
      decide("expire", null);
      ep.expired = true;
      return warmStop("expired");
    }
    const pause = pauseReasonAt(ctx);
    if (pause) {
      decide("skip", pause);
      invalidate();
      setPhase("PAUSED", pause === "child_work_active" ? "child_work" : "held");
      publish(true);
      return;
    }
    const cfg = config.get();
    mode = cfg.mode;
    const real = cfg.mode === "on" && lane.warmPath === "warmPromptCache" && lane.verified === true && warmer.available();
    const tokens = contextTokens(ctx);
    const stopReason = stopReasonAt(ctx, cfg, real, tokens);
    if (stopReason) return stop(stopReason);

    if (!real) {
      const why = cfg.mode !== "on" ? "shadow"
        : lane.warmPath !== "warmPromptCache" ? "no_warm_path"
        : lane.verified !== true ? "unverified"
        : "warmer_unavailable";
      decide("would_warm", why);
      ep.pingsSent += 1;
      ep.wouldWarm += 1;
      const usd = warmer.projectedCostUsd(ctx.model, tokens);
      ledger.recordSpend({ session: sessionId, episode: ep.id, usd, virtual: true });
      ep.virtualUsd += usd;
      anchorMs = firedAt;
      schedule(firedAt + lane.intervalSec * 1000);
      publish(true);
      return;
    }

    // Never ping without the prefix guard.
    if (lastRealPrefix === null) return stop("no_prefix");
    decide("warm", null);
    ep.pingsSent += 1;
    ep.pings += 1;
    const epId = ep.id;
    const segment = ep.segment;
    const tickNo = ep.tick;
    const ac = new AbortController();
    pingAbort = ac;
    const startedAt = now();
    setPhase("PINGING");
    publish(true);
    const res = await warmer.ping({
      pi,
      ctx,
      model: ctx.model,
      lastMessages: ctx.sessionManager.buildSessionContext().messages,
      expectPrefix: lastRealPrefix,
      signal: ac.signal,
    });
    if (pingAbort === ac) pingAbort = null;
    const current = g === gen;
    const aborted = !res.ok && res.error?.kind === "aborted";
    recorder.write("ping", {
      episode: epId,
      segment,
      tick: tickNo,
      ok: res.ok,
      hit: res.ok ? res.hit : null,
      usage: res.ok ? res.usage : null,
      costUsd: res.ok ? res.costUsd : null,
      durationMs: res.ok ? res.durationMs : now() - startedAt,
      error: res.ok ? null : res.error,
      stale: !current || aborted,
    });
    if (res.ok) {
      ledger.recordSpend({ session: sessionId, episode: epId, usd: res.costUsd, virtual: false });
      if (ep?.id === epId) ep.costUsd += res.costUsd;
    }
    if (!current) return;
    if (aborted) return warmStop("aborted");
    if (res.ok && res.hit) {
      anchorMs = startedAt;
      schedule(startedAt + lane.intervalSec * 1000);
      publish(true);
      return;
    }
    return warmStop(res.ok ? "cache_miss" : res.error.kind);
  }

  // ---- event handlers (all synchronous, all return undefined) -----------

  function onSessionStart(ev, ctx) {
    invalidate();
    ctxRef = ctx;
    startReason = ev?.reason ?? null;
    if (ctx?.mode === "print" || ctx?.mode === "json" || pi?.sessionKind === "worker") {
      inertForGood = true;
      setPhase("INERT");
      return;
    }
    sessionId = ctx.sessionManager.getSessionId();
    thinking = pi?.getThinkingLevel?.() ?? null;
    mode = config.get().mode;
    if (mode === "off") {
      setPhase("INERT");
      return;
    }
    activate(ctx, true);
  }

  function onSessionShutdown(ev) {
    if (phase === "DETACHED") return;
    invalidate();
    if (phase !== "INERT" && ep) {
      if (ev?.reason === "reload") status.saveEpisode(serialize());
      else closeEpisode({ kind: "censored", source: "session_shutdown", detail: ev?.reason ?? null, atMs: now() });
    }
    if (status) status.close();
    status = null;
    setPhase("DETACHED");
  }

  function onInput(ev, ctx) {
    if (!active()) return;
    ctxRef = ctx ?? ctxRef;
    provenance.noteInput({ inputId: ev?.inputId, source: ev?.source });
  }

  function onInputDisposition(ev, ctx) {
    if (!active()) return;
    ctxRef = ctx ?? ctxRef;
    const verdict = provenance.noteDisposition({ inputId: ev?.inputId, disposition: ev?.disposition });
    provenance.noteTurnImminent(null);
    const kind = verdictKind(verdict);
    const starts = ev?.disposition === "started" || ev?.disposition === "queued";
    if (ep) {
      if (kind === "human_return") {
        closeEpisode({ kind: "human_return", source: verdict.source, atMs: verdict.atMs });
      } else if (starts && (kind === "automated" || kind === "unattributed")) {
        invalidate();
        recordTurn(kind, verdict.source, verdict.atMs);
        preclassified = ev.disposition === "started";
        setPhase("PAUSED", "automated_turn");
        publish(true);
      } else {
        if (kind === "presence") addMarker(verdict.source, verdict.atMs);
        if (phase === "PAUSED" && pauseReason === "held") resume("after_turn");
      }
      return;
    }
    if (kind === "human_return") humanTurnPending = true;
    else if (!starts && phase === "HELD" && canOpen()) openEpisode(ctxRef, now(), "settled");
  }

  function onBeforeAgentStart(ev) {
    if (!active() || ev?.preview) return;
    provenance.noteTurnImminent(ev?.trigger ?? "prompt");
  }

  function onAgentStart(_ev, ctx) {
    if (!active()) return;
    ctxRef = ctx ?? ctxRef;
    provenance.noteTurnImminent(null);
    turnStartMs = now();
    if (!ep) {
      if (phase !== "BUSY") {
        setPhase("BUSY");
        publish(false);
      }
      return;
    }
    if (preclassified) {
      preclassified = false;
      return;
    }
    if (phase === "PAUSED" && pauseReason === "automated_turn") return;
    if (phase === "CLASSIFYING") return;
    invalidate();
    setPhase("CLASSIFYING");
    publish(false);
  }

  function onMessageStart(ev, ctx) {
    if (!active() || !ep || phase !== "CLASSIFYING") return;
    ctxRef = ctx ?? ctxRef;
    const message = ev?.message;
    if (message?.role === "custom" || message?.role === "user") classifyTurn(provenance.noteMessageStart(message));
    else if (message?.role === "assistant") classifyTurn(provenance.resolveUnattributed("assistant_message"));
  }

  function onMessageEnd(ev, ctx) {
    if (!active() || !returnUsage) return;
    const message = ev?.message;
    if (message?.role !== "assistant" || !message.usage) return;
    const u = message.usage;
    recorder.write("return_usage", {
      episode: returnUsage.episode,
      model: message.model ?? ctx?.model?.id ?? ctxRef?.model?.id ?? null,
      input: u.input ?? null,
      output: u.output ?? null,
      cacheRead: u.cacheRead ?? null,
      cacheWrite: u.cacheWrite ?? null,
      sinceRealAnchorSec: returnUsage.sinceRealAnchorSec,
    });
    returnUsage = null;
  }

  function onBeforeProviderRequest(ev, ctx) {
    if (!active() || phase === "PINGING") return; // PINGING: our own warm request
    ctxRef = ctx ?? ctxRef;
    if (ep && phase === "CLASSIFYING") classifyTurn(provenance.resolveUnattributed("provider_request"));
    const sessionRequest =
      !ep || phase === "CLASSIFYING" || (phase === "PAUSED" && pauseReason === "automated_turn");
    if (!sessionRequest) {
      // Some other extension's request while warming/observing: its prefix is unknown.
      addMarker("foreign_provider_request");
      return;
    }
    anchorMs = realAnchorMs = now();
    const payload = ev?.payload;
    lastRealPrefix =
      lanesFor(ctxRef.model).warmPath !== "none" && payload !== null && typeof payload === "object"
        ? captureRealPrefix(payload)
        : null;
  }

  function onAgentEnd(ev, ctx) {
    if (!active() || ev?.willRetry) return;
    ctxRef = ctx ?? ctxRef;
    const messages = Array.isArray(ev?.messages) ? ev.messages : [];
    const last = messages.findLast((m) => m?.role === "assistant");
    lastTurn = {
      stopReason: ev?.aborted ? "aborted" : last?.stopReason ?? null,
      usage: last?.usage ?? null,
    };
    lastFingerprint = fingerprintOf(ctxRef);
    if (ep && phase === "CLASSIFYING") classifyTurn(provenance.resolveUnattributed("agent_end"));
  }

  function onAgentSettled(_ev, ctx) {
    if (phase === "DETACHED") return;
    ctxRef = ctx ?? ctxRef;
    if (phase === "INERT") {
      if (inertForGood) return;
      mode = config.get().mode;
      if (mode === "off") return;
      if (!activated) activate(ctxRef, false);
      else {
        // Nothing was tracked while inert: re-estimate, never reuse an old prefix.
        lastRealPrefix = null;
        estimateFromHistory(ctxRef);
        setPhase("BUSY");
      }
    }
    // canOpen is judged before this settle clears a pending turn-imminent mark.
    const open = canOpen();
    provenance.noteTurnImminent(null);
    preclassified = false;
    if (!ep) {
      mode = config.get().mode;
      if (mode === "off") {
        setPhase("INERT");
        publish(false);
        return;
      }
      if (open) openEpisode(ctxRef, now(), "settled");
      else {
        setPhase("HELD");
        publish(false);
      }
      return;
    }
    if (phase === "CLASSIFYING") classifyTurn(provenance.resolveUnattributed("agent_settled"));
    if (!ep) return;
    if (phase === "PAUSED" && pauseReason !== "child_work") {
      if (open) openSegment("after_turn");
      else {
        setPhase("PAUSED", "held");
        publish(false);
      }
    }
  }

  function onModelSelect(ev) {
    if (!active() || !ep) return;
    if (modelKeyOf(ev?.model) === modelKeyOf(ev?.previousModel)) return;
    stopIfWarming("model_change");
    addMarker("model_select");
  }

  function onThinkingLevelSelect(ev) {
    if (!active() || ev?.level === ev?.previousLevel) return;
    thinking = ev?.level ?? null;
    if (!ep) return;
    stopIfWarming("effort_change");
    addMarker("thinking_level_select");
  }

  function onSessionCompact(ev) {
    if (!active() || !ep || ev?.accepted === false) return;
    stopIfWarming("prefix_change");
  }

  function onSessionTree() {
    if (!active() || !ep) return;
    stopIfWarming("prefix_change");
  }

  function onSessionParked() {
    if (!active() || !ep) return;
    stopIfWarming("session_parked");
    addMarker("session_parked");
  }

  function onSessionResumed() {
    if (active()) addMarker("session_resumed");
  }

  function onUserBash() {
    if (active()) addMarker("user_bash");
  }

  function onSessionAbort() {
    if (active()) addMarker("session_abort");
  }

  function onWakeSourceState(data) {
    if (!active() || !isWakeSourceState(data)) return;
    if (data.activeCount > 0) wake.set(data.source, data.activeCount);
    else wake.delete(data.source);
    wakeKnown = true;
    if (ep && phase === "PAUSED" && pauseReason === "child_work" && childWork() === 0) resume("children_drained");
  }

  function onCacheWarmPing() {
    if (!active()) return;
    seenWarmPing = true;
    if (ep) stopIfWarming("duplicate_warmer");
  }

  function snapshot() {
    return {
      phase,
      pauseReason,
      gen,
      session: sessionId,
      episode: ep?.id ?? null,
      segment: ep?.segment ?? null,
      tick: ep?.tick ?? null,
      awayStartMs: ep?.awayStartMs ?? null,
      anchorMs,
      realAnchorMs,
      hasPrefix: lastRealPrefix !== null,
      nextTickMs,
      pingsSent: ep?.pingsSent ?? 0,
      turnImminent: provenance.turnImminent(),
      pendingInputs: provenance.pendingInputCount(),
      childWork: childWork(),
      wakeKnown,
      humanTurnPending,
      mode,
    };
  }

  return {
    onSessionStart,
    onSessionShutdown,
    onInput,
    onInputDisposition,
    onBeforeAgentStart,
    onAgentStart,
    onMessageStart,
    onMessageEnd,
    onBeforeProviderRequest,
    onAgentEnd,
    onAgentSettled,
    onModelSelect,
    onThinkingLevelSelect,
    onSessionCompact,
    onSessionTree,
    onSessionParked,
    onSessionResumed,
    onUserBash,
    onSessionAbort,
    onWakeSourceState,
    onCacheWarmPing,
    snapshot,
  };
}
