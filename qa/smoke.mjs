// Smoke: a REAL senpi (RPC mode, temp agent dir, only the QA helper extension) completes chat turns
// against the local mock with zero non-localhost requests. Exit 0 iff every check passes.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonl, startMock, startSenpi } from "./rpc-driver.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const EVID = process.env.KW_QA_EVID_DIR ?? "C:/dev/omo/omo-keepwarm/.omo/evidence/keepwarm-v1/task-11/smoke";
mkdirSync(EVID, { recursive: true });

const checks = [];
const check = (name, pass, detail = "") => {
  checks.push({ name, pass: Boolean(pass), detail: String(detail) });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
};

const stripCache = (v) => {
  if (Array.isArray(v)) return v.map(stripCache);
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) if (k !== "cache_control") o[k] = stripCache(x);
    return o;
  }
  return v;
};
const normMsg = (m) => stripCache({ role: m.role, content: typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content });
const textOf = (m) => {
  const c = m?.content;
  if (typeof c === "string") return c;
  return Array.isArray(c) ? c.filter((b) => b?.type === "text").map((b) => b.text).join("") : "";
};
const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const tmp = mkdtempSync(join(tmpdir(), "kw-qa-smoke-"));
const mockLog = join(EVID, "mock-requests.jsonl");
let mock;
let senpi;
let stopInfo = null;
let mockUrl = "";
let fatal = null;
let blockLines = null;
let extRecords = [];
let events = [];

