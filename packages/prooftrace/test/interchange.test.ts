/**
 * The cross-fixture: a record from **this** path and a record from the
 * **kore-rpc** path must be the same shape, so a consumer reads both files with
 * one reader.
 *
 * `@kframework-ts/cterm` is a devDependency for this file and nothing else.
 * The check is a pin, not a coupling: this package deliberately *replicates*
 * `TraceEntry` rather than importing it (see `records.ts`), because `origin` is
 * typed against the haskell-backend's `LogOrigin` and `"llvm"` is not one of
 * its values.  Replication without a pin is how two shapes drift apart, so the
 * pin is here.
 *
 * If cterm changes its record, this test fails and someone has to decide
 * whether the two paths still agree.  That is the intended failure.
 */

import { describe, expect, test } from "bun:test";
import { assembleTrace, traceToJsonl, type TraceEntry } from "@kframework-ts/cterm/trace";
import { readKastDefinitionFromJson } from "@kframework-ts/kast";
import { parseDefinition } from "@kframework-ts/kore";

import { ordinalRuleIndex } from "../src/ordinals.ts";
import { assembleProofTrace, proofTraceContext, proofTraceToJsonl, type ProofTraceRecord } from "../src/records.ts";
import { fixtureText, runDefinition, runHeader, runHints } from "./support.ts";

/** One `rewrite`/`success` log entry, as a v0.1.155 server sends it. */
const KORE_RPC_LOGS = [
  {
    tag: "rewrite" as const,
    origin: "booster" as const,
    result: { tag: "success" as const, ruleId: "a".repeat(64) },
  },
  {
    tag: "rewrite" as const,
    origin: "kore-rpc" as const,
    result: { tag: "failure" as const, ruleId: "b".repeat(64), reason: "no rule applied" },
  },
];

/** A resolving index, so the cterm record has its optional fields *filled*. */
const CTERM_RECORDS = assembleTrace(KORE_RPC_LOGS, {
  rules: new Map([["a".repeat(64), { label: "M.rule", source: "m.k", location: [1, 2, 3, 4] as const, module: "M" }]]),
});

const LLVM_RECORDS = assembleProofTrace(
  runHints("addRewrite"),
  runHeader("addRewrite"),
  proofTraceContext(
    ordinalRuleIndex(parseDefinition(runDefinition("addRewrite"), { lazyAxioms: true })),
    readKastDefinitionFromJson(fixtureText("hints", "add-rewrite.compiled.json")),
  ),
);

/** `{key: "string" | "number" | "boolean" | "object" | "null"}` for one record. */
function shapeOf(entry: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(entry).map(([key, value]) => [key, value === null ? "null" : typeof value]));
}

