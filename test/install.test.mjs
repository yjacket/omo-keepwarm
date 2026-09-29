import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  computeVersion,
  install,
  REPO_ROOT,
  renderStub,
  stubPath,
  uninstall,
} from "../src/install.mjs";
import { layout } from "../src/paths.mjs";
import { run as runInstall } from "../src/cli/install.mjs";
import { run as runUpdate } from "../src/cli/update.mjs";
import { run as runUninstall } from "../src/cli/uninstall.mjs";
import { run as runDoctor } from "../src/cli/doctor.mjs";
import { run as runRenderStub } from "../src/cli/render-stub.mjs";
import { tmpHome } from "./helpers/fake-host.mjs";

// Fixed clock for the freshness windows (30 s omo-health sensors, 15 min keepwarm status).
const NOW = Date.UTC(2026, 5, 15, 9, 0, 0);
const clock = () => NOW;

function setup(t) {
  const T = tmpHome();
  t.after(() => rmSync(T, { recursive: true, force: true }));
  const env = {
    OMO_KEEPWARM_HOME: join(T, "kw"),
    OMO_CODING_AGENT_DIR: join(T, "agent"),
    SENPI_CODING_AGENT_DIR: join(T, "agent"),
    OMO_HEALTH_HOME: join(T, "health"),
  };
  const out = { out: "", err: "" };
  const io = { stdout: (s) => (out.out += s), stderr: (s) => (out.err += s), env, now: clock, cwd: T };
  const reset = () => {
    out.out = "";
    out.err = "";
  };
  return { T, env, io, out, reset, home: env.OMO_KEEPWARM_HOME, L: layout(env.OMO_KEEPWARM_HOME) };
}

/** A throwaway copy of the release inputs whose content we can change. */
function copyRepo(T) {
  const root = join(T, "repo");
  for (const rel of ["src", "extension", "package.json"]) cpSync(join(REPO_ROOT, rel), join(root, rel), { recursive: true });
  let n = 0;
  return {
    root,
    bump() {
      writeFileSync(join(root, "src", "_bump.mjs"), `export const n = ${++n};\n`);
    },
  };
}

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const releases = (L) => readdirSync(L.releasesDir).sort();

test("fresh install: release, current.json, config shadow, fixed stub", async (t) => {
  const { env, io, out, L } = setup(t);
  assert.equal(await runInstall([], io), 0, out.err);
  const version = computeVersion(REPO_ROOT);
  assert.match(version, /^\d+\.\d+\.\d+\+[0-9a-f]{8}$/);
  assert.equal(out.out, `installed ${version} (stub written)\n`);

  const cur = readJson(L.currentFile);
  assert.deepEqual(cur, { v: 1, version, root: join(L.releasesDir, version), previous: null, lkg: null });
  assert.ok(existsSync(join(cur.root, "src", "policy.mjs")));
  assert.ok(existsSync(join(cur.root, "extension", "stub.ts.tpl")));
  assert.ok(!releases(L).some((n) => n.endsWith(".staging")));

  assert.equal(readJson(L.config).mode, "shadow");

  const stub = readFileSync(stubPath(env), "utf8");
  assert.equal(stub, renderStub(readFileSync(join(REPO_ROOT, "extension", "stub.ts.tpl"), "utf8")));
  assert.ok(!stub.includes("__"), "no unreplaced token");
  assert.ok(!stub.includes(version) && !stub.includes(L.releasesDir.replace(/\\/g, "/")) && !stub.includes(L.releasesDir));
});

test("reinstall and update: stub unchanged, mtime unchanged", async (t) => {
  const { env, io, out, reset } = setup(t);
  assert.equal(await runInstall([], io), 0);
  const m0 = statSync(stubPath(env)).mtimeMs;
  reset();
  assert.equal(await runInstall([], io), 0);
  assert.match(out.out, /^installed \S+ \(stub unchanged\)\n$/);
  reset();
  assert.equal(await runUpdate([], io), 0);
  assert.match(out.out, /\(stub unchanged\)/);
  assert.equal(statSync(stubPath(env)).mtimeMs, m0);
});