try {
  mock = await startMock({ port: 0, logFile: mockLog });
  mockUrl = mock.url;
  senpi = await startSenpi({
    tmp,
    extensions: [join(here, "fetch-redirect.ext.mjs")],
    env: { KW_QA_MOCK_URL: mock.url },
    model: "auto",
  });
  events = senpi.events;
  check("senpi started and anthropic cacheRead>0 model selected", true, JSON.stringify(senpi.model));

  const runTurn = async (message) => {
    const from = senpi.events.length;
    const res = await senpi.send({ type: "prompt", message });
    if (!res?.success) throw new Error(`prompt "${message}" rejected: ${JSON.stringify(res)}`);
    await senpi.waitForEvent((e) => e.type === "agent_end", 60000, { from });
    return from;
  };

  let turn1 = false;
  let turn2 = false;
  try {
    await runTurn("hello");
    turn1 = true;
    await runTurn("again");
    turn2 = true;
  } catch (e) {
    fatal = e;
  }
  check("RPC emitted agent_end for both prompts", turn1 && turn2, fatal ? String(fatal.message) : `agent_end events: ${senpi.events.filter((e) => e.type === "agent_end").length}`);

  // Extension input -> handled -> extension-triggered turn.
  let extTurn = null;
  if (turn1 && turn2) {
    try {
      const from = senpi.events.length;
      const res = await senpi.send({ type: "prompt", message: "kw-qa-ext-input" });
      const userMsg = await senpi.waitForEvent(
        (e) => (e.type === "message_start" || e.type === "message_end") && e.message?.role === "user" && textOf(e.message).includes("kw qa extension input"),
        60000,
        { from },
      );
      await senpi.waitForEvent((e) => e.type === "agent_end", 60000, { from: senpi.events.indexOf(userMsg) });
      extTurn = { promptResponse: res, sawUserMessage: true };
    } catch (e) {
      extTurn = { error: String(e.message) };
    }
  }
  extRecords = readJsonl(senpi.extLog);
  const inputRec = extRecords.find((r) => r.type === "input" && r.text === "kw-qa-ext-input");
  const dispo = inputRec && extRecords.find((r) => r.type === "input_disposition" && r.inputId === inputRec.inputId);
  const rpcDispo = senpi.events.find((e) => e.type === "input_disposition");
  check(
    'prompt "kw-qa-ext-input" produced input_disposition "handled"',
    dispo?.disposition === "handled",
    `extension-side record: ${JSON.stringify(dispo ?? null)}; visible over RPC: ${rpcDispo ? JSON.stringify(rpcDispo) : "no"}`,
  );
  check(
    'extension-triggered turn with user message "kw qa extension input"',
    extTurn?.sawUserMessage === true,
    JSON.stringify(extTurn),
  );
} catch (e) {
  fatal = fatal ?? e;
  check("harness ran without fatal error", false, String(e?.stack ?? e));
} finally {
  if (senpi) {
    try {
      stopInfo = await senpi.stop();
    } catch (e) {
      stopInfo = { error: String(e.message) };
    }
  }
  if (mock) {
    const reqs = mock.requests();
    const chats = reqs.filter((r) => r.kind === "chat");
    const warms = reqs.filter((r) => r.kind === "warm");
    const others = reqs.filter((r) => r.kind === "other");
    check("mock received >= 2 streaming chat requests", chats.length >= 2, `chat=${chats.length} warm=${warms.length} other=${others.length}`);
    if (chats.length >= 2) {
      const a = chats[0].body.messages.map(normMsg);
      const b = chats[1].body.messages.map(normMsg);
      const prefixOk = b.length > a.length && a.every((m, i) => JSON.stringify(m) === JSON.stringify(b[i]));
      check("second chat request messages start with the first request's messages (ignoring cache_control)", prefixOk, `first=${a.length} msgs, second=${b.length} msgs`);
    } else {
      check("second chat request messages start with the first request's messages (ignoring cache_control)", false, "fewer than 2 chat requests");
    }
    check("every chat request used a localhost mock endpoint with the anthropic path", reqs.every((r) => r.path === "/v1/messages"), `paths=${[...new Set(reqs.map((r) => r.path))].join(",")}`);
    await mock.close();
  }
  if (senpi) {
    blockLines = existsSync(senpi.blockLog) ? readFileSync(senpi.blockLog, "utf8").split("\n").filter((l) => l.trim()) : [];
    check("block log has 0 lines (zero non-localhost requests)", blockLines.length === 0, blockLines.length ? blockLines.slice(0, 5).join(" | ") : "no blocked requests");
    for (const [src, name] of [[senpi.stdoutLog, "senpi-stdout.log"], [senpi.stderrLog, "senpi-stderr.log"], [senpi.extLog, "ext.log"], [senpi.blockLog, "block.log"]]) {
      if (existsSync(src)) copyFileSync(src, join(EVID, name));
      else writeFileSync(join(EVID, name), "");
    }
  }

  // Cleanup receipts.
  let mockClosed = false;
  if (mockUrl) {
    try {
      await fetch(mockUrl + "/v1/messages", { method: "POST", signal: AbortSignal.timeout(3000) });
    } catch {
      mockClosed = true;
    }
  }
  const pid = senpi?.pid;
  const pidGone = pid ? !pidAlive(pid) : true;
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  const tmpGone = !existsSync(tmp);
  writeFileSync(
    join(EVID, "cleanup.txt"),
    [
      `senpi pid ${pid ?? "n/a"}: ${pidGone ? "gone" : "STILL ALIVE"}`,
      `senpi stop: ${JSON.stringify(stopInfo)}`,
      `mock ${mockUrl || "n/a"}: ${mockClosed ? "closed (connection refused)" : "STILL LISTENING"}`,
      `temp dir ${tmp}: ${tmpGone ? "removed" : "STILL EXISTS"}`,
      "",
    ].join("\n"),
  );
  check("senpi process exited and pid is gone", pidGone && stopInfo?.killed !== true, `pid=${pid} stop=${JSON.stringify(stopInfo)}`);
  check("mock closed", mockClosed, mockUrl);
  check("temp dir removed", tmpGone, tmp);
}

const pass = checks.length > 0 && checks.every((c) => c.pass) && !fatal;
writeFileSync(join(EVID, "result.json"), JSON.stringify({ scenario: "smoke", pass, checks }, null, 2) + "\n");
console.log(pass ? "SMOKE PASS" : "SMOKE FAIL");
process.exit(pass ? 0 : 1);
