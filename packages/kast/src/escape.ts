/**
 * K's string and bytes escape codec.
 *
 * Transcribed from pyk `dequote.py` (the whole file, 123 L, at v7.1.337).  In
 * pyk this module is what gives `SortString` and `SortBytes` tokens their
 * textual form: `stringToken` wraps `enquote_string` in `"…"`
 * (`prelude/string.py:10`), `pretty_string` reverses it (`string.py:17`), and
 * the `b"…"` bytes token does the same through the `_bytes` variants
 * (`prelude/bytes.py:10,22,26`).  A `KToken`'s `token` field therefore always
 * holds *escaped* text; the functions here are the only way in and out of it.
 *
 * # The alphabet
 *
 * Six one-character escapes — `\t \n \f \r \" \\` — plus three fixed-width
 * hexadecimal forms, `\xHH`, `\uHHHH`, `\UHHHHHHHH`.  The set is closed: K is
 * not C, so `\a`, `\b`, `\v`, `\'` and octal escapes are errors, not literals.
 * The widths are exact rather than maximal, so `"\x4e80"` decodes to U+004E
 * followed by the literal text `80` (`test_dequote.py:88`).
 *
 * # Emit lowercase, accept both cases
 *
 * `enquoted` (`dequote.py:107-123`) formats hex with Python's `x` conversion —
 * lowercase, zero-padded to the escape's width — while `dequoted`
 * (`dequote.py:53`) builds its digit table from `'0123456789abcdefABCDEF'`.
 * Decoding is therefore case-insensitive and encoding is not; both halves are
 * load-bearing, since goldens produced by the Java frontend use uppercase and
 * our own output has to be byte-stable.
 *
 * # Bytes are latin-1
 *
 * pyk models a K `Bytes` value as a `str` in which every character is a byte,
 * and crosses to real bytes with `s.encode('latin-1')` / `b.decode('latin-1')`
 * (`dequote.py:26-31`).  {@link bytesEncode} / {@link bytesDecode} keep that
 * correspondence: one UTF-16 code unit per byte, nothing above U+00FF
 * encodable.  This is the one place in this file that is deliberately *not*
 * code-point iteration — see below.
 *
 * # The JavaScript hazard: code points, not UTF-16 units
 *
 * Python iterates a `str` by code point.  JavaScript's `for…of` does too, but
 * `s[i]` / `s.charCodeAt(i)` / `s.length` do not — they see UTF-16 code units.
 * An index loop would encode U+1F642 as the surrogate pair `🙂`,
 * i.e. two escapes of two values that are not characters at all, where pyk
 * emits the single `\U0001f642` (`test_dequote.py:109`).  Every loop in the
 * escape codec is `for…of` and every code is read with `codePointAt(0)`.
 *
 * # Divergence from pyk: surrogates and out-of-range code points
 *
 * `\U00110000` is rejected by pyk too — `chr()` raises `ValueError` above
 * U+10FFFF — and by the Java frontend
 * (`k-frontend/src/test/java/org/kframework/utils/StringUtilTest.java:24-28`).
 * The two disagree on `\U0000d801`: Java rejects it (`StringUtilTest.java:29-33`)
 * while pyk's `chr` happily produces a lone surrogate, and `enquote_string`
 * hands that surrogate straight back as `\ud801`.  We follow Java and reject
 * the surrogate block in **both** directions.  This is the file's only
 * intentional departure from pyk, and it is not the usual "pyk wins"
 * situation: a JS string can physically hold an unpaired surrogate, so
 * accepting one on decode would let a term carry text that is not valid
 * Unicode, will not survive `TextEncoder`, and re-encodes into a document our
 * own decoder refuses.  A codec that is lenient on one side and strict on the
 * other is not a round trip.
 *
 * # Relationship to `@kframework-ts/kore`
 *
 * That package transcribes the same pyk file for KORE string literals.  The
 * two transcriptions are independent (this package depends on nothing) and
 * were compared afterwards: the accepted/rejected languages and the emitted
 * spellings agree exactly, including the surrogate divergence above, which the
 * KORE grammar states outright (`kore-syntax.md:33`).  The only difference is
 * the error type — KORE throws bare `SyntaxError`, this module throws
 * {@link EscapeError}, which carries the offending index.
 */

