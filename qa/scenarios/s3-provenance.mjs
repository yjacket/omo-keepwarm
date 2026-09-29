// S3 provenance (shadow): real senpi (RPC). One open episode absorbs five automated turns; "." closes it as a
// manual continue; "hi" closes the next one as a human return.
//   4 x send_custom_message (goal-continuation, omo-health, senpi-terminal:restore-digest, senpi.todo-owed; triggerTurn true)
//   prompt "kw-qa-ext-input" (helper answers handled, then sendUserMessage) -> marker input_handled + turn input:extension
//   prompt "."  -> episode_close human_return manual_continue      prompt "hi" -> episode 2 closes human_return input:rpc
//   omo-keepwarm report --json (same home): humanReturns 2, automated turns 5
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO, runScenario } from "./lib.mjs";

const CUSTOMS = [
  { customType: "goal-continuation", display: false },
  { customType: "omo-health", display: true },
  { customType: "senpi-terminal:restore-digest", display: false },
  { customType: "senpi.todo-owed", display: false },
];

await runScenario({ name: "s3-provenance", taskDir: "task-12", config: "config-shadow", behavior: "behavior-fast" }, async (s) => {
  await s.turn("hello");
  const open1 = await s.waitForRecord((r) => r.type === "episode_open", 20000);
  const ep1 = open1.episode;
  s.check("episode 1 opened after the human turn", Boolean(ep1), `episode=${ep1}`);

  // Waits until n segments with reason after_turn exist for the episode (the settle after an automated turn).
  const settled = (n) =>
    s.waitForRecord((r) => (r.type === "segment_open" && r.episode === ep1 && r.reason === "after_turn" ? (settled.seen.add(r.segment), settled.seen.size >= n) : false), 30000);
  settled.seen = new Set();

  let n = 0;
  for (const c of CUSTOMS) {
    n += 1;
    const from = s.senpi.events.length;
    const res = await s.senpi.send({ type: "send_custom_message", customType: c.customType, content: `kw qa ${c.customType}`, display: c.display, triggerTurn: true });
    if (!res?.success) throw new Error(`send_custom_message ${c.customType} rejected: ${JSON.stringify(res)}`);
    await s.senpi.waitForEvent((e) => e.type === "agent_end", 60000, { from });
    const turn = await s.waitForRecord((r) => r.type === "turn" && r.episode === ep1 && r.source === c.customType, 20000).catch((e) => e);
    const ok = !(turn instanceof Error);
    s.check(`custom message ${c.customType} (display ${c.display}) -> turn automated, source=customType, episode kept`, ok && turn.kind === "automated" && turn.episode === ep1, ok ? `kind=${turn.kind} source=${turn.source} episode=${turn.episode}` : turn.message);
    await settled(n);
  }

  // Extension input: handled, then an extension-sent user message.
  const fromExt = s.senpi.events.length;
  const extRes = await s.senpi.send({ type: "prompt", message: "kw-qa-ext-input" });
  if (!extRes?.success) throw new Error(`prompt kw-qa-ext-input rejected: ${JSON.stringify(extRes)}`);
  await s.senpi.waitForEvent((e) => e.type === "agent_end", 60000, { from: fromExt });
  const marker = await s.waitForRecord((r) => r.type === "marker" && r.episode === ep1 && r.kind === "input_handled", 20000).catch((e) => e);
  s.check('prompt "kw-qa-ext-input" -> marker input_handled in the same episode', !(marker instanceof Error), marker instanceof Error ? marker.message : JSON.stringify(marker));
  const extTurn = await s.waitForRecord((r) => r.type === "turn" && r.episode === ep1 && r.source === "input:extension", 20000).catch((e) => e);
  const okExt = !(extTurn instanceof Error);
  s.check("extension-sent user message -> turn automated input:extension, episode kept", okExt && extTurn.kind === "automated", okExt ? `kind=${extTurn.kind} source=${extTurn.source}` : extTurn.message);
  await settled(5);

  // Marker before turn, and nothing closed the episode so far.
  const recs = s.records();
  const iMarker = recs.findIndex((r) => r.type === "marker" && r.kind === "input_handled");
  const iExtTurn = recs.findIndex((r) => r.type === "turn" && r.source === "input:extension");
  s.check("marker input_handled precedes the input:extension turn", iMarker >= 0 && iExtTurn > iMarker, `marker@${iMarker} turn@${iExtTurn}`);
  const turns1 = s.records("turn").filter((r) => r.episode === ep1);
  s.check(
    "episode 1 still open with exactly 5 automated turns in customType/input order",
    s.records("episode_close").length === 0 && turns1.length === 5 && turns1.every((t) => t.kind === "automated") &&
      JSON.stringify(turns1.map((t) => t.source)) === JSON.stringify([...CUSTOMS.map((c) => c.customType), "input:extension"]),
    `closes=${s.records("episode_close").length} turns=${JSON.stringify(turns1.map((t) => `${t.kind}:${t.source}`))}`,
  );

  // "." -> manual continue closes episode 1, then a new episode opens; "hi" closes it.
  await s.turn(".");
  const close1 = await s.waitForRecord((r) => r.type === "episode_close" && r.episode === ep1, 20000).catch((e) => e);
  const ok1 = !(close1 instanceof Error);
  s.check('prompt "." -> episode_close human_return manual_continue', ok1 && close1.kind === "human_return" && close1.source === "manual_continue", ok1 ? `kind=${close1.kind} source=${close1.source} detail=${close1.detail}` : close1.message);
  const open2 = await s.waitForRecord((r) => r.type === "episode_open" && r.episode !== ep1, 30000).catch((e) => e);
  const ok2 = !(open2 instanceof Error);
  s.check("a new episode opens after the manual continue settles", ok2, ok2 ? `episode=${open2.episode}` : open2.message);
  await s.turn("hi");
  const close2 = ok2 ? await s.waitForRecord((r) => r.type === "episode_close" && r.episode === open2.episode, 20000).catch((e) => e) : new Error("no episode 2");
  const okc2 = !(close2 instanceof Error);
  s.check('prompt "hi" -> episode_close human_return input:rpc', okc2 && close2.kind === "human_return" && close2.source === "input:rpc", okc2 ? `kind=${close2.kind} source=${close2.source}` : close2.message);

  // CLI report over the same home.
  const rep = spawnSync(process.execPath, [join(REPO, "bin", "omo-keepwarm.mjs"), "report", "--json"], {
    env: { ...process.env, ...s.kwEnv }, encoding: "utf8", windowsHide: true,
  });
  writeFileSync(join(s.evid, "report.json"), rep.stdout ?? "");
  let report = null;
  try {
    report = JSON.parse(rep.stdout);
  } catch {
    // reported by the check below
  }
  const total = report?.total;
  const automated = Object.values(total?.automatedTurnSources ?? {}).reduce((a, b) => a + b, 0);
  s.check(
    "report --json: humanReturns 2 and automated turns 5",
    rep.status === 0 && total?.humanReturns === 2 && automated === 5,
    `exit=${rep.status} humanReturns=${total?.humanReturns} automatedTurnSources=${JSON.stringify(total?.automatedTurnSources)} closeSources=${JSON.stringify(total?.closeSources)}`,
  );
  s.check("shadow mode: zero warm requests on the mock", s.mock.requests().filter((r) => r.kind === "warm").length === 0, `warm=${s.mock.requests().filter((r) => r.kind === "warm").length}`);
});
