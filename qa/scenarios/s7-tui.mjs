// S7 TUI (mode on): the real senpi TUI (no --mode rpc) on a real TTY, 120x40.
//   type "hello"+Enter -> reply -> episode_open -> >= 2 ok warm pings -> type "bye"+Enter -> episode_close human_return
//   input:interactive -> quit. Checks: source input:interactive; nothing keepwarm-ish on screen after the first reply;
//   the session JSONL carries no keepwarm entry; transcript.ansi / transcript.txt kept.
// TTY backend: qa/pty-driver.mjs (pi-pty when it has a native prebuild, else the Windows ConPTY host).
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startScenario, sessionAdditions, pidAlive } from "./lib.mjs";
import { discoverModel, startPtySenpi, stripAnsi } from "../pty-driver.mjs";

const NAME = "s7-tui";
const DEBUG = process.env.KW_QA_DEBUG === "1";
const s = await startScenario({ name: NAME, taskDir: "task-12", config: "config-on", behavior: "behavior-fast", senpi: false });
const t0 = Date.now();
let tui = null;
let stopInfo = null;
let screenshot = { produced: false, reason: "not attempted" };

const dumpScreen = async (label) => {
  if (!DEBUG || !tui) return;
  const snap = await tui.screen();
  console.log(`---- screen: ${label} ----\n${snap.visibleGrid.map((l) => l.trimEnd()).join("\n").replace(/\n+$/, "")}\n----`);
};

