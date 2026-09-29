// QA driver: real senpi TUI (no --mode rpc) on a real TTY, 120x40. QA only.
//
//   startPtySenpi({ tmp, extensions, env, model, extraArgs, cols = 120, rows = 40, command })
//     -> { backend, backendNote, pid, write(text), press(key), waitForOutput(pred, ms, { from }), waitForText(re, ms, { from }),
//          waitForExit(ms), transcript(), text(), mark(), screen(), stop(), agentDir, sessionDir, cwd, blockLog, extLog, args, model }
//   discoverModel({ tmp })  -> the first anthropic model with cost.cacheRead > 0 (one short RPC run)
//   stripAnsi(s)
//
// Backends:
//   "pi-pty"     @earendil-works/pi-pty PtySession when its native prebuild loads (the package ships darwin-arm64 only).
//   "conpty"     qa/conpty-host.cs (Windows ConPTY host, compiled on demand with the .NET Framework csc.exe) when pi-pty has
//                only its pipe fallback. The pipe fallback has no TTY, so senpi would silently go to print mode.
// pi-pty's TerminalScreen (headless xterm) renders the screen in both cases. The package is loaded by path
// (it ships with the senpi install); override with KW_QA_PTY_ROOT.
// All waiting is data-event driven with bounded timeouts. No fixed sleeps.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startSenpi } from "./rpc-driver.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const PTY_ROOT = process.env.KW_QA_PTY_ROOT || "C:/Users/yjack/.bun/install/global/node_modules/@earendil-works/pi-pty";
const SENPI_BIN = process.env.KW_QA_SENPI_BIN || "senpi";
const CSC = process.env.KW_QA_CSC || "C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe";
const SECRET_KEY = /(API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|^ANTHROPIC|^OPENAI|^GOOGLE|^GEMINI|^AWS_|^AZURE|^OMO_|^SENPI_|^PI_)/i;

let ptyModule;
export async function loadPty() {
  if (!ptyModule) ptyModule = await import(pathToFileURL(join(PTY_ROOT, "dist", "index.js")).href);
  return ptyModule;
}

// CSI, OSC (BEL or ST terminated), and two-character escapes.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]|\u001b[()][A-Za-z0-9]/g;
export function stripAnsi(s) {
  return s.replace(ANSI, "").replace(/\r/g, "");
}

function cleanEnv(base) {
  const out = {};
  for (const [k, v] of Object.entries(base)) if (!SECRET_KEY.test(k) && v !== undefined) out[k] = v;
  return out;
}

// The senpi TUI needs an explicit model (no RPC get_available_models); one short RPC run discovers it.
// env must carry the scenario's KW_QA_MOCK_URL / KW_QA_BLOCK_LOG: the network guard is loaded for the probe too.
export async function discoverModel({ tmp, env = {} }) {
  const probe = await startSenpi({ tmp, extensions: [join(here, "fetch-redirect.ext.mjs")], env, model: "auto" });
  const model = probe.model;
  await probe.stop();
  return model;
}

function resolveBin(cmd) {
  if (cmd.includes("/") || cmd.includes("\\")) return cmd;
  if (process.platform !== "win32") return cmd;
  const r = spawnSync("where", [cmd], { encoding: "utf8", windowsHide: true });
  const first = (r.stdout ?? "").split(/\r?\n/).map((l) => l.trim()).find((l) => /\.(exe|cmd|bat)$/i.test(l));
  return first ?? cmd;
}

