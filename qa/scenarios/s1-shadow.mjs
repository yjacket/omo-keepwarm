// S1 shadow: real senpi (RPC) + mock, keepwarm in shadow mode. It decides but never sends a warm request.
// hello -> episode_open / segment_open(eligible) / would_warm >= 2 / expire -> again -> episode_close human_return.
import { join } from "node:path";
import { readJsonSafeFile, runScenario, sessionAdditions } from "./lib.mjs";

await runScenario({ name: "s1-shadow", config: "config-shadow", behavior: "behavior-fast" }, async (s) => {
  await s.turn("hello");
  const open = await s.waitForRecord((r) => r.type === "episode_open", 20000);
  const seg = await s.waitForRecord((r) => r.type === "segment_open" && r.episode === open.episode, 20000);
  s.check("episode_open recorded in shadow mode", open.mode === "shadow" && open.lane === "anthropic-api", `mode=${open.mode} lane=${open.lane} expiry=${JSON.stringify(open.expiry)}`);
  s.check("segment_open eligible", seg.eligible === true, `eligible=${seg.eligible} disabledReason=${seg.disabledReason}`);

  // keepwarm's own timers: wait for the expire decision (60 s bound; the fixture expiry is 36 s).
  let expired = null;
  try {
    expired = await s.waitForRecord((r) => r.type === "decision" && r.episode === open.episode && r.action === "expire", 60000);
  } catch (e) {
    s.check("expire decision within 60 s", false, e.message);
  }
  const wouldWarm = s.records("decision").filter((r) => r.episode === open.episode && r.action === "would_warm");
  if (expired) s.check("expire decision within 60 s", true, `tAwayMin=${expired.tAwayMin}`);
  s.check("would_warm >= 2 before expiry", wouldWarm.length >= 2, `would_warm=${wouldWarm.length}`);

  // (d) global status, read while the session is alive.
  const global = readJsonSafeFile(join(s.home, "status", "_global.json"));
  s.check("(d) _global status mode shadow and staleAfter > now", global?.detail?.mode === "shadow" && global.staleAfter > Date.now(), JSON.stringify({ mode: global?.detail?.mode, staleAfter: global?.staleAfter, now: Date.now() }));

  await s.turn("again");
  const close = await s.waitForRecord((r) => r.type === "episode_close" && r.episode === open.episode, 20000);
  s.check("(a) episode_close kind human_return, source input:rpc", close.kind === "human_return" && close.source === "input:rpc", `kind=${close.kind} source=${close.source}`);
  s.check("episode_close counts would_warm and no real pings", close.wouldWarm >= 2 && close.pings === 0, `wouldWarm=${close.wouldWarm} pings=${close.pings} expired=${close.expired}`);

  const reqs = s.mock.requests();
  const chats = reqs.filter((r) => r.kind === "chat");
  const warms = reqs.filter((r) => r.kind === "warm");
  s.check("(b) mock saw 0 warm requests and 2 chat requests", warms.length === 0 && chats.length === 2, `chat=${chats.length} warm=${warms.length} other=${reqs.filter((r) => r.kind === "other").length}`);

  const entries = s.sessionEntries();
  const { additions, hostCustomTypes, messages } = sessionAdditions(entries);
  s.check("(c) session JSONL: no keepwarm-added entry, message roles only user/assistant, 4 messages", additions.length === 0 && messages === 4, `entries=${entries.length} keepwarmAdditions=${additions.length} messages=${messages} hostCustomTypes=${hostCustomTypes.join(",")}`);
});
