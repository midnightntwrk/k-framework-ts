/**
 * The two failure shapes a binary reader can have, and nothing else.
 *
 * The C++ reference reports malformed input two different ways depending on
 * which layer notices: `proof_trace_parser` returns `nullptr` all the way up
 * and prints nothing (`ProofTraceParser.h:359-747`), while `read_v2` and
 * `kore_header::kore_header` throw `std::runtime_error` with short messages
 * (`lib/binary/deserializer.cpp:39-160`).  Returning `null` from a parser is
 * not an option here — a caller would have no way to learn *where* the stream
 * stopped making sense, and this package's whole point is being able to say so
 * — so both become exceptions carrying the byte offset.
 */

/**
 * A byte in the input is not what the format says it should be.
 *
 * {@link offset} is the position of the first byte of the malformed field, not
 * the position the cursor had reached — so `xxd -s <offset>` lands on the
 * problem.
 */
export class ProofTraceError extends Error {
  /** Byte offset of the field that failed, or `undefined` when not positional. */
  readonly offset: number | undefined;

  constructor(message: string, offset?: number) {
    super(offset === undefined ? message : `${message} (at byte ${String(offset)})`);
    this.name = "ProofTraceError";
    this.offset = offset;
  }
}

/**
 * The input identifies itself, and it is not a version this package reads.
 *
 * Separated from {@link ProofTraceError} because it is the *expected* failure
 * when K moves: `proof_trace_parser::expected_version` is a single constant
 * that the backend bumps (`ProofTraceParser.h:348`), and a caller pinning K
 * versions wants to branch on "you are on the wrong K" rather than grep a
 * message for a number.
 */
export class ProofTraceVersionError extends ProofTraceError {
  /** The version this package implements. */
  readonly expected: number;
  /** The version the input declared. */
  readonly found: number;
  /** Which stream disagreed — the hints file, or the binary-KORE rich header. */
  readonly stream: "hints" | "header";

  constructor(stream: "hints" | "header", expected: number, found: number, offset: number) {
    super(`Unsupported ${stream} version: expected ${String(expected)}, got ${String(found)}`, offset);
    this.name = "ProofTraceVersionError";
    this.expected = expected;
    this.found = found;
    this.stream = stream;
  }
}
