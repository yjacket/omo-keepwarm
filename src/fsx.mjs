import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export function ensureDir(p) {
  mkdirSync(p, { recursive: true });
}

function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

export function readJsonSafe(p) {
  try {
    return JSON.parse(stripBom(readFileSync(p, "utf8")));
  } catch {
    return undefined;
  }
}

const RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

export function atomicWriteJson(p, v) {
  ensureDir(dirname(p));
  const tmp = join(dirname(p), `.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  writeFileSync(tmp, JSON.stringify(v, null, 2) + "\n");
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      renameSync(tmp, p);
      return;
    } catch (err) {
      lastErr = err;
      if (!RETRY_CODES.has(err?.code)) break;
    }
  }
  try {
    rmSync(tmp, { force: true });
  } catch {
    // best-effort temp cleanup; the original error is thrown below
  }
  throw lastErr;
}

export function appendJsonLine(p, v) {
  ensureDir(dirname(p));
  appendFileSync(p, JSON.stringify(v) + "\n");
}

export function readJsonLines(p) {
  let text;
  try {
    text = stripBom(readFileSync(p, "utf8"));
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // skip broken line
    }
  }
  return out;
}
