import test from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentDir, healthHome, keepwarmHome, layout, localDate, localMonth } from "../src/paths.mjs";

test("env overrides and precedence", () => {
  assert.equal(keepwarmHome({ OMO_KEEPWARM_HOME: "/k" }), "/k");
  assert.equal(healthHome({ OMO_HEALTH_HOME: "/h" }), "/h");
  assert.equal(agentDir({ OMO_CODING_AGENT_DIR: "/a", SENPI_CODING_AGENT_DIR: "/b", PI_CODING_AGENT_DIR: "/c" }), "/a");
  assert.equal(agentDir({ SENPI_CODING_AGENT_DIR: "/b", PI_CODING_AGENT_DIR: "/c" }), "/b");
  assert.equal(agentDir({ PI_CODING_AGENT_DIR: "/c" }), "/c");
});

test("defaults derive from homedir", () => {
  assert.equal(keepwarmHome({}), join(homedir(), ".omo-keepwarm"));
  assert.equal(healthHome({}), join(homedir(), ".omo-health"));
  assert.equal(agentDir({}), join(homedir(), ".omo", "agent"));
});

test("localDate/localMonth use local calendar", () => {
  const ms = new Date(2026, 0, 5, 23, 30).getTime();
  assert.equal(localDate(ms), "2026-01-05");
  assert.equal(localMonth(ms), "2026-01");
});

test("layout shapes", () => {
  const h = join("/", "home");
  const l = layout(h);
  const ms = new Date(2026, 8, 9, 12).getTime();
  assert.equal(l.config, join(h, "config.json"));
  assert.equal(l.behavior, join(h, "behavior.json"));
  assert.equal(l.recordFile("s1", ms), join(h, "records", "2026-09", "s1.jsonl"));
  assert.equal(l.sessionStatus("s1"), join(h, "status", "s1.json"));
  assert.equal(l.globalStatus, join(h, "status", "_global.json"));
  assert.equal(l.spendFile("2026-09-09"), join(h, "ledger", "spend-2026-09-09.jsonl"));
  assert.equal(l.dayFile("2026-09-09"), join(h, "ledger", "day-2026-09-09.jsonl"));
  assert.equal(l.errorLog, join(h, "logs", "errors.log"));
  assert.equal(l.stubLog, join(h, "logs", "stub.log"));
  assert.equal(l.currentFile, join(h, "app", "current.json"));
  assert.equal(l.releasesDir, join(h, "app", "releases"));
  assert.equal(l.loadedMarker("0.1.0"), join(h, "app", "loaded", "0.1.0"));
  assert.equal(l.recordsDir, join(h, "records"));
  assert.equal(l.statusDir, join(h, "status"));
  assert.equal(l.logsDir, join(h, "logs"));
  assert.equal(l.appDir, join(h, "app"));
});
