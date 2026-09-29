// `omo-keepwarm report [--days 7] [--json]`.
import { keepwarmHome } from "../paths.mjs";
import { buildReport, formatReport } from "../report.mjs";

export async function run(argv, io) {
  let days = 7;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") json = true;
    else if (a === "--days" || a.startsWith("--days=")) {
      const v = Number(a === "--days" ? argv[++i] : a.slice(7));
      if (!(Number.isInteger(v) && v > 0)) {
        io.stderr("report: --days must be a positive integer\n");
        return 2;
      }
      days = v;
    } else {
      io.stderr(`report: unknown argument ${a}\nusage: omo-keepwarm report [--days 7] [--json]\n`);
      return 2;
    }
  }
  const r = buildReport(keepwarmHome(io.env), { days, now: io.now ?? Date.now });
  io.stdout(json ? JSON.stringify(r, null, 2) + "\n" : formatReport(r));
  return 0;
}
