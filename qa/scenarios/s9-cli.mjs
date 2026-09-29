// S9 CLI: the omo-keepwarm CLI against a real keepwarm home, and expiry/habit changes reaching a RUNNING senpi.
//   Phase 1 (fast lane override, shadow): a short real session (hello / again) gives status, report, calibrate, expiry, habit
//   something to read. Phase 2 (lane override REMOVED, real anthropic-api:5m lane): in ONE senpi process,
//   `expiry set anthropic-api:5m 20m` changes the NEXT episode_open (expiry.source manual, effectiveMin 20) and
//   `habit set ...` changes the one after (habit.source manual), with no reload.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO, startScenario } from "./lib.mjs";

const NAME = "s9-cli";
const CONFIG_STAT_EVERY_MS = 5000; // src/config.mjs createConfigSource statEveryMs default
const t0 = Date.now();
const s = await startScenario({ name: NAME, taskDir: "task-12", config: "config-shadow", behavior: "behavior-fast" });
const cliLog = [];

const cli = (...args) => {
  const r = spawnSync(process.execPath, [join(REPO, "bin", "omo-keepwarm.mjs"), ...args], {
    env: { ...process.env, ...s.kwEnv, OMO_CODING_AGENT_DIR: s.senpi?.agentDir ?? s.tmp, SENPI_CODING_AGENT_DIR: s.senpi?.agentDir ?? s.tmp },
    encoding: "utf8",
    windowsHide: true,
    cwd: s.tmp,
  });
  cliLog.push(`$ omo-keepwarm ${args.join(" ")}\n[exit ${r.status}]\n${r.stdout}${r.stderr ? `[stderr]\n${r.stderr}` : ""}`);
  return r;
};
const json = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
// The config file is re-stat'ed at most every CONFIG_STAT_EVERY_MS by the running extension, so the next episode
// can only see a change made at least that long after the extension's last config read (an episode_open reads it).
// This waits for that product-defined window (computed from the record timestamp), it is not a guessed pause.
const untilAfter = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms - Date.now())));

