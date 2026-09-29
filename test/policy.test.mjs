import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  Z90, HORIZON_MIN, erf, phi, returnCdf, hazard, habitValid, tStarMinutes, snap, resolveExpiry, maxPings,
} from "../src/policy.mjs";
import { GRIDS } from "../src/lanes.mjs";

const ORACLE_PATH = fileURLToPath(
  new URL("../research/existing-data-analysis/evidence/out/expiry-table.json", import.meta.url),
);
const oracle = JSON.parse(readFileSync(ORACLE_PATH, "utf8"));

const DEFAULT = { p: 0.81, mMin: 10.5, t90Min: 140 };
const LANE_IV = { "5m": 4.5, "30m": 27, "1h": 55 };
const LANE_R = { "5m": 0.08, "30m": 0.08, "1h": 0.025 };

const lane = (key, overrides = {}) => ({
  id: key,
  policy: "decide",
  intervalSec: LANE_IV[key] * 60,
  r: LANE_R[key],
  grid: GRIDS[key],
  ...overrides,
});

test("constants", () => {
  assert.equal(Z90, 1.2816);
  assert.equal(HORIZON_MIN, 1440);
});

test("erf/phi accuracy", () => {
  assert.ok(Math.abs(erf(0)) < 1e-15);
  assert.ok(Math.abs(erf(1) - 0.8427007929497149) < 1e-14);
  assert.ok(Math.abs(erf(-0.5) + 0.5204998778130465) < 1e-14);
  assert.ok(Math.abs(erf(3) - 0.9999779095030014) < 1e-14);
  assert.equal(erf(7), 1);
  assert.equal(erf(-7), -1);
  assert.ok(Math.abs(phi(0) - 0.5) < 1e-15);
  assert.ok(Math.abs(phi(1.2816) - 0.9) < 1e-4);
});

test("oracle: T* table reproduces every expiry-table.json entry (93)", () => {
  const laneKeys = Object.keys(oracle.lanes);
  assert.deepEqual(laneKeys.sort(), ["1h", "30m", "5m"]);
  let compared = 0;
  for (const key of laneKeys) {
    const entry = oracle.lanes[key];
    const iv = entry.intervalMin;
    const r0 = entry.defaultR;
    assert.equal(iv, LANE_IV[key]);
    assert.equal(r0, LANE_R[key]);

    assert.equal(tStarMinutes({ intervalMin: iv, r: r0, habit: DEFAULT }), entry.tStarMin, `${key} tStarMin`);
    compared++;

    for (const [r, expected] of Object.entries(entry.tStarByR)) {
      assert.equal(tStarMinutes({ intervalMin: iv, r: Number(r), habit: DEFAULT }), expected, `${key} tStarByR[${r}]`);
      compared++;
    }
    for (const [m, expected] of Object.entries(entry.tStarByMedian)) {
      const mMin = Number(m);
      const habit = { p: DEFAULT.p, mMin, t90Min: (mMin * DEFAULT.t90Min) / DEFAULT.mMin };
      assert.equal(tStarMinutes({ intervalMin: iv, r: r0, habit }), expected, `${key} tStarByMedian[${m}]`);
      compared++;
    }
    for (const [p, expected] of Object.entries(entry.tStarByLevel)) {
      const habit = { p: Number(p), mMin: DEFAULT.mMin, t90Min: DEFAULT.t90Min };
      assert.equal(tStarMinutes({ intervalMin: iv, r: r0, habit }), expected, `${key} tStarByLevel[${p}]`);
      compared++;
    }
  }
  assert.equal(compared, 93);
});

test("h oracles (tolerance 1e-5)", () => {
  const cases = [
    ["5m", 13.5, 0.081251], ["5m", 18, 0.066414],
    ["30m", 81, 0.080969], ["30m", 108, 0.059135],
    ["1h", 275, 0.031524], ["1h", 330, 0.023882],
  ];
  for (const [key, t, expected] of cases) {
    const h = hazard(t, LANE_IV[key], DEFAULT);
    assert.ok(Math.abs(h - expected) < 1e-5, `${key} h(${t}) = ${h}, want ${expected}`);
  }
});

