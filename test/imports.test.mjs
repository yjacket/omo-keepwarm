import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Every .mjs under a folder, recursively (the .tpl stub is deliberately not one of them). */
function mjsFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...mjsFiles(p));
    else if (e.isFile() && e.name.endsWith(".mjs")) out.push(p);
  }
  return out;
}

/** Static import / export-from specifiers, side-effect imports, and string-literal dynamic import() specifiers. */
export function specifiers(text) {
  const out = [];
  const collect = (re, group) => {
    for (const m of text.matchAll(re)) out.push(m[group]);
  };
  collect(/^\s*(?:import|export)\s[^"'`;]*?\bfrom\s*(["'])([^"']+)\1/gm, 2);
  collect(/^\s*import\s*(["'])([^"']+)\1/gm, 2);
  collect(/\bimport\s*\(\s*(["'])([^"']+)\1\s*\)/g, 2);
  return out;
}

const allowed = (spec) => spec.startsWith("node:") || spec.startsWith("./") || spec.startsWith("../");

const files = [...mjsFiles(join(REPO, "src")), ...mjsFiles(join(REPO, "extension"))];

test("the specifier scanner sees every import form", () => {
  const sample = [
    'import a from "node:fs";',
    'import { b,',
    "  c } from './x.mjs';",
    'import * as d from "../y.mjs";',
    'import "side-effect";',
    'export { e } from "@code-yeongyu/senpi";',
    'export * from "left-pad";',
    'const m = await import("dyn-pkg");',
    "const n = import(`./${name}.mjs`);",
    '// import z from "in-a-comment";',
  ].join("\n");
  assert.deepEqual(specifiers(sample).sort(), ["../y.mjs", "./x.mjs", "@code-yeongyu/senpi", "dyn-pkg", "left-pad", "node:fs", "side-effect"]);
});

test("src/ and extension/ .mjs files are found, including the entry files", () => {
  const rel = files.map((f) => relative(REPO, f).replaceAll("\\", "/"));
  assert.ok(rel.includes("src/status.mjs"));
  assert.ok(rel.includes("src/cli/install.mjs"), "subfolders are scanned");
  assert.ok(rel.includes("extension/import-fresh.mjs"));
  assert.ok(rel.every((r) => r.endsWith(".mjs")), "the .tpl stub is excluded");
  assert.ok(files.flatMap((f) => specifiers(readFileSync(f, "utf8"))).length > 20, "the scan finds real imports");
});

// Loads the running senpi's own files by path (found from the CLI entry senpi was started with), so it names the
// package directory; it still imports nothing by package specifier.
const NAMES_HOST_PATH = new Set(["src/subscription-warm.mjs"]);

for (const file of files) {
  const rel = relative(REPO, file).replaceAll("\\", "/");
  test(`${rel} names no host package and imports only node:* or relative paths`, () => {
    const text = readFileSync(file, "utf8");
    if (!NAMES_HOST_PATH.has(rel)) {
      assert.ok(!text.includes("@earendil-works"), `${rel} mentions @earendil-works`);
      assert.ok(!text.includes("@code-yeongyu"), `${rel} mentions @code-yeongyu`);
    }
    const bad = specifiers(text).filter((s) => !allowed(s));
    assert.deepEqual(bad, [], `${rel} imports ${bad.join(", ")}`);
  });
}
