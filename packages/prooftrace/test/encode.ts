/**
 * A writer for both binary formats, used only by the tests.
 *
 * The reader has to be exercised on inputs the fixtures do not contain — a
 * `pattern_matching_failure` event, a `PTRC` stream, a sort with parameters, a
 * string with a NUL-hostile byte in it, a deliberately corrupt tag — and the
 * only honest way to produce those is to write the bytes.  Everything below is
 * transcribed from the *writer* side of the same sources the reader was:
 * `llvm-backend lib/binary/serializer.cpp:147-217` for the header and
 * `include/runtime/proof_trace_writer.h:100-260` for the events.
 *
 * It is deliberately not in `src/`.  Writing a hint stream is the LLVM
 * runtime's job; a TypeScript package that could forge one would be a liability
 * (a forged trace is an oracle that says whatever you want), and no consumer
 * has asked.
 */

/** Little-endian byte builder. */
export class ByteWriter {
  #bytes: number[] = [];

  get length(): number {
    return this.#bytes.length;
  }

  u8(value: number): this {
    this.#bytes.push(value & 0xff);
    return this;
  }

  u32(value: number): this {
    for (let shift = 0; shift < 32; shift += 8) this.#bytes.push((value >>> shift) & 0xff);
    return this;
  }

  u64(value: number): this {
    let remaining = BigInt(value);
    for (let index = 0; index < 8; index += 1) {
      this.#bytes.push(Number(remaining & 0xffn));
      remaining >>= 8n;
    }
    return this;
  }

  /** One byte repeated eight times — `detail::word` (`ProofTraceParser.h:16-23`). */
  word(byte: number): this {
    for (let index = 0; index < 8; index += 1) this.#bytes.push(byte);
    return this;
  }

  /** Raw latin-1 bytes, no length and no terminator. */
  raw(text: string): this {
    for (let index = 0; index < text.length; index += 1) this.#bytes.push(text.charCodeAt(index) & 0xff);
    return this;
  }

  /** A `<c-style null terminated string>` (`proof-trace.md:68`). */
  cstring(text: string): this {
    return this.raw(text).u8(0);
  }

  bytes(values: Iterable<number>): this {
    for (const value of values) this.#bytes.push(value & 0xff);
    return this;
  }

