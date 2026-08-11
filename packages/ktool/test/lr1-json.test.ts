import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { BisonLr1AnalysisSchema, type BisonLr1Analysis } from "@kframework-ts/bison";

import { KGrammarLr1CheckSchema } from "../src/generated-bison.ts";
import { bisonLr1Json, kGrammarLr1Json, KtoolLr1JsonSchema, Lr1JsonBytesSchema } from "../src/lr1-json.ts";

const bytes = new TextEncoder().encode("%define lr.type ielr\n%%\nstart: ;\n");
const digest = createHash("sha256").update(bytes).digest("hex");

function analysis(): BisonLr1Analysis {
  return BisonLr1AnalysisSchema.parse({
    source: { bytes, sha256: digest },
    classification: {
      kind: "not-lr1",
      conflicts: [{ kind: "shift-reduce", state: 7, symbol: '"+"', disabledReductionRule: 11 }],
    },
    policyDiagnostics: [
      {
        kind: "duplicate-lr-type",
        declarations: [
          { line: 1, raw: "%define lr.type ielr", value: "ielr" },
          { line: 2, raw: "%define lr.type", value: undefined },
        ],
      },
    ],
    evidence: {
      argv: ["/usr/bin/bison", "parser.y"],
      process: {
        args: ["/usr/bin/bison", "parser.y"],
        returncode: 1,
        stdout: "complete stdout\n",
        stderr: "complete stderr\n",
        signal: undefined,
      },
      xml: Uint8Array.of(0, 1, 255),
      textReport: new TextEncoder().encode("State 7 conflicts\n"),
    },
  });
}

describe("LR(1) JSON contract", () => {
  test("retains complete Bison structures and exact inline byte evidence", () => {
    const wire = bisonLr1Json(analysis());
    expect(wire).toMatchObject({ format: "KtoolLr1Result", version: 1, operation: "bison" });
    if (wire.operation !== "bison") throw new Error("expected Bison wire result");

    expect(Array.from(Buffer.from(wire.result.source.bytes.data, "base64"))).toEqual(Array.from(bytes));
    expect(wire.result.classification).toEqual({
      kind: "not-lr1",
      conflicts: [{ kind: "shift-reduce", state: 7, symbol: '"+"', disabledReductionRule: 11 }],
    });
    expect(wire.result.policyDiagnostics[0]).toEqual({
      kind: "duplicate-lr-type",
      declarations: [
        { line: 1, raw: "%define lr.type ielr", value: "ielr" },
        { line: 2, raw: "%define lr.type", value: null },
      ],
    });
    expect(wire.result.evidence).toMatchObject({
      process: {
        stdout: "complete stdout\n",
        stderr: "complete stderr\n",
        signal: null,
        cancelledBy: null,
      },
      xml: { data: "AAH/", byteLength: 3 },
    });
  });

  test("rejects lossy records and corrupt byte envelopes", () => {
    const encoded = bisonLr1Json(analysis());
    if (encoded.operation !== "bison") throw new Error("expected Bison wire result");
    const lossy = {
      ...encoded,
      result: {
        ...encoded.result,
        classification: { kind: "not-lr1", conflicts: [{ kind: "shift-reduce", state: 7, symbol: '"+"' }] },
      },
    };
    expect(KtoolLr1JsonSchema.safeParse(lossy).success).toBe(false);
    expect(
      KtoolLr1JsonSchema.safeParse({
        ...encoded,
        result: {
          ...encoded.result,
          classification: {
            kind: "not-lr1",
            conflicts: [
              {
                kind: "shift-reduce",
                state: 7,
                symbol: '"+"',
                disabledReductionRule: 11,
                unknownFutureField: true,
              },
            ],
          },
        },
      }).success,
    ).toBe(false);
    expect(Lr1JsonBytesSchema.safeParse({ ...encoded.result.source.bytes, data: "AA==" }).success).toBe(false);
  });

  test("keeps each complete K diagnostic and adds, rather than substitutes, its classification", () => {
    const record = {
      severity: "error" as const,
      group: "Inner Parser" as const,
      message: "Skipping modules [BAD] tagged as not-lr1 which are not supported by Bison.",
      source: "/definition/main.k",
      location: "(1,1,1,9)",
      snippet: "module BAD",
      wrapperTool: null,
      raw: "[Error] Inner Parser: Skipping modules [BAD] tagged as not-lr1 which are not supported by Bison.",
      rawLines: ["[Error] Inner Parser: Skipping modules [BAD] tagged as not-lr1 which are not supported by Bison."],
    };
    const checked = KGrammarLr1CheckSchema.parse({
      capture: {
        source: { bytes, sha256: digest },
        target: { kind: "pgm" },
        kVersion: {
          major: 7,
          minor: 1,
          patch: 337,
          git: undefined,
          text: "v7.1.337",
          banner: "K version:    v7.1.337\n",
          line: "K version:    v7.1.337",
        },
        diagnostics: [record],
        process: { args: ["kompile"], returncode: 0, stdout: "", stderr: record.raw, signal: undefined },
      },
      analysis: analysis(),
      unprovedBoundaries: ["scanner-determinism"],
    });

    const wire = kGrammarLr1Json(checked);
    if (wire.operation !== "k") throw new Error("expected K wire result");
    expect(wire.result.capture.diagnostics[0]).toEqual({
      record,
      classification: { family: "inner-parser", tag: "non-lr-grammar" },
    });
    expect(
      KtoolLr1JsonSchema.safeParse({
        ...wire,
        result: {
          ...wire.result,
          capture: {
            ...wire.result.capture,
            diagnostics: [{ record, classification: { family: "native", tag: "parser" } }],
          },
        },
      }).success,
    ).toBe(false);
    expect(
      KtoolLr1JsonSchema.safeParse({
        ...wire,
        result: {
          ...wire.result,
          capture: {
            ...wire.result.capture,
            diagnostics: [
              {
                record: { ...record, unknownFutureField: true },
                classification: { family: "inner-parser", tag: "non-lr-grammar" },
              },
            ],
          },
        },
      }).success,
    ).toBe(false);

    const { rawLines: _rawLines, ...recordWithoutRawLines } = record;
    const lossy = {
      ...wire,
      result: {
        ...wire.result,
        capture: {
          ...wire.result.capture,
          diagnostics: [
            { record: recordWithoutRawLines, classification: { family: "inner-parser", tag: "non-lr-grammar" } },
          ],
        },
      },
    };
    expect(KtoolLr1JsonSchema.safeParse(lossy).success).toBe(false);
  });
});
