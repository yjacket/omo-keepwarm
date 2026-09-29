// Shared helpers for the real-senpi QA scenarios (qa/scenarios/*.mjs). QA only. Later scenarios build on this
// file WITHOUT editing it; extend through options, not edits.
//
// API
//   Constants: REPO, QA_DIR, EVID_ROOT (env KW_QA_EVID_ROOT, default C:/dev/omo/omo-keepwarm/.omo/evidence/keepwarm-v1),
//              FIXTURES, EXT_HELPER (qa/fetch-redirect.ext.mjs)
//
//   loadFixture(nameOrObject) -> object | null
//       "config-on" | "config-on.json" | { ...inline } -> a fresh copy; null/undefined -> null.
//
//   prepareKeepwarm({ tmp, config, behavior }) -> { home, healthHome, stubPath, env }
//       Creates <tmp>/kw (keepwarm home) with config.json (from `config`, a fixture name or object) and behavior.json
//       (from `behavior`; updatedAt is set to now), then renders the dev-root stub to <tmp>/omo-keepwarm.ts through
//       `bin/omo-keepwarm.mjs render-stub --dev-root REPO` (this also points <tmp>/kw/app/current.json at the checkout).
//       env = { OMO_KEEPWARM_HOME, OMO_HEALTH_HOME }. A missing config/behavior writes no file.
//
//   startScenario({ name, taskDir = "task-11", config, behavior, mockScript, extraArgs = [], env = {}, model = "auto",
//                   stub = true, extensions = [], senpi = true }) -> Promise<s>
//       Evidence dir = <EVID_ROOT>/<taskDir>/<name>/ (wiped first). Starts the mock (log: <evid>/mock-requests.jsonl),
//       prepares keepwarm, and (unless senpi:false) a real `senpi --mode rpc` with [stub (if stub), ...extensions,
//       fetch-redirect helper] in <tmp>. Never throws: a failed start becomes s.startError and a failing check.
//     s = {
//       name, tmp, evid, home, healthHome, stubPath, kwEnv, mock, blockLog, extLog, model, startError,
//       senpi,                                   // primary handle from rpc-driver.startSenpi (null when senpi:false)
//       checks, check(name, pass, detail),       // record + print one check
//       records(type?),                          // all keepwarm records under <home>/records, ts-ordered, optional type filter
//       waitForRecord(pred, ms = 30000),         // fs.watch on <home>/records, resolves the record, rejects on timeout
//       expectNoRecord(pred, ms),                // waits at most ms; resolves { absent: true } or { absent: false, hit }
//       sessionFiles(root = tmp), sessionEntries(senpiHandle = s.senpi),   // senpi session JSONL (parsed)
//       turn(message, { timeoutMs = 60000, senpi = s.senpi, sessionId }),  // prompt -> agent_end; returns the RPC response
//       startExtra(label, { model, extraArgs, env, extensions }),          // another RPC senpi on the same keepwarm home
//       probeModel(),                            // model picked by rpc-driver (anthropic, cacheRead > 0), no keepwarm loaded
//       launchEnv(extra = {}),                   // env for a hand-started senpi (mock url, block/ext log, keepwarm env)
//       extensionArgs(),                         // [stub, helper] paths for a hand-started senpi
//       finish(extraChecks = []),                // stop everything, standard checks, copy evidence, write result.json/cleanup.txt
//     }
//     finish() standard checks: block log 0 lines, keepwarm errors.log/stub.log empty, senpi pid(s) gone,
//     mock closed, temp dir removed. Returns true iff every check passed.
//
//   runScenario(opts, async (s) => { ...s.check(...) }) -> never returns; exits 0 iff every check passed.
//       startScenario + fn + finish + process.exit; an exception in fn becomes a failing check.
//
//   sessionAdditions(entries) -> { additions, hostCustomTypes, messages }   (see its comment: keepwarm-added entries)
//   Small utilities: argValue(name), readJsonSafeFile(file), stripCache, normMsg, textOf, isPrefix(a, b), pidAlive(pid), readJsonl (re-export).
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonl, startMock, startSenpi } from "../rpc-driver.mjs";

export { readJsonl };

const here = dirname(fileURLToPath(import.meta.url));
export const QA_DIR = join(here, "..");
export const REPO = join(QA_DIR, "..");
export const FIXTURES = join(QA_DIR, "fixtures");
export const EXT_HELPER = join(QA_DIR, "fetch-redirect.ext.mjs");
export const EVID_ROOT = process.env.KW_QA_EVID_ROOT ?? "C:/dev/omo/omo-keepwarm/.omo/evidence/keepwarm-v1";

// ---- small utilities -------------------------------------------------------

export function argValue(name, argv = process.argv.slice(2)) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export const stripCache = (v) => {
  if (Array.isArray(v)) return v.map(stripCache);
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) if (k !== "cache_control") o[k] = stripCache(x);
    return o;
  }
  return v;
};

