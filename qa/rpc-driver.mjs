// QA driver: real senpi in RPC mode + local mock. QA only.
//
//   startMock({ port: 0, logFile, script }) -> { url, requests(), close() }   (re-exported)
//   startSenpi({ tmp, extensions, env, model, extraArgs }) ->
//     { send(cmd), waitForEvent(pred, ms, { from }), waitForJsonl(file, pred, ms), events, stdoutLog, stop(), pid, model, ... }
//   runSenpiPrint({ tmp, extensions, env, model, prompt, extraArgs, timeoutMs }) -> { code, timedOut, stdoutLog, stderrLog, ... }
//
// All waiting is event / fs.watch based with bounded timeouts. No fixed sleeps.
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createWriteStream, existsSync, mkdirSync, readFileSync, watch } from "node:fs";
import { dirname, join } from "node:path";

export { startMock } from "./mock-anthropic.mjs";

const SECRET_KEY = /(API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|^ANTHROPIC|^OPENAI|^GOOGLE|^GEMINI|^AWS_|^AZURE|^OMO_|^SENPI_|^PI_)/i;

function cleanEnv(base) {
  const out = {};
  for (const [k, v] of Object.entries(base)) if (!SECRET_KEY.test(k)) out[k] = v;
  return out;
}

const SENPI_BIN = process.env.KW_QA_SENPI_BIN || "senpi";

// Shared launch setup: temp dirs, argv and a scrubbed env. `lead` holds the mode arguments
// (["--mode", "rpc"] or ["-p", "<text>"]).
function launchSpec({ tmp, extensions, env, model, extraArgs, lead }) {
  if (!tmp) throw new Error("tmp is required");
  const agentDir = join(tmp, "agent");
  const homeDir = join(tmp, "home");
  const sessionDir = join(tmp, "sessions");
  const cwd = join(tmp, "work");
  for (const d of [agentDir, homeDir, sessionDir, cwd]) mkdirSync(d, { recursive: true });
  const blockLog = env.KW_QA_BLOCK_LOG ?? join(tmp, "block.log");
  const extLog = env.KW_QA_EXT_LOG ?? join(tmp, "ext.log");

  const args = [...lead, "--offline", "--no-extensions"];
  for (const e of extensions) args.push("-e", e);
  args.push("--provider", model === "auto" ? "anthropic" : model.provider);
  if (model !== "auto") args.push("--model", model.modelId);
  // senpi rejects --api-key without --model, so the auto-model start carries the dummy key in env instead.
  if (model !== "auto") args.push("--api-key", "kw-qa-dummy");
  args.push("--session-dir", sessionDir, ...extraArgs);

  const childEnv = {
    ...cleanEnv(process.env),
    ...(model === "auto" ? { ANTHROPIC_API_KEY: "kw-qa-dummy" } : {}),
    HOME: homeDir,
    USERPROFILE: homeDir,
    OMO_CODING_AGENT_DIR: agentDir,
    SENPI_CODING_AGENT_DIR: agentDir,
    KW_QA_BLOCK_LOG: blockLog,
    KW_QA_EXT_LOG: extLog,
    ...env,
  };
  return { args, childEnv, agentDir, homeDir, sessionDir, cwd, blockLog, extLog };
}

function killTree(child) {
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGKILL");
}

/**
 * One-shot print mode (`senpi -p <prompt>`); an explicit { provider, modelId } model is required.
 * Resolves { code, signal, timedOut, pid, stdoutLog, stderrLog, extLog, blockLog, args }; the process tree is killed on timeout.
 */
