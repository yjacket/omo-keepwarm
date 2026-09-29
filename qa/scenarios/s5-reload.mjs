// S5 reload: a real senpi (RPC) reloads its extensions while an away episode is open.
//   hello -> episode_open -> RPC reload -> marker reload, segment_open reason reload, SAME episode id,
//   no episode_close, no human_return -> prompt "again" -> that same episode closes as human_return input:rpc.
import { runScenario } from "./lib.mjs";

await runScenario({ name: "s5-reload", taskDir: "task-12", config: "config-shadow", behavior: "behavior-fast" }, async (s) => {
  await s.turn("hello");
  const open = await s.waitForRecord((r) => r.type === "episode_open", 20000);
  const seg1 = await s.waitForRecord((r) => r.type === "segment_open" && r.episode === open.episode, 10000);
  s.check("episode_open recorded before the reload", Boolean(open.episode), `episode=${open.episode} segment=${seg1.segment} reason=${seg1.reason}`);

  const res = await s.senpi.send({ type: "reload" }, { timeoutMs: 60000 });
  s.check("RPC reload succeeded and was not cancelled", res?.success === true && res.data?.cancelled === false, JSON.stringify(res));

  const marker = await s.waitForRecord((r) => r.type === "marker" && r.kind === "reload" && r.episode === open.episode, 30000).catch((e) => e);
  s.check("marker kind reload written for the same episode", !(marker instanceof Error), marker instanceof Error ? marker.message : JSON.stringify(marker));

  const reloadSeg = await s.waitForRecord((r) => r.type === "segment_open" && r.reason === "reload", 30000).catch((e) => e);
  const okSeg = !(reloadSeg instanceof Error);
  s.check(
    "segment_open reason reload, same episode id, next segment number",
    okSeg && reloadSeg.episode === open.episode && reloadSeg.segment === seg1.segment + 1,
    okSeg ? `episode=${reloadSeg.episode} segment=${reloadSeg.segment} (was ${seg1.segment}) eligible=${reloadSeg.eligible} disabledReason=${reloadSeg.disabledReason}` : reloadSeg.message,
  );

  const sessionRec = s.records("session").find((r) => r.reason === "reload");
  s.check("session record reason reload with restored true", sessionRec?.restored === true, JSON.stringify(sessionRec ?? null));

  const closesBefore = s.records("episode_close");
  const humanBefore = closesBefore.filter((r) => r.kind === "human_return");
  const opens = s.records("episode_open");
  s.check("no episode_close and no human_return after the reload; still one episode", closesBefore.length === 0 && humanBefore.length === 0 && opens.length === 1, `closes=${closesBefore.length} humanReturns=${humanBefore.length} episode_opens=${opens.length}`);

  await s.turn("again");
  const close = await s.waitForRecord((r) => r.type === "episode_close" && r.episode === open.episode, 20000).catch((e) => e);
  const okClose = !(close instanceof Error);
  s.check(
    "the same episode closes as human_return input:rpc after the reload",
    okClose && close.kind === "human_return" && close.source === "input:rpc",
    okClose ? `episode=${close.episode} kind=${close.kind} source=${close.source} segments=${close.segments}` : close.message,
  );
  s.check("closed episode counted both segments (before and after the reload)", okClose && close.segments >= 2, okClose ? `segments=${close.segments}` : "no close");
  s.check("exactly one human_return over the whole run", s.records("episode_close").filter((r) => r.kind === "human_return").length === 1, `human_return closes=${s.records("episode_close").filter((r) => r.kind === "human_return").length}`);
  s.check("shadow mode: zero warm requests on the mock", s.mock.requests().filter((r) => r.kind === "warm").length === 0, `warm=${s.mock.requests().filter((r) => r.kind === "warm").length}`);
});
