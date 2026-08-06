/**
 * The KORE string escape codec.
 *
 * Transcribed from pyk `dequote.py` (the whole file, 123 L), cross-checked
 * against the normative grammar in `haskell-backend/docs/kore-syntax.md:20-100`
 * (`<string-literal>` and the escape-sequence table).
 *
 * # The alphabet
 *
 * A KORE string literal's body is, per the grammar, a sequence of escape
 * sequences and printable 7-bit ASCII (U+0020..U+007E) other than `"` and `\`.
 * Six one-character escapes exist — `\t \n \f \r \" \\` — plus three
 * fixed-width hexadecimal forms: `\xHH`, `\uHHHH`, `\UHHHHHHHH`.  There are no
 * others: KORE is *not* C, so `\a`, `\b`, `\v`, `\'`, `\?` and octal escapes —
 * all of which `Kore/Parser/CString.hs:37,120-140` accepts, and some of which
 * it *emits* (it renders U+0080..U+00FF as three-digit octal, not `\xHH`) — are
 * outside the grammar.  `CString.hs` is a general C-string codec that predates
 * the current lexer and is not what the KORE lexer runs; we follow pyk and the
 * grammar, which agree with each other exactly.
 *
 * # Emit lowercase, accept both cases
 *
 * `enquoted` (`dequote.py:107-123`) formats hex with Python's `x` conversion,
 * i.e. lowercase, zero-padded to the escape's width.  `dequoted`
 * (`dequote.py:53`) builds its digit table from `'0123456789abcdefABCDEF'`, so
 * decoding is case-insensitive.  Both properties are load-bearing: goldens
 * produced elsewhere use uppercase (`\U0001F642`), and our own output must be
 * byte-stable.
 *
 * # Decoding rejects; it does not repair
 *
 * `dequoted` raises on an unknown escape, a non-hex digit inside a code point,
 * a truncated code point, and a trailing lone backslash.  Every one of those is
 * a `throw` here.  This is deliberately *not* scala-kore's behaviour, whose
 * `unquoteKOREString` silently drops the backslash of an unrecognised escape
 * and hands back corrupted text; a KORE document is an artifact that either
 * parses or does not.
 *
 * # The JavaScript hazard: code points, not UTF-16 units
 *
 * Python iterates a `str` by code point.  JavaScript's `for (const c of s)`
 * does too, but `s[i]` / `s.charCodeAt(i)` / `s.length` do not — they see
 * UTF-16 code units.  A naive index loop encodes U+1F642 as the surrogate pair
 * `🙂` instead of the single `\U0001f642` the grammar requires, and
 * pyk's own test data (`test_parser.py:171-174`) covers exactly this input.
 * Every loop in this file is `for…of`, and every code is read with
 * `codePointAt(0)`.
 *
 * # Lone surrogates are rejected in both directions; pyk is the outlier
 *
 * `kore-syntax.md:33-34` — "The surrogate code points in the range [U+D800,
 * U+DFFF] are illegal in the Unicode escape sequences."  The grammar says so,
 * the Haskell lexer enforces it, and scala-kore's `throwIfSurrogatePair`
 * (`StringUtil.java:103-113`, which also rejects ≥ U+110000) enforces it on
 * both sides.  **pyk enforces neither direction**, because Python's `chr` and
 * `ord` both accept surrogates, so `dequote_string(r'\ud800')` yields a lone
 * surrogate and `enquote_string` will hand it straight back.  We reject on
 * decode *and* on encode, with the grammar and the two other implementations:
 * a codec that accepts on one side and rejects on the other is not a round
 * trip, a JS string can hold an unpaired surrogate, and silently emitting
 * `\ud800` would produce a document our own decoder refuses.
 *
 * The choice to follow pyk over `CString.hs` on U+0080..U+00FF (above) has a
 * second shipping implementation in agreement: scala-kore's `getUnicodeEscape`
 * (`StringUtil.java:124-135`) is branch-for-branch pyk's `enquoted` — `\xHH`
 * below U+0100, `\uHHHH` below U+10000, `\UHHHHHHHH` above — and it iterates by
 * **code point**, which is exactly the JavaScript hazard the section above
 * calls out.
 *
 * Errors are `SyntaxError`: every failure in this file is a lexical property of
 * the text, which is what that class names.
 */

