/**
 * Cross-format conformance: the two codecs and the two writers agree with
 * each other, over the reference implementations' own test material.
 *
 * This is pyk's `test_parse_json` (`test_parser.py:104-116`) — its
 * highest-value test — extended to both directions:
 *
 *   JSON golden → AST → text → reparse ≡ AST     (writer and parser agree)
 *   text fixture → AST → JSON → decode ≡ AST     (JSON codec is faithful)
 *
 * Everything here imports through `../src/index.ts` on purpose: it doubles as
 * the check that the package root actually re-exports the whole surface (an
 * ambiguous `export *` name would be silently dropped and fail here).
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decodeKoreJson,
  KoreParser,
  koreText,
  parseDefinition,
  parsePattern,
  patternFromJson,
  patternToJson,
} from "../src/index.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const JSON_DIR = join(FIXTURES, "json");
const PATTERN_DIR = join(FIXTURES, "patterns");

const jsonFiles = readdirSync(JSON_DIR)
  .filter((f) => f.endsWith(".json"))
  .toSorted();

describe("JSON golden → AST → text → reparse is the identity", () => {
  test.each(jsonFiles)("%s", (file) => {
    const docs: unknown = JSON.parse(readFileSync(join(JSON_DIR, file), "utf8"));
    if (!Array.isArray(docs)) throw new Error(`${file}: expected a JSON array of envelopes`);
    for (const doc of docs) {
      const decoded = decodeKoreJson(doc).term;
      const reparsed = parsePattern(koreText(decoded));
      expect(reparsed).toEqual(decoded);
    }
  });
});

describe("text fixture → AST → JSON → decode is the identity", () => {
  test.each(readdirSync(PATTERN_DIR).toSorted())("patterns/%s", (file) => {
    const ast = parsePattern(readFileSync(join(PATTERN_DIR, file), "utf8"));
    const decoded = patternFromJson(patternToJson(ast));
    expect(decoded).toEqual(ast);
    expect(koreText(decoded)).toBe(koreText(ast));
  });

  test("every axiom pattern of a real kompiled definition JSON-round-trips", () => {
    const text = readFileSync(join(FIXTURES, "definitions", "empty.definition.kore"), "utf8");
    const definition = parseDefinition(text);
    let axioms = 0;
    for (const module of definition.modules) {
      for (const sentence of module.sentences) {
        if (sentence.tag !== "Axiom" && sentence.tag !== "Claim") continue;
        axioms += 1;
        const decoded = patternFromJson(patternToJson(sentence.pattern));
        expect(decoded).toEqual(sentence.pattern);
      }
    }
    // A count, so an accidentally-empty walk cannot pass silently.
    expect(axioms).toBeGreaterThan(50);
  });

  test("the prelude's modules survive both round trips", () => {
    const text = readFileSync(join(FIXTURES, "definitions", "prelude.kore"), "utf8");
    // `prelude.kore` is a module sequence, not a definition (no leading
    // attributes) — see parser.test.ts. Read the modules one by one.
    const parser = new KoreParser(text);
    let modules = 0;
    while (!parser.eof) {
      const module = parser.module();
      modules += 1;
      for (const sentence of module.sentences) {
        if (sentence.tag !== "Axiom" && sentence.tag !== "Claim") continue;
        const viaJson = patternFromJson(patternToJson(sentence.pattern));
        expect(viaJson).toEqual(sentence.pattern);
        expect(parsePattern(koreText(sentence.pattern))).toEqual(sentence.pattern);
      }
    }
    expect(modules).toBe(4);
  });
});