// Windows command-line quoting (CommandLineToArgvW rules).
function quoteArg(a) {
  if (a !== "" && !/[\s"]/.test(a)) return a;
  let out = '"';
  let bs = 0;
  for (const ch of a) {
    if (ch === "\\") bs++;
    else if (ch === '"') {
      out += "\\".repeat(bs * 2 + 1) + '"';
      bs = 0;
    } else {
      out += "\\".repeat(bs) + ch;
      bs = 0;
    }
  }
  return out + "\\".repeat(bs * 2) + '"';
}

function buildConptyHost() {
  const src = join(here, "conpty-host.cs");
  const dir = join(tmpdir(), "kw-qa-conpty");
  const exe = join(dir, "conpty-host.exe");
  if (existsSync(exe) && statSync(exe).mtimeMs >= statSync(src).mtimeMs) return exe;
  mkdirSync(dir, { recursive: true });
  const r = spawnSync(CSC, ["-nologo", "-optimize", `-out:${exe}`, src], { encoding: "utf8", windowsHide: true });
  if (r.status !== 0 || !existsSync(exe)) throw new Error(`csc failed building conpty-host.exe: ${r.stdout ?? ""}${r.stderr ?? ""}`);
  return exe;
}

// -> { backend, note, pid, write, onData(fn), onExit(fn), exited(), kill() }
async function spawnTty({ command, args, cwd, env, cols, rows }) {
  const pty = await loadPty();
  const native = pty.loadPtyNative?.().native ?? null;
  if (native) {
    const session = new pty.PtySession({ command, args, cwd, env, cols, rows }).start();
    return {
      backend: "pi-pty",
      note: `pi-pty ${session.backend}`,
      get pid() { return session.pid; },
      write: (t) => session.write(t),
      onData: (fn) => session.onData((b) => fn(b.toString("utf8"))),
      onExit: (fn) => session.onExit(fn),
      exited: () => session.exited,
      kill: async () => {
        await session.terminate({ signal: "SIGTERM", graceMs: 5000, forcedGraceMs: 3000 });
      },
    };
  }
  if (process.platform !== "win32") throw new Error("pi-pty has no native backend on this host and no fallback exists");
  const host = buildConptyHost();
  const cmdline = [command, ...args].map(quoteArg).join(" ");
  const child = spawn(host, [String(cols), String(rows), cmdline], { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let exited = false;
  const exitFns = new Set();
  const dataFns = new Set();
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (s) => dataFns.forEach((f) => f(s)));
  child.stderr.on("data", (c) => (stderr += c));
  child.stdin.on("error", () => {});
  child.on("close", (code) => {
    exited = true;
    exitFns.forEach((f) => f(code));
  });
  return {
    backend: "conpty",
    note: "pi-pty loaded only its pipe fallback (no win32-x64 native prebuild; senpi needs a TTY on stdin and stdout), so qa/conpty-host.cs (Windows ConPTY) hosts the TUI",
    get pid() { return child.pid; },
    stderr: () => stderr,
    write: (t) => child.stdin.write(t),
    onData: (fn) => dataFns.add(fn),
    onExit: (fn) => exitFns.add(fn),
    exited: () => exited,
    kill: async () => {
      if (exited) return;
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      if (!exited) await new Promise((r) => exitFns.add(r));
    },
  };
}

export async function startPtySenpi({ tmp, extensions = [], env = {}, model, extraArgs = [], cols = 120, rows = 40, command } = {}) {
  if (!tmp) throw new Error("startPtySenpi: tmp is required");
  if (!model?.provider || !model?.modelId) throw new Error("startPtySenpi: model { provider, modelId } is required");
  const pty = await loadPty();
  const agentDir = join(tmp, "agent");
  const homeDir = join(tmp, "home");
  const sessionDir = join(tmp, "sessions");
  const cwd = join(tmp, "work");
  for (const d of [agentDir, homeDir, sessionDir, cwd]) mkdirSync(d, { recursive: true });
  const blockLog = env.KW_QA_BLOCK_LOG ?? join(tmp, "block.log");
  const extLog = env.KW_QA_EXT_LOG ?? join(tmp, "ext.log");

  const args = ["--offline", "--no-extensions"];
  for (const e of extensions) args.push("-e", e);
  args.push("--provider", model.provider, "--model", model.modelId, "--api-key", "kw-qa-dummy");
  args.push("--session-dir", sessionDir, ...extraArgs);

  const childEnv = {
    ...cleanEnv(process.env),
    HOME: homeDir,
    USERPROFILE: homeDir,
    OMO_CODING_AGENT_DIR: agentDir,
    SENPI_CODING_AGENT_DIR: agentDir,
    KW_QA_BLOCK_LOG: blockLog,
    KW_QA_EXT_LOG: extLog,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    COLUMNS: String(cols),
    LINES: String(rows),
    ...env,
  };

  const screen = new pty.TerminalScreen({ cols, rows, scrollback: 5000 });
  let raw = "";
  const waiters = new Set();
  const tty = await spawnTty({ command: command ?? resolveBin(SENPI_BIN), args, cwd, env: childEnv, cols, rows });
  tty.onData((s) => {
    raw += s;
    screen.feed(s).catch(() => {});
    for (const w of [...waiters]) w();
  });
  tty.onExit(() => {
    for (const w of [...waiters]) w();
  });

  // Resolves once pred(strippedTextSince(from)) is true; rejects on timeout or exit.
  function waitForOutput(pred, ms = 30000, { from = 0 } = {}) {
    return new Promise((resolve, reject) => {
      let timer;
      const done = (fn, v) => {
        clearTimeout(timer);
        waiters.delete(check);
        fn(v);
      };
      const check = () => {
        const text = stripAnsi(raw.slice(from));
        if (pred(text)) return done(resolve, text);
        if (tty.exited()) return done(reject, new Error(`senpi exited while waiting for output (${raw.length} bytes seen)`));
        return undefined;
      };
      timer = setTimeout(
        () => done(reject, new Error(`waitForOutput timed out after ${ms} ms (${raw.length} bytes seen; tail: ${JSON.stringify(stripAnsi(raw).slice(-400))})`)),
        ms,
      );
      waiters.add(check);
      check();
    });
  }
  const waitForText = (re, ms, opts) => waitForOutput((t) => re.test(t), ms, opts);

  function waitForExit(ms = 15000) {
    return new Promise((resolve, reject) => {
      if (tty.exited()) return resolve(true);
      const timer = setTimeout(() => reject(new Error(`senpi did not exit within ${ms} ms`)), ms);
      tty.onExit(() => {
        clearTimeout(timer);
        resolve(true);
      });
      return undefined;
    });
  }

  const KEYS = { enter: "\r", esc: "\u001b", ctrlc: "\u0003", ctrld: "\u0004" };

  async function stop() {
    const wasRunning = !tty.exited();
    if (wasRunning) await tty.kill();
    await screen.flush().catch(() => {});
    return { pid: tty.pid ?? null, exited: tty.exited(), killedByDriver: wasRunning };
  }

  return {
    backend: tty.backend,
    backendNote: tty.note,
    get pid() { return tty.pid; },
    write: (text) => tty.write(text),
    press: (key) => tty.write(KEYS[key] ?? key),
    waitForOutput,
    waitForText,
    waitForExit,
    transcript: () => raw,
    text: () => stripAnsi(raw),
    mark: () => raw.length,
    // Async: waits until everything fed so far is parsed. -> { cols, rows, visibleGrid, scrollback, cursor }
    screen: async () => {
      await screen.flush();
      return screen.snapshot();
    },
    stop,
    isExited: () => tty.exited(),
    agentDir, sessionDir, cwd, blockLog, extLog, args, model,
    readExt: () => (existsSync(extLog) ? readFileSync(extLog, "utf8") : ""),
  };
}
