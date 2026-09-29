import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pointAtDevRoot, stubContent } from "../install.mjs";

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

/** QA only: write the fixed stub to --out; --dev-root also points a temp home's current.json at a checkout. */
export async function run(argv, io) {
  const out = arg(argv, "--out");
  if (!out) {
    io.stderr("usage: render-stub --out <file> [--dev-root <dir>]\n");
    return 2;
  }
  const devRoot = arg(argv, "--dev-root");
  if (argv.includes("--dev-root") && !devRoot) {
    io.stderr("--dev-root needs a directory\n");
    return 2;
  }
  if (devRoot && !io.env.OMO_KEEPWARM_HOME) {
    io.stderr("--dev-root refuses the real home: set OMO_KEEPWARM_HOME to a temp folder\n");
    return 2;
  }
  const file = resolve(io.cwd ?? ".", out);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, stubContent());
  if (devRoot) {
    const current = pointAtDevRoot(io.env, resolve(io.cwd ?? ".", devRoot));
    io.stdout(`current.json -> ${current.version} ${current.root}\n`);
  }
  io.stdout(`stub written to ${file}\n`);
  return 0;
}