  build(): Uint8Array {
    return Uint8Array.from(this.#bytes);
  }
}

/** One symbol-table row, as `emit_kore_rich_header` writes it. */
export interface SymbolRow {
  readonly name: string;
  /** Indices into the sort table. */
  readonly sortParams?: readonly number[];
  readonly arity: number;
}

/** One sort-table row. */
export interface SortRow {
  readonly name: string;
  /** Indices into the sort table; each must be strictly less than this row's. */
  readonly params?: readonly number[];
}

/**
 * Write a rich header — `emit_kore_rich_header` (`serializer.cpp:147-217`),
 * with the string table derived from the two other tables rather than laid out
 * as the real writer lays it out (tags, then sorts, then `\dv`).
 *
 * The layout is not part of the format: the reader only ever follows offsets.
 * Deriving it keeps a test's declaration to the two tables it cares about.
 */
export function writeHeader(sorts: readonly SortRow[], symbols: readonly SymbolRow[], version = 1): Uint8Array {
  const strings: string[] = [];
  const intern = (value: string): number => {
    const found = strings.indexOf(value);
    if (found >= 0) return found;
    strings.push(value);
    return strings.length - 1;
  };
  const sortNames = sorts.map((sort) => intern(sort.name));
  const symbolNames = symbols.map((symbol) => intern(symbol.name));

  const out = new ByteWriter();
  out.bytes([0x7f, 0x4b, 0x52, 0x32]).u32(version).u32(strings.length).u32(sorts.length).u32(symbols.length);
  for (const value of strings) out.u32(value.length).raw(value).u8(0);
  for (const [index, sort] of sorts.entries()) {
    out.u32(sortNames[index]!).u8(sort.params?.length ?? 0);
    for (const param of sort.params ?? []) out.u32(param);
  }
  for (const [index, symbol] of symbols.entries()) {
    out
      .u32(symbolNames[index]!)
      .u8(symbol.sortParams?.length ?? 0)
      .u8(symbol.arity);
    for (const param of symbol.sortParams ?? []) out.u32(param);
  }
  return out.build();
}

/** A term to serialize: a symbol-table index with children, or a string literal. */
export type TermSpec = { readonly tag: number; readonly args?: readonly TermSpec[] } | { readonly string: string };

/** Write one `\x7FKR2`-prefixed term (`ProofTraceParser.h:359-372` + `read_v2`'s inverse). */
export function writeTerm(term: TermSpec): Uint8Array {
  const out = new ByteWriter();
  out.bytes([0x7f, 0x4b, 0x52, 0x32]);
  writeTermBody(out, term);
  return out.build();
}

function writeTermBody(out: ByteWriter, term: TermSpec): void {
  if ("string" in term) {
    out.u8(0).u64(term.string.length).raw(term.string).u8(0);
    return;
  }
  out.u8(1).u32(term.tag);
  for (const arg of term.args ?? []) writeTermBody(out, arg);
}

/** `HINT`/`PTRC`/`CHNK` plus a 4-byte version (`ProofTraceParser.h:374-404`). */
export function writeTraceHeader(out: ByteWriter, kind: "HINT" | "PTRC" | "CHNK" = "HINT", version = 13): ByteWriter {
  return out.raw(kind).u32(version);
}

/** `rule ::= WORD(0x22) ordinal arity variable*`. */
export function writeRule(
  out: ByteWriter,
  ordinal: number,
  bindings: readonly (readonly [string, TermSpec])[],
): ByteWriter {
  out.word(0x22).u64(ordinal).u64(bindings.length);
  for (const [name, term] of bindings) out.cstring(name).bytes(writeTerm(term));
  return out;
}

/** `side_cond_entry ::= WORD(0xEE) ordinal arity variable*`. */
export function writeSideConditionEnter(
  out: ByteWriter,
  ordinal: number,
  bindings: readonly (readonly [string, TermSpec])[],
): ByteWriter {
  out.word(0xee).u64(ordinal).u64(bindings.length);
  for (const [name, term] of bindings) out.cstring(name).bytes(writeTerm(term));
  return out;
}

/** `side_cond_exit ::= WORD(0x33) ordinal boolean_result`. */
export function writeSideConditionExit(out: ByteWriter, ordinal: number, result: boolean): ByteWriter {
  return out
    .word(0x33)
    .u64(ordinal)
    .u8(result ? 1 : 0);
}

/** `function ::= WORD(0xDD) name location arg* WORD(0x11)`. */
export function writeFunction(
  out: ByteWriter,
  name: string,
  position: string,
  args: readonly TermSpec[] = [],
): ByteWriter {
  out.word(0xdd).cstring(name).cstring(position);
  for (const arg of args) out.bytes(writeTerm(arg));
  return out.word(0x11);
}

/** `function_exit ::= WORD(0x55) ordinal boolean_result`. */
export function writeFunctionExit(out: ByteWriter, ordinal: number, isTail: boolean): ByteWriter {
  return out
    .word(0x55)
    .u64(ordinal)
    .u8(isTail ? 1 : 0);
}

/** `hook ::= WORD(0xAA) name symbol_name location arg* WORD(0xBB) kore_term`. */
export function writeHook(
  out: ByteWriter,
  name: string,
  symbolName: string,
  position: string,
  args: readonly TermSpec[],
  result: TermSpec,
): ByteWriter {
  out.word(0xaa).cstring(name).cstring(symbolName).cstring(position);
  for (const arg of args) out.bytes(writeTerm(arg));
  return out.word(0xbb).bytes(writeTerm(result));
}

/** `pattern_matching_failure ::= WORD(0x44) function_name`. */
export function writePatternMatchingFailure(out: ByteWriter, functionName: string): ByteWriter {
  return out.word(0x44).cstring(functionName);
}

/** `config ::= WORD(0xFF) kore_term`. */
export function writeConfig(out: ByteWriter, term: TermSpec): ByteWriter {
  return out.word(0xff).bytes(writeTerm(term));
}
