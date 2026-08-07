/** Additive in-memory source-span contract. */

import { expect, test } from "bun:test";
import { codeBlocks, selectCodeBlocks } from "../src/markdown.ts";
import { OuterParser } from "../src/parser.ts";
import { sliceLocation, syntaxToDict } from "../src/index.ts";
import { IMP_OUTER_JSON, readFixture, readPykUnitTable } from "./fixtures.ts";

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected a parsed node");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

test("parser spans are half-open source slices while bubble locations remain content starts", () => {
  const text =
    'requires "a.k"\r\nmodule M [mod]\r\n  imports private N\r\n  syntax Foos ::= left: List{Foo, ","} [seqstrict, emoji("😀")]\r\n  rule [r]: X => Y [owise]\r\nendmodule';
  const definition = new OuterParser(text, "fixture.k").definition();
  const module = must(definition.modules[0]);
  const syntax = must(module.sentences[0]);
  const rule = must(module.sentences[1]);
  const require = must(definition.requires[0]);
  const imported = must(module.imports[0]);

  expect(sliceLocation(text, must(require.span))).toBe('requires "a.k"');
  expect(sliceLocation(text, must(module.span))).toBe(text.slice(text.indexOf("module M")));
  expect(sliceLocation(text, must(imported.span))).toBe("imports private N");
  expect(sliceLocation(text, must(syntax.span))).toBe('syntax Foos ::= left: List{Foo, ","} [seqstrict, emoji("😀")]');
  // The preceding indentation is intentionally excluded from the lexical span.
  expect(sliceLocation(text, must(syntax.span)).startsWith("syntax")).toBe(true);

  expect(syntax.node).toBe("SyntaxDefn");
  if (syntax.node !== "SyntaxDefn") throw new Error("expected syntax definition");
  const block = must(syntax.blocks[0]);
  const production = must(block.productions[0]);
  expect(sliceLocation(text, must(block.span))).toBe('left: List{Foo, ","} [seqstrict, emoji("😀")]');
  expect(sliceLocation(text, must(production.span))).toBe('List{Foo, ","} [seqstrict, emoji("😀")]');
  expect(sliceLocation(text, must(production.att.span))).toBe('[seqstrict, emoji("😀")]');
  expect(production.att.itemSpans?.map((span) => sliceLocation(text, span))).toEqual(["seqstrict", 'emoji("😀")']);

  if (rule.node !== "Rule") throw new Error("expected rule");
  expect(sliceLocation(text, must(rule.span))).toBe("rule [r]: X => Y [owise]");
  expect(rule.location).toEqual([5, 13, 5, 13]);
  expect(text.slice(text.indexOf("X => Y"), text.indexOf("X => Y") + rule.bubble.length)).toBe(rule.bubble);
  // Spans are deliberately absent from pyk-compatible AST JSON.
  expect(JSON.stringify(syntaxToDict(definition))).not.toContain('"span"');
  expect(JSON.stringify(syntaxToDict(definition))).not.toContain('"itemSpans"');
});

test("location helpers count UTF-16 code units, CR, tabs, and astral characters", () => {
  const text = "\t😀\r\nnext";
  expect(sliceLocation(text, [1, 1, 1, 5])).toBe("\t😀\r");
  expect(sliceLocation(text, [2, 1, 2, 5])).toBe("next");
});

test("code-block spans address the original literate source before right stripping", () => {
  const markdown = "# heading\n```k\nmodule M\r\nendmodule\n\n```\n";
  const block = must([...codeBlocks(markdown)][0]);
  expect(sliceLocation(markdown, must(block.span))).toBe("module M\r\nendmodule\n\n");
  expect(block.code).toBe("module M\r\nendmodule");

  const selected = selectCodeBlocks(markdown, "k");
  const module = new OuterParser(selected, "example.md").module();
  expect(sliceLocation(markdown, must(module.span))).toBe("module M\r\nendmodule");
});

test("every outer-parser sentence kind round-trips its complete lexical span", () => {
  const table = readPykUnitTable("outer-parser-sentence.json");
  const kinds = new Set<string>();
  for (const testCase of table.cases) {
    const text = String(testCase["kText"]);
    const sentence = new OuterParser(text).sentence();
    kinds.add(sentence.node);
    expect(sliceLocation(text, must(sentence.span))).toBe(text);
  }
  expect([...kinds].toSorted()).toEqual([
    "Alias",
    "Claim",
    "Config",
    "Context",
    "Rule",
    "SyntaxAssoc",
    "SyntaxDecl",
    "SyntaxDefn",
    "SyntaxLexical",
    "SyntaxPriority",
    "SyntaxSynonym",
  ]);
});

test("surface production spans agree with the comparable Java outer-parser locations", () => {
  const source = readFixture(IMP_OUTER_JSON, "imp.k");
  const parsed = new OuterParser(source, "imp.k").definition();
  const syntax = parsed.modules.find((module) => module.name === "IMP-SYNTAX");
  if (syntax === undefined) throw new Error("IMP-SYNTAX missing from source fixture");
  const surfaceLocations = new Set<string>();
  for (const sentence of syntax.sentences) {
    if (sentence.node !== "SyntaxDefn") continue;
    for (const block of sentence.blocks) {
      for (const production of block.productions) surfaceLocations.add(JSON.stringify(must(production.span)));
    }
  }
  const java: unknown = JSON.parse(readFixture(IMP_OUTER_JSON, "imp.json"));
  if (!isRecord(java) || !isRecord(java.term) || !isUnknownArray(java.term.modules)) {
    throw new Error("invalid Java outer-parser fixture envelope");
  }
  const javaModule = java.term.modules.find(
    (module) => isRecord(module) && module.name === "IMP-SYNTAX" && isUnknownArray(module.localSentences),
  );
  if (!isRecord(javaModule) || !isUnknownArray(javaModule.localSentences)) {
    throw new Error("IMP-SYNTAX missing from Java fixture");
  }
  const javaLocations = new Set<string>();
  for (const sentence of javaModule.localSentences) {
    if (!isRecord(sentence) || sentence.node !== "KProduction" || !isRecord(sentence.att)) continue;
    const attributes = sentence.att.att;
    if (!isRecord(attributes)) continue;
    javaLocations.add(JSON.stringify(attributes["org.kframework.attributes.Location"]));
  }
  for (const location of surfaceLocations) expect(javaLocations.has(location)).toBe(true);
});

test("serialized outer AST bytes are identical with spans stripped", () => {
  const text = 'module M\n  syntax S ::= List{E, ","} [seqstrict]\n  rule [r]: X => Y [owise]\nendmodule';
  const parsed = new OuterParser(text, "spans.k").definition();
  const serialized = syntaxToDict(parsed);
  expect(JSON.stringify(serialized)).toBe(JSON.stringify(stripSpans(serialized)));
});

function stripSpans(value: unknown): unknown {
  if (isUnknownArray(value)) return value.map((item) => stripSpans(item));
  if (typeof value !== "object" || value === null) return value;
  const entries = Object.entries(value)
    .filter(([key]) => key !== "span" && key !== "itemSpans")
    .map(([key, item]) => [key, stripSpans(item)]);
  return Object.fromEntries(entries);
}