test("src change: new version, stub bytes and mtime unchanged, previous updated", (t) => {
  const { T, env, L } = setup(t);
  const repo = copyRepo(T);
  const a = install({ env, sourceRoot: repo.root });
  assert.equal(a.stub, "written");
  const stubBytes = readFileSync(stubPath(env));
  const m0 = statSync(stubPath(env)).mtimeMs;
  repo.bump();
  const b = install({ env, sourceRoot: repo.root });
  assert.notEqual(b.version, a.version);
  assert.equal(b.stub, "unchanged");
  assert.deepEqual(readFileSync(stubPath(env)), stubBytes);
  assert.equal(statSync(stubPath(env)).mtimeMs, m0);
  const cur = readJson(L.currentFile);
  assert.equal(cur.version, b.version);
  assert.equal(cur.previous, a.version);
  assert.ok(existsSync(join(L.releasesDir, a.version)), "release A is immutable and kept as previous");
});

test("lkg only for a version with a loaded marker", (t) => {
  const { T, env, L } = setup(t);
  const repo = copyRepo(T);
  const a = install({ env, sourceRoot: repo.root });
  repo.bump();
  install({ env, sourceRoot: repo.root });
  assert.equal(readJson(L.currentFile).lkg, null, "A never loaded");
  const b = readJson(L.currentFile);
  mkdirSync(join(L.appDir, "loaded"), { recursive: true });
  writeFileSync(L.loadedMarker(b.version), "");
  repo.bump();
  const c = install({ env, sourceRoot: repo.root });
  assert.deepEqual(readJson(L.currentFile).lkg, { version: b.version, root: b.root });
  repo.bump();
  install({ env, sourceRoot: repo.root });
  const d = readJson(L.currentFile);
  assert.deepEqual(d.lkg, { version: b.version, root: b.root }, "C has no marker: existing lkg kept");
  assert.equal(d.previous, c.version);
  assert.notEqual(a.version, b.version);
});

test("existing config is preserved", async (t) => {
  const { io, L } = setup(t);
  const cfg = { v: 1, mode: "on", maxUsdPerEpisode: 0.2, custom: { x: 1 } };
  mkdirSync(join(L.config, ".."), { recursive: true });
  writeFileSync(L.config, JSON.stringify(cfg));
  const before = readFileSync(L.config, "utf8");
  assert.equal(await runInstall([], io), 0);
  assert.equal(readFileSync(L.config, "utf8"), before);
});

test("busy sessions: exit 3 with a list, --force overrides", async (t) => {
  const { env, io, out, reset, L } = setup(t);
  const now = NOW;
  // keepwarm session in a busy phase
  mkdirSync(L.statusDir, { recursive: true });
  writeFileSync(L.sessionStatus("kw-busy"), JSON.stringify({ v: 1, ts: now, session: "kw-busy", phase: "PINGING" }));
  writeFileSync(L.sessionStatus("kw-idle"), JSON.stringify({ v: 1, ts: now, session: "kw-idle", phase: "ARMED" }));
  writeFileSync(L.sessionStatus("kw-old"), JSON.stringify({ v: 1, ts: now - 16 * 60_000, session: "kw-old", phase: "BUSY" }));
  // omo-health sensor fixture, field names from real ~/.omo-health/sensors/*.json
  const sensors = join(env.OMO_HEALTH_HOME, "sensors");
  mkdirSync(sensors, { recursive: true });
  const sensor = (id, over) => ({ v: 1, pid: 1, sessionId: id, kind: "interactive", idle: true, pending: false, lastEventAt: now, executingTools: 0, hasUI: true, ts: now, ...over });
  writeFileSync(join(sensors, "h-tools.json"), JSON.stringify(sensor("h-tools", { idle: true, executingTools: 2 })));
  writeFileSync(join(sensors, "h-running.json"), JSON.stringify(sensor("h-running", { idle: false })));
  writeFileSync(join(sensors, "h-idle.json"), JSON.stringify(sensor("h-idle", {})));
  writeFileSync(join(sensors, "h-old.json"), JSON.stringify(sensor("h-old", { idle: false, ts: now - 60_000 })));

  assert.equal(await runInstall([], io), 3);
  for (const id of ["kw-busy", "h-tools", "h-running"]) assert.ok(out.err.includes(id), id);
  for (const id of ["kw-idle", "kw-old", "h-idle", "h-old"]) assert.ok(!out.err.includes(id), id);
  assert.ok(!existsSync(stubPath(env)), "refused install writes nothing");
  assert.ok(!existsSync(L.currentFile));

  reset();
  assert.equal(await runUninstall([], io), 3);
  reset();
  assert.equal(await runInstall(["--force"], io), 0, out.err);
  assert.ok(existsSync(stubPath(env)));
});

