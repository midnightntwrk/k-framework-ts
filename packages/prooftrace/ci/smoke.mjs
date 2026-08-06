// Consumer smoke test, run against the *packed tarball* under plain Node —
// never against the workspace. The failure this guards against is specific: an
// entry point that plain Node cannot load. Node refuses to strip types under
// `node_modules`, so a package whose `exports` points at `.ts` installs fine and
// then throws on first import. Packing and importing for real is the only check
// that sees it.
//
// CI copies this file into a scratch consumer project that has installed the
// tarball, so the imports below use the published package names. The four
// workspace dependencies are packed and installed alongside.
//
// No K, no fixtures and no filesystem: the bytes below are written here, which
// is also the tightest possible statement of the two formats. A header with two
// symbols and a hint stream with one rule event is enough to prove that the
// whole pipeline — cursor, header, terms, events, ordinals, records, JSONL —
// links and runs under Node.
import assert from "node:assert/strict";
import {
  assembleProofTrace,
  KoreHeader,
  KORE_HEADER_VERSION,
  K_RELEASE,
  LLVM_BACKEND_RELEASE,
  parseProofTrace,
  proofHintsArgs,
  proofTraceToJsonl,
  PROOF_TRACE_VERSION,
  SENTINELS,
  stripInjections,
} from "@kframework-ts/prooftrace";
import { koreText } from "@kframework-ts/kore";

assert.equal(K_RELEASE, "v7.1.337");
assert.equal(LLVM_BACKEND_RELEASE, "v0.1.140");
assert.equal(PROOF_TRACE_VERSION, 13);
assert.equal(KORE_HEADER_VERSION, 1);
assert.equal(SENTINELS.config, 0xff);

//////////////////////////////
// A rich header, by hand   //
//////////////////////////////

function u32(value) {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}
function u64(value) {
  return [...u32(value), 0, 0, 0, 0];
}
function ascii(text) {
  return [...text].map((c) => c.charCodeAt(0));
}
function word(byte) {
  return Array(8).fill(byte);
}
function entry(text) {
  return [...u32(text.length), ...ascii(text), 0];
}

// `\x7FKR2`, version 1, then 3 strings / 1 sort / 2 symbols.
const HEADER_BYTES = Uint8Array.from([
  0x7f,
  0x4b,
  0x52,
  0x32,
  ...u32(1),
  ...u32(3),
  ...u32(1),
  ...u32(2),
  ...entry("SortNat"),
  ...entry("Lblz"),
  ...entry("Lbls"),
  // sort 0: SortNat, no parameters
  ...u32(0),
  0,
  // symbol 0: Lblz, 0 params, arity 0 — symbol 1: Lbls, 0 params, arity 1
  ...u32(1),
  0,
  0,
  ...u32(2),
  0,
  1,
]);

const header = KoreHeader.parse(HEADER_BYTES);
assert.equal(header.symbols.length, 2);
assert.equal(header.symbol(1).name, "Lbls");
assert.equal(header.symbol(1).arity, 1);

//////////////////////////////
// A hint stream, by hand   //
//////////////////////////////

/** A composite term: `\x7FKR2` then tag 1 and a 32-bit symbol offset per node. */
const Z = [0x7f, 0x4b, 0x52, 0x32, 1, ...u32(0)];
const S_OF_Z = [0x7f, 0x4b, 0x52, 0x32, 1, ...u32(1), 1, ...u32(0)];

const HINTS = Uint8Array.from([
  ...ascii("HINT"),
  ...u32(13),
  // config ::= WORD(0xFF) kore_term
  ...word(0xff),
  ...Z,
  // rule ::= WORD(0x22) ordinal arity variable*
  ...word(0x22),
  ...u64(1),
  ...u64(1),
  ...ascii("VarN"),
  0,
  ...S_OF_Z,
  ...word(0xff),
  ...S_OF_Z,
]);

const trace = parseProofTrace(HINTS, header);
assert.equal(trace.version, 13);
assert.equal(trace.kind, "hint");
assert.deepEqual(trace.preTrace, []);
assert.equal(koreText(trace.initialConfig.term), "Lblz{}()");
assert.equal(trace.trace.length, 2);

const [rule] = trace.trace;
assert.equal(rule.tag, "rule");
assert.equal(rule.ordinal, 1);
assert.equal(rule.substitution.length, 1);
assert.equal(rule.substitution[0].name, "VarN");
assert.equal(koreText(rule.substitution[0].term), "Lbls{}(Lblz{}())");
assert.equal(koreText(stripInjections(rule.substitution[0].term)), "Lbls{}(Lblz{}())");

//////////////////////////////
// The record projection    //
//////////////////////////////

const rules = [
  {
    label: "SMOKE.dummy",
    declaredLabel: "SMOKE.dummy",
    source: "smoke.k",
    location: [1, 1, 1, 9],
    module: "SMOKE",
    ordinal: 0,
    uniqueId: null,
  },
  {
    label: "SMOKE.step",
    declaredLabel: "SMOKE.step",
    source: "smoke.k",
    location: [2, 1, 2, 9],
    module: "SMOKE",
    ordinal: 1,
    uniqueId: "f".repeat(64),
  },
];

// Without a `toKast`, `substitution` is null and everything else is filled —
// exactly how `@kframework-ts/cterm` behaves without its decoder.
const records = assembleProofTrace(HINTS, header, { rules });
assert.equal(records.length, 1);
assert.deepEqual(Object.keys(records[0]), [
  "index",
  "outcome",
  "ruleId",
  "resolved",
  "label",
  "source",
  "location",
  "module",
  "origin",
  "reason",
  "substitution",
]);
assert.deepEqual(records[0], {
  index: 0,
  outcome: "success",
  ruleId: "f".repeat(64),
  resolved: true,
  label: "SMOKE.step",
  source: "smoke.k",
  location: [2, 1, 2, 9],
  module: "SMOKE",
  origin: "llvm",
  reason: null,
  substitution: null,
});

const jsonl = proofTraceToJsonl(records);
assert.ok(jsonl.endsWith("\n"));
assert.equal(jsonl.trimEnd().split("\n").length, 1);
assert.equal(JSON.parse(jsonl).origin, "llvm");
assert.equal(proofTraceToJsonl([]), "");

// The one call into a K artifact, argv only — spawning needs a real backend.
assert.deepEqual(proofHintsArgs("/defn", "/in.kore", "/out.bin").slice(1), [
  "/in.kore",
  "-1",
  "/out.bin",
  "--proof-output",
]);

console.log(`@kframework-ts/prooftrace: packed tarball imports and runs under Node ${process.version}`);
