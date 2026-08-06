/**
 * The **binary KORE 2.0 rich header** — the string/sort/symbol tables a hint
 * stream's terms are decoded against.
 *
 * Normative sources, both in `runtimeverification/llvm-backend` at `v0.1.140`
 * (the submodule commit K `v7.1.337` pins):
 *
 * - `docs/binary-kore-2.md` §Header — the prose spec;
 * - `lib/binary/deserializer.cpp:38-119` — `kore_header::kore_header`, the
 *   reference reader, which is what this file transcribes;
 * - `lib/binary/serializer.cpp:147-217` — `emit_kore_rich_header`, the writer,
 *   which settles the three things the prose leaves implicit (below).
 *
 * # What the prose does not say, and the writer does
 *
 * 1. **A string-table entry's length excludes its NUL.** The doc says "a
 *    4-byte integer length of the string in bytes" then "the zero-terminated
 *    string itself"; the writer emits `len = name.size()` and *then* a separate
 *    `'\0'` (`serializer.cpp:162-166`), and the reader reads `len` bytes and
 *    then one more with `fgetc` (`deserializer.cpp:69-77`).  So an entry
 *    occupies `4 + len + 1` bytes.
 * 2. **The symbol table's second half is `\dv`, one entry per sort.** Symbols
 *    `0 .. N-1` are the definition's tags; symbols `N .. N+M-1` are `\dv`
 *    instantiated at each sort, each with one formal parameter and arity 1
 *    (`serializer.cpp:209-216`).  That is how a domain value reaches the wire
 *    as an ordinary composite pattern: tag = the `\dv`-at-sort-S entry, one
 *    child = the string pattern.
 * 3. **Sort parameters are back-references and must point strictly backwards.**
 *    The reader rejects `param_offset >= i` (`deserializer.cpp:88-89`) and the
 *    writer raises "found sort ordinal not in topological order"
 *    (`serializer.cpp:186-188`).  Both are reproduced: it is the only structural
 *    invariant the header has, and honouring it means the sort table can be
 *    built in one forward pass with no fixups.
 *
 * # Where this header comes from
 *
 * `kore-rich-header <definition.kore> -o <file>`
 * (`tools/kore-rich-header/main.cpp`).  It is **not** written by `kompile`, so
 * it is not in a kompiled directory: a consumer generates it once per
 * definition and keeps it beside the hints.  {@link generateKoreRichHeader} in
 * `generate.ts` is that call.
 */

import { sortApp, type Sort, type SortApp } from "@kframework-ts/kore";

import { ByteCursor } from "./cursor.js";
import { ProofTraceError, ProofTraceVersionError } from "./errors.js";

/** `7f4b 5232` — `\x7FKR2` (`binary-kore-2.md` §Header, `serializer.cpp:154`). */
export const KORE_HEADER_MAGIC: readonly number[] = Object.freeze([0x7f, 0x4b, 0x52, 0x32]);

/** The only rich-header version that exists (`deserializer.cpp:57-59`). */
export const KORE_HEADER_VERSION = 1;

/** One symbol-table entry: a name, its formal sort parameters, and its arity. */
export interface KoreHeaderSymbol {
  /** The KORE symbol id — `Lbl'-LT-'k'-GT-'`, `inj`, `kseq`, `\dv`, … */
  readonly name: string;
  /** The sorts written between `{}`, resolved through the sort table. */
  readonly formalSorts: readonly Sort[];
  /**
   * How many children the term carries.
   *
   * This is the *only* place a decoder learns a composite pattern's arity —
   * binary KORE 2.0 does not write one per term (`binary-kore-2.md`
   * §Composite patterns), which is exactly what makes the header mandatory.
   */
  readonly arity: number;
}

/**
 * A parsed rich header, ready to decode terms against.
 *
 * Immutable and cheap to hold: one per definition, shared by every hint stream
 * that definition produced.
 */
export class KoreHeader {
  /** Always {@link KORE_HEADER_VERSION}; carried so a caller can log it. */
  readonly version: number;
  /** The string table, in file order.  Exposed because it is the only human-readable index into the rest. */
  readonly strings: readonly string[];
  /** The sort table, in file order; entry `i` may only reference entries `< i`. */
  readonly sorts: readonly SortApp[];
  /** The symbol table, in file order.  A term's `uint32` tag is an index into this. */
  readonly symbols: readonly KoreHeaderSymbol[];