/** Decoder states — `dequote.py:34-36`. */
const NORMAL = 0;
const ESCAPE = 1;
const CPOINT = 2;

/**
 * The one-character escapes, decode direction — `dequote.py:38-45`.
 *
 * Six entries, and the set is closed: anything else after a backslash is an
 * error, not a literal.
 */
const ESCAPE_TABLE: Readonly<Record<string, string>> = {
  '"': '"',
  "\\": "\\",
  n: "\n",
  t: "\t",
  r: "\r",
  f: "\f",
};

/**
 * Hex-escape introducer to digit count — `dequote.py:47-51`.
 *
 * The widths are exact, not maxima: `\x` consumes exactly two digits, so
 * `"\x0f0"` decodes to U+000F followed by the literal `0`.
 */
const CPOINT_TABLE: Readonly<Record<string, number>> = { x: 2, u: 4, U: 8 };

/** The one-character escapes, encode direction, keyed by code — `dequote.py:97-104`. */
const ENQUOTE_TABLE: Readonly<Record<number, string>> = {
  9: "\\t",
  10: "\\n",
  12: "\\f",
  13: "\\r",
  34: '\\"',
  92: "\\\\",
};

/** Inclusive bounds of the UTF-16 surrogate block, illegal as a scalar value. */
const SURROGATE_MIN = 0xd800;
const SURROGATE_MAX = 0xdfff;

/** The largest Unicode code point. */
const MAX_CODE_POINT = 0x10_ff_ff;

/**
 * Value of a single hex digit, or `undefined` if `c` is not one.
 *
 * Transcribes `HEX_TABLE` (`dequote.py:53`), which is built from
 * `'0123456789abcdefABCDEF'` — so both cases decode, and nothing else does.
 * Note in particular that this must reject the non-ASCII digits that
 * `Number.parseInt` and `/\d/` would not (e.g. U+FF10 FULLWIDTH DIGIT ZERO).
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
 * `chr(acc)` (`dequote.py:69`) with the grammar's two validity rules applied.
 *
 * Python's `chr` rejects only `> 0x10FFFF`; the grammar
 * (`kore-syntax.md:33-34`) also rules out the surrogate block. See the
 * divergence note at the top of this file.
 */
function codePointToString(code: number): string {
  if (code >= SURROGATE_MIN && code <= SURROGATE_MAX) {
    throw new SyntaxError(`Surrogate code point in escape sequence: U+${hex(code, 4).toUpperCase()}`);
  }
  if (code > MAX_CODE_POINT) {
    throw new SyntaxError(`Code point out of range: U+${hex(code, 8).toUpperCase()}`);
  }
  return String.fromCodePoint(code);
}

/**
 * The decoder state machine — `dequoted` (`dequote.py:56-94`).
 *
 * `allowUnicode: false` is pyk's `allow_unicode=False`: `\u` and `\U` become
 * errors while `\x` stays legal, which is the `SortBytes` domain-value
 * alphabet.  It restricts *escapes only*; a literal non-ASCII character in the
 * input is passed through exactly as pyk passes it through (`dequote.py:88-89`
 * has no such check).  Callers wanting bytes apply `bytesEncode` to the result,
 * and that is where a non-latin-1 character is caught.
 */
function dequote(s: string, allowUnicode: boolean): string {
  const out: string[] = [];
  let state: number = NORMAL;
  let acc = 0;
  let cnt = 0;

  for (const c of s) {
    if (state === CPOINT) {
      const digit = hexValue(c);
      if (digit === undefined) throw new SyntaxError(`Expected hex digit, got: ${c}`);
      acc = acc * 16 + digit;
      cnt -= 1;
      if (cnt === 0) {
        out.push(codePointToString(acc));
        acc = 0;
        state = NORMAL;
      }
    } else if (state === ESCAPE) {
      const width = CPOINT_TABLE[c];
      if (width !== undefined) {
        if (!allowUnicode && c !== "x") {
          throw new SyntaxError(`Unicode escape sequence not allowed: \\${c}`);
        }
        cnt = width;
        state = CPOINT;
      } else {
        const literal = ESCAPE_TABLE[c];
        if (literal === undefined) throw new SyntaxError(`Unexpected escape sequence: \\${c}`);
        out.push(literal);
        state = NORMAL;
      }
    } else if (c === "\\") {
      state = ESCAPE;
    } else {
      out.push(c);
    }
  }

  // `dequote.py:91-94` — an escape left open at end of input is an error, not
  // a silently dropped backslash.
  if (state === CPOINT) throw new SyntaxError("Incomplete Unicode code point");
  if (state === ESCAPE) throw new SyntaxError("Incomplete escape sequence");

  return out.join("");
}

