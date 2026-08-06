/**
 * Binary KORE 2.0 terms: the two tags, the `\dv` fold, the `inj` TODO, and the
 * `pattern_len` arithmetic — bug included, because the reference tool prints it.
 */

import { describe, expect, test } from "bun:test";
import { koreText } from "@kframework-ts/kore";

import { BINARY_KORE_TERM_MAGIC, parseBinaryKoreTerm, readBinaryKoreTerm, stripInjections } from "../src/binary.ts";
import { ByteCursor } from "../src/cursor.ts";
import { ProofTraceError } from "../src/errors.ts";
import { KoreHeader } from "../src/header.ts";
import { ByteWriter, writeHeader, writeTerm } from "./encode.ts";

const HEADER = KoreHeader.parse(
  writeHeader(
    [{ name: "SortInt" }, { name: "SortKItem" }, { name: "SortFoo" }],
    [
      { name: "Lblz", arity: 0 }, // 0
      { name: "Lbls", arity: 1 }, // 1
      { name: "Lblpair", arity: 2 }, // 2
      { name: "inj", sortParams: [2, 1], arity: 1 }, // 3
      { name: "\\dv", sortParams: [0], arity: 1 }, // 4
      { name: "\\and", sortParams: [0], arity: 2 }, // 5
    ],
  ),
);

describe("binary KORE 2.0 terms", () => {
  test("a composite pattern's arity comes from the header, not the wire", () => {
    // This is the whole reason the header is mandatory: the bytes below carry
    // three tags and no arity at all.
    const term = parseBinaryKoreTerm(writeTerm({ tag: 1, args: [{ tag: 1, args: [{ tag: 0 }] }] }), HEADER);
    expect(koreText(term)).toBe("Lbls{}(Lbls{}(Lblz{}()))");
  });

  test("a `\\dv` becomes a DV node, as pyk's bridge produces", () => {
    const term = parseBinaryKoreTerm(writeTerm({ tag: 4, args: [{ string: "42" }] }), HEADER);
    expect(term.tag).toBe("DV");
    expect(koreText(term)).toBe('\\dv{SortInt{}}("42")');
  });

  test("other ML connectives go through the same dispatch", () => {
    const term = parseBinaryKoreTerm(writeTerm({ tag: 5, args: [{ tag: 0 }, { tag: 0 }] }), HEADER);
    expect(term.tag).toBe("And");
    expect(koreText(term)).toBe("\\and{SortInt{}}(Lblz{}(), Lblz{}())");
  });

  test("a string pattern is latin-1 and carries its own NUL past the count", () => {
    // `read_v2`'s string case reads `len` bytes and then one more
    // (`deserializer.cpp:127-137`); a reader that skipped the NUL would be one
    // byte out for the rest of the stream.
    const term = parseBinaryKoreTerm(writeTerm({ tag: 4, args: [{ string: "aÿb" }] }), HEADER);
    expect(term.tag === "DV" && term.value.value).toBe("aÿb");
  });

  test("pattern_len is the reference's arithmetic, which ignores composites", () => {
    // 4 for the magic, and nothing at all for a composite pattern — so a term
    // of any size with no domain values in it reports 4.
    const composite = readBinaryKoreTerm(
      new ByteCursor(writeTerm({ tag: 2, args: [{ tag: 1, args: [{ tag: 0 }] }, { tag: 0 }] })),
      HEADER,
    );
    expect(composite.patternLength).toBe(4);
    // 4 + (2 + 8 + len) for one string, which is what `kore[15]` in the
    // reference tool's non-expanded output means for a one-character value.
    const withValue = readBinaryKoreTerm(new ByteCursor(writeTerm({ tag: 4, args: [{ string: "0" }] })), HEADER);
    expect(withValue.patternLength).toBe(15);
  });

  test("the magic is checked, and its absence is named", () => {
    const noMagic = writeTerm({ tag: 0 }).subarray(BINARY_KORE_TERM_MAGIC.length);
    expect(() => parseBinaryKoreTerm(noMagic, HEADER)).toThrow(/Not a binary KORE 2\.0 term: bad magic number/);
  });

  test("an unknown tag byte is 'Bad term', as the reference calls it", () => {
    const bytes = new ByteWriter().bytes(BINARY_KORE_TERM_MAGIC).u8(7).build();
    expect(() => parseBinaryKoreTerm(bytes, HEADER)).toThrow(
      /Bad term: unknown binary KORE 2\.0 tag 0x07 \(at byte 4\)/,
    );
  });

  test("trailing bytes after a lone term are an error", () => {
    const bytes = new ByteWriter()
      .bytes(writeTerm({ tag: 0 }))
      .u8(0)
      .build();
    expect(() => parseBinaryKoreTerm(bytes, HEADER)).toThrow(/1 bytes left after the term/);
  });

  test("a symbol tag the header does not declare is reported, not indexed past", () => {
    expect(() => parseBinaryKoreTerm(writeTerm({ tag: 99 }), HEADER)).toThrow(ProofTraceError);
  });
});

describe("stripInjections", () => {
  test("drops every inj wrapper, recursively, as the reference printer does", () => {
    const term = parseBinaryKoreTerm(
      writeTerm({ tag: 2, args: [{ tag: 3, args: [{ tag: 3, args: [{ tag: 0 }] }] }, { tag: 0 }] }),
      HEADER,
    );
    expect(koreText(term)).toBe(
      "Lblpair{}(inj{SortFoo{}, SortKItem{}}(inj{SortFoo{}, SortKItem{}}(Lblz{}())), Lblz{}())",
    );
    expect(koreText(stripInjections(term))).toBe("Lblpair{}(Lblz{}(), Lblz{}())");
  });

  test("returns the identical object when there is nothing to strip", () => {
    const term = parseBinaryKoreTerm(writeTerm({ tag: 2, args: [{ tag: 0 }, { tag: 0 }] }), HEADER);
    expect(stripInjections(term)).toBe(term);
  });

  test("leaves a domain value alone", () => {
    const term = parseBinaryKoreTerm(writeTerm({ tag: 4, args: [{ string: "1" }] }), HEADER);
    expect(stripInjections(term)).toBe(term);
  });

  test("the decoded term keeps its injections — the TODO is reproduced, not fixed", () => {
    // `read_v2` carries a TODO about rewriting an `inj`'s second sort parameter
    // (`deserializer.cpp:145-147`) and does not do it; a reader that "fixed" it
    // would disagree with `kore-proof-trace` on the same bytes.
    const term = parseBinaryKoreTerm(writeTerm({ tag: 3, args: [{ tag: 0 }] }), HEADER);
    expect(koreText(term)).toBe("inj{SortFoo{}, SortKItem{}}(Lblz{}())");
  });
});