  private constructor(
    version: number,
    strings: readonly string[],
    sorts: readonly SortApp[],
    symbols: readonly KoreHeaderSymbol[],
  ) {
    this.version = version;
    this.strings = strings;
    this.sorts = sorts;
    this.symbols = symbols;
  }

  /**
   * Read a `kore-rich-header` file — `kore_header::kore_header`
   * (`deserializer.cpp:38-119`).
   *
   * @throws {ProofTraceVersionError} when the version field is not
   *   {@link KORE_HEADER_VERSION}.
   * @throws {ProofTraceError} on a bad magic, a truncated table, or a
   *   forward sort reference.
   */
  static parse(bytes: Uint8Array): KoreHeader {
    const cursor = new ByteCursor(bytes);
    cursor.expectMagic(KORE_HEADER_MAGIC, "binary KORE 2.0 header");

    const versionOffset = cursor.offset;
    const version = cursor.readUint32();
    if (version !== KORE_HEADER_VERSION) {
      throw new ProofTraceVersionError("header", KORE_HEADER_VERSION, version, versionOffset);
    }

    // `num_entries[1..3]`: strings, sorts, symbols, in that order
    // (`deserializer.cpp:46-53`, `serializer.cpp:156-158`).
    const stringCount = cursor.readUint32();
    const sortCount = cursor.readUint32();
    const symbolCount = cursor.readUint32();

    const strings: string[] = [];
    for (let index = 0; index < stringCount; index += 1) {
      const length = cursor.readUint32();
      strings.push(cursor.readFixedString(length));
      // The separate NUL the writer emits after the counted bytes; `fgetc(in)`
      // at `deserializer.cpp:76`, whose result the reference also discards.
      cursor.readByte();
    }

    const sorts: SortApp[] = [];
    for (let index = 0; index < sortCount; index += 1) {
      const nameOffset = cursor.readUint32();
      const parameterCount = cursor.readByte();
      const parameters: Sort[] = [];
      for (let parameter = 0; parameter < parameterCount; parameter += 1) {
        const parameterOffset = cursor.offset;
        const target = cursor.readUint32();
        // `param_offset >= i` is the reference's rejection (`:88-89`); a sort
        // may only be parameterised by one declared before it.
        const resolved = target < index ? sorts[target] : undefined;
        if (resolved === undefined) {
          throw new ProofTraceError(
            `Sort ${String(index)} references sort ${String(target)}, which is not strictly earlier`,
            parameterOffset,
          );
        }
        parameters.push(resolved);
      }
      sorts.push(sortApp(stringAt(strings, nameOffset, "sort", cursor.offset), parameters));
    }

    const symbols: KoreHeaderSymbol[] = [];
    for (let index = 0; index < symbolCount; index += 1) {
      const nameOffset = cursor.readUint32();
      const parameterCount = cursor.readByte();
      const arity = cursor.readByte();
      const formalSorts: Sort[] = [];
      for (let parameter = 0; parameter < parameterCount; parameter += 1) {
        const parameterOffset = cursor.offset;
        const target = cursor.readUint32();
        const resolved = sorts[target];
        if (resolved === undefined) {
          throw new ProofTraceError(
            `Symbol ${String(index)} references unknown sort ${String(target)}`,
            parameterOffset,
          );
        }
        formalSorts.push(resolved);
      }
      symbols.push(
        Object.freeze({
          name: stringAt(strings, nameOffset, "symbol", cursor.offset),
          formalSorts: Object.freeze(formalSorts),
          arity,
        }),
      );
    }

    return new KoreHeader(version, Object.freeze(strings), Object.freeze(sorts), Object.freeze(symbols));
  }

  /**
   * The symbol a term's tag names — `get_symbol`/`get_arity`
   * (`deserializer.h:32-37`), which index without checking.
   *
   * This one checks: an out-of-range tag is the single most likely symptom of
   * a header and a hints file that came from *different* kompilations, and
   * that is worth a sentence rather than an `undefined` propagating into a
   * pattern.
   */
  symbol(tag: number): KoreHeaderSymbol {
    const symbol = this.symbols[tag];
    if (symbol === undefined) {
      throw new ProofTraceError(
        `Symbol tag ${String(tag)} is outside this header's ${String(this.symbols.length)} symbols — ` +
          `the header and the trace are probably from different kompilations`,
      );
    }
    return symbol;
  }
}

function stringAt(strings: readonly string[], offset: number, what: string, at: number): string {
  const value = strings[offset];
  if (value === undefined) {
    throw new ProofTraceError(`A ${what} names string ${String(offset)}, which is not in the string table`, at);
  }
  return value;
}
