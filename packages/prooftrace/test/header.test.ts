/**
 * The rich header: the three things `binary-kore-2.md` leaves implicit and the
 * writer settles, plus the real 4 404-byte header a `kompile` produced.
 */

import { describe, expect, test } from "bun:test";

import { ProofTraceError, ProofTraceVersionError } from "../src/errors.ts";
import { KORE_HEADER_VERSION, KoreHeader } from "../src/header.ts";
import { caught } from "./caught.ts";
import { ByteWriter, writeHeader } from "./encode.ts";
import { fixtureBytes } from "./support.ts";

describe("KoreHeader.parse", () => {
  test("reads the three tables and resolves names through the string table", () => {
    const header = KoreHeader.parse(
      writeHeader(
        [{ name: "SortInt" }, { name: "SortKItem" }, { name: "SortList", params: [0, 1] }],
        [
          { name: "Lblfoo", arity: 0 },
          { name: "inj", sortParams: [0, 1], arity: 1 },
          { name: "\\dv", sortParams: [0], arity: 1 },
        ],
      ),
    );
    expect(header.version).toBe(KORE_HEADER_VERSION);
    expect(header.sorts.map((sort) => sort.name)).toEqual(["SortInt", "SortKItem", "SortList"]);
    // A parameterised sort resolves its parameters through the same table.
    expect(header.sorts[2]?.sorts.map((sort) => (sort.tag === "SortApp" ? sort.name : ""))).toEqual([
      "SortInt",
      "SortKItem",
    ]);
    expect(header.symbol(1)).toEqual({
      name: "inj",
      formalSorts: [header.sorts[0]!, header.sorts[1]!],
      arity: 1,
    });
  });

  test("a sort may only reference a strictly earlier sort", () => {
    // `param_offset >= i` is the reference's own rejection
    // (`deserializer.cpp:88-89`); accepting it would mean an unresolvable
    // forward reference or a cycle.
    expect(() => KoreHeader.parse(writeHeader([{ name: "SortA", params: [0] }], []))).toThrow(
      /references sort 0, which is not strictly earlier/,
    );
    expect(() => KoreHeader.parse(writeHeader([{ name: "SortA" }, { name: "SortB", params: [1] }], []))).toThrow(
      ProofTraceError,
    );
  });

  test("the version is asserted, not assumed", () => {
    const error = caught(() => KoreHeader.parse(writeHeader([], [], 2)), ProofTraceVersionError);
    expect(error.stream).toBe("header");
    expect(error.expected).toBe(1);
    expect(error.found).toBe(2);
  });

  test("a file that is not a header says so instead of producing nonsense", () => {
    expect(() => KoreHeader.parse(new ByteWriter().raw("HINT").u32(13).build())).toThrow(
      /Not a binary KORE 2\.0 header: bad magic number \(at byte 0\)/,
    );
  });

  test("a truncated table is an error at the byte it ran out on", () => {
    const complete = writeHeader([{ name: "SortInt" }], [{ name: "Lblfoo", arity: 0 }]);
    expect(() => KoreHeader.parse(complete.subarray(0, complete.length - 3))).toThrow(ProofTraceError);
  });

  test("an out-of-range symbol tag names the likely cause", () => {
    const header = KoreHeader.parse(writeHeader([], [{ name: "Lblfoo", arity: 0 }]));
    expect(() => header.symbol(7)).toThrow(/different kompilations/);
  });

  test("the real header a kompile produced has the shape the writer promises", () => {
    // `emit_kore_rich_header` writes `num_strings = num_tags + num_sorts + 1`
    // and `num_symbols = num_tags + num_sorts` (`serializer.cpp:148-152`), so
    // the two counts differ by exactly one — the `\dv` string — and the last
    // `num_sorts` symbols are all `\dv`.
    const header = KoreHeader.parse(fixtureBytes("hints", "add-rewrite.header"));
    expect(header.strings.length).toBe(header.symbols.length + 1);
    const tags = header.symbols.length - header.sorts.length;
    expect(header.symbols.slice(tags).every((symbol) => symbol.name === "\\dv")).toBe(true);
    // …each with one formal parameter and arity one (`:209-216`), which is what
    // makes a domain value an ordinary composite pattern on the wire.
    expect(header.symbols.slice(tags).every((symbol) => symbol.arity === 1 && symbol.formalSorts.length === 1)).toBe(
      true,
    );
    expect(header.symbols.slice(0, tags).some((symbol) => symbol.name === "inj")).toBe(true);
    expect(header.strings.at(-1)).toBe("\\dv");
  });

  test("the two real headers disagree, which is why one is not reusable for the other", () => {
    const addRewrite = KoreHeader.parse(fixtureBytes("hints", "add-rewrite.header"));
    const guarded = KoreHeader.parse(fixtureBytes("hints", "guarded.header"));
    expect(guarded.symbols.length).not.toBe(addRewrite.symbols.length);
  });
});
