import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createConfigSource, updateConfig } from "./config.mjs";
import { atomicWriteJson, ensureDir, readJsonSafe } from "./fsx.mjs";
import { agentDir, healthHome, keepwarmHome, layout } from "./paths.mjs";
import { STALE_AFTER_MS } from "./policy.mjs";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const STUB_NAME = "omo-keepwarm.ts";
export const STUB_FORMAT = "1";
export const BUSY_PHASES = new Set(["BUSY", "PINGING", "CLASSIFYING"]);
export const HEALTH_FRESH_MS = 30_000;
const SELF_CHECK_TIMEOUT_MS = 30_000;
const DAY_MS = 24 * 3600_000;

export function stubPath(env) {
  return join(agentDir(env), "extensions", STUB_NAME);
}

/** The stub is fixed text: the only token is the stub format. */
export function renderStub(template) {
  return template.replaceAll("__STUB_FORMAT__", STUB_FORMAT);
}

export function stubContent(root = REPO_ROOT) {
  return renderStub(readFileSync(join(root, "extension", "stub.ts.tpl"), "utf8"));
}

function readText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function walk(root, rel, out) {
  let entries;
  try {
    entries = readdirSync(join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const r = `${rel}/${e.name}`;
    if (e.isDirectory()) walk(root, r, out);
    else if (e.isFile()) out.push(r);
  }
}

/** Release content: extension/**, src/**, package.json; forward-slash relative paths, sorted. */
export function sourceFiles(root) {
  const out = [];
  walk(root, "extension", out);
  walk(root, "src", out);
  if (existsSync(join(root, "package.json"))) out.push("package.json");
  return out.sort();
}

/** package.json version + "+" + sha256 over the sorted release files (path and content). */
export function computeVersion(root) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8").replace(/^\uFEFF/, ""));
  const h = createHash("sha256");
  for (const rel of sourceFiles(root)) {
    h.update(rel);
    h.update("\0");
    h.update(readFileSync(join(root, rel)));
    h.update("\0");
  }
  return `${pkg.version}+${h.digest("hex").slice(0, 8)}`;
}

/** Imports <root>/src/policy.mjs in a fresh node process. */
export function selfCheck(root) {
  const url = pathToFileURL(join(root, "src", "policy.mjs")).href;
  const code = `import(${JSON.stringify(url)}).then(m=>process.exit(typeof m.tStarMinutes==='function'?0:1))`;
  const r = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", windowsHide: true, timeout: SELF_CHECK_TIMEOUT_MS });
  return r.status === 0
    ? { ok: true }
    : { ok: false, detail: `exit ${r.status}${r.error ? ` ${r.error.message}` : ""} ${(r.stderr ?? "").trim().slice(0, 500)}`.trim() };
}

function listJson(dir) {
  try {
    return readdirSync(dir).filter((n) => n.endsWith(".json") && n !== "_global.json" && !n.startsWith("."));
  } catch {
    return [];
  }
}

/** Fresh keepwarm session status files (ts within STALE_AFTER_MS). */
function liveKeepwarmStatus(home, nowMs) {
  const dir = layout(home).statusDir;
  const out = [];
  for (const n of listJson(dir)) {
    const s = readJsonSafe(join(dir, n));
    if (s && typeof s.ts === "number" && nowMs - s.ts <= STALE_AFTER_MS) out.push({ name: n, s });
  }
  return out;
}

/**
 * Read-only busy-session scan. keepwarm: status/*.json within 15 min in phase BUSY/PINGING/CLASSIFYING.
 * omo-health: sensors/*.json and status/*.json within 30 s with idle/isIdle false or executingTools > 0.
 * Fresh files of the calling session (env.PI_SESSION_ID) are skipped; `excluded` is its id when that happened.
 */
export function findBusy({ env, now = Date.now }) {
  const nowMs = now();
  const caller = env.PI_SESSION_ID || undefined;
  const busy = [];
  let excluded = null;
  const isCaller = (id) => {
    if (caller === undefined || id !== caller) return false;
    excluded = caller;
    return true;
  };
  for (const { name, s } of liveKeepwarmStatus(keepwarmHome(env), nowMs)) {
    const id = s.session ?? name.slice(0, -5);
    if (isCaller(id)) continue;
    if (BUSY_PHASES.has(s.phase)) busy.push({ source: "keepwarm", id, reason: `phase ${s.phase}` });
  }
  const hh = healthHome(env);
  for (const sub of ["sensors", "status"]) {
    const dir = join(hh, sub);
    for (const n of listJson(dir)) {
      const s = readJsonSafe(join(dir, n));
      if (!s || typeof s.ts !== "number" || nowMs - s.ts > HEALTH_FRESH_MS) continue;
      const id = s.sessionId ?? n.slice(0, -5);
      if (isCaller(id)) continue;
      const reasons = [];
      if (s.idle === false || s.isIdle === false) reasons.push("not idle");
      if (typeof s.executingTools === "number" && s.executingTools > 0) reasons.push(`${s.executingTools} executing tools`);
      if (reasons.length) busy.push({ source: `omo-health ${sub}`, id, reason: reasons.join(", ") });
    }
  }
  return { busy, excluded };
}

