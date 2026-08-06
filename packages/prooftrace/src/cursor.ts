/**
 * A bounds-checked little-endian byte cursor — `proof_trace_memory_buffer`
 * (`llvm-backend include/kllvm/binary/deserializer.h:69-146`), transcribed.
 *
 * Every read the two formats need is here and nowhere else, so the format
 * modules read like their grammars.  The C++ methods return `bool` and leave
 * the caller to propagate; these throw {@link ProofTraceError} with the offset,
 * for the reason `errors.ts` gives.
 *
 * # Three transcription notes worth stating
 *
 * 1. **`peek_word` is only ever compared against a sentinel.** Every sentinel
 *    the format defines is `detail::word(b)` — one byte repeated eight times
 *    (`ProofTraceParser.h:16-38`) — and the parser's only uses of `peek_word`
 *    are equality tests against those constants and the `switch` at `:667`.
 *    So {@link ByteCursor.peekSentinel} answers "the next eight bytes are all
 *    `b`, and here is `b`" instead of materialising a 64-bit value, which
 *    avoids a `BigInt` on the hot path.  It is exactly equivalent: `peek_word()
 *    == word(b)` iff the next eight bytes all equal `b`.
 * 2. **`has_word()` is *not* implied by `peekSentinel() !== undefined`.** The
 *    reference distinguishes the two — `while (has_word() && peek_word() != X)`
 *    at `:720` stops at a short tail, while `while (!has_word() || peek_word()
 *    != X)` at `:446` keeps going into one — so {@link ByteCursor.hasWord} is
 *    kept as its own predicate and both loops are transcribed literally.
 * 3. **Strings are latin-1.** The C++ copies raw bytes into a `std::string`;
 *    pyk decodes the same bytes with `latin-1` (`kllvm/convert.py:203`).
 *    `@kframework-ts/kore`'s `bytesDecode` is that decode, so a `KoreString`
 *    read here round-trips through `koreText` to the same escapes pyk produces.
 */

import { bytesDecode } from "@kframework-ts/kore";

import { ProofTraceError } from "./errors.js";

/** Eight, the width of a sentinel word and of every length field in the trace. */
const WORD = 8;

/** A read-only cursor over `bytes`, tracking a byte offset. */
export class ByteCursor {
  readonly #bytes: Uint8Array;
  readonly #view: DataView;
  #offset: number;