/**
 * The encoder — `enquoted` (`dequote.py:107-123`).
 *
 * Branch order is pyk's, and it matters: the six table escapes win over the
 * printable-ASCII range (`"` and `\` are both printable), and the
 * `allowUnicode` rejection sits *after* the `<= 0xFF` branch, so `\x80` is
 * legal in bytes mode.
 *
 * pyk's final `code <= 0xFFFFFFFF` guard has no counterpart here: JavaScript
 * code points are bounded by U+10FFFF by construction, so the branch is
 * unreachable and its absence changes nothing.
 */
function enquote(s: string, allowUnicode: boolean): string {
  const out: string[] = [];

  for (const c of s) {
    const code = c.codePointAt(0);
    // Unreachable: `for…of` never yields an empty string.  Written as a guard
    // rather than a non-null assertion, which `src` does not use.
    if (code === undefined) continue;

    const escape = ENQUOTE_TABLE[code];
    if (escape !== undefined) {
      out.push(escape);
    } else if (code >= 32 && code < 127) {
      out.push(c);
    } else if (code <= 0xff) {
      out.push(`\\x${hex(code, 2)}`);
    } else if (!allowUnicode) {
      throw new SyntaxError(`Unicode character not allowed: '${c}' (${code})`);
    } else if (code >= SURROGATE_MIN && code <= SURROGATE_MAX) {
      // Divergence from pyk — see the file header.  Reachable only from an
      // unpaired surrogate in the input string, which is not valid text.
      throw new SyntaxError(`Unpaired surrogate: U+${hex(code, 4).toUpperCase()}`);
    } else if (code <= 0xffff) {
      out.push(`\\u${hex(code, 4)}`);
    } else {
      out.push(`\\U${hex(code, 8)}`);
    }
  }

  return out.join("");
}

/**
 * Escape a string for a KORE `<string-literal>` body — pyk `enquote_string`
 * (`dequote.py:10-11`).
 *
 * The result does **not** include the surrounding quotes; the writer adds
 * those (`syntax.py:495-499`).
 */
export function enquoteString(s: string): string {
  return enquote(s, true);
}

/**
 * Decode a KORE `<string-literal>` body — pyk `dequote_string`
 * (`dequote.py:14-15`).
 *
 * Input is the text *between* the quotes.  Throws `SyntaxError` on any escape
 * the grammar does not define.
 */
export function dequoteString(s: string): string {
  return dequote(s, true);
}

/**
 * Escape a `SortBytes` domain value — pyk `enquote_bytes` (`dequote.py:18-19`).
 *
 * Identical to {@link enquoteString} except that a code point above U+00FF is
 * an error rather than a `\u`/`\U` escape: the value denotes bytes, and the
 * byte alphabet is latin-1.
 */
export function enquoteBytes(s: string): string {
  return enquote(s, false);
}

/**
 * Decode a `SortBytes` domain value — pyk `dequote_bytes` (`dequote.py:22-23`).
 *
 * `\u` and `\U` are rejected; `\x` and the six one-character escapes are not.
 */
export function dequoteBytes(s: string): string {
  return dequote(s, false);
}

/**
 * latin-1 encode — pyk `bytes_encode` (`dequote.py:26-27`), i.e.
 * `s.encode('latin-1')`.
 *
 * Each UTF-16 code unit maps to one byte, so this is deliberately *not* code
 * point iteration: a code point above U+00FF has no latin-1 encoding and must
 * fail, and its surrogates fail the same check. Mirrors Python's
 * `UnicodeEncodeError`.
 */
export function bytesEncode(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const unit = s.charCodeAt(i);
    if (unit > 0xff) {
      throw new SyntaxError(`Character not encodable in latin-1 at index ${i}: (${unit})`);
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
  // Chunked so that a large value cannot exhaust the argument limit of
  // `String.fromCharCode`, which spreading the whole array would.
  const CHUNK = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < b.length; i += CHUNK) {
    parts.push(String.fromCharCode(...b.subarray(i, i + CHUNK)));
  }
  return parts.join("");
}