test("busy check excludes the calling session (PI_SESSION_ID)", async (t) => {
  const { env, io, out, reset, L } = setup(t);
  const now = NOW;
  env.PI_SESSION_ID = "caller";
  mkdirSync(L.statusDir, { recursive: true });
  // the caller is busy in every source: keepwarm status, omo-health sensor and omo-health status
  writeFileSync(L.sessionStatus("caller"), JSON.stringify({ v: 1, ts: now, session: "caller", phase: "BUSY" }));
  for (const sub of ["sensors", "status"]) {
    mkdirSync(join(env.OMO_HEALTH_HOME, sub), { recursive: true });
    writeFileSync(join(env.OMO_HEALTH_HOME, sub, "caller.json"), JSON.stringify({ sessionId: "caller", idle: false, executingTools: 1, ts: now }));
  }
  const line = "busy check: excluded caller session caller\n";

  // (a) caller busy, nobody else busy -> proceeds, with one exclusion line
  assert.equal(await runInstall([], io), 0, out.err);
  assert.equal(out.out.split(line).length - 1, 1);
  assert.match(out.out, /installed \S+ \(stub written\)/);
  assert.ok(existsSync(stubPath(env)));

  // (b) caller busy and another session busy -> exit 3 listing only the other one
  writeFileSync(L.sessionStatus("other"), JSON.stringify({ v: 1, ts: now, session: "other", phase: "CLASSIFYING" }));
  reset();
  assert.equal(await runInstall([], io), 3);
  assert.ok(out.out.includes(line));
  assert.match(out.err, /keepwarm other: phase CLASSIFYING/);
  assert.ok(!out.err.includes("caller"));
  reset();
  assert.equal(await runUninstall([], io), 3);
  assert.ok(out.out.includes(line));
  assert.ok(existsSync(stubPath(env)));

  // without PI_SESSION_ID the caller's own files count as busy
  delete env.PI_SESSION_ID;
  rmSync(L.sessionStatus("other"));
  reset();
  assert.equal(await runUninstall([], io), 3);
  assert.ok(!out.out.includes("excluded"));
  assert.match(out.err, /caller/);
});

test("uninstall writes config mode off before deleting the stub", async (t) => {
  const { env, io, out, reset, L } = setup(t);
  assert.equal(await runInstall([], io), 0);
  const seen = [];
  const r = uninstall({
    env,
    removeStub: (file) => {
      seen.push({ file, mode: readJson(L.config).mode, stubThere: existsSync(file) });
      rmSync(file);
    },
  });
  assert.equal(r.installed, true);
  assert.deepEqual(seen, [{ file: stubPath(env), mode: "off", stubThere: true }]);

  // real CLI path
  reset();
  assert.equal(await runInstall([], io), 0);
  reset();
  assert.equal(await runUninstall([], io), 0);
  assert.match(out.out, /^uninstalled/);
  assert.equal(readJson(L.config).mode, "off");
  assert.ok(!existsSync(stubPath(env)));
  assert.ok(existsSync(L.currentFile), "data kept without --purge");
  reset();
  assert.equal(await runUninstall([], io), 0);
  assert.equal(out.out, "not installed\n");
});

test("uninstall --purge removes the whole home", async (t) => {
  const { env, io, home } = setup(t);
  assert.equal(await runInstall([], io), 0);
  assert.equal(await runUninstall(["--purge"], io), 0);
  assert.ok(!existsSync(home));
  assert.ok(!existsSync(stubPath(env)));
  assert.ok(existsSync(env.OMO_CODING_AGENT_DIR), "agent dir itself is not touched");
});