describe("the two oracle paths write interchangeable records", () => {
  test("the same keys, in the same order", () => {
    // Key *order* matters as much as the key set: `traceToJsonl` and
    // `proofTraceToJsonl` both rely on `JSON.stringify` preserving insertion
    // order, so a reordering would produce two byte-different files that a
    // naive diff of two runs would flag.
    expect(Object.keys(LLVM_RECORDS[0]!)).toEqual(Object.keys(CTERM_RECORDS[0]!));
  });

  test("the same value types for every key", () => {
    // `substitution` is the one honest difference: `null` on every kore-rpc
    // record a v0.1.155 server can produce (`cterm/src/trace.ts:19-31`) and an
    // object on every record here.  That *is* the reason this package exists,
    // so it is asserted rather than papered over.
    const { substitution: ctermSubstitution, ...cterm } = shapeOf({ ...CTERM_RECORDS[0]! });
    const { substitution: llvmSubstitution, ...llvm } = shapeOf({ ...LLVM_RECORDS[0]! });
    expect(llvm).toEqual(cterm);
    expect(ctermSubstitution).toBe("null");
    expect(llvmSubstitution).toBe("object");
  });

  test("origin is what distinguishes them, and it is a value not a shape", () => {
    expect(CTERM_RECORDS.map((entry) => entry.origin)).toEqual(["booster", "kore-rpc"]);
    expect(new Set(LLVM_RECORDS.map((entry) => entry.origin))).toEqual(new Set(["llvm"]));
  });

  test("both outcomes exist on both paths, with the same spelling", () => {
    expect(new Set(CTERM_RECORDS.map((entry) => entry.outcome))).toEqual(new Set(["success", "failure"]));
    // The LLVM path's `failure` is a side condition that rejected a rule; the
    // kore-rpc path's is a step the server abandoned.  Different causes, same
    // meaning — "attempted and not taken" — and the same two strings.
    const guarded = assembleProofTrace(
      runHints("guardedBig"),
      runHeader("guardedBig"),
      proofTraceContext(
        ordinalRuleIndex(parseDefinition(runDefinition("guardedBig"), { lazyAxioms: true })),
        readKastDefinitionFromJson(fixtureText("hints", "guarded.compiled.json")),
      ),
    );
    expect(new Set(guarded.map((entry) => entry.outcome))).toEqual(new Set(["success", "failure"]));
  });

  test("the two JSONL writers are the same function over the same record", () => {
    // Feed cterm's own records to this package's writer and vice versa: if the
    // projections agree on both inputs, the files are interchangeable by
    // construction and not by coincidence.
    // Both writers are `records.map((r) => JSON.stringify(r) + "\n").join("")`
    // over structurally identical records, so each must reproduce the other's
    // output on the other's input.  Stated as a JSON round trip rather than a
    // cast, because a cast would be the thing under test asserting itself.
    expect(proofTraceToJsonl(reinterpret(CTERM_RECORDS, asProofTraceRecord))).toBe(traceToJsonl(CTERM_RECORDS));
    expect(proofTraceToJsonl(LLVM_RECORDS)).toBe(traceToJsonl(reinterpret(LLVM_RECORDS, asTraceEntry)));
  });

  test("a concatenated file is still one record per line", () => {
    // R7's reader must not care which oracle produced which line.
    const merged = traceToJsonl(CTERM_RECORDS) + proofTraceToJsonl(LLVM_RECORDS);
    const lines = merged.trimEnd().split("\n");
    expect(lines.length).toBe(CTERM_RECORDS.length + LLVM_RECORDS.length);
    for (const line of lines) {
      const parsed: unknown = JSON.parse(line);
      expect(parsed).toMatchObject({ index: expect.any(Number) });
      expect(line).toMatch(/"origin":"(booster|kore-rpc|llvm)"/);
    }
  });
});

/**
 * A record from one path, re-read as the other's.
 *
 * The round trip through JSON is the point: if a `TraceEntry` survives
 * `JSON.parse(JSON.stringify(...))` and is still a valid `ProofTraceRecord`
 * (and vice versa), the two types describe the same documents, which is the
 * only sense in which two files can be "interchangeable".  The type parameters
 * are unconstrained on purpose — the *runtime* equality below is the assertion.
 */
function reinterpret<T>(records: readonly unknown[], reader: (value: unknown) => T): readonly T[] {
  const parsed: unknown = JSON.parse(JSON.stringify(records));
  return Array.isArray(parsed) ? parsed.map((value: unknown) => reader(value)) : [];
}

/**
 * The two readers, each of which validates the eleven keys and nothing more.
 *
 * `KEYS` is passed rather than closed over so that its element type is checked
 * against the target's *own* keys at each call site: if either record grows,
 * loses or renames a field, one of the two lines below stops compiling.  That
 * is a second, static half of the same pin the runtime assertions make.
 */
function asProofTraceRecord(value: unknown): ProofTraceRecord {
  return checkedRecord<ProofTraceRecord>(value, KEYS);
}

function asTraceEntry(value: unknown): TraceEntry {
  return checkedRecord<TraceEntry>(value, KEYS);
}

function checkedRecord<T extends object>(value: unknown, keys: readonly (keyof T & string)[]): T {
  if (typeof value !== "object" || value === null) throw new TypeError("not a record");
  for (const key of keys) if (!(key in value)) throw new TypeError(`missing ${key}`);
  // Every key is present and the shapes were compared above, so this is a
  // re-labelling of a value already proven to have the right form.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as T;
}

const KEYS = [
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
] as const;
