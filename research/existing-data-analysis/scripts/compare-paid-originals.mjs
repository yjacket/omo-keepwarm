// Compare this analysis's input hashes of the paid originals with the hash list the final
// verification wave recorded on 2026-09-27 (final-successor/paid-originals.after.sha256).
// usage: node compare-paid-originals.mjs <inputs.json> <paid-originals.after.sha256> <idle-live-run dir> <report>
import { readFileSync } from "node:fs"
import { writeOut } from "./common.mjs"

const [inputsPath, listPath, baseDir, report] = process.argv.slice(2)
const inputs = JSON.parse(readFileSync(inputsPath, "utf8")).files
const base = baseDir.replaceAll("\\", "/").replace(/\/$/, "")
let same = 0
const differ = []
const notInInputs = []
for (const line of readFileSync(listPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^([0-9a-f]{64}) \*(.+)$/)
  if (!m) continue
  const p = `${base}/${m[2]}`
  const rec = inputs[p]
  if (!rec) notInInputs.push(m[2])
  else if (rec.sha256 === m[1]) same++
  else differ.push(m[2])
}
const lines = [
  `listed in ${listPath}: ${same + differ.length + notInInputs.length}`,
  `identical to this analysis's input hash: ${same}`,
  `different: ${differ.length}${differ.length ? `\n  ${differ.join("\n  ")}` : ""}`,
  `listed but not an input of this analysis: ${notInInputs.length}${notInInputs.length ? `\n  ${notInInputs.join("\n  ")}` : ""}`,
]
writeOut(report, `${lines.join("\n")}\n`)
console.log(lines.join("\n"))
process.exitCode = differ.length ? 1 : 0
