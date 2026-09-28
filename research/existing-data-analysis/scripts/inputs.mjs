// Input inventory and integrity check (read-only).
//   node inputs.mjs --write <inputs.json>          record size, line count and sha256 of every input
//   node inputs.mjs --verify <inputs.json> --report <file>
//       re-hash; a file that only grew (a live session appending) is checked on its recorded prefix
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { DEFAULTS, listFiles, parseArgs, sha256File, stable, writeOut } from "./common.mjs"

const args = parseArgs(process.argv.slice(2))

function inventory() {
  const groups = {
    rolloverEventLog: [...listFiles(join(DEFAULTS.rolloverDir, "sessions"), { filter: (p) => p.endsWith(".jsonl") }), `${DEFAULTS.rolloverDir}/summary.jsonl`],
    senpiTranscripts: [],
    firstRun: listFiles(DEFAULTS.firstRun, { recursive: true }),
    rerun: listFiles(DEFAULTS.rerun, { recursive: true }),
    quota0919: listFiles(DEFAULTS.quota0919),
  }
  for (const name of readdirSync(DEFAULTS.sessionsDir).sort()) {
    const dir = `${DEFAULTS.sessionsDir}/${name}`
    if (!statSync(dir).isDirectory()) continue
    for (const f of listFiles(dir, { filter: (p) => p.endsWith(".jsonl") }))
      if (!DEFAULTS.excludeSessions.some((s) => f.includes(s))) groups.senpiTranscripts.push(f)
  }
  return groups
}

const lineCount = (p) => {
  let n = 0
  for (const b of readFileSync(p)) if (b === 10) n++
  return n
}

if (args.write) {
  const groups = inventory()
  const files = {}
  for (const [g, list] of Object.entries(groups))
    for (const p of list) {
      const st = statSync(p)
      files[p] = { group: g, bytes: st.size, lines: p.endsWith(".jsonl") ? lineCount(p) : null, sha256: sha256File(p) }
    }
  const counts = Object.fromEntries(Object.entries(groups).map(([g, l]) => [g, l.length]))
  writeOut(args.write, stable({ v: "idle-existing-data-analysis/inputs/1", excludedSessions: DEFAULTS.excludeSessions, counts, files }))
  console.log(`inventory: ${Object.keys(files).length} files -> ${args.write}`)
} else if (args.verify) {
  const before = JSON.parse(readFileSync(args.verify, "utf8"))
  let same = 0
  let grewPrefixSame = 0
  const changed = []
  const missing = []
  const byGroup = {}
  for (const [p, rec] of Object.entries(before.files)) {
    byGroup[rec.group] ??= { files: 0, identical: 0, appendOnly: 0, changedOrMissing: 0 }
    byGroup[rec.group].files++
    if (!existsSync(p)) {
      missing.push(p)
      byGroup[rec.group].changedOrMissing++
      continue
    }
    const st = statSync(p)
    if (st.size === rec.bytes && sha256File(p) === rec.sha256) {
      same++
      byGroup[rec.group].identical++
    } else if (st.size > rec.bytes && sha256File(p, rec.bytes) === rec.sha256) {
      grewPrefixSame++
      byGroup[rec.group].appendOnly++
    } else {
      changed.push(p)
      byGroup[rec.group].changedOrMissing++
    }
  }
  const lines = [
    `files recorded: ${Object.keys(before.files).length}`,
    `identical: ${same}`,
    `grew by appending only (recorded prefix identical): ${grewPrefixSame}`,
    `changed: ${changed.length}${changed.length ? `\n  ${changed.join("\n  ")}` : ""}`,
    `missing: ${missing.length}${missing.length ? `\n  ${missing.join("\n  ")}` : ""}`,
    `by group: ${JSON.stringify(byGroup)}`,
  ]
  writeOut(args.report, `${lines.join("\n")}\n`)
  console.log(lines.join("\n"))
  process.exitCode = changed.length || missing.length ? 1 : 0
} else {
  console.error("usage: node inputs.mjs --write <inputs.json> | --verify <inputs.json> --report <file>")
  process.exitCode = 2
}
