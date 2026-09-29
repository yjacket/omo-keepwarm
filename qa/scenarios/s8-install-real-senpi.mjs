// S8 install with a real senpi: the real CLI installs into temp homes; senpi (RPC, NO --no-extensions, NO stub -e)
// discovers <agent dir>/extensions/omo-keepwarm.ts, runs a turn and writes records + the loaded marker;
// update leaves the stub untouched (no reload of the open session); uninstall turns keepwarm off and removes the stub
// but keeps data; uninstall --purge removes the home.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO, EXT_HELPER, readJsonSafeFile, startScenario } from "./lib.mjs";
import { startDiscoverySenpi } from "../rpc-discovery-driver.mjs";

const NAME = "s8-install-real-senpi";
const t0 = Date.now();
const s = await startScenario({ name: NAME, taskDir: "task-12", stub: false, senpi: false });
let senpi = null;
let stopInfo = null;

try {
  if (s.startError) throw s.startError;
  const model = await s.probeModel();
  s.model = model;

  // Fresh, separate homes for this scenario: nothing but what `install` creates.
  const home = join(s.tmp, "s8-kw");
  const healthHome = join(s.tmp, "s8-health");
  const agentDir = join(s.tmp, "s8", "agent");
  s.home = home;
  s.healthHome = healthHome;
  s.kwEnv = { OMO_KEEPWARM_HOME: home, OMO_HEALTH_HOME: healthHome };
  const stub = join(agentDir, "extensions", "omo-keepwarm.ts");
  const cliEnv = {
    ...process.env,
    HOME: join(s.tmp, "s8", "home"),
    USERPROFILE: join(s.tmp, "s8", "home"),
    OMO_KEEPWARM_HOME: home,
    OMO_HEALTH_HOME: healthHome,
    OMO_CODING_AGENT_DIR: agentDir,
    SENPI_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_DIR: agentDir,
  };
  const cli = (...args) => {
    const r = spawnSync(process.execPath, [join(REPO, "bin", "omo-keepwarm.mjs"), ...args], { env: cliEnv, encoding: "utf8", windowsHide: true, cwd: s.tmp });
    const line = `$ omo-keepwarm ${args.join(" ")}\n[exit ${r.status}]\n${r.stdout}${r.stderr ? `[stderr]\n${r.stderr}` : ""}`;
    cliLog.push(line);
    return r;
  };
  const cliLog = [];

  // ---- install -----------------------------------------------------------
  const inst = cli("install");
  s.check("install exits 0", inst.status === 0, `${inst.stdout.trim()} ${inst.stderr.trim()}`);
  const current = readJsonSafeFile(join(home, "app", "current.json"));
  s.check("install wrote app/current.json and a staged release under app/releases", Boolean(current?.version) && existsSync(join(current.root, "src", "policy.mjs")) && current.root.startsWith(join(home, "app", "releases")), JSON.stringify(current));
  s.check("install placed the stub in <agent dir>/extensions", existsSync(stub), stub);
  const cfg0 = readJsonSafeFile(join(home, "config.json"));
  s.check("install wrote config.json in default shadow mode", cfg0?.mode === "shadow", JSON.stringify(cfg0));
  const stubText = readFileSync(stub, "utf8");
  s.check("the stub names no version and no path of this checkout", !stubText.includes(current.version) && !stubText.includes(REPO.replace(/\\/g, "/")) && !stubText.includes(REPO), "stub text is fixed");
  const extList0 = readdirSync(join(agentDir, "extensions")).sort();
  s.check("agent dir extensions/ holds only the installed stub before senpi starts", extList0.length === 1 && extList0[0] === "omo-keepwarm.ts", extList0.join(","));

  // ---- real senpi, discovery only ------------------------------------------
  senpi = await startDiscoverySenpi({
    tmp: join(s.tmp, "s8"),
    agentDir,
    env: s.launchEnv({ PI_CODING_AGENT_DIR: agentDir }),
    extensions: [EXT_HELPER],
    model: { provider: model.provider, modelId: model.modelId },
  });
  s.check(
    "senpi started WITHOUT --no-extensions and WITHOUT a stub -e (only the QA fetch helper is -e)",
    !senpi.args.includes("--no-extensions") && senpi.args.filter((a) => a === "-e").length === 1 && senpi.args.includes(EXT_HELPER),
    `args=${senpi.args.join(" ")}`,
  );
  const from = senpi.events.length;
  const res = await senpi.send({ type: "prompt", message: "hello" });
  if (!res?.success) throw new Error(`prompt rejected: ${JSON.stringify(res)}`);
  await senpi.waitForEvent((e) => e.type === "agent_end", 60000, { from });
  const open = await s.waitForRecord((r) => r.type === "episode_open", 30000);
  s.check("episode_open recorded by the discovered stub", Boolean(open.episode), `episode=${open.episode} mode=${open.mode} lane=${open.lane}`);
  const sessionRec = s.records("session")[0];
  s.check("session record carries the installed release version", sessionRec?.keepwarmVersion === current.version, `session.keepwarmVersion=${sessionRec?.keepwarmVersion} current=${current.version}`);
  const marker = join(home, "app", "loaded", current.version);
  s.check("app/loaded/<version> marker exists", existsSync(marker), marker);
  const extList1 = readdirSync(join(agentDir, "extensions")).sort();
  writeFileSync(join(s.evid, "extensions-dir.txt"), `before senpi start: ${extList0.join(", ")}\nafter senpi start: ${extList1.join(", ")}\n`);

  // ---- update while the session is open --------------------------------------
  const st0 = statSync(stub);
  const text0 = readFileSync(stub, "utf8");
  const upd = cli("update");
  const st1 = statSync(stub);
  s.check("update exits 0", upd.status === 0, `${upd.stdout.trim()} ${upd.stderr.trim()}`);
  s.check("update leaves the stub unchanged (mtime and content)", st1.mtimeMs === st0.mtimeMs && readFileSync(stub, "utf8") === text0 && /unchanged/.test(upd.stdout), `mtime ${st0.mtimeMs} -> ${st1.mtimeMs}; ${upd.stdout.trim()}`);
  const reloads = s.records("session").filter((r) => r.reason === "reload");
  s.check("the open session was not reloaded by the update", reloads.length === 0 && senpi.events.every((e) => e.type !== "extension_reload"), `session reload records=${reloads.length}`);
  const from2 = senpi.events.length;
  await senpi.send({ type: "prompt", message: "again" });
  await senpi.waitForEvent((e) => e.type === "agent_end", 60000, { from: from2 });
  const close1 = await s.waitForRecord((r) => r.type === "episode_close" && r.episode === open.episode, 20000);
  s.check("the still-open session keeps working after the update (episode closes as human_return)", close1.kind === "human_return", `kind=${close1.kind} source=${close1.source}`);

  stopInfo = await senpi.stop();
  s.check("senpi stopped cleanly before uninstall", stopInfo.killed === false, JSON.stringify(stopInfo));

  const errLines = ["errors.log", "stub.log"].flatMap((n) => (existsSync(join(home, "logs", n)) ? readFileSync(join(home, "logs", n), "utf8").split("\n").filter((l) => l.trim()) : []));
  s.check("keepwarm errors.log and stub.log are empty before uninstall (the standard check runs after the purge)", errLines.length === 0, errLines.slice(0, 3).join(" | ") || "no errors logged");
  s.check(
    "the only extensions senpi itself added to the agent dir are its bundled defaults (no keepwarm copy besides the stub)",
    extList1.filter((n) => /keepwarm/i.test(n)).join(",") === "omo-keepwarm.ts",
    `after start: ${extList1.join(", ")}`,
  );

  // Evidence copies before uninstall/purge remove them.
  cpSync(home, join(s.evid, "keepwarm-home-before-uninstall"), { recursive: true });
  cpSync(join(s.tmp, "s8", "sessions"), join(s.evid, "session"), { recursive: true });

  // ---- uninstall (keeps data) -------------------------------------------------
  const un = cli("uninstall");
  s.check("uninstall exits 0", un.status === 0, `${un.stdout.trim()} ${un.stderr.trim()}`);
  const cfg1 = readJsonSafeFile(join(home, "config.json"));
  s.check("uninstall set config mode off", cfg1?.mode === "off", JSON.stringify(cfg1));
  s.check("uninstall removed the stub", !existsSync(stub), stub);
  const recordsLeft = existsSync(join(home, "records")) && readdirSync(join(home, "records")).length > 0;
  s.check("uninstall kept the data (records, app)", recordsLeft && existsSync(join(home, "app")), `records=${recordsLeft}`);

  // ---- uninstall --purge ------------------------------------------------------
  const purge = cli("uninstall", "--purge");
  s.check("uninstall --purge exits 0", purge.status === 0, `${purge.stdout.trim()} ${purge.stderr.trim()}`);
  s.check("uninstall --purge removed the keepwarm home", !existsSync(home), home);
  writeFileSync(join(s.evid, "cli-output.txt"), cliLog.join("\n"));
} catch (e) {
  s.check("scenario ran without fatal error", false, String(e?.stack ?? e));
} finally {
  if (senpi && !stopInfo) stopInfo = await senpi.stop().catch((e) => ({ error: String(e.message) }));
  if (senpi) {
    const { copyFileSync } = await import("node:fs");
    for (const [src, name] of [[senpi.stdoutLog, "senpi-stdout.log"], [senpi.stderrLog, "senpi-stderr.log"]]) if (existsSync(src)) copyFileSync(src, join(s.evid, name));
    if (existsSync(s.extLog)) copyFileSync(s.extLog, join(s.evid, "ext.log"));
    writeFileSync(join(s.evid, "senpi-args.txt"), senpi.args.join(" ") + "\n");
  }
}
const pass = await s.finish(senpi ? [{ name: "discovery senpi pid is gone", pass: !senpi.isExited() ? false : true, detail: `pid=${senpi.pid} stop=${JSON.stringify(stopInfo)}` }] : []);
console.log(`${pass ? "SCENARIO PASS" : "SCENARIO FAIL"} ${NAME} (${((Date.now() - t0) / 1000).toFixed(1)} s) -> ${s.evid}`);
process.exit(pass ? 0 : 1);
