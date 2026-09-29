import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { install, REPO_ROOT, renderStub, stubPath } from "../src/install.mjs";
import { layout } from "../src/paths.mjs";

const nodeRequire = createRequire(import.meta.url);
const CALLS = Symbol.for("omo-keepwarm.test.stub-load");
const PI_AI = "@earendil-works/pi-ai";
const SENPI = "@code-yeongyu/senpi";

const fakePiAi = { warmPromptCache() {}, marker: "fake-pi-ai" };
const fakeConvertToLlm = (messages) => messages;
const virtualModules = { [PI_AI]: fakePiAi, [SENPI]: { convertToLlm: fakeConvertToLlm } };

/**
 * Load the rendered stub the way senpi does: a vm script (no dynamic import callback) whose imports are
 * virtual modules. The template's TypeScript is only `: any` annotations, which are stripped here.
 */
function loadStub(source) {
  const body = source
    .replace(/: any\b(\[\])?/g, "")
    .replace(/^import \* as (\w+) from "([^"]+)";$/gm, 'const $1 = __req("$2");')
    .replace(/^import \{([^}]+)\} from "([^"]+)";$/gm, 'const {$1} = __req("$2");')
    .replace("export default async function omoKeepwarmStub", "async function omoKeepwarmStub");
  assert.doesNotMatch(body, /^\s*(import|export)\b/m, "every import/export of the template was rewritten");
  const factory = new vm.Script(`(function (__req) {\n${body}\nreturn omoKeepwarmStub;\n})`, { filename: "omo-keepwarm.stub.vm.js" }).runInThisContext();
  return factory((spec) => {
    if (Object.hasOwn(virtualModules, spec)) return virtualModules[spec];
    assert.ok(spec.startsWith("node:"), `the stub imports only node:* and the two host packages, got ${spec}`);
    return nodeRequire(spec);
  });
}

function template() {
  return readFileSync(join(REPO_ROOT, "extension", "stub.ts.tpl"), "utf8");
}

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "omo-keepwarm-stub-load-"));
  const home = join(dir, "home");
  delete globalThis[CALLS];
  t.after(() => {
    delete globalThis[CALLS];
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, home, L: layout(home) };
}

/** A fake release root: the real import-fresh.mjs plus a tiny extension/keepwarm.mjs. */
function makeRoot(dir, name, { version, broken = false }) {
  const root = join(dir, name);
  mkdirSync(join(root, "extension"), { recursive: true });
  cpSync(join(REPO_ROOT, "extension", "import-fresh.mjs"), join(root, "extension", "import-fresh.mjs"));
  writeFileSync(
    join(root, "extension", "keepwarm.mjs"),
    broken
      ? `throw new Error(${JSON.stringify(`broken release ${version}`)});\n`
      : `export default function keepwarm(pi, deps) {\n  (globalThis[Symbol.for("omo-keepwarm.test.stub-load")] ??= []).push({ pi, deps, loaded: ${JSON.stringify(version)} });\n}\n`,
  );
  return root;
}

function writeCurrent(L, current) {
  mkdirSync(L.appDir, { recursive: true });
  writeFileSync(L.currentFile, JSON.stringify({ v: 1, previous: null, ...current }));
}

async function runStub(home, pi = { on() {} }) {
  const entry = loadStub(renderStub(template()));
  const previous = process.env.OMO_KEEPWARM_HOME;
  process.env.OMO_KEEPWARM_HOME = home;
  try {
    await entry(pi);
  } finally {
    if (previous === undefined) delete process.env.OMO_KEEPWARM_HOME;
    else process.env.OMO_KEEPWARM_HOME = previous;
  }
  return pi;
}

/** One entry per failure; an entry may continue on untimestamped lines. */
function stubLogLines(L) {
  if (!existsSync(L.stubLog)) return [];
  return readFileSync(L.stubLog, "utf8")
    .split("\n")
    .filter((line) => /^\d{4}-\d\d-\d\dT/.test(line));
}

test("the stub's load path works where senpi evaluates extensions (vm script without a dynamic import callback)", async (t) => {
  const { dir } = fixture(t);
  const root = makeRoot(dir, "r1", { version: "1.0.0" });
  const entry = join(root, "extension", "keepwarm.mjs");
  const bare = new vm.Script("(file) => import(file)").runInThisContext();
  await assert.rejects(bare(entry), { code: "ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING" }, "the environment reproduces the failure");
  const load = new vm.Script(`(async (createRequire, entry, helper) => {
    const { importFresh } = createRequire(entry)(helper);
    const mod = await importFresh(entry);
    return typeof mod.default;
  })`).runInThisContext();
  assert.equal(await load(createRequire, entry, join(root, "extension", "import-fresh.mjs")), "function");
});

test("current.json valid: its root loads and deps carry { piAi, convertToLlm, version }", async (t) => {
  const { dir, home, L } = fixture(t);
  const root = makeRoot(dir, "r-current", { version: "1.2.3+aaaaaaaa" });
  const lkgRoot = makeRoot(dir, "r-lkg", { version: "1.0.0+bbbbbbbb" });
  writeCurrent(L, {
    version: "1.2.3+aaaaaaaa",
    root,
    lkg: { version: "1.0.0+bbbbbbbb", root: lkgRoot },
  });
  const pi = { on() {} };
  await runStub(home, pi);
  const calls = globalThis[CALLS];
  assert.equal(calls.length, 1, "exactly one runtime loaded");
  assert.equal(calls[0].loaded, "1.2.3+aaaaaaaa");
  assert.equal(calls[0].pi, pi);
  assert.deepEqual(Object.keys(calls[0].deps).sort(), ["convertToLlm", "piAi", "version"]);
  assert.equal(calls[0].deps.piAi, fakePiAi);
  assert.equal(calls[0].deps.convertToLlm, fakeConvertToLlm);
  assert.equal(calls[0].deps.version, "1.2.3+aaaaaaaa", "version is the loaded root's version");
  assert.equal(existsSync(L.stubLog), false, "a clean load leaves no log");
});

