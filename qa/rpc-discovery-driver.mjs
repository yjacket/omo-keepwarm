// QA driver: real senpi in RPC mode WITHOUT --no-extensions, so extensions are discovered from
// <agent dir>/extensions (used by s8 to load the installed stub). qa/rpc-driver.mjs always passes
// --no-extensions, and is not edited; this is the small discovery-mode sibling.
//
//   startDiscoverySenpi({ tmp, agentDir, env, extensions, model: { provider, modelId } })
//     -> { send(cmd, { timeoutMs }), waitForEvent(pred, ms, { from }), events, stop(), pid, args, agentDir, sessionDir, cwd,
//          stdoutLog, stderrLog, isExited() }
// All waiting is event based with bounded timeouts. No fixed sleeps.
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";

const SECRET_KEY = /(API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|^ANTHROPIC|^OPENAI|^GOOGLE|^GEMINI|^AWS_|^AZURE|^OMO_|^SENPI_|^PI_)/i;
const SENPI_BIN = process.env.KW_QA_SENPI_BIN || "senpi";

export async function startDiscoverySenpi({ tmp, agentDir, env = {}, extensions = [], model } = {}) {
  if (!tmp || !agentDir || !model?.provider || !model?.modelId) throw new Error("startDiscoverySenpi: tmp, agentDir and model are required");
  const homeDir = join(tmp, "home");
  const sessionDir = join(tmp, "sessions");
  const cwd = join(tmp, "work");
  for (const d of [agentDir, homeDir, sessionDir, cwd]) mkdirSync(d, { recursive: true });
  const stdoutLog = join(tmp, "senpi-stdout.log");
  const stderrLog = join(tmp, "senpi-stderr.log");

  // No --no-extensions: discovery from <agentDir>/extensions stays on. Explicit -e only for the QA helper.
  const args = ["--mode", "rpc", "--offline"];
  for (const e of extensions) args.push("-e", e);
  args.push("--provider", model.provider, "--model", model.modelId, "--api-key", "kw-qa-dummy", "--session-dir", sessionDir);

  const childEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!SECRET_KEY.test(k)) childEnv[k] = v;
  Object.assign(childEnv, {
    HOME: homeDir,
    USERPROFILE: homeDir,
    OMO_CODING_AGENT_DIR: agentDir,
    SENPI_CODING_AGENT_DIR: agentDir,
    ...env,
  });

  const out = createWriteStream(stdoutLog);
  const err = createWriteStream(stderrLog);
  const child = spawn(SENPI_BIN, args, { cwd, env: childEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const pid = child.pid;
  const bus = new EventEmitter();
  bus.setMaxListeners(0);
  const events = [];
  const pending = new Map();
  let nextId = 1;
  let exited = false;
  let exitInfo = null;

  child.on("error", (e) => {
    exited = true;
    bus.emit("exit");
    for (const p of pending.values()) p.reject(e);
    pending.clear();
  });
  child.stderr.on("data", (c) => err.write(c));
  let buf = "";
  child.stdout.on("data", (c) => {
    out.write(c);
    buf += c.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        events.push({ type: "non_json_line", line });
        bus.emit("event");
        continue;
      }
      if (msg?.type === "response" && msg.id !== undefined && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        p.resolve(msg);
        continue;
      }
      events.push(msg);
      bus.emit("event");
    }
  });
  child.on("exit", (code, signal) => {
    exited = true;
    exitInfo = { code, signal };
    bus.emit("exit");
    for (const p of pending.values()) p.reject(new Error(`senpi exited (code ${code}) before responding`));
    pending.clear();
  });

  function send(cmd, { timeoutMs = 60000 } = {}) {
    if (exited) return Promise.reject(new Error("senpi already exited"));
    const id = cmd.id ?? `kwd-${nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`send(${cmd.type}) timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      child.stdin.write(JSON.stringify({ ...cmd, id }) + "\n", (e) => {
        if (e) {
          clearTimeout(timer);
          pending.delete(id);
          reject(e);
        }
      });
    });
  }

  function waitForEvent(pred, ms = 30000, { from = 0 } = {}) {
    return new Promise((resolve, reject) => {
      let scanned = from;
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        bus.off("event", scan);
        bus.off("exit", onExit);
      };
      const scan = () => {
        for (; scanned < events.length; scanned++) {
          if (pred(events[scanned])) {
            const hit = events[scanned];
            cleanup();
            resolve(hit);
            return true;
          }
        }
        return false;
      };
      const onExit = () => {
        if (scan()) return;
        cleanup();
        reject(new Error(`senpi exited while waiting for event (code ${exitInfo?.code})`));
      };
      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`waitForEvent timed out after ${ms} ms (${events.length} events seen)`));
      }, ms);
      bus.on("event", scan);
      bus.on("exit", onExit);
      if (exited) onExit();
      else scan();
    });
  }

  async function stop({ graceMs = 10000 } = {}) {
    let killed = false;
    if (!exited) {
      try {
        child.stdin.end();
      } catch {
        // already closed
      }
      const done = new Promise((r) => (exited ? r() : bus.once("exit", r)));
      const timedOut = await Promise.race([done.then(() => false), new Promise((r) => setTimeout(() => r(true), graceMs).unref())]);
      if (timedOut && !exited) {
        killed = true;
        if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
        else child.kill("SIGKILL");
        await new Promise((r) => (exited ? r() : bus.once("exit", r)));
      }
    }
    await Promise.all([new Promise((r) => out.end(r)), new Promise((r) => err.end(r))]);
    return { pid, exitCode: exitInfo?.code ?? null, signal: exitInfo?.signal ?? null, killed };
  }

  return { send, waitForEvent, events, stop, pid, args, agentDir, sessionDir, cwd, stdoutLog, stderrLog, isExited: () => exited };
}
