/**
 * **Binary KORE 2.0 terms** → `@kframework-ts/kore` `Pattern`s.
 *
 * Normative sources (`runtimeverification/llvm-backend` at `v0.1.140`):
 *
 * - `docs/binary-kore-2.md` §Terms — two tags, `00` for a string pattern and
 *   `01` for a composite one, and nothing else;
 * - `lib/binary/deserializer.cpp:123-160` — `detail::read_v2`, the reference
 *   reader, transcribed here statement for statement;
 * - `include/kllvm/binary/ProofTraceParser.h:359-372` — `parse_kore_term`,
 *   which is what puts the `\x7FKR2` magic in front of every term the hint
 *   stream carries.
 *
 * # This is **not** the format `binary-kore.md` describes
 *
 * `@kframework-ts/kore` does not read either one today, and the two must not be
 * confused.  Binary KORE **1.x** (`docs/binary-kore.md`, magic `\x7FKORE`) is
 * self-describing, postfix, variable-length-encoded, string-interned and
 * composable by concatenation.  Binary KORE **2.0** (magic `\x7FKR2`) is none
 * of those: it is prefix, fixed-width, and carries no symbol names, no sorts
 * and no arities at all — every one of those comes out of the rich header, and
 * a term without its header is undecodable.  `binary-kore-2.md`'s preface says
 * why in one line: "Serialization of terms must be as fast as possible … Terms
 * do not need to be composable."  Only 2.0 appears in a hint stream.
 *
 * # Three deviations, all forced and all small
 *
 * 1. **`\dv` becomes a `DV` node, not an `App`.** The C++ keeps a
 *    `kore_composite_pattern` whose constructor is named `\dv`; pyk's bridge
 *    turns exactly that into `MLPattern.of('\dv', …)` on the way out
 *    (`pyk/kllvm/convert.py:216-218`).  `mlPattern` is that dispatch, so the
 *    `Pattern` this returns is the one a pyk caller would hold, and
 *    `koreText` prints `\dv{SortInt{}}("0")` rather than an application.
 * 2. **Strings are decoded latin-1.** `cursor.ts` note 3.
 * 3. **`inj`'s second sort parameter is left as the header wrote it.**
 *    `read_v2` carries a `TODO` at `deserializer.cpp:145-147` saying the
 *    injection's result sort ought to be rewritten to the enclosing pattern's
 *    sort and is not.  Reproducing the TODO rather than fixing it is
 *    deliberate: a "fix" would make this reader disagree with `kore-proof-trace`
 *    on the same bytes, and the sort is recoverable from the definition anyway.
 *    {@link stripInjections} exists because that is what the backend's own tool
 *    does before printing.
 */

import { app, koreString, ML_SYMBOLS, mlPattern, type Pattern, type Sort } from "@kframework-ts/kore";

import { ByteCursor } from "./cursor.js";
import { ProofTraceError } from "./errors.js";
import type { KoreHeader } from "./header.js";

/** `7f4b 5232` — the per-term magic (`ProofTraceParser.h:362-368`). */
export const BINARY_KORE_TERM_MAGIC: readonly number[] = Object.freeze([0x7f, 0x4b, 0x52, 0x32]);

/** A decoded term, with the byte count the backend's own tools report for it. */
export interface BinaryKoreTerm {
  readonly pattern: Pattern;
  /**
   * `pattern_len` as `parse_kore_term` computes it — **not** the term's size.
   *
   * `read_v2` accumulates `2 + sizeof(len) + len` for each *string* pattern
   * (`deserializer.cpp:136`) and adds nothing at all for a composite one, then
   * `parse_kore_term` adds 4 for the magic (`ProofTraceParser.h:370`).  So a
   * term with no domain values in it reports 4 no matter how large it is.
   *
   * It is surfaced because `kore-proof-trace` without `--expand-terms` prints
   * exactly this number (`ProofTraceParser.cpp:43`), and a reader comparing
   * against that output needs the same arithmetic — bug included.  Nothing in
   * this package uses it for anything.
   */
  readonly patternLength: number;
}

/**
 * Read one `\x7FKR2`-prefixed term at the cursor — `parse_kore_term`
 * (`ProofTraceParser.h:359-372`).
 *
 * @throws {ProofTraceError} on a bad magic, an unknown tag byte, or a symbol
 *   tag the header does not declare.
 */
export function readBinaryKoreTerm(cursor: ByteCursor, header: KoreHeader): BinaryKoreTerm {
  cursor.expectMagic(BINARY_KORE_TERM_MAGIC, "binary KORE 2.0 term");
  const state = { length: 0 };
  const pattern = readV2(cursor, header, state);
  // `pattern_len += 4` for the magic, after the body (`:370`).
  return Object.freeze({ pattern, patternLength: state.length + BINARY_KORE_TERM_MAGIC.length });
}

