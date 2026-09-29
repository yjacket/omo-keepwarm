import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { createLedger, sumDay } from "../src/ledger.mjs";
import { layout, localDate } from "../src/paths.mjs";
import { readJsonLines } from "../src/fsx.mjs";
import { createFakeClock, tmpHome } from "./helpers/fake-host.mjs";

function setup(startMs) {
  const home = tmpHome();
  const clock = createFakeClock(startMs);
  return { home, clock, ledger: createLedger({ home, now: clock.now }) };
}

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test("recordSpend appends one JSON line per call", () => {
  const { home, clock, ledger } = setup(new Date(2026, 5, 15, 12, 0).getTime());
  ledger.recordSpend({ session: "s1", episode: "s1:1", usd: 0.01, virtual: false });
  ledger.recordSpend({ session: "s1", episode: "s1:1", usd: 0.02, virtual: true });
  const lines = readJsonLines(layout(home).spendFile(localDate(clock.now())));
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], {
    v: 1,
    ts: new Date(clock.now()).toISOString(),
    session: "s1",
    episode: "s1:1",
    usd: 0.01,
    virtual: false,
  });
  assert.equal(lines[1].virtual, true);
});

test("virtual and real spend are summed separately", () => {
  const { ledger } = setup(new Date(2026, 5, 15, 12, 0).getTime());
  ledger.recordSpend({ session: "s1", episode: "s1:1", usd: 0.1, virtual: false });
  ledger.recordSpend({ session: "s1", episode: "s1:1", usd: 0.25, virtual: true });
  ledger.recordSpend({ session: "s2", episode: "s2:1", usd: 0.05, virtual: false });
  close(ledger.spendToday({ virtual: false }), 0.15);
  close(ledger.spendToday({ virtual: true }), 0.25);
  close(ledger.spendToday(), 0.15);
});

test("per-episode totals", () => {
  const { ledger } = setup(new Date(2026, 5, 15, 12, 0).getTime());
  ledger.recordSpend({ session: "s1", episode: "s1:1", usd: 0.1, virtual: false });
  ledger.recordSpend({ session: "s1", episode: "s1:2", usd: 0.3, virtual: false });
  ledger.recordSpend({ session: "s1", episode: "s1:1", usd: 0.2, virtual: false });
  ledger.recordSpend({ session: "s1", episode: "s1:1", usd: 0.7, virtual: true });
  close(ledger.spendEpisode("s1:1", { virtual: false }), 0.3);
  close(ledger.spendEpisode("s1:1", { virtual: true }), 0.7);
  close(ledger.spendEpisode("s1:2", { virtual: false }), 0.3);
  close(ledger.spendEpisode("nope", { virtual: false }), 0);
});

test("local midnight splits daily totals; episode total spans the boundary", async () => {
  const { home, clock, ledger } = setup(new Date(2026, 2, 9, 23, 59, 0).getTime());
  ledger.recordSpend({ session: "s1", episode: "s1:1", usd: 0.4, virtual: false });
  ledger.recordDay({ episodes: 1, humanReturns: 1, wouldWarm: 0, pings: 2, usd: 0.4 });
  await clock.jump(2 * 60_000);
  assert.equal(localDate(clock.now()), "2026-03-10");
  close(ledger.spendToday({ virtual: false }), 0);
  ledger.recordSpend({ session: "s1", episode: "s1:1", usd: 0.1, virtual: false });
  ledger.recordDay({ episodes: 1, humanReturns: 0, wouldWarm: 3, pings: 0, usd: 0.1 });
  close(ledger.spendToday({ virtual: false }), 0.1);
  close(ledger.spendEpisode("s1:1", { virtual: false }), 0.5);
  const files = readdirSync(dirname(layout(home).spendFile("x"))).sort();
  assert.deepEqual(files, ["day-2026-03-09.jsonl", "day-2026-03-10.jsonl", "spend-2026-03-09.jsonl", "spend-2026-03-10.jsonl"]);
  assert.deepEqual(sumDay(home, "2026-03-09"), { episodes: 1, humanReturns: 1, wouldWarm: 0, pings: 2, usd: 0.4 });
  assert.deepEqual(sumDay(home, "2026-03-10"), { episodes: 1, humanReturns: 0, wouldWarm: 3, pings: 0, usd: 0.1 });
});

test("broken lines are ignored", () => {
  const { home, clock, ledger } = setup(new Date(2026, 5, 15, 12, 0).getTime());
  const date = localDate(clock.now());
  ledger.recordSpend({ session: "s1", episode: "s1:1", usd: 0.1, virtual: false });
  appendFileSync(layout(home).spendFile(date), '{"usd": 5, "virt\n{bad\nnull\n"x"\n');
  ledger.recordSpend({ session: "s1", episode: "s1:1", usd: 0.2, virtual: false });
  close(ledger.spendToday({ virtual: false }), 0.3);
  close(ledger.spendEpisode("s1:1", { virtual: false }), 0.3);
  ledger.recordDay({ episodes: 2, humanReturns: 1, wouldWarm: 1, pings: 1, usd: 0.1 });
  appendFileSync(layout(home).dayFile(date), '{"episodes":\n');
  ledger.recordDay({ episodes: 1, humanReturns: 1, wouldWarm: 0, pings: 0, usd: 0 });
  assert.deepEqual(sumDay(home, date), { episodes: 3, humanReturns: 2, wouldWarm: 1, pings: 1, usd: 0.1 });
});
