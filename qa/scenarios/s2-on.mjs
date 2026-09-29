// S2 on: real senpi (RPC) + mock, keepwarm in mode on with a verified lane: it sends real warm requests.
//   node qa/scenarios/s2-on.mjs              hello -> episode 1 (>= 2 warm) -> again -> episode 2 (>= 2 warm) -> bye
//   node qa/scenarios/s2-on.mjs --inject 429 mock answers 429 to warm request 2 (and every later one, so an SDK retry cannot
//                                            succeed): expects warm_stop rate_limit and no warm request after it.
import { argValue, isPrefix, normMsg, runScenario, sessionAdditions, textOf } from "./lib.mjs";

const inject = argValue("--inject");
if (inject !== undefined && inject !== "429") {
  console.error(`s2-on: unsupported --inject ${inject} (only 429)`);
  process.exit(2);
}
const INTERVAL_MS = 4000; // qa lane override intervalSeconds

// --diag-no-tools: DIAGNOSTIC ONLY (result dir gets a -notools suffix, never an acceptance run). It starts senpi with
// --no-tools so the real and the warm request carry the same (empty) tool list; the checks are unchanged.
const noTools = process.argv.includes("--diag-no-tools");
const suffix = noTools ? "-notools" : "";
const extraArgs = noTools ? ["--no-tools"] : [];

// Wait until two ping records of this episode exist (each ping record is written after its response),
// failing fast with the reason when warming stops first.
async function twoPings(s, episode, ms = 30000) {
  const pings = new Set();
  const hit = await s.waitForRecord((r) => {
    if (r.type === "ping" && r.episode === episode && r.ok === true) pings.add(r.tick);
    return pings.size >= 2 || (r.type === "warm_stop" && r.episode === episode);
  }, ms);
  if (pings.size < 2) {
    const bad = s.records("ping").filter((p) => p.episode === episode && !p.ok).map((p) => p.error?.kind);
    throw new Error(`warming stopped before 2 ok pings: warm_stop reason=${hit.reason} failed ping kinds=${JSON.stringify(bad)}`);
  }
  return pings.size;
}

