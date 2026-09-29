// omo-keepwarm stub, format __STUB_FORMAT__. Installed by `omo-keepwarm install`; removed by `omo-keepwarm uninstall`.
// This file names no version and no path, so installs and updates never rewrite it (a rewrite reloads every open
// session). It loads the runtime named by <keepwarmHome>/app/current.json: its root, then its last known good root.
// If neither loads it leaves one line in <keepwarmHome>/logs/stub.log and stays inert.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import * as piAi from "@earendil-works/pi-ai";
import * as senpi from "@code-yeongyu/senpi";

function keepwarmHome() {
	return process.env.OMO_KEEPWARM_HOME || join(homedir(), ".omo-keepwarm");
}

/** Leave a trace for `omo-keepwarm doctor`; one line per failed load. */
function logFailure(message: any) {
	try {
		const dir = join(keepwarmHome(), "logs");
		mkdirSync(dir, { recursive: true });
		appendFileSync(join(dir, "stub.log"), `${new Date().toISOString()} pid=${process.pid} ${String(message).replace(/\s+/g, " ").slice(0, 2000)}\n`);
	} catch {
		// nothing else to do
	}
}

/** current.root, then lkg.root; read once at load time, never again in this session. */
function candidates(errors: any[]) {
	const out: any[] = [];
	try {
		const current = JSON.parse(readFileSync(join(keepwarmHome(), "app", "current.json"), "utf8").replace(/^\uFEFF/, ""));
		for (const entry of [current, current?.lkg]) {
			if (typeof entry?.root === "string" && entry.root) out.push({ root: entry.root, version: typeof entry.version === "string" ? entry.version : undefined });
		}
	} catch (error: any) {
		errors.push(`current.json: ${error?.message ?? error}`);
	}
	const seen = new Set();
	return out.filter((c) => {
		const key = c.root.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
		return seen.has(key) ? false : (seen.add(key), true);
	});
}

export default async function omoKeepwarmStub(pi: any) {
	const errors: any[] = [];
	let mod: any;
	let version: any;
	for (const { root, version: v } of candidates(errors)) {
		try {
			// senpi evaluates extensions through jiti/vm, where import() has no dynamic-import callback.
			// Node's own require() loads a helper whose import() runs in Node's ESM loader, with ?v=<mtime>.
			const entry = join(root, "extension", "keepwarm.mjs");
			const { importFresh } = createRequire(entry)(join(root, "extension", "import-fresh.mjs"));
			mod = await importFresh(entry);
			version = v;
			break;
		} catch (error: any) {
			errors.push(`${root}: ${error?.message ?? error}`);
		}
	}
	if (!mod) {
		logFailure(`inert: ${errors.length ? errors.join("; ") : "no runtime in current.json"}`);
		return;
	}
	try {
		// Not retried with another root: an entry that failed half way may already have registered handlers.
		await mod.default(pi, { piAi, convertToLlm: senpi.convertToLlm, version });
	} catch (error: any) {
		logFailure(`inert: ${version}: ${error?.stack ?? error}`);
	}
}
