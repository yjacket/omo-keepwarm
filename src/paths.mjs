import { homedir } from "node:os";
import { join } from "node:path";

export function keepwarmHome(env = process.env) {
  return env.OMO_KEEPWARM_HOME || join(homedir(), ".omo-keepwarm");
}

export function agentDir(env = process.env) {
  return (
    env.OMO_CODING_AGENT_DIR ||
    env.SENPI_CODING_AGENT_DIR ||
    env.PI_CODING_AGENT_DIR ||
    join(homedir(), ".omo", "agent")
  );
}

export function healthHome(env = process.env) {
  return env.OMO_HEALTH_HOME || join(homedir(), ".omo-health");
}

const p2 = (n) => String(n).padStart(2, "0");

export function localMonth(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}`;
}

export function localDate(ms) {
  const d = new Date(ms);
  return `${localMonth(ms)}-${p2(d.getDate())}`;
}

export function layout(home) {
  return {
    config: join(home, "config.json"),
    behavior: join(home, "behavior.json"),
    recordsDir: join(home, "records"),
    recordFile: (sessionId, ms) => join(home, "records", localMonth(ms), `${sessionId}.jsonl`),
    statusDir: join(home, "status"),
    sessionStatus: (id) => join(home, "status", `${id}.json`),
    globalStatus: join(home, "status", "_global.json"),
    spendFile: (date) => join(home, "ledger", `spend-${date}.jsonl`),
    dayFile: (date) => join(home, "ledger", `day-${date}.jsonl`),
    logsDir: join(home, "logs"),
    errorLog: join(home, "logs", "errors.log"),
    stubLog: join(home, "logs", "stub.log"),
    appDir: join(home, "app"),
    currentFile: join(home, "app", "current.json"),
    releasesDir: join(home, "app", "releases"),
    loadedMarker: (version) => join(home, "app", "loaded", String(version)),
  };
}