try {
  if (s.startError) throw s.startError;

  // ---- phase 1: a short real session --------------------------------------------
  await s.turn("hello");
  const open1 = await s.waitForRecord((r) => r.type === "episode_open", 30000);
  let wouldWarm = 0;
  await s.waitForRecord(() => {
    wouldWarm = s.records("decision").filter((d) => d.episode === open1.episode && d.action === "would_warm").length;
    return wouldWarm >= 2;
  }, 60000);
  s.check("phase 1: shadow episode produced >= 2 would_warm decisions", wouldWarm >= 2, `would_warm=${wouldWarm}`);

  const stLive = cli("status");
  s.check("status exits 0 and prints the keepwarm line", stLive.status === 0 && stLive.stdout.trim().length > 0, stLive.stdout.trim().split("\n")[0]);
  const stJson = cli("status", "--json");
  const sj = json(stJson.stdout);
  s.check(
    "status --json: state ok, global text says shadow, this session listed with mode shadow",
    stJson.status === 0 && sj?.state === "ok" && /shadow/.test(sj?.global?.text ?? "") && Array.isArray(sj.sessions) && sj.sessions.length === 1 && sj.sessions[0].mode === "shadow" && sj.sessions[0].session === open1.session,
    JSON.stringify(sj ? { state: sj.state, level: sj.global?.level, text: sj.global?.text, sessions: sj.sessions?.map((x) => ({ session: x.session, mode: x.mode, phase: x.phase })) } : stJson.stdout.slice(0, 200)),
  );

  await s.turn("again");
  await s.waitForRecord((r) => r.type === "episode_close" && r.episode === open1.episode, 20000);
  await s.waitForRecord((r) => r.type === "episode_open" && r.episode !== open1.episode, 20000);
  const sid1 = open1.session;

  const rep = cli("report");
  s.check("report exits 0 with text", rep.status === 0 && rep.stdout.trim().length > 0, rep.stdout.trim().split("\n").slice(0, 2).join(" | "));
  const repJson = cli("report", "--json");
  const rj = json(repJson.stdout);
  s.check("report --json parses and counts the human return", repJson.status === 0 && rj !== undefined && JSON.stringify(rj).includes("human_return"), rj ? `keys=${Object.keys(rj).join(",")}` : repJson.stdout.slice(0, 200));
  const cal = cli("calibrate");
  s.check("calibrate with too little data exits 2 and writes nothing", cal.status === 2 && /not enough data/.test(cal.stdout), `exit ${cal.status}: ${cal.stdout.trim().split("\n").slice(-1)[0]}`);
  const expShow = cli("expiry");
  s.check("expiry lists the anthropic-api:5m lane with its steps", expShow.status === 0 && /anthropic-api:5m/.test(expShow.stdout) && /steps:/.test(expShow.stdout), expShow.stdout.split("\n").filter((l) => /anthropic-api:5m/.test(l))[0] ?? expShow.stdout.slice(0, 200));
  const habShow = cli("habit");
  s.check("habit shows the observed habit from behavior.json", habShow.status === 0 && /habit observed/.test(habShow.stdout), habShow.stdout.trim().split("\n")[0]);

  await s.senpi.stop();

  // ---- phase 2: real lane, no override, one senpi process ------------------------
  writeFileSync(join(s.home, "config.json"), JSON.stringify({ v: 1, mode: "shadow" }, null, 2) + "\n");
  const h2 = await s.startExtra("real-lane");
  const pid2 = h2.pid;
  const p2 = (r) => r.session !== sid1;
  await s.turn("hello", { senpi: h2 });
  const epA = await s.waitForRecord((r) => r.type === "episode_open" && p2(r), 30000);
  s.check(
    "phase 2: lane override removed, the real anthropic-api lane (5m class) is used and expiry is auto",
    epA.lane === "anthropic-api" && epA.expiry?.source === "auto" && epA.habit?.source === "observed",
    `lane=${epA.lane} expiry=${JSON.stringify(epA.expiry)} habit=${JSON.stringify(epA.habit)} maxPings=${epA.maxPings}`,
  );
  const autoMin = epA.expiry?.effectiveMin;

  const setExp = cli("expiry", "set", "anthropic-api:5m", "20m");
  s.check("expiry set anthropic-api:5m 20m exits 0", setExp.status === 0, setExp.stdout.trim() || setExp.stderr.trim());
  await untilAfter(Date.parse(epA.ts) + CONFIG_STAT_EVERY_MS + 500);
  await s.turn("again", { senpi: h2 });
  const epB = await s.waitForRecord((r) => r.type === "episode_open" && p2(r) && r.episode !== epA.episode, 30000);
  s.check(
    "the NEXT episode_open in the same senpi process: expiry.source manual, effectiveMin 20",
    epB.expiry?.source === "manual" && epB.expiry?.effectiveMin === 20 && epB.expiry?.requestedMin === 20,
    `auto was effectiveMin ${autoMin}; now ${JSON.stringify(epB.expiry)} maxPings=${epB.maxPings}`,
  );
  s.check("manual 20m raised maxPings above the auto episode's (ceil(20/4.5)+1 = 6)", epB.maxPings === 6 && epB.maxPings !== epA.maxPings, `maxPings ${epA.maxPings} -> ${epB.maxPings}`);

  const setAuto = cli("expiry", "set", "anthropic-api:5m", "auto");
  const setHabit = cli("habit", "set", "--return-rate", "0.9", "--median", "8m", "--t90", "60m");
  s.check("expiry set ... auto and habit set exit 0", setAuto.status === 0 && setHabit.status === 0, `${setAuto.stdout.trim()} | ${setHabit.stdout.trim().split("\n")[0]}`);
  await untilAfter(Date.parse(epB.ts) + CONFIG_STAT_EVERY_MS + 500);
  await s.turn("bye", { senpi: h2 });
  const epC = await s.waitForRecord((r) => r.type === "episode_open" && p2(r) && r.episode !== epA.episode && r.episode !== epB.episode, 30000);
  s.check(
    "the NEXT episode_open after habit set: habit.source manual with the set values",
    epC.habit?.source === "manual" && epC.habit.p === 0.9 && epC.habit.mMin === 8 && epC.habit.t90Min === 60,
    JSON.stringify(epC.habit),
  );
  s.check("expiry is back to auto and computed from the manual habit", epC.expiry?.source === "auto" && typeof epC.expiry.formulaMin === "number", JSON.stringify(epC.expiry));

  const reloads = s.records("session").filter((r) => r.session !== sid1 && r.reason === "reload");
  const sessions2 = new Set(s.records().filter(p2).map((r) => r.session));
  s.check("all three episodes came from one senpi process and session, with no reload", reloads.length === 0 && sessions2.size === 1 && h2.pid === pid2 && !h2.isExited(), `pid=${pid2} sessions=${[...sessions2].join(",")} reload records=${reloads.length}`);

  const closes = s.records("episode_close").filter(p2);
  s.check("episodes A and B closed as human_return input:rpc", closes.filter((c) => c.kind === "human_return" && c.source === "input:rpc").length === 2, closes.map((c) => `${c.kind}/${c.source}`).join(","));
  writeFileSync(join(s.evid, "cli-output.txt"), cliLog.join("\n"));
  const finalStatus = cli("status", "--json");
  cliLog.push("");
  writeFileSync(join(s.evid, "cli-output.txt"), cliLog.join("\n"));
  s.check("status --json still ok at the end", json(finalStatus.stdout)?.state === "ok", finalStatus.stdout.slice(0, 160));
} catch (e) {
  s.check("scenario ran without fatal error", false, String(e?.stack ?? e));
  writeFileSync(join(s.evid, "cli-output.txt"), cliLog.join("\n"));
}
const pass = await s.finish();
console.log(`${pass ? "SCENARIO PASS" : "SCENARIO FAIL"} ${NAME} (${((Date.now() - t0) / 1000).toFixed(1)} s) -> ${s.evid}`);
process.exit(pass ? 0 : 1);