/**
 * A positioned escape-codec failure.
 *
 * `position` is a UTF-16 index into the offending string: the index of the
 * character that made the failure detectable, except that a malformed code
 * point value points at the `\` that opened its escape (the digits themselves
 * were all individually legal), and an escape left open at end of input points
 * one past the end.  For {@link bytesEncode} it is the index of the
 * unencodable code unit.
 *
 * Extends `SyntaxError` because every failure here is a lexical property of
 * the text — matching the KORE package's choice, so that a future
 * KAST↔KORE converter can catch one class.
 */
export class EscapeError extends SyntaxError {
  readonly position: number;

  constructor(position: number, description: string) {
    super(`${description} (at index ${position})`);
    this.name = "EscapeError";
    this.position = position;
  }
}

/** Decoder states — `dequote.py:34-36`. */
const NORMAL = 0;
const ESCAPE = 1;
const CPOINT = 2;

/**
 * The one-character escapes, decode direction — `dequote.py:38-45`.
 *
 * A `Map`, not an object literal: the keys are looked up with text taken
 * straight out of the input, and `{}['constructor']` is not `undefined`.
 */
const ESCAPE_TABLE = new Map<string, string>([
  ['"', '"'],
  ["\\", "\\"],
  ["n", "\n"],
  ["t", "\t"],
  ["r", "\r"],
  ["f", "\f"],
]);

/** Hex-escape introducer to its exact digit count — `dequote.py:47-51`. */
const CPOINT_TABLE = new Map<string, number>([
  ["x", 2],
  ["u", 4],
  ["U", 8],
]);

/** The one-character escapes, encode direction, keyed by code — `dequote.py:97-104`. */
const ENQUOTE_TABLE = new Map<number, string>([
  [9, "\\t"],
  [10, "\\n"],
  [12, "\\f"],
  [13, "\\r"],
  [34, '\\"'],
  [92, "\\\\"],
]);

/** Inclusive bounds of the UTF-16 surrogate block, which holds no characters. */
const SURROGATE_MIN = 0xd800;
const SURROGATE_MAX = 0xdfff;

/** The largest Unicode code point; `chr()` raises above it (`dequote.py:69`). */
const MAX_CODE_POINT = 0x10_ff_ff;

/**
 * Value of a single hex digit, or `undefined` if `c` is not one.
 *
 * Transcribes `HEX_TABLE` (`dequote.py:53`), built from
 * `'0123456789abcdefABCDEF'` — both cases decode and nothing else does.  In
 * particular this must reject the non-ASCII digits that `Number.parseInt` and
 * `/\d/` accept (e.g. U+FF10 FULLWIDTH DIGIT ZERO).
 */
function hexValue(c: string): number | undefined {
  const code = c.codePointAt(0);
  if (code === undefined) return undefined;
  if (code >= 0x30 && code <= 0x39) return code - 0x30; // 0-9
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10; // a-f
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10; // A-F
  return undefined;
}

/** Lowercase hex, zero-padded — Python's `f'{code:0{width}x}'`. */
function hex(code: number, width: number): string {
  return code.toString(16).padStart(width, "0");
}

/**
 * `chr(acc)` (`dequote.py:69`), with the surrogate block ruled out as well.
 *
 * See the divergence note in the file header: the range check is pyk's, the
 * surrogate check is the Java frontend's.
 */
