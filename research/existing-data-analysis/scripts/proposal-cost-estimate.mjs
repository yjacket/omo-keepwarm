// Spend estimate for the proposed (not executed) measurements, from the rerun's own usage converted
// with the d8a4abd conversion ends. An estimate, not a quote: the output coefficient is an upper bound.
// usage: node proposal-cost-estimate.mjs --repo <analysis worktree> --rerun <dir> --out <file>
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { parseArgs, stable, writeOut, round } from "./common.mjs"

const args = parseArgs(process.argv.slice(2))
const { conversionEnds, convertSums, sumRecords } = await import(pathToFileURL(join(args.repo, "scripts/idle-live-analyze.mjs")).href)
const results = JSON.parse(readFileSync(join(args.repo, "docs/idle-live-results.json"), "utf8"))
const T = results.experiments["fable-write-tick"].findings.intersectedT
const kOutUB = results.experiments["output-quota"].findings.kOutUpperBound
const ends = conversionEnds({ T: { lo: T.lo, hi: T.hi }, kOut: null, kOutUpperBound: kOutUB, meter: "unified-5h" })
const rows = readFileSync(join(args.rerun, "requests.jsonl"), "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
const eq = (rs) => {
  const c = convertSums(sumRecords(rs), ends)
  return [round(c.lo, 5), round(c.hi, 5)]
}
const pe = rows.filter((r) => r.experiment === "policy-effect")
const oq = rows.filter((r) => r.experiment === "output-quota")
const out = {
  meter: "unified-5h utilization fraction (0.01 = one tick)",
  policyEffectPerPair: [1, 2, 3].map((p) => ({ pair: p, requests: pe.filter((r) => r.run === p).length, eq: eq(pe.filter((r) => r.run === p)) })),
  policyEffectThreePairs: eq(pe),
  outputQuota: { requests: oq.length, outputTokens: oq.reduce((a, r) => a + (r.usage?.output_tokens ?? 0), 0), eq: eq(oq) },
}
writeOut(args.out, stable(out))
console.log(JSON.stringify(out))
