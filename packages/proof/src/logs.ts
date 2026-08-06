/**
 * `proof.json`'s `logs` map, in pyk's key order.
 *
 * Reading and writing the entries themselves is `@kframework-ts/kore-rpc`'s
 * job; what belongs here is the *proof file's* shape:
 *
 * - Only `tag: "rewrite"` is readable. `LogEntry.from_dict` (`kore/rpc.py:598-604`)
 *   raises on every other tag, so nothing else can legitimately appear in a
 *   proof directory, and accepting more would let this package write files pyk
 *   cannot read back.
 * - The key order is `LogRewrite.to_dict`'s (`kore/rpc.py:623`) — `tag`,
 *   `origin`, `result` — and `RewriteSuccess`/`RewriteFailure`'s
 *   (`kore/rpc.py:665`, `:681`). `encodeLogEntry` orders by the Haskell
 *   declaration instead, which is right for a server exchange and wrong for a
 *   file pyk wrote, so the entry is reordered on the way out.
 * - `RewriteFailure` writes `rule-id` unconditionally, as `null` when unset.
 */

import { decodeLogEntry, encodeLogEntry, type LogEntry } from "@kframework-ts/kore-rpc";

import { ProofError } from "./proof.js";

type JsonObject = Readonly<Record<string, unknown>>;

function asObject(value: unknown, where: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProofError(`Expected an object for ${where}`);
  }
  // The three checks above are the whole structural guarantee this decoder needs.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as JsonObject;
}

/** Read one `proof.json` log entry; anything but a rewrite is a decode error. */
export function decodeProofLogEntry(value: unknown, where: string): LogEntry {
  const entry = decodeLogEntry(value, where);
  if (entry.tag !== "rewrite") {
    const tag = entry.tag === "unknown-log-entry" ? entry.logTag : entry.tag;
    throw new ProofError(`Unsupported LogEntry tag in ${where}: ${JSON.stringify(tag)}`);
  }
  return entry;
}

/** Write one log entry in `LogRewrite.to_dict` order. */
export function encodeProofLogEntry(entry: LogEntry): JsonObject {
  if (entry.tag !== "rewrite") {
    throw new ProofError(`Only rewrite log entries can be written to a proof file, got ${JSON.stringify(entry.tag)}`);
  }
  const encoded = encodeLogEntry(entry);
  const result = asObject(encoded["result"], "rewrite log result");
  return { tag: "rewrite", origin: encoded["origin"], result: reorderRewriteResult(result) };
}

function reorderRewriteResult(result: JsonObject): JsonObject {
  if (result["tag"] === "success") {
    // `RewriteSuccess.to_dict` (`kore/rpc.py:665`): tag, rule-id, then the
    // optional rewritten term. `substitution` has no upstream counterpart and
    // so never appears in a pyk-written file; it is preserved last when a
    // caller supplies one rather than being silently dropped.
    const out: Record<string, unknown> = { tag: "success", "rule-id": result["rule-id"] };
    if ("rewritten-term" in result) out["rewritten-term"] = result["rewritten-term"];
    if ("substitution" in result) out["substitution"] = result["substitution"];
    return out;
  }
  // `RewriteFailure.to_dict` (`kore/rpc.py:681`): rule-id is always written,
  // as JSON `null` when the failure predates rule selection.
  return { tag: "failure", "rule-id": result["rule-id"] ?? null, reason: result["reason"] };
}

/** Decode the whole `{"<node id>": [entry, ...]}` map. */
export function decodeProofLogs(value: unknown, where: string): Map<number, readonly LogEntry[]> {
  const logs = new Map<number, readonly LogEntry[]>();
  for (const [key, entries] of Object.entries(asObject(value, where))) {
    const nodeId = Number(key);
    if (!Number.isSafeInteger(nodeId)) throw new ProofError(`Expected an integer node id in ${where}, got ${key}`);
    if (!Array.isArray(entries)) throw new ProofError(`Expected an array for ${where}[${key}]`);
    logs.set(
      nodeId,
      Object.freeze(entries.map((entry, index) => decodeProofLogEntry(entry, `${where}[${key}][${index}]`))),
    );
  }
  return logs;
}

/**
 * Encode the whole `logs` map.
 *
 * Python preserves insertion order for these integer keys; JavaScript objects
 * reorder integer-like keys ascending, and `JSON.stringify` follows suit. The
 * keys are node ids, which pyk inserts in increasing order in every observed
 * artifact, so the two agree in practice — but the divergence is real and is
 * pinned by a test.
 */
export function encodeProofLogs(logs: ReadonlyMap<number, readonly LogEntry[]>): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [nodeId, entries] of logs) out[String(nodeId)] = entries.map(encodeProofLogEntry);
  return out;
}