function codePointToString(code: number, position: number): string {
  if (code >= SURROGATE_MIN && code <= SURROGATE_MAX) {
    throw new EscapeError(position, `Surrogate code point in escape sequence: U+${hex(code, 4).toUpperCase()}`);
  }
  if (code > MAX_CODE_POINT) {
    throw new EscapeError(position, `Code point out of range: U+${hex(code, 8).toUpperCase()}`);
  }
  return String.fromCodePoint(code);
}

/**
 * The decoder state machine — `dequoted` (`dequote.py:56-94`).
 *
 * `allowUnicode: false` is pyk's `allow_unicode=False`: `\u` and `\U` become
 * errors while `\x` stays legal, which is the `Bytes` token alphabet.  It
 * restricts *escapes only* — a literal non-ASCII character in the input passes
 * through untouched, exactly as in pyk (`dequote.py:88-89` has no such check).
 * Callers wanting real bytes apply {@link bytesEncode} afterwards, and that is
 * where such a character is caught (`prelude/bytes.py:22,26`).
 */
function dequote(s: string, allowUnicode: boolean): string {
  const out: string[] = [];
  let state: number = NORMAL;
  let acc = 0;
  let cnt = 0;
  let escapeStart = 0;
  let i = 0;

  for (const c of s) {
    const at = i;
    i += c.length; // `c` is a code point: two UTF-16 units above the BMP.

    if (state === CPOINT) {
      const digit = hexValue(c);
      if (digit === undefined) throw new EscapeError(at, `Expected hex digit, got: ${c}`);
      acc = acc * 16 + digit;
      cnt -= 1;
      if (cnt === 0) {
        out.push(codePointToString(acc, escapeStart));
        acc = 0;
        state = NORMAL;
      }
    } else if (state === ESCAPE) {
      const width = CPOINT_TABLE.get(c);
      // The hex-escape test comes first because pyk's does (`dequote.py:74`);
      // swapping the branches to avoid the negation would reorder the two
      // tables' precedence in the reader's mind for no behavioural gain.
      // oxlint-disable-next-line no-negated-condition, unicorn/no-negated-condition
      if (width !== undefined) {
        if (!allowUnicode && c !== "x") {
          throw new EscapeError(at, `Unicode escape sequence not allowed: \\${c}`);
        }
        cnt = width;
        state = CPOINT;
      } else {
        const literal = ESCAPE_TABLE.get(c);
        if (literal === undefined) throw new EscapeError(at, `Unexpected escape sequence: \\${c}`);
        out.push(literal);
        state = NORMAL;
      }
    } else if (c === "\\") {
      escapeStart = at;
      state = ESCAPE;
    } else {
      out.push(c);
    }
  }

  // `dequote.py:91-94` — an escape left open at end of input is an error, not
  // a silently dropped backslash.
  if (state === CPOINT) throw new EscapeError(s.length, "Incomplete Unicode code point");
  if (state === ESCAPE) throw new EscapeError(s.length, "Incomplete escape sequence");

  return out.join("");
}

/**
 * The encoder — `enquoted` (`dequote.py:107-123`).
 *
 * Branch order is pyk's and it matters: the six table escapes win over the
 * printable-ASCII range (`"` and `\` are both printable), and the
 * `allowUnicode` rejection sits *after* the `<= 0xFF` branch, so `\x80` stays
 * legal in bytes mode.
 *
 * pyk's final `code <= 0xFFFFFFFF` guard (`dequote.py:120-123`) has no
 * counterpart: a JavaScript code point is bounded by U+10FFFF by construction,
 * so that branch is unreachable and its absence changes nothing.
 */
