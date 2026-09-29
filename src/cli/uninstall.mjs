import { formatBusy, formatExcluded, uninstall } from "../install.mjs";

export async function run(argv, io) {
  let result;
  try {
    result = uninstall({ env: io.env, now: io.now, purge: argv.includes("--purge"), force: argv.includes("--force") });
  } catch (err) {
    io.stderr(`uninstall failed: ${err.message}\n`);
    return 1;
  }
  if (result.excluded) io.stdout(formatExcluded(result.excluded));
  if (result.busy) {
    io.stderr(formatBusy(result.busy));
    return 3;
  }
  const purged = result.purged ? ", home purged" : "";
  io.stdout(result.installed ? `uninstalled (config mode off, stub removed${purged})\n` : `not installed${purged}\n`);
  return 0;
}
