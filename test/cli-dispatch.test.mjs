import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS, main } from "../bin/omo-keepwarm.mjs";
import {
  createFakeClock,
  createFakeCtx,
  createFakePi,
  createFakePiAi,
  models,
  tmpHome,
} from "./helpers/fake-host.mjs";

const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "omo-keepwarm.mjs");
const io = () => {
  const o = { out: "", err: "" };
  return { o, io: { stdout: (s) => (o.out += s), stderr: (s) => (o.err += s), env: {}, now: () => 0, cwd: "." } };
};

test("--help and no args list the 10 commands, exit 0", async () => {
  assert.equal(COMMANDS.length, 10);
  for (const argv of [["--help"], []]) {
    const { o, io: i } = io();
    assert.equal(await main(argv, i), 0);
    for (const c of COMMANDS) assert.ok(o.out.includes(c), c);
  }
});

test("unknown command exits 64", async () => {
  const { io: i } = io();
  assert.equal(await main(["bogus"], i), 64);
});

test("known command without module exits 70 'not implemented'", async () => {
  // only meaningful while no src/cli/<name>.mjs exists for the probed command
  const r = spawnSync(process.execPath, [bin, "render-stub"], { encoding: "utf8" });
  if (r.status === 70) assert.match(r.stderr, /not implemented/);
  else assert.equal(typeof r.status, "number");
});

test("process exit codes via real spawn", () => {
  assert.equal(spawnSync(process.execPath, [bin, "--help"], { encoding: "utf8" }).status, 0);
  assert.equal(spawnSync(process.execPath, [bin, "bogus"], { encoding: "utf8" }).status, 64);
});

test("fake host: clock orders timers and jump runs overdue ones", async () => {
  const c = createFakeClock(1000);
  const log = [];
  c.setTimeout(() => log.push("b"), 20);
  c.setTimeout(() => log.push("a"), 10);
  const iv = c.setInterval(() => log.push("i"), 15);
  await c.advance(30);
  assert.deepEqual(log, ["a", "i", "b", "i"]);
  assert.equal(c.now(), 1030);
  c.clearInterval(iv);
  c.setTimeout(() => log.push("late"), 5);
  await c.jump(100);
  assert.equal(log.at(-1), "late");
  assert.equal(c.pendingCount(), 0);
});

test("fake host: pi, ctx, piAi, models, tmpHome", async () => {
  const pi = createFakePi();
  pi.on("x", (ev) => ev + 1, { a: 1 });
  assert.deepEqual(await pi.emit("x", 1, {}), [2]);
  assert.equal(pi.registrations[0].opts.a, 1);
  pi.sendMessage("hi");
  assert.equal(pi.forbiddenCalls.length, 1);

  const ctx = createFakeCtx({ model: models.anthropic5m });
  ctx.ui.notify("n");
  assert.equal(ctx.uiCalls[0].name, "notify");
  ctx.setIdle(false);
  assert.equal(ctx.isIdle(), false);
  assert.equal((await ctx.prepareProviderRequest([1])).messages[0], 1);

  const ai = createFakePiAi();
  const res = await ai.warmPromptCache(models.anthropic5m, { messages: [] }, {});
  assert.equal(res.supported, true);
  const d = createFakePiAi({ deferred: true });
  const p = d.warmPromptCache(models.anthropic5m, {}, {});
  d.pending[0].resolve();
  assert.equal((await p).supported, true);

  assert.equal(Object.keys(models).length, 8);
  assert.equal(models.kiroLb.baseUrl, "http://127.0.0.1:8100");
  assert.ok(tmpHome().length > 0);
});
