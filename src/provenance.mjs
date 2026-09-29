import { STALE_INPUT_MS } from "./policy.mjs";

export function createProvenance({ now }) {
  const inputs = [];
  let imminent = null;

  function discardStale() {
    const cutoff = now() - STALE_INPUT_MS;
    while (inputs.length && inputs[0].atMs < cutoff) inputs.shift();
  }

  function noteInput({ inputId, source }) {
    discardStale();
    inputs.push({ inputId, source, atMs: now() });
  }

  function noteDisposition({ inputId, disposition }) {
    discardStale();
    const index = inputId === undefined
      ? (inputs.length ? inputs.length - 1 : -1)
      : inputs.findIndex((input) => input.inputId === inputId);
    if (index < 0) {
      return { kind: "unattributed", source: "disposition_without_input", atMs: now() };
    }
    const [input] = inputs.splice(index, 1);
    if (disposition === "started" || disposition === "queued") {
      if (input.source === "interactive" || input.source === "rpc") {
        return { kind: "human_return", source: `input:${input.source}`, atMs: input.atMs };
      }
      if (input.source === "extension") {
        return { kind: "automated", source: "input:extension", atMs: input.atMs };
      }
      return { kind: "unattributed", source: "disposition_without_input", atMs: input.atMs };
    }
    if ((disposition === "handled" || disposition === "rejected") &&
        (input.source === "interactive" || input.source === "rpc")) {
      return { kind: "presence", source: disposition === "handled" ? "input_handled" : "input_rejected", atMs: input.atMs };
    }
    return { kind: "none", source: input.source, atMs: input.atMs };
  }

  function noteTurnImminent(trigger) {
    imminent = trigger == null ? null : { trigger, atMs: now() };
  }

  function noteMessageStart(message) {
    if (!message) return { kind: "none", source: null };
    if (message.role === "user") return { kind: "unattributed", source: "user_message_without_input" };
    if (message.role !== "custom") return { kind: "none", source: null };
    const customType = message.customType;
    if (customType === "environment-context") return { kind: "none", source: customType };
    if (customType === "manual-continue") return { kind: "human_return", source: "manual_continue" };
    return { kind: "automated", source: customType };
  }

  return {
    noteInput,
    noteDisposition,
    noteTurnImminent,
    turnImminent: () => imminent,
    pendingInputCount: () => { discardStale(); return inputs.length; },
    noteMessageStart,
    resolveUnattributed(reason) { return { kind: "unattributed", source: reason }; },
    reset() { inputs.length = 0; imminent = null; },
  };
}
