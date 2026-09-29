import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const STALE_RE = /stale extension generation/i;

export function createSafe({ logFile, now = Date.now, maxDistinctErrors = 5, onDisable } = {}) {
  const seen = new Set();
  let off = false;
  let count = 0;

  function log(name, message) {
    if (!logFile) return;
    try {
      mkdirSync(dirname(logFile), { recursive: true });
      appendFileSync(logFile, `${new Date(now()).toISOString()} ${name} ${message}\n`);
    } catch {
      // logging must never throw
    }
  }

  function fail(name, err) {
    const message = String(err?.message ?? err);
    count++;
    const key = `${name}\u0000${message}`;
    if (!seen.has(key)) {
      seen.add(key);
      log(name, message);
    }
    if (!off && (STALE_RE.test(message) || seen.size >= maxDistinctErrors)) {
      off = true;
      try {
        onDisable?.({ name, message });
      } catch {
        // onDisable errors are ignored
      }
    }
  }

  function wrap(name, fn) {
    return (...args) => {
      if (off) return undefined;
      try {
        const r = fn(...args);
        if (r && typeof r.then === "function") {
          return r.then(undefined, (err) => {
            fail(name, err);
            return undefined;
          });
        }
        return r;
      } catch (err) {
        fail(name, err);
        return undefined;
      }
    };
  }

  return { wrap, disabled: () => off, errorCount: () => count };
}