test("current root missing: the lkg root loads and version is the lkg version", async (t) => {
  const { dir, home, L } = fixture(t);
  const lkgRoot = makeRoot(dir, "r-lkg", { version: "0.9.0+cccccccc" });
  writeCurrent(L, {
    version: "1.2.3+aaaaaaaa",
    root: join(dir, "no-such-release"),
    lkg: { version: "0.9.0+cccccccc", root: lkgRoot },
  });
  await runStub(home);
  const calls = globalThis[CALLS];
  assert.equal(calls.length, 1);
  assert.equal(calls[0].loaded, "0.9.0+cccccccc");
  assert.equal(calls[0].deps.version, "0.9.0+cccccccc", "not the broken current version");
  assert.equal(calls[0].deps.piAi, fakePiAi);
  assert.equal(calls[0].deps.convertToLlm, fakeConvertToLlm);
});

test("current root throws on import: the lkg root loads", async (t) => {
  const { dir, home, L } = fixture(t);
  const bad = makeRoot(dir, "r-bad", { version: "2.0.0", broken: true });
  const lkgRoot = makeRoot(dir, "r-lkg", { version: "1.0.0" });
  writeCurrent(L, { version: "2.0.0", root: bad, lkg: { version: "1.0.0", root: lkgRoot } });
  await runStub(home);
  assert.equal(globalThis[CALLS].length, 1);
  assert.equal(globalThis[CALLS][0].deps.version, "1.0.0");
});

test("current and lkg both fail: inert, no throw, exactly one line in logs/stub.log", async (t) => {
  const { dir, home, L } = fixture(t);
  const bad = makeRoot(dir, "r-bad", { version: "2.0.0", broken: true });
  writeCurrent(L, {
    version: "2.0.0",
    root: bad,
    lkg: { version: "1.0.0", root: join(dir, "no-such-lkg") },
  });
  const pi = { on() {}, registerCommand() {} };
  await assert.doesNotReject(runStub(home, pi));
  assert.equal(globalThis[CALLS], undefined, "no runtime was called");
  const lines = stubLogLines(L);
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.match(lines[0], /^\d{4}-\d\d-\d\dT[^ ]+ pid=\d+ inert: /);
  assert.match(lines[0], /broken release 2\.0\.0/);
  assert.match(lines[0], /no-such-lkg/);
});

test("app/current.json absent: inert with exactly one stub.log line", async (t) => {
  const { home, L } = fixture(t);
  await assert.doesNotReject(runStub(home));
  assert.equal(globalThis[CALLS], undefined);
  const lines = stubLogLines(L);
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.match(lines[0], /inert: current\.json/);
  assert.equal(existsSync(L.currentFile), false, "the stub never creates current.json");
});

test("a runtime that throws from its default export is logged once and not retried with the lkg root", async (t) => {
  const { dir, home, L } = fixture(t);
  const throwing = makeRoot(dir, "r-throws", { version: "3.0.0" });
  writeFileSync(join(throwing, "extension", "keepwarm.mjs"), 'export default function keepwarm() { throw new Error("entry boom"); }\n');
  const lkgRoot = makeRoot(dir, "r-lkg", { version: "1.0.0" });
  writeCurrent(L, { version: "3.0.0", root: throwing, lkg: { version: "1.0.0", root: lkgRoot } });
  await assert.doesNotReject(runStub(home));
  assert.equal(globalThis[CALLS], undefined, "the lkg runtime was not started on top of a half-registered one");
  const lines = stubLogLines(L);
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.match(lines[0], /entry boom/);
});

test("the rendered stub is byte-identical for installs of different versions", async (t) => {
  const { dir } = fixture(t);
  const env = {
    OMO_KEEPWARM_HOME: join(dir, "kw"),
    OMO_CODING_AGENT_DIR: join(dir, "agent"),
    SENPI_CODING_AGENT_DIR: join(dir, "agent"),
    OMO_HEALTH_HOME: join(dir, "health"),
  };
  const source = join(dir, "repo");
  for (const rel of ["src", "extension", "package.json"]) cpSync(join(REPO_ROOT, rel), join(source, rel), { recursive: true });
  const L = layout(env.OMO_KEEPWARM_HOME);

  install({ env, sourceRoot: source, force: true });
  const first = readFileSync(stubPath(env));
  const v1 = JSON.parse(readFileSync(L.currentFile, "utf8")).version;

  writeFileSync(join(source, "src", "_bump.mjs"), "export const bumped = true;\n");
  install({ env, sourceRoot: source, force: true });
  const second = readFileSync(stubPath(env));
  const v2 = JSON.parse(readFileSync(L.currentFile, "utf8")).version;

  assert.notEqual(v1, v2, "the second install is a different version");
  assert.ok(first.equals(second), "stub bytes are identical across versions");
  assert.ok(first.equals(Buffer.from(renderStub(template()))), "and equal the rendered template");
  const text = first.toString("utf8");
  assert.doesNotMatch(text, /__STUB_FORMAT__/, "the only token is substituted");
  assert.ok(!text.includes(v1) && !text.includes(v2), "no version in the stub");
  assert.ok(!text.includes(source) && !text.includes(env.OMO_KEEPWARM_HOME), "no install path in the stub");
});
