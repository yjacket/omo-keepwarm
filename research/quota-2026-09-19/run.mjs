// Block runner v2: node run.mjs <model> <block> [port]
// Blocks: gate | probe | N | Wt | Rt | Ot
//   Wt: 1h-cache writes (~100K each, distinct seeds) repeated until the 5h utilization header ticks twice (0.01 steps).
//   Rt: reads (resume the last Wt session, ~100K cache read each) repeated until two ticks.
//   Ot: long numeric output (1..2000) repeated until two ticks or QT_MAX trials.
// Headers have 0.01 resolution, so the design counts "requests per tick" instead of per-request deltas.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

const [model, block, portArg] = process.argv.slice(2);
const PORT = Number(portArg || process.env.QT_PORT || 18321);
const DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const LABEL_FILE = path.join(DIR, "label.txt");
const TRIALS = path.join(DIR, "trials.jsonl");
const RAW = path.join(DIR, "raw.jsonl");
const SESS = path.join(DIR, "last-session." + model + ".txt");
const WORK = path.join(os.tmpdir(), "quota-work");
fs.mkdirSync(WORK, { recursive: true });
const CLI = path.join(process.env.APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
const BASE5H = Number(process.env.QT_BASE5H || "0.12"); // utilization at experiment start (abort at +0.15)
const MAX = Number(process.env.QT_MAX || "0");
const LINES = Number(process.env.QT_LINES || "4800"); // ~29.4 tokens/line -> ~141K tokens, stays under the 200K window (no auto-compact on resume)

// Benign, deterministic, non-repeating filler: a synthetic measurement table (avoids safeguard refusals on nonsense text).
const SITES = "Aberdeen Bristol Cardiff Dundee Exeter Falmouth Glasgow Hull Inverness Jarrow Kendal Leeds Margate Norwich Oxford Plymouth Reading Swansea Truro York".split(" ");
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function filler(seed, lines) {
  const r = rng(seed); const out = ["Weather station log (synthetic test data, seed " + seed + ")", "id,site,date,temp_c,humidity,wind_kph,pressure_hpa"];
  for (let i = 0; i < lines; i++) {
    const d = new Date(Date.UTC(2020, 0, 1) + Math.floor(r() * 2000) * 86400000).toISOString().slice(0, 10);
    out.push(`${i + 1},${SITES[Math.floor(r() * SITES.length)]},${d},${(r() * 35 - 5).toFixed(1)},${Math.floor(r() * 100)},${(r() * 80).toFixed(1)},${(980 + r() * 60).toFixed(1)}`);
  }
  return out.join("\n");
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function setLabel(l) { fs.writeFileSync(LABEL_FILE, l); }
function lastHeaders() {
  const lines = fs.readFileSync(RAW, "utf8").trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) { const j = JSON.parse(lines[i]); if (j.path === "/v1/messages" && j.headers && j.headers["anthropic-ratelimit-unified-5h-utilization"]) return j.headers; }
  return null;
}
const u5 = (h) => Number(h["anthropic-ratelimit-unified-5h-utilization"]);
const u7 = (h) => Number(h["anthropic-ratelimit-unified-7d-utilization"]);

async function trial(label, prompt, { sessionId, resume } = {}) {
  setLabel(label);
  const args = ["-p", "--model", model, "--output-format", "json", "--safe-mode", "--strict-mcp-config",
    "--tools", "", "--disable-slash-commands", "--permission-mode", "dontAsk", "--effort", "low", "--max-turns", "1", "--fallback-model", model];
  if (resume) args.push("--resume", resume); else if (sessionId) args.push("--session-id", sessionId); else args.push("--no-session-persistence");
  const env = { ...process.env, ANTHROPIC_BASE_URL: "http://127.0.0.1:" + PORT, MAX_THINKING_TOKENS: "0",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" };
  const t0 = Date.now();
  const res = await new Promise((resolve) => {
    const p = spawn(CLI, args, { cwd: WORK, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { err += d; });
    p.on("close", (code) => resolve({ code, out, err }));
    p.stdin.end(prompt);
  });
  let j = null; try { j = JSON.parse(res.out); } catch {}
  const h = lastHeaders() || {};
  const rec = { ts: new Date().toISOString(), label, model, block, sessionId: sessionId || resume || null, code: res.code,
    secs: (Date.now() - t0) / 1000, prompt_chars: prompt.length, result_preview: (j?.result ?? res.out).slice(0, 80),
    usage: j?.usage ?? null, modelUsage: j?.modelUsage ?? null, is_error: j?.is_error ?? null, stderr: res.err.slice(0, 300),
    u5: u5(h), u7: u7(h), status: h["anthropic-ratelimit-unified-status"], reset5h: h["anthropic-ratelimit-unified-5h-reset"] };
  fs.appendFileSync(TRIALS, JSON.stringify(rec) + "\n");
  console.log(label, "code=" + res.code, rec.secs + "s", JSON.stringify(rec.result_preview.slice(0, 40)), "u5=" + rec.u5, "u7=" + rec.u7, rec.stderr ? "STDERR:" + rec.stderr.slice(0, 100) : "");
  if (rec.status !== "allowed" || rec.u5 - BASE5H > 0.15) throw new Error("ABORT status=" + rec.status + " u5=" + rec.u5);
  return rec;
}

const NULLP = "Hi! Quick connectivity check of my CLI setup. Please respond with just the word OK.";
const OUTP = "Please list the integers from 1 to 2000, one per line, with no other text before or after.";
const tag = (s) => model.split("-")[1] + "." + block + "." + s;

// Repeat `fn(i)` until the 5h header has ticked `ticks` times (or MAX trials); returns per-trial records.
async function untilTicks(fn, max, ticks = 2) {
  const recs = []; const start = (await fn(0)); recs.push(start);
  let u0 = start.u5, seen = 0;
  for (let i = 1; i < max && seen < ticks; i++) {
    await sleep(3000); const r = await fn(i); recs.push(r);
    if (r.u5 !== u0) { seen++; console.log("TICK5h", u0, "->", r.u5, "after trial", i); u0 = r.u5; }
    if (r.reset5h !== start.reset5h) { console.log("RESET CHANGED - block invalid"); break; }
  }
  return recs;
}

async function main() {
  if (block === "gate") { await trial(tag("null"), NULLP); return; }
  if (block === "probe2") {
    const vs = ["Hi! Quick connectivity check of my CLI setup. Please respond with just the word OK.", "What is 2 + 2? Reply with only the number.", "Say OK."];
    for (let i = 0; i < vs.length; i++) { await trial(tag("v" + (i + 1)), vs[i]); await sleep(3000); }
    return;
  }
  if (block === "probe") { await trial(tag("p1"), NULLP); await sleep(3000); await trial(tag("p2.filler20k"), filler(7, 900) + "\n\n" + NULLP); return; }
  await trial(tag("start"), NULLP); await sleep(3000);
  if (block === "N") {
    for (let i = 1; i <= 5; i++) { await trial(tag("null" + i), NULLP); await sleep(3000); }
  } else if (block === "Wt") {
    await untilTicks(async (i) => { const sid = randomUUID(); const seed = (Date.now() & 0xffffff) + i; fs.writeFileSync(SESS, sid);
      return trial(tag("w100k." + i + ".seed" + seed), filler(seed, LINES) + "\n\n" + NULLP, { sessionId: sid }); }, MAX || 12);
  } else if (block === "WR") {
    // one ~140K 1h write into a fresh session, then read pings (resume) until two ticks; Rt continues the same session
    const sid = randomUUID(); const seed = Date.now() & 0xffffff; fs.writeFileSync(SESS, sid);
    await trial(tag("w140k.seed" + seed), filler(seed, LINES) + "\n\n" + NULLP, { sessionId: sid });
    await sleep(3000);
    await untilTicks((i) => trial(tag("r." + i), NULLP, { resume: sid }), MAX || 70);
  } else if (block === "Rf") {
    // reads without --resume: re-send the identical filler prompt (same seed) in fresh sessions -> prefix cache hit
    const seed = Number(process.env.QT_SEED); const prompt = filler(seed, LINES) + "\n\n" + NULLP;
    await untilTicks((i) => trial(tag("rf." + i + ".seed" + seed), prompt), MAX || 60);
  } else if (block === "Rt") {
    const sid = fs.readFileSync(SESS, "utf8").trim();
    await untilTicks((i) => trial(tag("r." + i), NULLP, { resume: sid }), MAX || 150);
  } else if (block === "Ot") {
    await untilTicks((i) => trial(tag("o2000." + i), OUTP), MAX || 4);
  } else throw new Error("unknown block " + block);
  await sleep(3000); await trial(tag("end"), NULLP);
}
main().then(() => { setLabel(""); console.log("BLOCK_DONE", model, block); }).catch((e) => { setLabel(""); console.error(String(e)); process.exit(1); });
