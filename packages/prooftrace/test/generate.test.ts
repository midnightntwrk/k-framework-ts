/**
 * The generation layer's pure half — the argv, and the two preconditions that
 * are checked before anything is spawned.
 *
 * The spawns themselves are `live-k.test.ts`'s: a fake `interpreter` would
 * prove nothing this package cares about, since the thing under test is a byte
 * stream only the real backend can produce.
 */

import { describe, expect, test } from "bun:test";
import { llvmInterpretArgs } from "@kframework-ts/ktool";
import { join } from "node:path";

import {
  generateKoreRichHeader,
  generateProofHints,
  KORE_RICH_HEADER,
  PROOF_OUTPUT_FLAG,
  proofHintsArgs,
} from "../src/generate.ts";
import { caughtAsync } from "./caught.ts";

describe("proofHintsArgs", () => {
  test("is pyk's list, with --proof-output last", () => {
    // `[str(interpreter), str(input_kore_file), '-1', str(hints_file),
    // '--proof-output']` — `pyk/src/pyk/kllvm/compiler.py:124`.
    expect(proofHintsArgs("/defn", "/in.kore", "/out.bin")).toEqual([
      join("/defn", "interpreter"),
      "/in.kore",
      "-1",
      "/out.bin",
      "--proof-output",
    ]);
  });

  test("is ktool's interpreter argv plus one flag, and stays that way", () => {
    // Stated as an equation rather than a second literal so that a change to
    // `llvmInterpretArgs` — the positional order, the `-1` sentinel — cannot
    // silently diverge from what this package spawns.
    expect(proofHintsArgs("/defn", "/in.kore", "/out.bin", 7)).toEqual([
      ...llvmInterpretArgs("/defn", 7, "/in.kore", "/out.bin"),
      PROOF_OUTPUT_FLAG,
    ]);
  });

  test("an absent depth is -1, and depth 0 is not absent", () => {
    // `-1` is the interpreter's own "run to completion"; `0` is a different
    // request (take no steps) and must survive as `0`.
    expect(proofHintsArgs("/d", "/i", "/o")[2]).toBe("-1");
    expect(proofHintsArgs("/d", "/i", "/o", 0)[2]).toBe("0");
  });
});

describe("preconditions", () => {
  test("a directory with no interpreter is named before any spawn", async () => {
    const error = await caughtAsync(generateProofHints("/nonexistent-definition-dir", "Lblz{}()"), Error);
    expect(error.message).toMatch(/File does not exist:.*interpreter/);
  });

  test("a missing definition.kore is named before kore-rich-header runs", async () => {
    const error = await caughtAsync(generateKoreRichHeader("/nonexistent/definition.kore"), Error);
    expect(error.message).toMatch(/File does not exist/);
  });

  test("the default command is the one on PATH", () => {
    expect(KORE_RICH_HEADER).toBe("kore-rich-header");
  });
});