test("hazard boundaries", () => {
  for (const t of [0, 1e-9, 1e7]) {
    const h = hazard(t, 4.5, DEFAULT);
    assert.ok(Number.isFinite(h) && h >= 0 && h <= 1, `h(${t}) = ${h}`);
  }
  assert.equal(hazard(0, 4.5, DEFAULT), returnCdf(4.5, DEFAULT));
  const h = hazard(1e9, 55, { p: 1, mMin: 10.5, t90Min: 140 });
  assert.ok(Number.isFinite(h) && h >= 0 && h <= 1);
  assert.equal(returnCdf(0, DEFAULT), 0);
  assert.equal(returnCdf(-3, DEFAULT), 0);
});

test("snap", () => {
  const cases = [
    [5, "5m", 0], [5.01, "5m", 10], [17.5, "5m", 15], [18, "5m", 20], [36, "5m", 30],
    [108, "30m", 120], [330, "1h", 300], [1440, "1h", 720],
  ];
  for (const [min, key, expected] of cases) assert.equal(snap(min, GRIDS[key]), expected, `snap(${min}, ${key})`);
});

test("habitValid", () => {
  assert.equal(habitValid(DEFAULT), true);
  assert.equal(habitValid({ p: 1, mMin: 1, t90Min: 2 }), true);
  assert.equal(habitValid({ p: 1.3, mMin: 10.5, t90Min: 140 }), false);
  assert.equal(habitValid({ p: 0, mMin: 10.5, t90Min: 140 }), false);
  assert.equal(habitValid({ p: 0.8, mMin: 140, t90Min: 140 }), false);
  assert.equal(habitValid({ p: 0.8, mMin: 0, t90Min: 140 }), false);
  assert.equal(habitValid({ p: NaN, mMin: 10.5, t90Min: 140 }), false);
  assert.equal(habitValid({ p: 0.8, mMin: 10.5, t90Min: Infinity }), false);
  assert.equal(habitValid(undefined), false);
});

test("resolveExpiry: auto", () => {
  assert.deepEqual(resolveExpiry({ lane: lane("5m"), habit: DEFAULT, setting: "auto" }), {
    formulaMin: 18, autoMin: 20, requestedMin: null, effectiveMin: 20, source: "auto",
  });
  assert.deepEqual(resolveExpiry({ lane: lane("30m"), habit: DEFAULT, setting: undefined }), {
    formulaMin: 108, autoMin: 120, requestedMin: null, effectiveMin: 120, source: "auto",
  });
  assert.deepEqual(resolveExpiry({ lane: lane("1h"), habit: DEFAULT, setting: "auto" }), {
    formulaMin: 330, autoMin: 300, requestedMin: null, effectiveMin: 300, source: "auto",
  });
});

test("resolveExpiry: manual", () => {
  assert.deepEqual(resolveExpiry({ lane: lane("5m"), habit: DEFAULT, setting: 44 }), {
    formulaMin: 18, autoMin: 20, requestedMin: 44, effectiveMin: 45, source: "manual",
  });
  assert.deepEqual(resolveExpiry({ lane: lane("1h"), habit: DEFAULT, setting: 0 }), {
    formulaMin: 330, autoMin: 300, requestedMin: 0, effectiveMin: 0, source: "manual",
  });
  const invalid = resolveExpiry({ lane: lane("5m"), habit: { p: 1.3, mMin: 10.5, t90Min: 140 }, setting: 60 });
  assert.equal(invalid.formulaMin, null);
  assert.equal(invalid.effectiveMin, 60);
  assert.equal(invalid.source, "manual");
});

test("resolveExpiry: invalid habit under auto gives E 0", () => {
  const habits = [
    { p: 1.3, mMin: 10.5, t90Min: 140 },
    { p: 0, mMin: 10.5, t90Min: 140 },
    { p: 0.8, mMin: 140, t90Min: 140 },
    { p: NaN, mMin: 10.5, t90Min: 140 },
  ];
  for (const habit of habits) {
    const res = resolveExpiry({ lane: lane("5m"), habit, setting: "auto" });
    assert.equal(res.effectiveMin, 0);
    assert.equal(res.source, "auto-invalid-habit");
    assert.equal(res.formulaMin, null);
  }
});

test("resolveExpiry: observe and invalid lanes give null", () => {
  assert.equal(resolveExpiry({ lane: lane("5m", { policy: "observe" }), habit: DEFAULT, setting: "auto" }), null);
  assert.equal(resolveExpiry({ lane: lane("5m", { policy: "invalid" }), habit: DEFAULT, setting: 20 }), null);
});

test("maxPings", () => {
  assert.equal(maxPings(0, 4.5), 0);
  assert.equal(maxPings(20, 4.5), 6);
  assert.equal(maxPings(300, 55), 7);
});
