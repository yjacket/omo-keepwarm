// `omo-keepwarm habit`, `habit set --return-rate <0-1> --median <dur> --t90 <dur>`, `habit auto`.
import { createConfigSource, updateConfig } from "../config.mjs";
import { readJsonSafe } from "../fsx.mjs";
import { keepwarmHome, layout } from "../paths.mjs";
import { habitText, parseDuration } from "./expiry.mjs";

const USAGE = "usage: omo-keepwarm habit [set --return-rate <0-1> --median <dur> --t90 <dur> | auto]\n";

function show(home, now, io) {
  const src = createConfigSource({ home, now });
  const cfg = src.get();
  const lines = [habitText(src.habit()), `setting ${cfg.habit === "auto" ? "auto" : "manual"}`];
  const b = readJsonSafe(layout(home).behavior);
  if (b && typeof b === "object") {
    lines.push(`behavior.json: ${b.humanReturns ?? "?"} human returns, updated ${b.updatedAt ?? "?"}`);
  }
  io.stdout(lines.join("\n") + "\n");
  return 0;
}

function parseFlags(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) return { error: `unexpected argument ${a}` };
    const eq = a.indexOf("=");
    const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
    const val = eq > 0 ? a.slice(eq + 1) : args[++i];
    if (val === undefined) return { error: `missing value for --${key}` };
    out[key] = val;
  }
  return { flags: out };
}

function set(home, now, args, io) {
  const { flags, error } = parseFlags(args);
  if (error) {
    io.stderr(`habit: ${error}\n${USAGE}`);
    return 2;
  }
  const known = new Set(["return-rate", "median", "t90"]);
  const unknown = Object.keys(flags).filter((k) => !known.has(k));
  if (unknown.length) {
    io.stderr(`habit: unknown option --${unknown[0]}\n${USAGE}`);
    return 2;
  }
  const p = flags["return-rate"] === undefined ? NaN : Number(flags["return-rate"]);
  const m = parseDuration(flags.median);
  const t90 = parseDuration(flags.t90);
  const errs = [];
  if (!(Number.isFinite(p) && p > 0 && p <= 1)) errs.push("--return-rate must be in (0, 1]");
  if (!(Number.isFinite(m) && m > 0)) errs.push("--median must be a positive duration");
  if (!(Number.isFinite(t90) && t90 > 0)) errs.push("--t90 must be a positive duration");
  if (!errs.length && !(m < t90)) errs.push("--median must be shorter than --t90");
  if (errs.length) {
    io.stderr(`habit: ${errs.join("; ")}\n${USAGE}`);
    return 2;
  }
  updateConfig(home, (c) => {
    c.habit = { p, medianMinutes: m, t90Minutes: t90 };
  });
  return show(home, now, io);
}

export async function run(argv, io) {
  const home = keepwarmHome(io.env);
  const now = io.now ?? Date.now;
  if (argv.length === 0) return show(home, now, io);
  if (argv[0] === "set") return set(home, now, argv.slice(1), io);
  if (argv[0] === "auto" && argv.length === 1) {
    updateConfig(home, (c) => {
      c.habit = "auto";
    });
    return show(home, now, io);
  }
  io.stderr(USAGE);
  return 2;
}