if (inject) {
  const warm = {};
  for (let n = 2; n <= 12; n++) warm[n] = { status: 429 };
  await runScenario({ name: `s2-on-429${suffix}`, config: "config-on", behavior: "behavior-fast", mockScript: { warm }, extraArgs }, async (s) => {
    await s.turn("hello");
    const open = await s.waitForRecord((r) => r.type === "episode_open", 20000);
    const stop = await s.waitForRecord((r) => r.type === "warm_stop" && r.episode === open.episode, 40000);
    const warmsAtStop = s.mock.requests().filter((r) => r.kind === "warm").length;
    s.check("warm_stop reason rate_limit", stop.reason === "rate_limit", `reason=${stop.reason}`);
    const pings = s.records("ping").filter((r) => r.episode === open.episode);
    const failed = pings.find((p) => p.ok === false);
    s.check("failed ping recorded with error kind rate_limit / status 429", failed?.error?.kind === "rate_limit" && failed.error.status === 429, JSON.stringify(failed?.error ?? null));
    s.check("first ping ok and a cache hit before the 429", pings[0]?.ok === true && pings[0]?.hit === true, JSON.stringify(pings.map((p) => ({ ok: p.ok, hit: p.hit }))));

    // No further warm decision, ping or request during 2 intervals after the stop.
    const after = await s.expectNoRecord((r) => (r.type === "decision" || r.type === "ping") && r.ts > stop.ts, 2 * INTERVAL_MS + 1000);
    const warmsLater = s.mock.requests().filter((r) => r.kind === "warm").length;
    s.check("zero warm decisions/pings/requests after warm_stop", after.absent && warmsLater === warmsAtStop, `warm requests at stop=${warmsAtStop} later=${warmsLater} recordHit=${after.hit ? JSON.stringify(after.hit) : "none"}`);

    await s.turn("again");
    const close = await s.waitForRecord((r) => r.type === "episode_close" && r.episode === open.episode, 20000);
    s.check("episode_close human_return input:rpc after the stop", close.kind === "human_return" && close.source === "input:rpc", `kind=${close.kind} source=${close.source}`);
    const entries = s.sessionEntries();
    const sa = sessionAdditions(entries);
    s.check("session JSONL: no keepwarm-added entry, only user/assistant messages", sa.additions.length === 0, `entries=${entries.length} keepwarmAdditions=${sa.additions.length} hostCustomTypes=${sa.hostCustomTypes.join(",")}`);
  });
} else {
  await runScenario({ name: `s2-on${suffix}`, config: "config-on", behavior: "behavior-fast", extraArgs }, async (s) => {
    await s.turn("hello");
    const ep1 = await s.waitForRecord((r) => r.type === "episode_open", 20000);
    await twoPings(s, ep1.episode);
    await s.turn("again");
    const close1 = await s.waitForRecord((r) => r.type === "episode_close" && r.episode === ep1.episode, 20000);
    const ep2 = await s.waitForRecord((r) => r.type === "episode_open" && r.episode !== ep1.episode, 20000);
    await twoPings(s, ep2.episode);
    await s.turn("bye");
    const close2 = await s.waitForRecord((r) => r.type === "episode_close" && r.episode === ep2.episode, 20000);

    s.check("both episodes closed by human_return input:rpc", [close1, close2].every((c) => c.kind === "human_return" && c.source === "input:rpc"), `${close1.kind}/${close1.source}, ${close2.kind}/${close2.source}`);
    s.check("episode_open in mode on, verified lane, warmPath warmPromptCache", [ep1, ep2].every((e) => e.mode === "on" && e.verified === true && e.warmPath === "warmPromptCache"), JSON.stringify({ mode: ep1.mode, verified: ep1.verified, warmPath: ep1.warmPath }));

    const reqs = s.mock.requests();
    const warms = reqs.filter((r) => r.kind === "warm");
    const warmDecisions = s.records("decision").filter((r) => r.action === "warm");
    const per = (id) => warmDecisions.filter((d) => d.episode === id).length;
    s.check("(a) mock warm requests == warm decisions, >= 2 per episode", warms.length === warmDecisions.length && per(ep1.episode) >= 2 && per(ep2.episode) >= 2, `mockWarm=${warms.length} decisions=${warmDecisions.length} ep1=${per(ep1.episode)} ep2=${per(ep2.episode)}`);

    // (b) each warm mirrors the chat before it: system/tools deep-equal, chat messages are a prefix of warm messages.
    const problems = [];
    let lastChat = null;
    for (const r of reqs) {
      if (r.kind === "chat") {
        lastChat = r;
        continue;
      }
      if (r.kind !== "warm") continue;
      if (!lastChat) {
        problems.push(`warm ${r.n}: no preceding chat`);
        continue;
      }
      if (JSON.stringify(r.body.system) !== JSON.stringify(lastChat.body.system)) problems.push(`warm ${r.n}: system differs from chat ${lastChat.n}`);
      if (JSON.stringify(r.body.tools) !== JSON.stringify(lastChat.body.tools)) problems.push(`warm ${r.n}: tools differ from chat ${lastChat.n}`);
      const a = lastChat.body.messages.map(normMsg);
      const b = r.body.messages.map(normMsg);
      if (!isPrefix(a, b)) problems.push(`warm ${r.n}: chat ${lastChat.n} messages (${a.length}) are not a prefix of warm messages (${b.length})`);
    }
    s.check("(b) warm system/tools deep-equal the preceding chat; chat messages are a prefix of warm messages", warms.length > 0 && problems.length === 0, problems.slice(0, 4).join(" | ") || `${warms.length} warm requests checked`);

    // Episode 2 warms carry the whole two-turn history (review B2).
    const ep2Warms = warms.filter((w) => w.n > per(ep1.episode) && w.body.messages.some((m) => textOf(m).includes("again")));
    const fullHistory = ep2Warms.length >= 2 && ep2Warms.every((w) => {
      const userTexts = w.body.messages.filter((m) => m.role === "user").map(textOf);
      return userTexts.some((t) => t.includes("hello")) && userTexts.some((t) => t.includes("again")) && w.body.messages.filter((m) => m.role === "assistant").length >= 1;
    });
    s.check("episode 2 warm requests carry both turns' history (hello + again)", fullHistory, `ep2 warms with 'again'=${ep2Warms.length}`);

    s.check("(c) warm requests: max_tokens 0 and no stream", warms.length > 0 && warms.every((w) => w.body.max_tokens === 0 && !w.body.stream), JSON.stringify([...new Set(warms.map((w) => `max_tokens=${w.body.max_tokens} stream=${w.body.stream}`))]));

    const pings = s.records("ping");
    s.check("(d) every ping ok and a cache hit, ping count == warm requests", pings.length === warms.length && pings.every((p) => p.ok === true && p.hit === true), `pings=${pings.length} warms=${warms.length} notOkHit=${pings.filter((p) => !(p.ok && p.hit)).length}`);

    const entries = s.sessionEntries();
    const messages = entries.filter((e) => e.type === "message");
    const sa = sessionAdditions(entries);
    s.check("(e) session JSONL has no keepwarm-added entry and exactly 6 user/assistant messages", sa.additions.length === 0 && messages.length === 6, `entries=${entries.length} messages=${messages.length} keepwarmAdditions=${sa.additions.length} hostCustomTypes=${sa.hostCustomTypes.join(",")}`);
  });
}