export function formatExcluded(id) {
  return `busy check: excluded caller session ${id}\n`;
}

export function formatBusy(busy) {
  return `busy sessions (rerun with --force to ignore):\n${busy.map((b) => `  ${b.source} ${b.id}: ${b.reason}`).join("\n")}\n`;
}

function copyTree(srcRoot, dstRoot) {
  for (const rel of sourceFiles(srcRoot)) {
    const dst = join(dstRoot, rel);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(join(srcRoot, rel), dst);
  }
}

function renameRetry(from, to) {
  let last;
  for (let i = 0; i < 5; i++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      last = err;
      if (!["EPERM", "EBUSY", "EACCES"].includes(err?.code)) break;
    }
  }
  throw last;
}

/** Stage releases/<version>.staging, self-check it, rename. An existing release is immutable and kept. */
function stageRelease(home, sourceRoot, version) {
  const L = layout(home);
  const root = join(L.releasesDir, version);
  if (existsSync(join(root, "src", "policy.mjs"))) return root;
  const staging = `${root}.staging`;
  rmSync(staging, { recursive: true, force: true });
  ensureDir(staging);
  copyTree(sourceRoot, staging);
  const check = selfCheck(staging);
  if (!check.ok) {
    rmSync(staging, { recursive: true, force: true });
    throw new Error(`self-check failed for ${version}: ${check.detail}`);
  }
  rmSync(root, { recursive: true, force: true });
  renameRetry(staging, root);
  return root;
}

function nextCurrent(home, version, root) {
  const L = layout(home);
  const prior = readJsonSafe(L.currentFile);
  const priorOk = prior && typeof prior.version === "string" && typeof prior.root === "string";
  let previous = null;
  if (priorOk) previous = prior.version === version ? (prior.previous ?? null) : prior.version;
  let lkg = prior?.lkg && typeof prior.lkg.version === "string" && typeof prior.lkg.root === "string" ? { version: prior.lkg.version, root: prior.lkg.root } : null;
  if (priorOk && existsSync(L.loadedMarker(prior.version))) lkg = { version: prior.version, root: prior.root };
  return { v: 1, version, root, previous, lkg };
}