  constructor(bytes: Uint8Array, offset = 0) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.#offset = offset;
  }

  /** How many bytes have been consumed. */
  get offset(): number {
    return this.#offset;
  }

  /** How many bytes are left. */
  get remaining(): number {
    return this.#bytes.length - this.#offset;
  }

  /** `proof_trace_memory_buffer::eof` (`deserializer.h:97`). */
  eof(): boolean {
    return this.remaining <= 0;
  }

  /** `proof_trace_memory_buffer::has_word` (`:95`) — at least eight bytes left. */
  hasWord(): boolean {
    return this.remaining >= WORD;
  }

  /** `proof_trace_memory_buffer::peek` (`:99-104`), with `undefined` for `EOF`. */
  peekByte(): number | undefined {
    return this.eof() ? undefined : this.#bytes[this.#offset];
  }

  /**
   * The repeated byte of the next sentinel word, or `undefined` when the next
   * eight bytes are not all equal (or there are fewer than eight).
   *
   * See note 1 in the module header for why this replaces `peek_word`.
   */
  peekSentinel(): number | undefined {
    if (!this.hasWord()) return undefined;
    const first = this.#bytes[this.#offset];
    for (let index = 1; index < WORD; index += 1) {
      if (this.#bytes[this.#offset + index] !== first) return undefined;
    }
    return first;
  }

  /** One byte.  `proof_trace_memory_buffer::read()` (`:88-93`). */
  readByte(): number {
    const byte = this.peekByte();
    if (byte === undefined) throw new ProofTraceError("Unexpected end of input", this.#offset);
    this.#offset += 1;
    return byte;
  }

  /** One byte as a boolean — `read_bool` (`:60-66`), which is `b = read()`. */
  readBool(): boolean {
    return this.readByte() !== 0;
  }

  /** `read_uint32` (`:108-115`). */
  readUint32(): number {
    this.#require(4, "uint32");
    const value = this.#view.getUint32(this.#offset, true);
    this.#offset += 4;
    return value;
  }

  /**
   * `read_uint64` (`:117-124`), narrowed to a JS number.
   *
   * Every `uint64` the format actually carries is a count — an ordinal, an
   * arity, a string length — so a value past `Number.MAX_SAFE_INTEGER` is
   * corruption rather than a number this package should try to represent.
   * Saying so is better than silently losing precision.
   */
  readUint64(): number {
    this.#require(WORD, "uint64");
    const start = this.#offset;
    const value = this.#view.getBigUint64(start, true);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ProofTraceError(`Length or ordinal is out of range: ${value.toString()}`, start);
    }
    this.#offset += WORD;
    return Number(value);
  }

  /** `length` raw bytes, as a subarray that shares the input's storage. */
  readBytes(length: number): Uint8Array {
    this.#require(length, `${String(length)} bytes`);
    const slice = this.#bytes.subarray(this.#offset, this.#offset + length);
    this.#offset += length;
    return slice;
  }

  /**
   * A NUL-terminated string — `read_string(std::string&)` (`:126-135`).
   *
   * The reference fails rather than returning a truncated string when no NUL
   * is found before the end of the buffer (`len == end_ - ptr_`), and so does
   * this.
   */
  readCString(): string {
    const start = this.#offset;
    const end = this.#bytes.indexOf(0, start);
    if (end < 0) throw new ProofTraceError("Unterminated string", start);
    this.#offset = end + 1;
    return bytesDecode(this.#bytes.subarray(start, end));
  }

  /** Exactly `length` bytes as latin-1 — `read_string(std::string&, size_t)` (`:137-145`). */
  readFixedString(length: number): string {
    return bytesDecode(this.readBytes(length));
  }

  /**
   * Consume a sentinel word and check it — `check_word` (`:49-55`).
   *
   * `what` names the sentinel in the failure, because "expected 0xDD" is not
   * a sentence anybody wants to debug from.
   */
  expectSentinel(byte: number, what: string): void {
    const start = this.#offset;
    const found = this.peekSentinel();
    if (found !== byte) {
      throw new ProofTraceError(
        `Expected the ${what} sentinel 0x${byte.toString(16).padStart(2, "0").repeat(WORD)}`,
        start,
      );
    }
    this.#offset += WORD;
  }

  /**
   * Whether the next bytes are `magic`, without consuming anything.
   *
   * The reference reads the four magic bytes and then compares
   * (`ProofTraceParser.h:376-391`), which works there because a failed
   * comparison ends the parse.  Here three magics are tried in turn, so the
   * probe has to be non-destructive.
   */
  startsWith(magic: readonly number[]): boolean {
    if (this.remaining < magic.length) return false;
    for (let index = 0; index < magic.length; index += 1) {
      if (this.#bytes[this.#offset + index] !== magic[index]) return false;
    }
    return true;
  }

  /** Consume and check a fixed byte prefix — the `HINT`/`\x7FKR2` magics. */
  expectMagic(magic: readonly number[], what: string): void {
    const start = this.#offset;
    this.#require(magic.length, what);
    for (let index = 0; index < magic.length; index += 1) {
      if (this.#bytes[start + index] !== magic[index]) {
        throw new ProofTraceError(`Not a ${what}: bad magic number`, start);
      }
    }
    this.#offset += magic.length;
  }

  #require(length: number, what: string): void {
    if (length < 0 || this.remaining < length) {
      throw new ProofTraceError(`Unexpected end of input while reading ${what}`, this.#offset);
    }
  }
}
