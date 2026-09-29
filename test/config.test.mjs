import test from "node:test";
import assert from "node:assert/strict";
import fs, { existsSync, readdirSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { createConfigSource, updateConfig, DEFAULTS, DEFAULT_HABIT } from "../src/config.mjs";
import { layout } from "../src/paths.mjs";
import { readJsonSafe } from "../src/fsx.mjs";
import { createFakeClock, tmpHome } from "./helpers/fake-host.mjs";

const DAY = 24 * 60 * 60 * 1000;

function setup() {
  const home = tmpHome();
  const clock = createFakeClock();
  const files = layout(home);
  const src = createConfigSource({ home, now: clock.now, statEveryMs: 0 });
  const put = (file, text) => {
    mkdirSync(home, { recursive: true });
    writeFileSync(file, typeof text === "string" ? text : JSON.stringify(text));
  };
  return { home, clock, files, src, put };
}

test("missing file -> mode off, nothing created by get()", () => {
  const { home, src } = setup();
  const cfg = src.get();
  assert.equal(cfg.mode, "off");
  assert.equal(cfg.maxUsdPerEpisode, DEFAULTS.maxUsdPerEpisode);
  assert.deepEqual(src.invalid(), []);
  assert.equal(src.exists(), false);
  assert.deepEqual(readdirSync(home), []);
});

test("a stat error other than ENOENT keeps the last config instead of treating it as deleted", (t) => {
  const { files, src, put } = setup();
  put(files.config, { v: 1, mode: "shadow" });
  assert.equal(src.exists(true), true);
  const real = fs.statSync;
  fs.statSync = (p, ...rest) => {
    if (String(p) === files.config) throw Object.assign(new Error("busy"), { code: "EBUSY" });
    return real(p, ...rest);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.statSync = real;
    syncBuiltinESMExports();
  });
  assert.equal(src.exists(true), true);
  assert.equal(src.get().mode, "shadow");
});

test("broken JSON -> defaults (shadow) + invalid", () => {
  const { files, src, put } = setup();
  put(files.config, "{ not json");
  assert.equal(src.get().mode, "shadow");
  assert.ok(src.invalid().length > 0);
  assert.equal(src.exists(), true);
});

test("mode typo -> shadow + invalid mentions mode", () => {
  const { files, src, put } = setup();
  put(files.config, { mode: "loud" });
  assert.equal(src.get().mode, "shadow");
  assert.ok(src.invalid().includes("mode"));
});

test("valid modes are accepted", () => {
  const { files, src, put } = setup();
  let i = 0;
  for (const mode of ["off", "shadow", "on"]) {
    put(files.config, { v: 1, mode });
    const t = new Date(1_700_000_000_000 + 10_000 * ++i);
    utimesSync(files.config, t, t);
    assert.equal(src.get().mode, mode);
    assert.deepEqual(src.invalid(), []);
  }
});

test("negative caps -> defaults + invalid", () => {
  const { files, src, put } = setup();
  put(files.config, { maxUsdPerEpisode: -1, maxUsdPerDay: -5, mode: "on" });
  const cfg = src.get();
  assert.equal(cfg.maxUsdPerEpisode, 0.5);
  assert.equal(cfg.maxUsdPerDay, 3);
  assert.equal(cfg.mode, "on");
  assert.ok(src.invalid().includes("maxUsdPerEpisode"));
  assert.ok(src.invalid().includes("maxUsdPerDay"));
});

test("expiry values: auto or finite non-negative; bad entries dropped", () => {
  const { files, src, put } = setup();
  put(files.config, {
    expiry: { a: "auto", b: 120, c: 0, d: -1, e: "soon", f: null, g: 1e999 },
  });
  const cfg = src.get();
  assert.deepEqual(cfg.expiry, { a: "auto", b: 120, c: 0 });
  assert.deepEqual(
    src.invalid().filter((x) => x.startsWith("expiry.")).sort(),
    ["expiry.d", "expiry.e", "expiry.f", "expiry.g"],
  );
});

test("expiry that is not an object -> {} + invalid", () => {
  const { files, src, put } = setup();
  put(files.config, { expiry: 60 });
  assert.deepEqual(src.get().expiry, {});
  assert.ok(src.invalid().includes("expiry"));
});

test("re-reads only when mtime changes", () => {
  const { files, src, put } = setup();
  put(files.config, { mode: "on" });
  const t0 = new Date(1_700_000_000_000);
  utimesSync(files.config, t0, t0);
  assert.equal(src.get().mode, "on");

  // different content, same mtime -> cached value stays
  put(files.config, { mode: "off" });
  utimesSync(files.config, t0, t0);
  assert.equal(src.get().mode, "on");

  // mtime changes -> re-read
  const t1 = new Date(1_700_000_100_000);
  utimesSync(files.config, t1, t1);
  assert.equal(src.get().mode, "off");
});