export const normMsg = (m) =>
  stripCache({ role: m.role, content: typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content });

export const textOf = (m) => {
  const c = m?.content;
  if (typeof c === "string") return c;
  return Array.isArray(c) ? c.filter((b) => b?.type === "text").map((b) => b.text).join("") : "";
};

/** true when message list a (already normalised) is a strict-or-equal prefix of b. */
export const isPrefix = (a, b) => a.length <= b.length && a.every((m, i) => JSON.stringify(m) === JSON.stringify(b[i]));

/**
 * Session entries keepwarm could have added. senpi itself writes custom/custom_message entries (pi-rules.scan,
 * environment-context, senpi.todo-first-turn, senpi.hooks.stop-state ...), so "no customType at all" cannot hold;
 * the invariant is that nothing mentions keepwarm and every message is user/assistant.
 * Returns { additions, hostCustomTypes, messages }.
 */
export function sessionAdditions(entries) {
  const additions = entries.filter(
    (e) =>
      /keepwarm/i.test(JSON.stringify(e)) ||
      (e.type === "message" && !["user", "assistant"].includes(e.message?.role)) ||
      (e.type !== "message" && !["session", "model_change", "thinking_level_change", "custom", "custom_message"].includes(e.type)),
  );
  const hostCustomTypes = [...new Set(entries.filter((e) => e.customType !== undefined).map((e) => e.customType))];
  return { additions, hostCustomTypes, messages: entries.filter((e) => e.type === "message").length };
}

/** Parsed JSON file or undefined (never throws). */
export function readJsonSafeFile(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return undefined;
  }
}

export function loadFixture(x) {
  if (x === null || x === undefined) return null;
  if (typeof x === "object") return JSON.parse(JSON.stringify(x));
  const file = join(FIXTURES, x.endsWith(".json") ? x : `${x}.json`);
  return JSON.parse(readFileSync(file, "utf8"));
}

// ---- keepwarm preparation --------------------------------------------------

export function prepareKeepwarm({ tmp, config, behavior } = {}) {
  if (!tmp) throw new Error("prepareKeepwarm: tmp is required");
  const home = join(tmp, "kw");
  const healthHome = join(tmp, "health");
  mkdirSync(home, { recursive: true });
  mkdirSync(healthHome, { recursive: true });
  const cfg = loadFixture(config);
  if (cfg) writeFileSync(join(home, "config.json"), JSON.stringify(cfg, null, 2) + "\n");
  const beh = loadFixture(behavior);
  if (beh) writeFileSync(join(home, "behavior.json"), JSON.stringify({ ...beh, updatedAt: Date.now() }, null, 2) + "\n");
  const env = { OMO_KEEPWARM_HOME: home, OMO_HEALTH_HOME: healthHome };
  const stubPath = join(tmp, "omo-keepwarm.ts");
  const r = spawnSync(
    process.execPath,
    [join(REPO, "bin", "omo-keepwarm.mjs"), "render-stub", "--dev-root", process.env.KW_QA_DEV_ROOT ?? REPO, "--out", stubPath],
    { env: { ...process.env, ...env }, encoding: "utf8", windowsHide: true },
  );
  if (r.status !== 0) throw new Error(`render-stub failed (exit ${r.status}): ${r.stderr || r.stdout}`);
  return { home, healthHome, stubPath, env };
}

// ---- scenario lifecycle ----------------------------------------------------

function walk(dir, out = []) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    const p = join(dir, n);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const lines = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((l) => l.trim()) : []);