function enquote(s: string, allowUnicode: boolean): string {
  const out: string[] = [];
  let i = 0;

  for (const c of s) {
    const at = i;
    i += c.length;

    const code = c.codePointAt(0);
    // Unreachable — `for…of` never yields an empty string — but written as a
    // guard rather than a non-null assertion, which this package does not use.
    if (code === undefined) continue;

    const escape = ENQUOTE_TABLE.get(code);
    if (escape !== undefined) {
      out.push(escape);
    } else if (code >= 32 && code < 127) {
      out.push(c);
    } else if (code <= 0xff) {
      out.push(`\\x${hex(code, 2)}`);
    } else if (!allowUnicode) {
      throw new EscapeError(at, `Unicode character not allowed: '${c}' (${code})`);
    } else if (code >= SURROGATE_MIN && code <= SURROGATE_MAX) {
      // Divergence from pyk — see the file header.  Reachable only from an
      // unpaired surrogate, which `for…of` yields as a lone code unit.
      throw new EscapeError(at, `Unpaired surrogate: U+${hex(code, 4).toUpperCase()}`);
    } else if (code <= 0xffff) {
      out.push(`\\u${hex(code, 4)}`);
    } else {
      out.push(`\\U${hex(code, 8)}`);
    }
  }

  return out.join("");
}

/**
 * Escape text for the body of a K `String` token — pyk `enquote_string`
 * (`dequote.py:10-11`).
 *
 * The result does not include the surrounding quotes; `stringToken` adds those
 * (`prelude/string.py:10`).
 */
export function enquoteString(s: string): string {
  return enquote(s, true);
}

/**
 * Decode the body of a K `String` token — pyk `dequote_string`
 * (`dequote.py:14-15`).
 *
 * Input is the text *between* the quotes.  Throws {@link EscapeError} on any
 * escape K does not define.
 */
export function dequoteString(s: string): string {
  return dequote(s, true);
}

/**
 * Escape a `Bytes` value for the body of a `b"…"` token — pyk `enquote_bytes`
 * (`dequote.py:18-19`).
 *
 * Identical to {@link enquoteString} except that a code point above U+00FF is
 * an error rather than a `\u`/`\U` escape: the value denotes bytes, and the
 * byte alphabet is latin-1.
 */
export function enquoteBytes(s: string): string {
  return enquote(s, false);
}

/**
 * Decode the body of a `b"…"` token — pyk `dequote_bytes` (`dequote.py:22-23`).
 *
 * `\u` and `\U` are rejected; `\x` and the six one-character escapes are not.
 * The result is pyk's byte-per-character string, ready for {@link bytesEncode}.
 */
export function dequoteBytes(s: string): string {
  return dequote(s, false);
}

/**
 * latin-1 encode — pyk `bytes_encode` (`dequote.py:26-27`), i.e.
 * `s.encode('latin-1')`.
 *
 * Each UTF-16 code unit becomes one byte, so this is deliberately *not* code
 * point iteration: nothing above U+00FF has a latin-1 encoding, and a
 * surrogate half fails the same check rather than being paired up first.
 * Mirrors Python's `UnicodeEncodeError`.
 */
export function bytesEncode(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    // Code *units* are the point: latin-1 is one unit per byte, and an astral
    // character must fail rather than be pieced back together.
    // oxlint-disable-next-line unicorn/prefer-code-point
    const unit = s.charCodeAt(i);
    if (unit > 0xff) {
      throw new EscapeError(i, `Character not encodable in latin-1: U+${hex(unit, 4).toUpperCase()}`);
    }
    out[i] = unit;
  }
  return out;
}

/**
 * latin-1 decode — pyk `bytes_decode` (`dequote.py:30-31`), i.e.
 * `b.decode('latin-1')`.
 *
 * Total: every byte is a valid latin-1 character.
 */
export function bytesDecode(b: Uint8Array): string {
  // Chunked because spreading a large array into `String.fromCharCode` would
  // exceed the argument limit and throw `RangeError`.
  const CHUNK = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < b.length; i += CHUNK) {
    // As in `bytesEncode`: each byte is one latin-1 code unit, never a code
    // point above U+00FF.
    // oxlint-disable-next-line unicorn/prefer-code-point
    parts.push(String.fromCharCode(...b.subarray(i, i + CHUNK)));
  }
  return parts.join("");
}
