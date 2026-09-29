import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createSafe } from "../src/safe.mjs";
import { tmpHome } from "./helpers/fake-host.mjs";

const mk = (extra = {}) => {
  const logFile = join(tmpHome(), "logs", "errors.log");
  const disabled = [];
  const safe = createSafe({ logFile, now: () => 1000, onDisable: (i) => disabled.push(i), ...extra });
  return { safe, logFile, disabled };
};
const lines = (f) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : []);

test("passes through return values", async () => {
  const { safe } = mk();
  assert.equal(safe.wrap("a", (x) => x + 1)(1), 2);
  assert.equal(await safe.wrap("b", async (x) => x + 1)(1), 2);
});

test("catches sync and async errors, logs one line per (name,message)", async () => {
  const { safe, logFile } = mk();
  const f = safe.wrap("h", () => {
    throw new Error("boom");
  });
  f();
  f();
  const g = safe.wrap("h2", async () => {
    throw new Error("boom");
  });
  assert.equal(await g(), undefined);
  assert.equal(lines(logFile).length, 2);
  assert.equal(safe.errorCount(), 3);
  assert.equal(safe.disabled(), false);
});

test("disables once after maxDistinctErrors distinct errors; wrap becomes no-op", () => {
  const { safe, disabled } = mk({ maxDistinctErrors: 3 });
  for (let i = 0; i < 5; i++) {
    safe.wrap("h", () => {
      throw new Error(`e${i}`);
    })();
  }
  assert.equal(safe.disabled(), true);
  assert.equal(disabled.length, 1);
  let ran = false;
  safe.wrap("z", () => void (ran = true))();
  assert.equal(ran, false);
});

test("stale extension generation disables immediately and is not logged as an error", () => {
  const { safe, disabled, logFile } = mk();
  safe.wrap("h", () => {
    throw new Error("This Stale Extension Generation was replaced");
  })();
  assert.equal(safe.disabled(), true);
  assert.equal(disabled.length, 1);
  assert.deepEqual(lines(logFile), []);
});