test("stat is throttled by statEveryMs using the injected clock", () => {
  const home = tmpHome();
  const clock = createFakeClock();
  const files = layout(home);
  const src = createConfigSource({ home, now: clock.now, statEveryMs: 5000 });
  assert.equal(src.get().mode, "off");
  writeFileSync(files.config, JSON.stringify({ mode: "on" }));
  assert.equal(src.get().mode, "off"); // within the window
  return clock.advance(5000).then(() => {
    assert.equal(src.get().mode, "on");
  });
});

function behaviorFile(extra = {}, now) {
  return { v: 1, p: 0.7, mMin: 12, t90Min: 100, humanReturns: 30, updatedAt: new Date(now).toISOString(), ...extra };
}

test("habit: default when nothing exists", () => {
  const { src } = setup();
  assert.deepEqual(src.habit(), DEFAULT_HABIT);
});

test("habit: observed with 30 returns within 28 days", () => {
  const { files, src, put, clock } = setup();
  put(files.config, { mode: "on" });
  put(files.behavior, behaviorFile({ updatedAt: new Date(clock.now() - 28 * DAY).toISOString() }, clock.now()));
  assert.deepEqual(src.habit(), { p: 0.7, mMin: 12, t90Min: 100, source: "observed" });
});

test("habit: observed with 29 returns -> default", () => {
  const { files, src, put, clock } = setup();
  put(files.behavior, behaviorFile({ humanReturns: 29 }, clock.now()));
  assert.deepEqual(src.habit(), DEFAULT_HABIT);
});

test("habit: observed updated 29 days ago -> default", () => {
  const { files, src, put, clock } = setup();
  put(files.behavior, behaviorFile({ updatedAt: new Date(clock.now() - 29 * DAY).toISOString() }, clock.now()));
  assert.deepEqual(src.habit(), DEFAULT_HABIT);
});

test("habit: invalid behavior file -> default", () => {
  const { files, src, put, clock } = setup();
  put(files.behavior, behaviorFile({ p: 2 }, clock.now()));
  assert.deepEqual(src.habit(), DEFAULT_HABIT);
});

test("habit: manual beats observed", () => {
  const { files, src, put, clock } = setup();
  put(files.behavior, behaviorFile({}, clock.now()));
  put(files.config, { habit: { p: 0.9, medianMinutes: 5, t90Minutes: 60 } });
  assert.deepEqual(src.habit(), { p: 0.9, mMin: 5, t90Min: 60, source: "manual" });
});

test("habit: invalid manual habit -> auto + invalid", () => {
  const { files, src, put, clock } = setup();
  put(files.behavior, behaviorFile({}, clock.now()));
  put(files.config, { habit: { p: 0.9, medianMinutes: 70, t90Minutes: 60 } });
  assert.equal(src.get().habit, "auto");
  assert.ok(src.invalid().includes("habit"));
  assert.equal(src.habit().source, "observed");
});

test("updateConfig: creates file from DEFAULTS when missing", () => {
  const { home, files } = setup();
  const out = updateConfig(home, (c) => {
    c.mode = "on";
  });
  assert.equal(out.mode, "on");
  const disk = readJsonSafe(files.config);
  assert.equal(disk.mode, "on");
  assert.equal(disk.maxUsdPerDay, 3);
  assert.equal(disk.v, 1);
});

test("updateConfig: preserves unknown keys", () => {
  const { home, files, put } = setup();
  put(files.config, { v: 1, mode: "shadow", futureKey: { a: 1 }, other: [1, 2] });
  updateConfig(home, (c) => {
    c.mode = "off";
  });
  const disk = readJsonSafe(files.config);
  assert.equal(disk.mode, "off");
  assert.deepEqual(disk.futureKey, { a: 1 });
  assert.deepEqual(disk.other, [1, 2]);
});

test("updateConfig: mutator may return a replacement; result is validated", () => {
  const { home, files } = setup();
  updateConfig(home, () => ({ mode: "loud", maxUsdPerDay: -2, expiry: { x: 30 } }));
  const disk = readJsonSafe(files.config);
  assert.equal(disk.mode, "shadow");
  assert.equal(disk.maxUsdPerDay, 3);
  assert.deepEqual(disk.expiry, { x: 30 });
});

test("updateConfig: atomic write leaves no temp files and old file survives a throwing mutator", () => {
  const { home, files, put } = setup();
  put(files.config, { v: 1, mode: "on" });
  assert.throws(() =>
    updateConfig(home, () => {
      throw new Error("boom");
    }),
  );
  assert.equal(readJsonSafe(files.config).mode, "on");
  updateConfig(home, (c) => {
    c.expiry = { a: "auto" };
  });
  assert.deepEqual(readdirSync(home).filter((n) => n.startsWith(".tmp-")), []);
  assert.ok(existsSync(join(home, "config.json")));
  assert.deepEqual(readJsonSafe(files.config).expiry, { a: "auto" });
});

test("updateConfig on a broken file starts from defaults", () => {
  const { home, files, put } = setup();
  put(files.config, "{ broken");
  updateConfig(home, (c) => {
    c.mode = "on";
  });
  assert.equal(readJsonSafe(files.config).mode, "on");
});
