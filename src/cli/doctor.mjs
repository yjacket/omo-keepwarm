import { doctor, formatDoctor } from "../install.mjs";

export async function run(_argv, io) {
  const rows = doctor({ env: io.env, now: io.now });
  io.stdout(formatDoctor(rows));
  return rows.some((r) => r.status === "FAIL") ? 1 : 0;
}
