// omo-keepwarm runtime entry: mod.default(pi, { piAi, convertToLlm, version }) is called by the stub.
// Silent by design: no pi.sendMessage / appendEntry / setStatus / notify / ui, no session entries.
// Every handler runs through safe.wrap, so a throwing handler is logged and never reaches the host.
import { ensureDir } from "../src/fsx.mjs";
import { writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { maybeAutoCalibrate } from "../src/calibrate.mjs";
import { createConfigSource } from "../src/config.mjs";
import { createController, wireController } from "../src/episode.mjs";
import { createLedger } from "../src/ledger.mjs";
import { keepwarmHome, layout } from "../src/paths.mjs";
import { HEARTBEAT_MS } from "../src/policy.mjs";
import { createRecorder } from "../src/records.mjs";
import { createSafe } from "../src/safe.mjs";
import { createStatus } from "../src/status.mjs";
import { createWarmer } from "../src/warm.mjs";

const INSTANCES = Symbol.for("omo-keepwarm.instances");
const STATUS_DEBOUNCE_MS = 1000;
const CALIBRATE_DELAY_MS = 60_000;

// The one piece of module-level state: sessionId -> token of the instance that owns the session.
function instanceTable() {
  return (globalThis[INSTANCES] ??= new Map());
}

export default function omoKeepwarm(pi, deps = {}) {
  if (pi?.sessionKind === "worker") return;

  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimeout ?? globalThis.setTimeout;
  const clearTimer = deps.clearTimeout ?? globalThis.clearTimeout;
  const setTick = deps.setInterval ?? globalThis.setInterval;
  const clearTick = deps.clearInterval ?? globalThis.clearInterval;
  const home = deps.home ?? keepwarmHome();
  const L = layout(home);
  const autoCalibrate = deps.autoCalibrate ?? maybeAutoCalibrate;
  const token = Symbol("omo-keepwarm.instance");

  let inert = false; // duplicate instance for this session: registers handlers, does nothing
  let claimedId = null;
  let statusHandle = null;
  let heartbeat = null;
  let calibrateTimer = null;
  let calibrateDone = false;
  let markerDone = false;
  let controller = null;

  const safe = createSafe({ logFile: L.errorLog, now, onDisable: disable });

  function stopHeartbeat() {
    if (heartbeat !== null) clearTick(heartbeat);
    heartbeat = null;
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeat = setTick(
      safe.wrap("heartbeat", () => {
        // A purge or an off switch is noticed here even when no host event arrives; the gate then
        // abandons the status handle and stops this heartbeat before it can write.
        controller?.checkConfig();
        statusHandle?.heartbeat();
      }),
      HEARTBEAT_MS,
    );
    heartbeat?.unref?.();
  }

  function releaseToken() {
    if (claimedId === null) return;
    const table = instanceTable();
    if (table.get(claimedId) === token) table.delete(claimedId);
    claimedId = null;
  }

  // Pending status write first, then the heartbeat and extension timers, then the instance token.
  function teardown() {
    try {
      statusHandle?.flush();
    } finally {
      statusHandle = null;
      stopHeartbeat();
      if (calibrateTimer !== null) {
        clearTimer(calibrateTimer);
        calibrateTimer = null;
      }
      releaseToken();
    }
  }

  // safe.onDisable: publish "disabled", stop the controller, then release everything.
  function disable() {
    try {
      if (statusHandle) {
        statusHandle.update({ self: "disabled" });
        statusHandle.flush();
      }
    } finally {
      try {
        controller?.halt();
      } finally {
        teardown();
      }
    }
  }

  function writeLoadedMarker() {
    // No config file (home purged or never installed): the runtime writes nothing anywhere.
    if (markerDone || !deps.version || !config.exists(true)) return;
    const file = L.loadedMarker(deps.version);
    ensureDir(dirname(file));
    writeFileSync(file, `${new Date(now()).toISOString()}\n`);
    markerDone = true;
  }

  function scheduleCalibrate() {
    if (calibrateDone || calibrateTimer !== null) return;
    calibrateTimer = setTimer(
      safe.wrap("autoCalibrate", () => {
        calibrateTimer = null;
        calibrateDone = true;
        // mode off writes nothing (IS-13), not even behavior.json.
        if (config.get().mode !== "off") autoCalibrate({ home, now });
      }),
      CALIBRATE_DELAY_MS,
    );
    calibrateTimer?.unref?.();
  }

  function startSession(fn, ev, ctx) {
    inert = false;
    // print / json: the controller goes inert for good; nothing is claimed, written or scheduled.
    if (ctx?.mode === "print" || ctx?.mode === "json") return fn(ev, ctx);
    const id = ctx.sessionManager.getSessionId();
    const table = instanceTable();
    const holder = table.get(id);
    if (holder !== undefined && holder !== token) {
      inert = true;
      return undefined;
    }
    if (claimedId !== null && claimedId !== id) releaseToken();
    table.set(id, token);
    claimedId = id;
    fn(ev, ctx);
    writeLoadedMarker();
    scheduleCalibrate();
    return undefined;
  }

  // controller handler -> safe handler. session_shutdown tears down after the controller has saved
  // and closed its status, even when the controller throws.
  function guard(name, fn) {
    if (name === "session_start") return safe.wrap(name, (ev, ctx) => startSession(fn, ev, ctx));
    if (name === "session_shutdown") {
      return safe.wrap(name, (ev, ctx) => {
        try {
          return inert ? undefined : fn(ev, ctx);
        } finally {
          teardown();
        }
      });
    }
    return safe.wrap(name, (ev, ctx) => (inert ? undefined : fn(ev, ctx)));
  }

  const onError = (err) =>
    safe.wrap("timer", () => {
      throw err;
    })();

  const config = deps.config ?? createConfigSource({ home, now });
  controller = createController({
    pi,
    deps: {
      now,
      setTimeout: setTimer,
      clearTimeout: clearTimer,
      config,
      recorder: (sessionId) => createRecorder({ home, sessionId, now }),
      status: (sessionId) => {
        statusHandle = createStatus({
          home,
          sessionId,
          now,
          debounceMs: STATUS_DEBOUNCE_MS,
          canWrite: () => config.exists(true),
          setTimeout: setTimer,
          clearTimeout: clearTimer,
        });
        startHeartbeat();
        return statusHandle;
      },
      ledger: createLedger({ home, now }),
      warmer: createWarmer({ piAi: deps.piAi, convertToLlm: deps.convertToLlm, now }),
      piAi: deps.piAi,
      home,
      version: deps.version,
      onError,
      onQuiet: stopHeartbeat,
    },
  });
  wireController(pi, controller, { wrap: guard });
}
