// Reproduction (fake host, no network, no model): the extension's own "/rollover now" dispatch
// after an idle park reaches the typed-command handler, which closes the idle-cost shadow episode
// as "returned" and moves the user clock, although no user input happened.
// Writes only under <evidence>/tmp/repro-<pid> and removes that exact directory at the end.
// usage: node repro-self-dispatch-shadow.mjs --repo <analysis worktree> --tmp <dir> --out <file>
import { mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { parseArgs, writeOut } from "./common.mjs"

const args = parseArgs(process.argv.slice(2))
const { createRollover } = await import(pathToFileURL(join(args.repo, "extension/rollover.ts")).href)
const dir = join(args.tmp, `repro-${process.pid}`)
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, "config.json"), JSON.stringify({ idleCostMode: "shadow", idleMinutes: 1, idleGraceMinutes: 1, idleMinTokens: 1000 }))

const hooks = {}
const bus = {}
const sent = []
let handler = null
let clock = 0
let branch = []
const ctx = {
  cwd: dir,
  model: { id: "fixture-model", provider: "fixture-lane" },
  isIdle: () => true,
  hasPendingMessages: () => false,
  getContextUsage: () => ({ tokens: 150000 }),
  ui: { notify() {} },
  sessionManager: { getSessionId: () => "s1", getBranch: () => branch, getHeader: () => ({}), getSessionFile: () => join(dir, "s1.jsonl") },
  newSession: async () => ({ cancelled: false }),
  shutdown: () => {},
}
const ext = createRollover(
  {
    on: (e, fn) => {
      hooks[e] = fn
    },
    events: {
      on: (e, fn) => {
        bus[e] = fn
      },
    },
    registerCommand: (_name, spec) => {
      handler = spec.handler
    },
    sendUserMessage: (text) => {
      sent.push(String(text))
    },
  },
  {
    env: { OMO_ROLLOVER_DIR: dir },
    now: () => new Date(clock),
    goalStatus: async () => null,
    pauseGoal: async () => ({ ok: false, method: "none" }),
    resumeGoal: async () => ({ ok: true, method: "main" }),
    timer: { setInterval: (fn) => ({ fn }), clearInterval: () => {} },
  },
)
const fire = (e, data = {}) => hooks[e]?.(data, ctx)
const rows = () => (existsSync(join(dir, "sessions/s1.jsonl")) ? readFileSync(join(dir, "sessions/s1.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [])

await fire("session_start")
bus.wake_source_state?.({ source: "senpi-task", activeCount: 0 })
await fire("message_end", { message: { role: "assistant", content: "done", usage: { input: 1, output: 1, cacheRead: 150000, cacheWrite: 0 } } })
await fire("agent_settled")
clock += 3 * 60000
await ext.tick() // idle park: arms and sends the handoff prompt (delivered by the host as extension input)
const handoffSent = sent.some((s) => s.length > 0 && !s.startsWith("/rollover"))
await fire("input", { source: "extension", text: "handoff prompt" })
branch = [{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "wrote handoff\n<successor>continue from the handoff file</successor>" }] } }]
await fire("agent_settled") // tryRollover: successor found -> the extension sends "/rollover now" itself
const selfDispatch = sent.includes("/rollover now")
const userClockBefore = ext.clocks?.().lastUserAt ?? null
if (selfDispatch && handler) await handler("now", ctx) // the host routes the dispatched command to the handler
const userClockAfter = ext.clocks?.().lastUserAt ?? null

const log = rows()
const shadow = log.filter((r) => r.ev === "idle_cost_shadow")
const lastShadow = shadow.at(-1) ?? null
const interactiveInputs = log.filter((r) => r.ev === "user_input" && r.source !== "extension").length
const result = {
  idleParkLogged: log.some((r) => r.ev === "idle_park"),
  handoffPromptSent: handoffSent,
  successorFoundLogged: log.some((r) => r.ev === "successor_found"),
  extensionSentRolloverNow: selfDispatch,
  commandLoggedAfterSuccessor: log.findIndex((r) => r.ev === "command") > log.findIndex((r) => r.ev === "successor_found"),
  interactiveUserInputs: interactiveInputs,
  lastShadowEpisodeStatus: lastShadow?.episodeStatus ?? null,
  lastShadowEpisodeEndReason: lastShadow?.episodeEndReason ?? null,
  userClockMovedByDispatch: userClockBefore !== null && userClockAfter !== null ? userClockAfter !== userClockBefore : "clocks() unavailable",
}
await fire("session_shutdown", { reason: "quit" })
rmSync(dir, { recursive: true, force: true })
result.tmpRemoved = !existsSync(dir)
result.defectReproduced = result.extensionSentRolloverNow && result.interactiveUserInputs === 0 && result.lastShadowEpisodeStatus === "returned" && result.lastShadowEpisodeEndReason === "command"
writeOut(args.out, `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify(result))
