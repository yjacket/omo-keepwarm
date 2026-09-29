import { formatBusy, formatExcluded, install } from "../install.mjs";

export async function run(argv, io) {
  const force = argv.includes("--force");
  let result;
  try {
    result = install({ env: io.env, now: io.now, force });
  } catch (err) {
    io.stderr(`install failed: ${err.message}\n`);
    return 1;
  }
  if (result.excluded) io.stdout(formatExcluded(result.excluded));
  if (result.busy) {
    io.stderr(formatBusy(result.busy));
    return 3;
  }
  io.stdout(`installed ${result.version} (stub ${result.stub})\n`);
  return 0;
}