try {
  if (s.startError) throw s.startError;
  const model = await discoverModel({ tmp: join(s.tmp, "probe"), env: s.launchEnv() });
  s.model = model;
  tui = await startPtySenpi({
    tmp: join(s.tmp, "tui"),
    extensions: s.extensionArgs(),
    env: s.launchEnv(),
    model: { provider: model.provider, modelId: model.modelId },
    cols: 120,
    rows: 40,
  });
  s.check("senpi TUI started on a real TTY (120x40), no --mode rpc", !tui.args.includes("--mode") && tui.pid > 0, `backend=${tui.backend}; ${tui.backendNote}; args=${tui.args.join(" ")}`);

  // A fresh cwd raises senpi's "Trust project folder?" dialog: pick "Trust (this session only)" (down, down, enter).
  await tui.waitForText(/Trust project folder\?/, 60000);
  tui.write("\u001b[B");
  tui.write("\u001b[B");
  tui.press("enter");
  s.check("trust dialog answered with Trust (this session only)", true, "empty temp cwd, no .senpi content to trust");

  // Ready: keepwarm's session_start record exists and the loading spinner is gone.
  await s.waitForRecord((r) => r.type === "session", 60000);
  await tui.waitForOutput((t) => /hello|Ask|message|Type|>/i.test(t.slice(-3000)) && !/Loading senpi/.test(t.slice(-600)), 60000);
  await dumpScreen("ready");

  // Turn 1
  tui.write("hello");
  tui.press("enter");
  const open1 = await s.waitForRecord((r) => r.type === "episode_open", 60000);
  const firstReplyMark = tui.mark();
  await dumpScreen("after first reply");
  s.check("first reply arrived and the episode opened", Boolean(open1.episode), `episode=${open1.episode} expiry=${JSON.stringify(open1.expiry)} mode=${open1.mode}`);
  const chatsAfterFirst = s.mock.requests().filter((r) => r.kind === "chat").length;
  s.check("mock served one streaming chat for the first message", chatsAfterFirst === 1, `chat=${chatsAfterFirst}`);

  // >= 2 warm pings recorded (mode on)
  // Waits for the second ok ping, or for keepwarm to stop warming (warm_stop / expire), whichever comes first;
  // the checks below then judge what happened. The flow continues either way so the other checks still run.
  await s.waitForRecord((r) => {
    if (r.episode !== open1.episode) return false;
    return (
      s.records("ping").filter((p) => p.episode === open1.episode && p.ok === true).length >= 2 ||
      (r.type === "warm_stop") ||
      (r.type === "decision" && r.action === "expire")
    );
  }, 60000).catch(() => null);
  const stops = s.records("warm_stop").filter((w) => w.episode === open1.episode);
  const pings = s.records("ping").filter((p) => p.episode === open1.episode);
  s.check("at least 2 ok warm pings recorded before the return", pings.filter((p) => p.ok === true).length >= 2, `pings=${pings.map((p) => `ok=${p.ok}/hit=${p.hit}/${p.error?.kind ?? "-"}`).join(",") || "none"} warm_stop=${stops.map((w) => w.reason).join(",") || "none"}`);
  const warmReqs = s.mock.requests().filter((r) => r.kind === "warm");
  s.check("the mock received the warm requests (non-stream, max_tokens 0)", warmReqs.length >= 2 && warmReqs.every((r) => r.body?.max_tokens === 0 && r.body?.stream !== true), `warm=${warmReqs.length} max_tokens=${warmReqs.map((r) => r.body?.max_tokens).join(",")}`);

  // Turn 2: the return
  tui.write("bye");
  tui.press("enter");
  const close1 = await s.waitForRecord((r) => r.type === "episode_close" && r.episode === open1.episode, 60000);
  s.check(
    "(a) episode closed as human_return with source input:interactive",
    close1.kind === "human_return" && close1.source === "input:interactive",
    `kind=${close1.kind} source=${close1.source} awayMin=${close1.awayMin?.toFixed?.(3)} pings=${close1.pings}`,
  );
  const open2 = await s.waitForRecord((r) => r.type === "episode_open" && r.episode !== open1.episode, 60000);
  await dumpScreen("after bye reply");
  s.check("second reply arrived and a new episode opened", Boolean(open2.episode), `episode=${open2.episode}`);

  // Leave the TUI through the keyboard; the shutdown closes the second episode.
  const beforeQuit = tui.mark();
  let exitedGracefully = false;
  let quitKeys = "none";
  for (const [label, keys] of [["Ctrl-D", ["\u0004"]], ["Ctrl-C twice", ["\u0003", "\u0003"]], ["/quit", ["/quit", "\r"]]]) {
    for (const k of keys) tui.write(k);
    try {
      await tui.waitForExit(6000);
      exitedGracefully = true;
      quitKeys = label;
      break;
    } catch {
      // try the next way out
    }
  }
  await dumpScreen("after quit keys");
  s.check("the TUI exited from the keyboard without being killed", exitedGracefully, exitedGracefully ? `exited on ${quitKeys}` : `still running after Ctrl-D, Ctrl-C x2 and /quit; tail=${JSON.stringify(stripAnsi(tui.transcript().slice(beforeQuit)).slice(-300))}`);

  // (b) silence: ANSI-stripped output after the first reply
  const after = stripAnsi(tui.transcript().slice(firstReplyMark));
  const hits = after.match(/keepwarm|warm ping|⚡/gi) ?? [];
  s.check("(b) ANSI-stripped output after the first reply has 0 matches of /keepwarm|warm ping|⚡/i", hits.length === 0, `bytes after first reply=${after.length} matches=${hits.length}`);
  const rendered = await tui.screen();
  const renderedText = [...rendered.scrollback, ...rendered.visibleGrid].join("\n");
  const renderedHits = renderedText.match(/warm ping|⚡/gi) ?? [];
  s.check("rendered final screen and scrollback show no warm ping or lightning marker", renderedHits.length === 0, `matches=${renderedHits.length}`);

  // (c) session JSONL
  const entries = s.sessionEntries(tui);
  const adds = sessionAdditions(entries);
  s.check(
    "(c) the session JSONL has no keepwarm-added entry (only user/assistant messages plus host entries)",
    entries.length > 0 && adds.additions.length === 0,
    `entries=${entries.length} messages=${adds.messages} hostCustomTypes=${adds.hostCustomTypes.join(",")} additions=${adds.additions.length}`,
  );

  const close2 = s.records("episode_close").find((r) => r.episode === open2.episode);
  s.check("the second episode was closed by the session shutdown (censored)", close2?.kind === "censored" && close2.source === "session_shutdown", JSON.stringify(close2 ? { kind: close2.kind, source: close2.source, detail: close2.detail } : null));

  // Transcript and rendered screen evidence
  writeFileSync(join(s.evid, "transcript.ansi"), tui.transcript());
  writeFileSync(join(s.evid, "transcript.txt"), stripAnsi(tui.transcript()));
  writeFileSync(join(s.evid, "screen-final.txt"), rendered.visibleGrid.map((l) => l.trimEnd()).join("\n") + "\n");
  screenshot = {
    produced: false,
    reason:
      "no image screenshot: this run has no browser/xterm.js rendering tool available to a Node script; the equivalent evidence is the pi-pty TerminalScreen (headless xterm) render of the final screen in screen-final.txt, plus transcript.ansi and transcript.txt",
  };
} catch (e) {
  s.check("scenario ran without fatal error", false, String(e?.stack ?? e));
  if (tui) {
    try {
      writeFileSync(join(s.evid, "transcript.ansi"), tui.transcript());
      writeFileSync(join(s.evid, "transcript.txt"), stripAnsi(tui.transcript()));
      const snap = await tui.screen();
      writeFileSync(join(s.evid, "screen-final.txt"), snap.visibleGrid.map((l) => l.trimEnd()).join("\n") + "\n");
    } catch {
      // best effort
    }
  }
} finally {
  if (tui) {
    try {
      stopInfo = await tui.stop();
    } catch (err) {
      stopInfo = { error: String(err.message) };
    }
    const dst = join(s.evid, "session");
    for (const f of s.sessionFiles(tui.sessionDir)) {
      mkdirSync(dst, { recursive: true });
      copyFileSync(f, join(dst, f.slice(tui.sessionDir.length + 1).replace(/[\\/]/g, "_")));
    }
    if (existsSync(tui.extLog)) copyFileSync(tui.extLog, join(s.evid, "ext.log"));
    writeFileSync(join(s.evid, "tui-args.txt"), `backend: ${tui.backend}\nnote: ${tui.backendNote}\nargs: senpi ${tui.args.join(" ")}\nmodel: ${JSON.stringify(tui.model)}\n`);
  }
}
const pidGone = !tui || !tui.pid || !pidAlive(tui.pid);
const extra = [{ name: "TUI process tree stopped and pid is gone", pass: pidGone, detail: `pid=${tui?.pid} stop=${JSON.stringify(stopInfo)}` }];
const pass = await s.finish(extra);
try {
  const file = join(s.evid, "result.json");
  const result = JSON.parse(readFileSync(file, "utf8"));
  result.screenshot = screenshot;
  result.tty = tui ? { backend: tui.backend, note: tui.backendNote } : null;
  writeFileSync(file, JSON.stringify(result, null, 2) + "\n");
} catch (e) {
  console.error(`result.json annotate failed: ${e.message}`);
}
console.log(`${pass ? "SCENARIO PASS" : "SCENARIO FAIL"} ${NAME} (${((Date.now() - t0) / 1000).toFixed(1)} s) -> ${s.evid}`);
process.exit(pass ? 0 : 1);