export async function runSenpiPrint({ tmp, extensions = [], env = {}, model, prompt, extraArgs = [], timeoutMs = 90000 } = {}) {
  if (!model || model === "auto") throw new Error("runSenpiPrint: an explicit { provider, modelId } model is required");
  const spec = launchSpec({ tmp, extensions, env, model, extraArgs, lead: ["-p", prompt] });
  const stdoutLog = join(tmp, "senpi-print-stdout.log");
  const stderrLog = join(tmp, "senpi-print-stderr.log");
  const out = createWriteStream(stdoutLog);
  const err = createWriteStream(stderrLog);
  const child = spawn(SENPI_BIN, spec.args, { cwd: spec.cwd, env: spec.childEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout.on("data", (c) => out.write(c));
  child.stderr.on("data", (c) => err.write(c));
  let timedOut = false;
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    child.once("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, spawnError: e.message });
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  await Promise.all([new Promise((r) => out.end(r)), new Promise((r) => err.end(r))]);
  return { ...result, timedOut, pid: child.pid, stdoutLog, stderrLog, extLog: spec.extLog, blockLog: spec.blockLog, args: spec.args };
}

export async function startSenpi({ tmp, extensions = [], env = {}, model = "auto", extraArgs = [] } = {}) {
  if (!tmp) throw new Error("startSenpi: tmp is required");
  const { args, childEnv, agentDir, sessionDir, cwd, blockLog, extLog } = launchSpec({
    tmp, extensions, env, model, extraArgs, lead: ["--mode", "rpc"],
  });
  const stdoutLog = join(tmp, "senpi-stdout.log");
  const stderrLog = join(tmp, "senpi-stderr.log");

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
  let spawnError = null;

  child.on("error", (e) => {
    spawnError = e;
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
    for (const p of pending.values()) p.reject(new Error(`senpi exited (code ${code}, signal ${signal}) before responding`));
    pending.clear();
  });

  function send(cmd, { timeoutMs = 60000 } = {}) {
    if (exited) return Promise.reject(new Error("senpi already exited"));
    const id = cmd.id ?? `kw-${nextId++}`;
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

  // Resolves with the first event (index >= from) that satisfies pred; rejects on timeout or exit.
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

  // Wait until a JSONL file contains a record satisfying pred (fs.watch on the directory).
  function waitForJsonl(file, pred, ms = 30000) {
    return waitForFileRecord(file, pred, ms);
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
      const timedOut = await Promise.race([
        done.then(() => false),
        new Promise((r) => setTimeout(() => r(true), graceMs).unref()),
      ]);
      if (timedOut && !exited) {
        killed = true;
        killTree(child);
        await new Promise((r) => (exited ? r() : bus.once("exit", r)));
      }
    }
    await Promise.all([new Promise((r) => out.end(r)), new Promise((r) => err.end(r))]);
    return { pid, exitCode: exitInfo?.code ?? null, signal: exitInfo?.signal ?? null, killed, spawnError: spawnError?.message ?? null };
  }

  const handle = {
    send, waitForEvent, waitForJsonl, events, stdoutLog, stderrLog, blockLog, extLog, stop,
    pid, agentDir, sessionDir, cwd, args,
    isExited: () => exited,
    model: null,
  };

  if (model === "auto") {
    let listed;
    try {
      listed = await send({ type: "get_available_models" });
    } catch (e) {
      const info = await stop();
      const tail = existsSync(stderrLog) ? readFileSync(stderrLog, "utf8").slice(-1500) : "";
      throw new Error(`get_available_models failed: ${e.message}; stop=${JSON.stringify(info)}; stderr tail: ${tail}`);
    }
    const models = listed?.data?.models ?? [];
    const pick = models.find((m) => m.provider === "anthropic" && m.cost?.cacheRead > 0);
    if (!pick) {
      await stop();
      throw new Error(`no anthropic model with cost.cacheRead > 0 in get_available_models (${models.length} models)`);
    }
    const set = await send({ type: "set_model", provider: pick.provider, modelId: pick.id });
    if (!set?.success) {
      await stop();
      throw new Error(`set_model failed: ${JSON.stringify(set)}`);
    }
    handle.model = { provider: pick.provider, modelId: pick.id, api: pick.api, baseUrl: pick.baseUrl, cost: pick.cost };
  } else {
    handle.model = { ...model };
  }
  return handle;
}

export function readJsonl(file) {
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // partially written trailing line
    }
  }
  return out;
}

export function waitForFileRecord(file, pred, ms = 30000) {
  return new Promise((resolve, reject) => {
    const dir = dirname(file);
    let watcher;
    let timer;
    const finish = (fn, v) => {
      clearTimeout(timer);
      watcher?.close();
      fn(v);
    };
    const check = () => {
      const hit = readJsonl(file).find(pred);
      if (hit) finish(resolve, hit);
      return Boolean(hit);
    };
    mkdirSync(dir, { recursive: true });
    watcher = watch(dir, () => check());
    timer = setTimeout(() => finish(reject, new Error(`waitForFileRecord timed out after ${ms} ms: ${file}`)), ms);
    check();
  });
}
