import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendJsonLine, atomicWriteJson, ensureDir, readJsonLines, readJsonSafe } from "../src/fsx.mjs";
import { tmpHome } from "./helpers/fake-host.mjs";

test("readJsonSafe returns undefined for missing and broken files, strips BOM", () => {
  const d = tmpHome();
  assert.equal(readJsonSafe(join(d, "nope.json")), undefined);
  writeFileSync(join(d, "bad.json"), "{oops");
  assert.equal(readJsonSafe(join(d, "bad.json")), undefined);
  writeFileSync(join(d, "bom.json"), "\uFEFF{\"a\":1}");
  assert.deepEqual(readJsonSafe(join(d, "bom.json")), { a: 1 });
});

test("atomicWriteJson writes, overwrites, creates parents, leaves no tmp files", () => {
  const d = tmpHome();
  const p = join(d, "x", "y.json");
  atomicWriteJson(p, { a: 1 });
  atomicWriteJson(p, { a: 2 });
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), { a: 2 });
  assert.deepEqual(readdirSync(join(d, "x")), ["y.json"]);
});

test("appendJsonLine + readJsonLines skip broken lines", () => {
  const d = tmpHome();
  const p = join(d, "l", "a.jsonl");
  appendJsonLine(p, { n: 1 });
  writeFileSync(p, readFileSync(p, "utf8") + "not json\n");
  appendJsonLine(p, { n: 2 });
  assert.deepEqual(readJsonLines(p), [{ n: 1 }, { n: 2 }]);
  assert.deepEqual(readJsonLines(join(d, "missing")), []);
});

test("ensureDir is idempotent", () => {
  const d = tmpHome();
  ensureDir(join(d, "a", "b"));
  ensureDir(join(d, "a", "b"));
  assert.deepEqual(readdirSync(join(d, "a")), ["b"]);
});