test("doctor: FAIL before install, PASS after, WARN on builtin keep-alive", async (t) => {
  const { env, io, out, reset } = setup(t);
  assert.equal(await runDoctor([], io), 1);
  assert.match(out.out, /^FAIL config/m);
  assert.match(out.out, /^FAIL current release/m);
  assert.match(out.out, /^FAIL stub/m);

  reset();
  assert.equal(await runInstall([], io), 0);
  reset();
  assert.equal(await runDoctor([], io), 0, out.out);
  for (const name of ["node >= 24", "home writable", "config", "current release", "stub", "builtin keep-alive"]) {
    assert.match(out.out, new RegExp(`^PASS ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "m"), name);
  }
  assert.match(out.out, /^WARN last known good/m);
  assert.ok(!/^FAIL/m.test(out.out));

  const current = JSON.parse(readFileSync(layout(env.OMO_KEEPWARM_HOME).currentFile, "utf8"));
  mkdirSync(join(env.OMO_KEEPWARM_HOME, "app", "loaded"), { recursive: true });
  writeFileSync(layout(env.OMO_KEEPWARM_HOME).loadedMarker(current.version), "x");
  reset();
  assert.equal(await runDoctor([], io), 0);
  assert.match(out.out, /^PASS last known good .*is loaded by a session/m);

  writeFileSync(join(env.OMO_CODING_AGENT_DIR, "settings.json"), JSON.stringify({ promptCache: { keepAlive: { enabled: true } } }));
  reset();
  assert.equal(await runDoctor([], io), 0);
  assert.match(out.out, /^WARN builtin keep-alive/m);

  rmSync(stubPath(env));
  reset();
  assert.equal(await runDoctor([], io), 1);
  assert.match(out.out, /^FAIL stub/m);
});

test("prune keeps current, previous, lkg and fresh status keepwarmVersion", (t) => {
  const { T, env, L } = setup(t);
  const repo = copyRepo(T);
  const v = [];
  v.push(install({ env, now: clock, sourceRoot: repo.root }).version); // 0: referenced by a fresh status file
  repo.bump();
  v.push(install({ env, now: clock, sourceRoot: repo.root }).version); // 1: will be dropped
  mkdirSync(L.statusDir, { recursive: true });
  writeFileSync(L.sessionStatus("s1"), JSON.stringify({ v: 1, ts: NOW, session: "s1", phase: "HELD", keepwarmVersion: v[0] }));
  repo.bump();
  const r2 = install({ env, now: clock, sourceRoot: repo.root });
  v.push(r2.version); // 2: previous
  repo.bump();
  const r3 = install({ env, now: clock, sourceRoot: repo.root });
  v.push(r3.version); // 3: current
  assert.deepEqual(releases(L), [v[0], v[2], v[3]].sort());
  assert.ok(r3.pruned.includes(v[1]));
  const cur = readJson(L.currentFile);
  assert.equal(cur.version, v[3]);
  assert.equal(cur.previous, v[2]);
});

test("render-stub: writes the fixed stub; --dev-root refuses the real home", async (t) => {
  const { T, env, io, out, reset, L } = setup(t);
  const target = join(T, "out", "omo-keepwarm.ts");
  const bare = { ...io, env: {} };
  assert.equal(await runRenderStub(["--out", target, "--dev-root", REPO_ROOT], bare), 2);
  assert.match(out.err, /OMO_KEEPWARM_HOME/);
  assert.ok(!existsSync(target));
  assert.equal(await runRenderStub([], io), 2);

  reset();
  assert.equal(await runRenderStub(["--out", target, "--dev-root", REPO_ROOT], io), 0, out.err);
  const cur = readJson(L.currentFile);
  assert.equal(cur.root, REPO_ROOT);
  assert.equal(cur.version, computeVersion(REPO_ROOT));

  assert.equal(await runInstall([], io), 0);
  assert.deepEqual(readFileSync(target), readFileSync(stubPath(env)), "same bytes as the installed stub");
});