export async function startScenario(opts = {}) {
  const {
    name, taskDir = "task-11", config, behavior, mockScript, extraArgs = [], env = {}, model = "auto",
    stub = true, extensions = [], senpi: wantSenpi = true,
  } = opts;
  if (!name) throw new Error("startScenario: name is required");
  const t0 = Date.now();
  const evid = join(EVID_ROOT, taskDir, name);
  rmSync(evid, { recursive: true, force: true });
  mkdirSync(evid, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), `kw-qa-${name}-`));

  const checks = [];
  const check = (n, pass, detail = "") => {
    checks.push({ name: n, pass: Boolean(pass), detail: String(detail) });
    console.log(`${pass ? "PASS" : "FAIL"} ${n}${detail ? ` - ${detail}` : ""}`);
  };

  const s = {
    name, tmp, evid, checks, check, startError: null, senpi: null, mock: null, model: null,
    home: null, healthHome: null, stubPath: null, kwEnv: null,
    blockLog: join(tmp, "block.log"), extLog: join(tmp, "ext.log"),
  };
  const handles = []; // every RPC senpi started here, [{ label, handle, tmp }]
  let mockUrl = "";

  const recDir = () => join(s.home, "records");
  s.records = (type) => {
    const all = [];
    for (const f of walk(recDir())) if (f.endsWith(".jsonl")) all.push(...readJsonl(f));
    all.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    return type ? all.filter((r) => r.type === type) : all;
  };

  // Watches <home>/records; resolves { hit } for the first record satisfying pred, or { hit: null } after ms.
  function watchRecords(pred, ms) {
    return new Promise((resolve) => {
      mkdirSync(recDir(), { recursive: true });
      let w;
      let timer;
      const done = (hit) => {
        clearTimeout(timer);
        w?.close();
        resolve({ hit });
      };
      const scan = () => {
        const hit = s.records().find(pred);
        if (hit) done(hit);
        return Boolean(hit);
      };
      timer = setTimeout(() => done(null), ms);
      w = watch(recDir(), { recursive: true }, scan);
      scan();
    });
  }
  s.waitForRecord = async (pred, ms = 30000) => {
    const { hit } = await watchRecords(pred, ms);
    if (!hit) throw new Error(`waitForRecord timed out after ${ms} ms (${s.records().length} records seen)`);
    return hit;
  };
  s.expectNoRecord = async (pred, ms) => {
    const { hit } = await watchRecords(pred, ms);
    return hit ? { absent: false, hit } : { absent: true };
  };

  s.sessionFiles = (root = tmp) => walk(root).filter((f) => f.endsWith(".jsonl") && /[\\/]sessions[\\/]/.test(f));
  s.sessionEntries = (handle = s.senpi) => {
    const dir = handle?.sessionDir ?? join(tmp, "sessions");
    return walk(dir).filter((f) => f.endsWith(".jsonl")).flatMap((f) => readJsonl(f));
  };

  s.turn = async (message, { timeoutMs = 60000, senpi = s.senpi, sessionId } = {}) => {
    const from = senpi.events.length;
    const res = await senpi.send({ type: "prompt", message, ...(sessionId ? { sessionId } : {}) });
    if (!res?.success) throw new Error(`prompt "${message}" rejected: ${JSON.stringify(res)}`);
    await senpi.waitForEvent((e) => e.type === "agent_end" && (!sessionId || e.sessionId === sessionId), timeoutMs, { from });
    return res;
  };

  s.launchEnv = (extra = {}) => ({
    KW_QA_MOCK_URL: mockUrl,
    KW_QA_BLOCK_LOG: s.blockLog,
    KW_QA_EXT_LOG: s.extLog,
    ...s.kwEnv,
    ...extra,
  });
  s.extensionArgs = () => [...(stub ? [s.stubPath] : []), ...extensions, EXT_HELPER];

  s.startExtra = async (label, o = {}) => {
    const dir = join(tmp, label);
    const handle = await startSenpi({
      tmp: dir,
      extensions: o.extensions ?? s.extensionArgs(),
      env: s.launchEnv({ KW_QA_EXT_LOG: join(dir, "ext.log"), ...(o.env ?? {}) }),
      model: o.model ?? "auto",
      extraArgs: o.extraArgs ?? [],
    });
    handles.push({ label, handle, tmp: dir });
    return handle;
  };

  s.probeModel = async () => {
    const dir = join(tmp, "probe");
    const handle = await startSenpi({ tmp: dir, extensions: [], env: { KW_QA_BLOCK_LOG: s.blockLog }, model: "auto" });
    const picked = handle.model;
    await handle.stop();
    return picked;
  };

  try {
    const kw = prepareKeepwarm({ tmp, config, behavior });
    Object.assign(s, { home: kw.home, healthHome: kw.healthHome, stubPath: kw.stubPath, kwEnv: kw.env });
    s.mock = await startMock({ port: 0, logFile: join(evid, "mock-requests.jsonl"), script: mockScript });
    mockUrl = s.mock.url;
    if (wantSenpi) {
      s.senpi = await startSenpi({
        tmp,
        extensions: s.extensionArgs(),
        env: s.launchEnv(env),
        model,
        extraArgs,
      });
      s.model = s.senpi.model;
      handles.push({ label: "primary", handle: s.senpi, tmp });
      check("senpi started (model with cacheRead > 0)", true, JSON.stringify(s.model));
    }
  } catch (e) {
    s.startError = e;
    check("harness started", false, String(e?.stack ?? e));
  }

  s.finish = async (extraChecks = []) => {
    for (const c of extraChecks) check(c.name ?? c[0], c.pass ?? c[1], c.detail ?? c[2] ?? "");
    const stops = [];
    for (const h of handles) {
      try {
        stops.push({ label: h.label, pid: h.handle.pid, info: await h.handle.stop() });
      } catch (e) {
        stops.push({ label: h.label, pid: h.handle.pid, info: { error: String(e.message) } });
      }
    }
    if (s.mock) await s.mock.close().catch(() => {});

    // Standard checks that need the logs before the temp dir goes away.
    const blockLines = lines(s.blockLog);
    check("block log has 0 lines (zero non-localhost requests)", blockLines.length === 0, blockLines.length ? blockLines.slice(0, 5).join(" | ") : "no blocked requests");
    if (s.home) {
      const errs = [...lines(join(s.home, "logs", "errors.log")), ...lines(join(s.home, "logs", "stub.log"))];
      check("keepwarm errors.log and stub.log are empty", errs.length === 0, errs.length ? errs.slice(0, 3).join(" | ") : "no errors logged");
    }

    // Evidence copies.
    const copyIf = (src, dst) => {
      try {
        if (existsSync(src)) cpSync(src, dst, { recursive: true });
      } catch (e) {
        writeFileSync(`${dst}.copy-error.txt`, String(e.message));
      }
    };
    if (s.home) copyIf(s.home, join(evid, "keepwarm-home"));
    for (const h of handles) {
      const suffix = h.label === "primary" ? "" : `-${h.label}`;
      copyIf(h.handle.stdoutLog, join(evid, `senpi-stdout${suffix}.log`));
      copyIf(h.handle.stderrLog, join(evid, `senpi-stderr${suffix}.log`));
      copyIf(h.handle.extLog, join(evid, `ext${suffix}.log`));
      const sd = h.handle.sessionDir;
      if (sd && existsSync(sd)) for (const f of walk(sd)) if (f.endsWith(".jsonl")) copyIf(f, join(evid, `session${suffix}`, f.slice(sd.length + 1).replace(/[\\/]/g, "_")));
    }
    for (const f of walk(tmp)) {
      // hand-started runs (print mode etc.) leave their logs directly under tmp subdirs
      if (/senpi-print-(stdout|stderr)\.log$/.test(f)) copyIf(f, join(evid, f.slice(tmp.length + 1).replace(/[\\/]/g, "_")));
    }
    copyIf(s.blockLog, join(evid, "block.log"));
    if (!existsSync(join(evid, "block.log"))) writeFileSync(join(evid, "block.log"), "");
    if (!existsSync(join(evid, "ext.log"))) writeFileSync(join(evid, "ext.log"), "");
    if (!existsSync(join(evid, "senpi-stdout.log"))) writeFileSync(join(evid, "senpi-stdout.log"), "");
    if (!existsSync(join(evid, "senpi-stderr.log"))) writeFileSync(join(evid, "senpi-stderr.log"), "");

    // Cleanup receipts.
    let mockClosed = true;
    if (mockUrl) {
      mockClosed = false;
      try {
        await fetch(mockUrl + "/v1/messages", { method: "POST", signal: AbortSignal.timeout(3000) });
      } catch {
        mockClosed = true;
      }
    }
    const pidsGone = stops.every((x) => !x.pid || !pidAlive(x.pid));
    rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
    const tmpGone = !existsSync(tmp);
    writeFileSync(
      join(evid, "cleanup.txt"),
      [
        ...stops.map((x) => `senpi ${x.label} pid ${x.pid ?? "n/a"}: ${!x.pid || !pidAlive(x.pid) ? "gone" : "STILL ALIVE"} stop=${JSON.stringify(x.info)}`),
        `mock ${mockUrl || "n/a"}: ${mockClosed ? "closed (connection refused)" : "STILL LISTENING"}`,
        `temp dir ${tmp}: ${tmpGone ? "removed" : "STILL EXISTS"}`,
        "",
      ].join("\n"),
    );
    check("senpi process(es) exited and pid(s) are gone", pidsGone && stops.every((x) => x.info?.killed !== true), stops.map((x) => `${x.label}:${x.pid} ${JSON.stringify(x.info)}`).join(" | ") || "no senpi started");
    check("mock closed", mockClosed, mockUrl || "no mock");
    check("temp dir removed", tmpGone, tmp);

    const pass = checks.length > 0 && checks.every((c) => c.pass);
    const result = { scenario: name, pass, durationMs: Date.now() - t0, model: s.model, checks };
    writeFileSync(join(evid, "result.json"), JSON.stringify(result, null, 2) + "\n");
    return pass;
  };

  return s;
}

export async function runScenario(opts, fn) {
  const s = await startScenario(opts);
  const t0 = Date.now();
  try {
    if (!s.startError) await fn(s);
  } catch (e) {
    s.check("scenario ran without fatal error", false, String(e?.stack ?? e));
  }
  const pass = await s.finish().catch((e) => {
    console.error(`finish failed: ${e?.stack ?? e}`);
    return false;
  });
  console.log(`${pass ? "SCENARIO PASS" : "SCENARIO FAIL"} ${opts.name} (${((Date.now() - t0) / 1000).toFixed(1)} s) -> ${s.evid}`);
  process.exit(pass ? 0 : 1);
}