/** Keep current, previous, lkg and versions that fresh session status files report. */
export function pruneReleases(home, current, now = Date.now) {
  const L = layout(home);
  const keep = new Set([current.version, current.previous, current.lkg?.version].filter(Boolean));
  for (const { s } of liveKeepwarmStatus(home, now())) if (typeof s.keepwarmVersion === "string") keep.add(s.keepwarmVersion);
  const removed = [];
  let entries = [];
  try {
    entries = readdirSync(L.releasesDir, { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.endsWith(".staging") || keep.has(e.name)) continue;
    rmSync(join(L.releasesDir, e.name), { recursive: true, force: true });
    removed.push(e.name);
  }
  return removed;
}

/** Writes `text` only when the file is missing or differs. */
function writeIfChanged(file, text) {
  if (readText(file) === text) return "unchanged";
  ensureDir(dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameRetry(tmp, file);
  return "written";
}

/**
 * install/update: busy check, immutable release, current.json, config (only when absent), stub (only when
 * missing or different), prune. Returns { busy, excluded } when refused.
 */
export function install({ env, now = Date.now, sourceRoot = REPO_ROOT, force = false }) {
  const { busy, excluded } = force ? { busy: [], excluded: null } : findBusy({ env, now });
  if (busy.length) return { busy, excluded };
  const home = keepwarmHome(env);
  const L = layout(home);
  const version = computeVersion(sourceRoot);
  const root = stageRelease(home, sourceRoot, version);
  const current = nextCurrent(home, version, root);
  atomicWriteJson(L.currentFile, current);
  if (!existsSync(L.config)) updateConfig(home, (c) => c);
  const stub = writeIfChanged(stubPath(env), stubContent(root));
  const pruned = pruneReleases(home, current, now);
  return { version, root, current, stub, pruned, excluded };
}

/** Writes mode "off" first (open sessions stop at their next tick/settle), then deletes the stub. */
export function uninstall({ env, now = Date.now, purge = false, force = false, removeStub = (f) => rmSync(f, { force: true }) }) {
  const { busy, excluded } = force ? { busy: [], excluded: null } : findBusy({ env, now });
  if (busy.length) return { busy, excluded };
  const home = keepwarmHome(env);
  const file = stubPath(env);
  const installed = existsSync(file);
  if (installed) {
    updateConfig(home, (c) => {
      c.mode = "off";
    });
    removeStub(file);
  }
  if (purge) rmSync(home, { recursive: true, force: true });
  return { installed, purged: purge, excluded };
}

function recentLogLines(file, nowMs) {
  const text = readText(file);
  if (!text) return [];
  return text.split("\n").filter((line) => {
    const ms = Date.parse(line.split(" ", 1)[0]);
    return Number.isFinite(ms) && nowMs - ms <= DAY_MS;
  });
}

/** Rows of { status: "PASS"|"WARN"|"FAIL", name, detail }. */
export function doctor({ env, now = Date.now }) {
  const nowMs = now();
  const home = keepwarmHome(env);
  const L = layout(home);
  const rows = [];
  const row = (status, name, detail) => rows.push({ status, name, detail });

  const major = Number(process.versions.node.split(".")[0]);
  row(major >= 24 ? "PASS" : "FAIL", "node >= 24", process.versions.node);

  try {
    ensureDir(home);
    const probe = join(home, `.doctor-${process.pid}`);
    writeFileSync(probe, "");
    rmSync(probe, { force: true });
    row("PASS", "home writable", home);
  } catch (err) {
    row("FAIL", "home writable", `${home}: ${err.message}`);
  }

  const cfg = createConfigSource({ home, now });
  if (!cfg.exists()) row("FAIL", "config", `${L.config} missing (run install)`);
  else if (cfg.invalid().length) row("WARN", "config", `invalid fields replaced by defaults: ${cfg.invalid().join(", ")}`);
  else row("PASS", "config", `mode ${cfg.get().mode}`);

  const current = readJsonSafe(L.currentFile);
  if (typeof current?.root !== "string" || typeof current.version !== "string") row("FAIL", "current release", `${L.currentFile} missing (run install)`);
  else if (!existsSync(current.root)) row("FAIL", "current release", `${current.version}: root ${current.root} missing (run install)`);
  else {
    const check = selfCheck(current.root);
    row(check.ok ? "PASS" : "FAIL", "current release", check.ok ? `${current.version} ${current.root}` : `${current.version}: ${check.detail}`);
  }

  const lkg = current?.lkg;
  if (!lkg) row("WARN", "last known good", "none yet (no session has loaded a release)");
  else if (typeof lkg.root !== "string" || !existsSync(lkg.root)) row("FAIL", "last known good", `${lkg.version}: root missing`);
  else row("PASS", "last known good", `${lkg.version}`);

  const file = stubPath(env);
  const stubText = readText(file);
  if (stubText === undefined) row("FAIL", "stub", `${file} missing (run install)`);
  else {
    let want;
    try {
      want = stubContent(typeof current?.root === "string" && existsSync(current.root) ? current.root : REPO_ROOT);
    } catch {
      want = stubContent(REPO_ROOT);
    }
    row(stubText === want ? "PASS" : "WARN", "stub", stubText === want ? file : `${file} differs from the current template (run install)`);
  }

  for (const [name, log] of [["stub.log (24 h)", L.stubLog], ["errors.log (24 h)", L.errorLog]]) {
    const lines = recentLogLines(log, nowMs);
    row(lines.length ? "WARN" : "PASS", name, lines.length ? `${lines.length} line(s); last: ${lines.at(-1).slice(0, 300)}` : "no entries");
  }

  const global = readJsonSafe(L.globalStatus);
  if (!global) row("WARN", "_global status", "none yet");
  else if (typeof global.staleAfter !== "number" || global.staleAfter < nowMs) row("WARN", "_global status", `stale (ts ${new Date(global.ts).toISOString()})`);
  else row("PASS", "_global status", global.text ?? "fresh");

  const settings = readJsonSafe(join(agentDir(env), "settings.json"));
  if (settings?.promptCache?.keepAlive?.enabled === true) row("WARN", "builtin keep-alive", "promptCache.keepAlive.enabled is true in settings.json");
  else row("PASS", "builtin keep-alive", "off");

  return rows;
}

export function formatDoctor(rows) {
  return rows.map((r) => `${r.status} ${r.name}${r.detail ? ` - ${r.detail}` : ""}`).join("\n") + "\n";
}

/** QA: point the temp home's current.json at a dev checkout. */
export function pointAtDevRoot(env, devRoot) {
  const home = keepwarmHome(env);
  const root = resolve(devRoot);
  const current = { v: 1, version: computeVersion(root), root, previous: null, lkg: null };
  atomicWriteJson(layout(home).currentFile, current);
  return current;
}
