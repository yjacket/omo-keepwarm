// S6 inert: keepwarm (mode on) must stay silent and write nothing where no human drives an interactive session.
//   1. `senpi -p "hi"` (print mode)            -> no keepwarm files at all
//   2. `--mode rpc --multi-session`, open_session kind worker + prompt -> no record / status for that session
//      (control: an interactive session on the same host DOES get records, so the absence is not "keepwarm never loaded").
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runScenario } from "./lib.mjs";
import { runSenpiPrint } from "../rpc-driver.mjs";

const filesUnder = (dir) => {
  const out = [];
  const walk = (d) => {
    let names = [];
    try {
      names = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of names) (e.isDirectory() ? walk(join(d, e.name)) : out.push(join(d, e.name)));
  };
  walk(dir);
  return out;
};

await runScenario({ name: "s6-inert", config: "config-on", behavior: "behavior-fast", senpi: false }, async (s) => {
  const model = await s.probeModel();
  s.check("model with cacheRead > 0 discovered", Boolean(model?.modelId), JSON.stringify(model));

  // ---- 1. print mode
  const printTmp = join(s.tmp, "print");
  const print = await runSenpiPrint({
    tmp: printTmp,
    extensions: s.extensionArgs(),
    env: s.launchEnv({ KW_QA_EXT_LOG: join(printTmp, "ext.log") }),
    model,
    prompt: "hi",
  });
  const chatsAfterPrint = s.mock.requests().filter((r) => r.kind === "chat").length;
  s.check("print mode: senpi -p exited 0 and reached the mock (1 chat request)", print.code === 0 && !print.timedOut && chatsAfterPrint === 1, `code=${print.code} timedOut=${print.timedOut} chats=${chatsAfterPrint}`);
  const kwFilesAfterPrint = filesUnder(s.home).filter((f) => !f.endsWith("config.json") && !f.endsWith("behavior.json") && !/[\\/]app[\\/]current\.json$/.test(f));
  s.check("print mode: keepwarm wrote no record, status, ledger, marker or log file", kwFilesAfterPrint.length === 0, kwFilesAfterPrint.length ? kwFilesAfterPrint.join(" | ") : `only config/behavior/current.json under ${s.home}`);

  // ---- 2. multi-session RPC: worker vs interactive
  const multi = await s.startExtra("multi", { model, extraArgs: ["--multi-session"] });
  const openWorker = await multi.send({ type: "open_session", kind: "worker", cwd: multi.cwd });
  const workerRpcId = openWorker?.data?.sessionId;
  const workerId = openWorker?.data?.state?.sessionId;
  s.check("open_session kind worker accepted", openWorker?.success === true && Boolean(workerRpcId) && Boolean(workerId), JSON.stringify(openWorker).slice(0, 300));
  await s.turn("hi from worker", { senpi: multi, sessionId: workerRpcId });
  const chatsAfterWorker = s.mock.requests().filter((r) => r.kind === "chat").length;
  s.check("worker session completed a turn against the mock", chatsAfterWorker === 2, `chats=${chatsAfterWorker}`);

  const openInter = await multi.send({ type: "open_session", cwd: multi.cwd });
  const interRpcId = openInter?.data?.sessionId;
  const interId = openInter?.data?.state?.sessionId;
  s.check("open_session interactive (control) accepted", openInter?.success === true && Boolean(interRpcId) && Boolean(interId) && interId !== workerId, JSON.stringify(openInter).slice(0, 300));
  await s.turn("hi from interactive", { senpi: multi, sessionId: interRpcId });
  const interOpen = await s.waitForRecord((r) => r.type === "episode_open" && r.session === interId, 20000);
  s.check("control: the interactive session got keepwarm records (episode_open)", Boolean(interOpen), `session=${interId}`);

  const workerRecords = s.records().filter((r) => r.session === workerId);
  const workerStatus = existsSync(join(s.home, "status", `${workerId}.json`));
  s.check("worker session: no keepwarm record and no status file", workerRecords.length === 0 && !workerStatus, `records=${workerRecords.length} statusFile=${workerStatus}`);
  const printSessionRecords = s.records().filter((r) => r.session !== interId);
  s.check("no keepwarm record belongs to any session but the interactive control", printSessionRecords.length === 0, printSessionRecords.slice(0, 3).map((r) => `${r.type}:${r.session}`).join(" | ") || "none");
});