/**
 * Read a whole buffer as one term — the convenience a test or a caller holding
 * a single serialized term wants.
 *
 * Trailing bytes are an error: a lone term file has no framing, so anything
 * left over means the buffer was not what the caller thought it was.
 */
export function parseBinaryKoreTerm(bytes: Uint8Array, header: KoreHeader): Pattern {
  const cursor = new ByteCursor(bytes);
  const { pattern } = readBinaryKoreTerm(cursor, header);
  if (!cursor.eof()) {
    throw new ProofTraceError(`${String(cursor.remaining)} bytes left after the term`, cursor.offset);
  }
  return pattern;
}

/** `detail::read_v2` (`deserializer.cpp:125-159`) — the recursive descent proper. */
function readV2(cursor: ByteCursor, header: KoreHeader, state: { length: number }): Pattern {
  const tagOffset = cursor.offset;
  const tag = cursor.readByte();

  // `case 0`: a string pattern (`binary-kore-2.md` §String patterns).
  if (tag === 0) {
    const length = cursor.readUint64();
    const value = cursor.readFixedString(length);
    // The zero terminator, read and discarded exactly as `buffer.read()` at
    // `deserializer.cpp:135` does.
    cursor.readByte();
    // `pattern_len += 2 + sizeof(len) + len` (`:136`): the tag byte, the NUL,
    // the 8-byte length, and the bytes.
    state.length += 2 + 8 + length;
    return koreString(value);
  }

  // `case 1`: a composite pattern, whose arity comes only from the header.
  if (tag === 1) {
    const tagValueOffset = cursor.offset;
    const symbol = header.symbol(cursor.readUint32());
    const args: Pattern[] = [];
    for (let index = 0; index < symbol.arity; index += 1) args.push(readV2(cursor, header, state));
    return composite(symbol.name, symbol.formalSorts, args, tagValueOffset);
  }

  // `default: throw std::runtime_error("Bad term")` (`:158`).
  throw new ProofTraceError(`Bad term: unknown binary KORE 2.0 tag 0x${tag.toString(16).padStart(2, "0")}`, tagOffset);
}

/**
 * Build the `Pattern` for a decoded head — `llvm_to_pattern`'s composite arm
 * (`pyk/kllvm/convert.py:212-221`), minus the two `\left-assoc`/`\right-assoc`
 * cases.
 *
 * Those two cannot occur: `binary-kore.md` §Caveats states that the assoc sugar
 * exists only in *textual* KORE and never in a parsed AST, and the LLVM runtime
 * serializes from its own in-memory term, where it likewise does not exist.  An
 * `App` is what a definition that somehow declared such a symbol would get,
 * which is strictly better than throwing on a term we can otherwise represent.
 */
function composite(name: string, sorts: readonly Sort[], args: readonly Pattern[], at: number): Pattern {
  if (name in ML_SYMBOLS) {
    try {
      return mlPattern(name, sorts, args);
    } catch (error) {
      // `mlPattern` enforces each connective's arity; a header that declares
      // `\and` with the wrong one is corruption, and the offset says where.
      throw new ProofTraceError(`Malformed ${name}: ${error instanceof Error ? error.message : String(error)}`, at);
    }
  }
  return app(name, sorts, args);
}

/**
 * Drop every `inj{_, _}(x)` wrapper — `kore_composite_pattern::strip_injections`
 * (`llvm-backend lib/ast/AST.cpp:1128-1139`).
 *
 * This is not decoding, and no term in a {@link BinaryKoreTerm} has been put
 * through it.  It is here because `kore-proof-trace` applies it to every term
 * it prints (`ProofTraceParser.cpp:41`, `:112`), so it is the transformation a
 * reader needs in order to compare this package's output against the backend's
 * own tool — which is exactly what `test/reference.test.ts` does.
 */
export function stripInjections(pattern: Pattern): Pattern {
  if (pattern.tag !== "App") return pattern;
  if (pattern.symbol === "inj" && pattern.args.length === 1) {
    // `arguments_[0]->strip_injections()` — the wrapper vanishes, and the
    // child is stripped in turn (`AST.cpp:1129-1131`).
    return stripInjections(pattern.args[0]!);
  }
  const args = pattern.args.map(stripInjections);
  return args.every((arg, index) => arg === pattern.args[index]) ? pattern : app(pattern.symbol, pattern.sorts, args);
}
