#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const COMMANDS = [
  "install",
  "update",
  "uninstall",
  "doctor",
  "status",
  "report",
  "calibrate",
  "expiry",
  "habit",
  "render-stub",
];

const here = dirname(fileURLToPath(import.meta.url));

function usage() {
  return `omo-keepwarm <command> [options]\n\nCommands:\n${COMMANDS.map((c) => `  ${c}`).join("\n")}\n`;
}

export async function main(argv, io) {
  const [cmd, ...rest] = argv;
  if (cmd === undefined || cmd === "--help" || cmd === "-h" || cmd === "help") {
    io.stdout(usage());
    return 0;
  }
  if (!COMMANDS.includes(cmd)) {
    io.stderr(`unknown command: ${cmd}\n${usage()}`);
    return 64;
  }
  const file = join(here, "..", "src", "cli", `${cmd}.mjs`);
  if (!existsSync(file)) {
    io.stderr(`${cmd}: not implemented\n`);
    return 70;
  }
  const mod = await import(pathToFileURL(file).href);
  return (await mod.run(rest, io)) ?? 0;
}

const invoked = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invoked) {
  const io = {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    env: process.env,
    now: Date.now,
    cwd: process.cwd(),
  };
  process.exitCode = await main(process.argv.slice(2), io);
}
