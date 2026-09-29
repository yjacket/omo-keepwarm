// Keeps README.md and docs/*.md honest against the code.
// KEEPWARM_DOCS_README points the README checks at another file (used for mutation checks).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { classifyLane } from "../src/lanes.mjs";
import { run as expiryRun } from "../src/cli/expiry.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readmePath = process.env.KEEPWARM_DOCS_README ? resolve(process.env.KEEPWARM_DOCS_README) : join(root, "README.md");
const readme = readFileSync(readmePath, "utf8").replace(/\r\n/g, "\n");

// Tiny fake of the pi-ai helpers the classifier consults.
const piAi = {
  isAnthropicApiBaseUrl(url) {
    try {
      return new URL(url).hostname === "api.anthropic.com";
    } catch {
      return false;
    }
  },
  isOpenAIResponsesPromptCacheModel(model) {
    return model?.api === "openai-responses" && model?.provider === "openai";
  },
  resolvePromptCacheTtlSeconds() {
    return undefined;
  },
};

const MODELS = {
  "claude-subscription": { provider: "anthropic", api: "claude-sdk-oauth", id: "claude-opus-5-5", baseUrl: "https://api.anthropic.com" },
  "codex-subscription": { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.6-sol", baseUrl: "https://chatgpt.com/backend-api" },
  "anthropic-api": {
    provider: "anthropic", api: "anthropic-messages", id: "claude-opus-5", baseUrl: "https://api.anthropic.com/v1",
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
  "openai-api": {
    provider: "openai", api: "openai-responses", id: "gpt-5.6", baseUrl: "https://api.openai.com/v1",
    cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.5625 },
  },
  "github-copilot": { provider: "github-copilot", api: "openai-completions", id: "gpt-5.6-sol", baseUrl: "https://api.githubcopilot.com" },
  devin: { provider: "devin", api: "devin-agent", id: "swe-2-high", baseUrl: "https://api.devin.ai" },
  other: { provider: "acme", api: "openai-completions", id: "mystery", baseUrl: "https://llm.acme.example/v1" },
};

// 가능 = a warm path exists; 미확인 = unknown lane; 불가 = known lane without a usable path.
function verdict(lane) {
  if (lane.warmPath === "warmPromptCache") return "가능";
  if (lane.id === "other") return "미확인";
  return "불가";
}

function laneTable(md) {
  const lines = md.split("\n");
  const head = lines.findIndex((l) => /^\|\s*lane id\s*\|/.test(l));
  assert.notEqual(head, -1, "README has a lane table");
  const cols = lines[head].split("|").slice(1, -1).map((c) => c.trim());
  const idCol = cols.indexOf("lane id");
  const verdictCol = cols.indexOf("판정");
  assert.ok(verdictCol > 0, "lane table has a 판정 column");
  const rows = [];
  for (let i = head + 2; i < lines.length && lines[i].startsWith("|"); i++) {
    const cells = lines[i].split("|").slice(1, -1).map((c) => c.trim());
    rows.push({ id: cells[idCol].replace(/`/g, ""), verdict: cells[verdictCol] });
  }
  return rows;
}

test("README lane table verdicts match classifyLane()", () => {
  const rows = laneTable(readme);
  assert.deepEqual(rows.map((r) => r.id).sort(), Object.keys(MODELS).sort());
  for (const row of rows) {
    const lane = classifyLane(MODELS[row.id], { piAi });
    assert.equal(lane.id, row.id, `representative model for ${row.id}`);
    assert.equal(row.verdict, verdict(lane), `${row.id} verdict`);
    if (row.verdict === "가능") assert.equal(lane.verified, false, `${row.id} is off by default`);
  }
});

test("README expiry block equals real `expiry` output with the default habit", async () => {
  const home = mkdtempSync(join(tmpdir(), "keepwarm-docs-"));
  try {
    let out = "";
    const code = await expiryRun([], {
      env: { OMO_KEEPWARM_HOME: home },
      now: Date.now,
      stdout: (s) => (out += s),
      stderr: (s) => assert.fail(s),
    });
    assert.equal(code, 0);
    const m = /\$ omo-keepwarm expiry\n```\n\n```text\n([\s\S]*?)```/.exec(readme);
    assert.ok(m, "README has an expiry output block after `$ omo-keepwarm expiry`");
    assert.equal(m[1], out);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("relative markdown links in README.md and docs/*.md resolve", () => {
  const files = [readmePath, ...readdirSync(join(root, "docs")).filter((n) => n.endsWith(".md")).map((n) => join(root, "docs", n))];
  const broken = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const [, raw] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^[a-z]+:/i.test(raw) || raw.startsWith("#")) continue;
      const target = decodeURI(raw.split("#")[0]);
      // A README copy elsewhere still resolves against the repo root.
      const base = file === readmePath ? root : dirname(file);
      if (!existsSync(resolve(base, target))) broken.push(`${file}: ${raw}`);
    }
  }
  assert.deepEqual(broken, []);
});
