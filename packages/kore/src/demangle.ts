/**
 * The KORE symbol-name codec: K labels in, `kompile`-style mangled identifiers
 * out, and back.
 *
 * A K label is arbitrary text — `_+Int_`, `<k>`, `.List{"_,_"}`.  A KORE
 * identifier is not: the lexer's `_ID_CHARS` (`src/lexer.ts:257`, pyk
 * `lexer.py:117`) admits only `[A-Za-z0-9'-]`, and the apostrophe is reserved
 * for exactly this encoding.  So `kompile` rewrites every character outside
 * `[A-Za-z0-9-]` as a four-character mnemonic inside a pair of apostrophes:
 * `_List_` becomes `'Unds'List'Unds'`, `<k>` becomes `'-LT-'k'-GT-'`.
 *
 * # What this module is *not*
 *
 * `Lbl` is not part of the encoding.  `ModuleToKORE.java:1986-2003,2005-2019`
 * appends the literal `"Lbl"` *before* calling the encoder on the label name,
 * and pyk's decoder correspondingly slices it back off by hand
 * (`_kore_to_kast.py:101` — `unmunge(symbol[3:])`).  The same is true of the
 * `Sort` prefix on sorts and the `Var` prefix on variables.  All three are
 * plain identifier characters, so they survive both directions untouched, and
 * this module deliberately neither adds nor strips them:
 * `demangleName("Lbl'Unds'List'Unds'")` is `"Lbl_List_"`, not `"_List_"`.
 * Strip the prefix yourself if you want the bare label.
 *
 * The functions transform a whole string.  Encoded runs are decoded wherever
 * they appear; everything in `[A-Za-z0-9-]` passes through.
 *
 * # The encoder
 *
 * `StringUtil.encodeStringToAlphanumeric` (`StringUtil.java:529-559`), driven
 * by `ModuleToKORE.convert(String, StringBuilder)`
 * (`ModuleToKORE.java:2169-2186`) with
 * `identChar = Pattern.compile("[A-Za-z0-9\\-]")` and `escapeChar = "'"`.  The
 * loop keeps one bit of state, `inIdent`, and emits an apostrophe on *every*
 * transition:
 *
 * ```java
 * boolean inIdent = true;                       // start outside a quoted run
 * for (int i = 0; i < name.length(); i++) {
 *   if (identChar…lookingAt()) {
 *     if (!inIdent) { inIdent = true;  sb.append(escapeChar); }
 *     sb.append(name.charAt(i));
 *   } else {
 *     if (inIdent)  { inIdent = false; sb.append(escapeChar); }
 *     int charAt = name.charAt(i);
 *     if (charAt < 128 && table[charAt] != null) sb.append(table[charAt]);
 *     else sb.append(String.format("%04x", charAt));
 *   }
 * }
 * if (!inIdent) sb.append("'");                 // close a trailing run
 * ```
 *
 * Two consequences worth stating outright, because they are what makes the
 * format decodable at all:
 *
 * 1. **Consecutive encoded characters share one apostrophe pair.**  A run is
 *    opened once and closed once, so `_+_` is `'UndsPlusUnds'` — three
 *    mnemonics, two apostrophes — not `'Unds''Plus''Unds'`.  Every mnemonic in
 *    the table is exactly four characters wide precisely so that a run can be
 *    chopped back into pieces without delimiters.
 * 2. **`-` is an identifier character**, so it *interrupts* a run.  This is why
 *    `_|->_` mangles to `'UndsPipe'-'-GT-Unds'`: the `-` closes the run after
 *    `Pipe`, sits outside as itself, and `>` opens a fresh one.  It is also why
 *    the KORE overrides below can afford to spell `<` as `-LT-`.
 *
 * # The table
 *
 * `StringUtil.asciiReadableEncodingDefault` (`StringUtil.java:383-513`) is a
 * 128-entry array indexed by code, transcribed verbatim into
 * {@link ASCII_READABLE_ENCODING_KORE}.  `ModuleToKORE`'s
 * `asciiReadableEncodingKoreCalc` (`ModuleToKORE.java:2154-2165`) copies it and
 * overrides five entries so that they are four characters wide like the rest:
 *
 * | code | default | KORE   |
 * | ---- | ------- | ------ |
 * | 0x26 | `And`   | `And-` |
 * | 0x3c | `LT`    | `-LT-` |
 * | 0x3e | `GT`    | `-GT-` |
 * | 0x40 | `AT`    | `-AT-` |
 * | 0x5e | `Xor`   | `Xor-` |
 *
 * The single-character entries (`-`, `0`-`9`, `A`-`Z`, `a`-`z`) are dead code
 * in the KORE encoder: they are exactly the `identChar` set, which the `if`
 * branch has already handled.  They are kept here because they are in the Java
 * array and because the decode map is built by the same length filter the Java
 * uses (`StringUtil.java:516-520`: entries with `length() > 1`).
 *
 * # Non-ASCII, and the C0 controls
 *
 * The `else` branch: `String.format("%04x", charAt)` where `charAt` is
 * `name.charAt(i)`, a Java `char` — a **UTF-16 code unit**, not a code point.
 * So anything with no table entry becomes exactly four lowercase hex digits:
 * the C0 controls and `DEL` (`\n` is `'000a'`), and every character above
 * U+007F (`é` is `'00e9'`).  A character outside the BMP is emitted as its two
 * surrogates, `'d83dde00'` for U+1F600 — one run, eight hex digits.
 *
 * This module therefore iterates UTF-16 code units, with `charCodeAt`, which is
 * the *opposite* of `src/escape.ts`, whose codec is specified over code points
 * and iterates with `for…of`.  Getting this backwards would produce `'1f600'`,
 * five characters, which nothing can decode.
 *
 * # `'Kywd'`
 *
 * `ModuleToKORE.convert(String, StringBuilder)` short-circuits before encoding
 * when the name is one of eight KORE keywords, appending a literal `'Kywd'`
 * suffix instead (`ModuleToKORE.java:2169-2186`; pyk mirrors it in
 * `name_to_kore`, `_module_to_kore.py:143-147`, over `KORE_KEYWORDS`,
 * `_module_to_kore.py:55-64`).  This is how the attribute `symbol` becomes the
 * KORE symbol `symbol'Kywd'` that the fixtures are full of.  `Kywd` is *not* a
 * mnemonic and is in no table; the suffix is a whole-name marker, so
 * {@link demangleName} strips it only when the entire input is a keyword
 * followed by it, and rejects `'Kywd'` anywhere else as the unknown mnemonic it
 * is.
 *
 * # The decoder, and why it is pyk's and not Java's
 *
 * `StringUtil.decodeKoreString` (`StringUtil.java:561-579`) is broken for KORE
 * input, and the transcription here does not follow it.  Its lookup map
 * (`StringUtil.java:514-520`) is built from `asciiReadableEncodingDefault` — the
 * *default* table, not `asciiReadableEncodingKore` — so its keys for the five
 * overridden codes are `And`, `LT`, `GT`, `AT`, `Xor`, while it looks entries up
 * with `encoded.substring(i, i + 4)`, a fixed four characters.  Those five keys
 * are two and three characters long, so they can never match, and what a real
 * `'-LT-'` gets is `map.get("-LT-") == null`, which `StringBuilder.append`
 * renders as the four-character string `"null"`.  Its own unit test
 * (`StringUtilTest.java:37-39`) only exercises `Unds` and `Ques`, which are
 * spelled the same in both tables, so the bug is invisible there.  It also
 * accepts, silently, both the empty quoted section `''` and adjacent sections
 * `'Unds''Unds'`, neither of which its encoder can produce.
 *
 * pyk's `unmunged` (`konvert/_utils.py:69-113`) is the decoder that works: its
 * `UNMUNGE_TABLE` (`_utils.py:12-45`) is the KORE table, 32 entries, and it
 * raises on the empty section, on adjacent sections, on a partial mnemonic, on
 * an unknown mnemonic, and on an unterminated section.  We follow it, because
 * rejecting non-canonical input is what keeps `mangleName ∘ demangleName` an
 * identity on well-formed names.
 *
 * # Hex escapes decode: three implementations, three answers
 *
 * There are three shipping decoders and no two agree on a `%04x` group, and no
 * fixture anywhere covers the case:
 *
 * 1. **pyk raises.**  Its `UNMUNGE_TABLE` has no hex path, so
 *    `unmunge("'00e9'")` is `Unknown encoding "00e9"` — on a symbol its own
 *    `munge` would have produced.
 * 2. **k-frontend returns the escape text.**  `KoreToK.mapCode`
 *    (`KoreToK.scala:59-65`) parses the group as hex only to discard the result
 *    and return the six-character string `"\\u" + code`, so `é` decodes to the
 *    literal text `é`.  Its `Integer.parseInt(code, 16)` also accepts
 *    uppercase hex, where we deliberately do not.
 * 3. **We decode.**  A four-lowercase-hex-digit group becomes its UTF-16 code
 *    unit, which makes `demangleName(mangleName(x)) === x` total over every
 *    JavaScript string — the only one of the three where the round trip is.
 *    That is why it is kept.
 *
 * The decoding is unambiguous: all 32 mnemonics contain an uppercase letter or
 * a `-`, and no hex digit is either, so the two alphabets cannot collide.
 * Uppercase hex is *not* accepted — `%04x` emits lowercase, and accepting
 * `'00E9'` too would mean two spellings of one name.
 *
 * Free corroboration from the same file: `KoreToK.scala:24-57` carries its own
 * inline mnemonic table, and it is **exactly** ours — 32 entries, all five KORE
 * overrides (`And-`, `-LT-`, `-GT-`, `-AT-`, `Xor-`), `-` correctly absent.
 *
 * # The round trip
 *
 * `demangleName(mangleName(label)) === label` for every string.  The converse,
 * `mangleName(demangleName(name)) === name`, holds for every name `demangleName`
 * accepts *that is a legal KORE identifier* — which is what the fixture test
 * asserts over both definitions.  It fails for inputs that are not: the decoder
 * passes an unquoted `_` straight through, following Java and pyk, so
 * `demangleName("a_b")` is `"a_b"` and mangling that gives `"a'Unds'b"`.  Such a
 * string could never have come out of `kompile`, and no KORE lexer would tokenise
 * it as one identifier.
 *
 * Errors are `SyntaxError`, matching `src/escape.ts`: every failure here is a
 * lexical property of the text.
 */

/* oxlint-disable unicorn/prefer-code-point -- the UTF-16 code unit is the unit
   of this format, not the code point: `String.format("%04x", name.charAt(i))`
   (`StringUtil.java:556`) reads a Java `char`. Switching to `codePointAt` would
   emit five hex digits for an astral character and break the round trip. See
   the header. */

/**
 * `StringUtil.asciiReadableEncodingDefault` (`StringUtil.java:383-513`) with
 * `asciiReadableEncodingKoreCalc`'s five overrides applied
 * (`ModuleToKORE.java:2154-2165`), indexed by ASCII code.
 *
 * `null` means "no mnemonic": the encoder falls back to `%04x` for those, and
 * `charAt >= 128` never reaches the table at all.
 */
export const ASCII_READABLE_ENCODING_KORE: readonly (string | null)[] = [
  null, // 0x00
  null, // 0x01
  null, // 0x02
  null, // 0x03
  null, // 0x04
  null, // 0x05
  null, // 0x06
  null, // 0x07
  null, // 0x08
  null, // 0x09
  null, // 0x0a
  null, // 0x0b
  null, // 0x0c
  null, // 0x0d
  null, // 0x0e
  null, // 0x0f
  null, // 0x10
  null, // 0x11
  null, // 0x12
  null, // 0x13
  null, // 0x14
  null, // 0x15
  null, // 0x16
  null, // 0x17
  null, // 0x18
  null, // 0x19
  null, // 0x1a
  null, // 0x1b
  null, // 0x1c
  null, // 0x1d
  null, // 0x1e
  null, // 0x1f
  "Spce", // 0x20
  "Bang", // 0x21
  "Quot", // 0x22
  "Hash", // 0x23
  "Dolr", // 0x24
  "Perc", // 0x25
  "And-", // 0x26  <- kore override (default: "And")
  "Apos", // 0x27
  "LPar", // 0x28
  "RPar", // 0x29
  "Star", // 0x2a
  "Plus", // 0x2b
  "Comm", // 0x2c
  "-", // 0x2d
  "Stop", // 0x2e
  "Slsh", // 0x2f
  "0", // 0x30
  "1", // 0x31
  "2", // 0x32
  "3", // 0x33
  "4", // 0x34
  "5", // 0x35
  "6", // 0x36
  "7", // 0x37
  "8", // 0x38
  "9", // 0x39
  "Coln", // 0x3a
  "SCln", // 0x3b
  "-LT-", // 0x3c  <- kore override (default: "LT")
  "Eqls", // 0x3d
  "-GT-", // 0x3e  <- kore override (default: "GT")
  "Ques", // 0x3f
  "-AT-", // 0x40  <- kore override (default: "AT")
  "A", // 0x41
  "B", // 0x42
  "C", // 0x43
  "D", // 0x44
  "E", // 0x45
  "F", // 0x46
  "G", // 0x47
  "H", // 0x48
  "I", // 0x49
  "J", // 0x4a
  "K", // 0x4b
  "L", // 0x4c
  "M", // 0x4d
  "N", // 0x4e
  "O", // 0x4f
  "P", // 0x50
  "Q", // 0x51
  "R", // 0x52
  "S", // 0x53
  "T", // 0x54
  "U", // 0x55
  "V", // 0x56
  "W", // 0x57
  "X", // 0x58
  "Y", // 0x59
  "Z", // 0x5a
  "LSqB", // 0x5b
  "Bash", // 0x5c
  "RSqB", // 0x5d
  "Xor-", // 0x5e  <- kore override (default: "Xor")
  "Unds", // 0x5f
  "BQuo", // 0x60
  "a", // 0x61
  "b", // 0x62
  "c", // 0x63
  "d", // 0x64
  "e", // 0x65
  "f", // 0x66
  "g", // 0x67
  "h", // 0x68
  "i", // 0x69
  "j", // 0x6a
  "k", // 0x6b
  "l", // 0x6c
  "m", // 0x6d
  "n", // 0x6e
  "o", // 0x6f
  "p", // 0x70
  "q", // 0x71
  "r", // 0x72
  "s", // 0x73
  "t", // 0x74
  "u", // 0x75
  "v", // 0x76
  "w", // 0x77
  "x", // 0x78
  "y", // 0x79
  "z", // 0x7a
  "LBra", // 0x7b
  "Pipe", // 0x7c
  "RBra", // 0x7d
  "Tild", // 0x7e
  null, // 0x7f
];

/** The exact width of every mnemonic, and the stride the decoder reads at. */
const MNEMONIC_WIDTH = 4;

/**
 * Character to mnemonic — the encode direction, derived from
 * {@link ASCII_READABLE_ENCODING_KORE} by the same filter the Java decode map
 * uses (`StringUtil.java:516-520`: entries whose `length() > 1`), which drops
 * the single-character identity entries.
 *
 * 32 entries, equal to pyk's `MUNGE_TABLE` (`_utils.py:48`).
 */
export const MANGLE_TABLE: Readonly<Record<string, string>> = Object.freeze(
  ((): Record<string, string> => {
    const table: Record<string, string> = {};
    for (const [code, mnemonic] of ASCII_READABLE_ENCODING_KORE.entries()) {
      if (mnemonic !== null && mnemonic.length > 1) table[String.fromCharCode(code)] = mnemonic;
    }
    return table;
  })(),
);

/**
 * Mnemonic to character — the decode direction, i.e. pyk's `UNMUNGE_TABLE`
 * (`_utils.py:12-45`), which this inverts rather than transcribes because the
 * two agree entry for entry.
 */
export const DEMANGLE_TABLE: Readonly<Record<string, string>> = Object.freeze(
  ((): Record<string, string> => {
    const table: Record<string, string> = {};
    for (const [char, mnemonic] of Object.entries(MANGLE_TABLE)) table[mnemonic] = char;
    return table;
  })(),
);

/**
 * The eight names that take a `'Kywd'` suffix instead of being encoded —
 * `ModuleToKORE.java:2172-2181`, pyk `KORE_KEYWORDS`
 * (`_module_to_kore.py:55-64`).
 *
 * They are the KORE keywords that could otherwise collide with the grammar's
 * own tokens.  Note that all eight are already pure `identChar` text, so
 * encoding them would have been a no-op — the suffix exists to make them
 * *different*, not to make them legal.
 */
export const KORE_KEYWORDS: readonly string[] = [
  "module",
  "endmodule",
  "sort",
  "hooked-sort",
  "symbol",
  "hooked-symbol",
  "alias",
  "axiom",
];

/** The `'Kywd'` marker, apostrophes included, as it is appended and stripped. */
const KYWD_SUFFIX = "'Kywd'";

const KORE_KEYWORD_SET: ReadonlySet<string> = new Set(KORE_KEYWORDS);

/** `identChar`, `Pattern.compile("[A-Za-z0-9\\-]")` (`ModuleToKORE.java:2167`), by code unit. */
function isIdentChar(unit: number): boolean {
  return (
    (unit >= 0x41 && unit <= 0x5a) || // A-Z
    (unit >= 0x61 && unit <= 0x7a) || // a-z
    (unit >= 0x30 && unit <= 0x39) || // 0-9
    unit === 0x2d // -
  );
}

/** Value of a lowercase hex digit, or `undefined` — the alphabet `%04x` emits. */
function lowerHexValue(unit: number): number | undefined {
  if (unit >= 0x30 && unit <= 0x39) return unit - 0x30; // 0-9
  if (unit >= 0x61 && unit <= 0x66) return unit - 0x61 + 10; // a-f
  return undefined;
}

/**
 * A four-character group back to its character, or `undefined` if it is neither
 * a mnemonic nor a `%04x` escape.
 */
function decodeMnemonic(group: string): string | undefined {
  // `Object.hasOwn` first: `DEMANGLE_TABLE` is a plain object, so a bare index
  // would also find `Object.prototype`'s members. None of them happens to be
  // four characters long, but relying on that is not a property worth relying
  // on.
  if (Object.hasOwn(DEMANGLE_TABLE, group)) return DEMANGLE_TABLE[group];
  let code = 0;
  for (let i = 0; i < MNEMONIC_WIDTH; i++) {
    const digit = lowerHexValue(group.charCodeAt(i));
    if (digit === undefined) return undefined;
    code = code * 16 + digit;
  }
  return String.fromCharCode(code);
}

/**
 * Encode a K label as a KORE identifier —
 * `encodeStringToAlphanumeric(sb, label, asciiReadableEncodingKore, identChar, "'")`
 * (`StringUtil.java:529-559`), preceded by the `'Kywd'` short-circuit
 * (`ModuleToKORE.java:2169-2186`), byte for byte.
 *
 * No prefix is added: pass `"Lbl" + mangleName(label)` if you want a symbol.
 */
export function mangleName(label: string): string {
  if (KORE_KEYWORD_SET.has(label)) return label + KYWD_SUFFIX;

  let out = "";
  let inIdent = true;
  for (let i = 0; i < label.length; i++) {
    const unit = label.charCodeAt(i);
    if (isIdentChar(unit)) {
      if (!inIdent) {
        inIdent = true;
        out += "'";
      }
      out += label.charAt(i);
    } else {
      if (inIdent) {
        inIdent = false;
        out += "'";
      }
      const mnemonic = unit < 128 ? ASCII_READABLE_ENCODING_KORE[unit] : null;
      // `String.format("%04x", charAt)`: a Java `char` is at most 0xffff, so
      // this is always exactly four digits and never needs truncating.
      out += mnemonic ?? unit.toString(16).padStart(MNEMONIC_WIDTH, "0");
    }
  }
  if (!inIdent) out += "'";
  return out;
}

/**
 * Decode a KORE identifier back to its K label — pyk's `unmunged`
 * (`konvert/_utils.py:69-113`), with `'Kywd'` and `%04x` handled as described
 * in this file's header.
 *
 * Characters outside quoted runs are passed through as they are, so a `Lbl`,
 * `Sort` or `Var` prefix survives; strip it before or after, as you like.
 *
 * @throws {SyntaxError} on an unterminated, empty, or doubled quoted section, on
 *   an unknown four-character group, or on a partial group at the end of one.
 */
export function demangleName(mangled: string): string {
  if (mangled.endsWith(KYWD_SUFFIX)) {
    const bare = mangled.slice(0, -KYWD_SUFFIX.length);
    if (KORE_KEYWORD_SET.has(bare)) return bare;
    // Anything else ending in `'Kywd'` is not something the encoder emits; fall
    // through and let the loop reject `Kywd` as the unknown mnemonic it is.
  }

  let out = "";
  let i = 0;
  while (i < mangled.length) {
    const char = mangled.charAt(i);
    if (char !== "'") {
      out += char;
      i += 1;
      continue;
    }

    const close = mangled.indexOf("'", i + 1);
    if (close < 0) {
      throw new SyntaxError(`Unterminated quoted section at index ${i}: ${JSON.stringify(mangled)}`);
    }
    const body = mangled.slice(i + 1, close);
    if (body.length === 0) {
      throw new SyntaxError(`Empty quoted section at index ${i}: ${JSON.stringify(mangled)}`);
    }
    // Groups left to right, and the length complaint last — pyk's order
    // (`_utils.py:99-108` decodes each group as its fourth character arrives,
    // and only reaches `Unexpected end of symbol` once whole groups run out).
    // So `'NotAThing'` is reported as the unknown mnemonic `NotA`, which is
    // the useful half of the answer, not as a section of the wrong length.
    let j = 0;
    for (; j + MNEMONIC_WIDTH <= body.length; j += MNEMONIC_WIDTH) {
      const group = body.slice(j, j + MNEMONIC_WIDTH);
      const decoded = decodeMnemonic(group);
      if (decoded === undefined) {
        throw new SyntaxError(`Unknown mnemonic ${JSON.stringify(group)} at index ${i + 1 + j}`);
      }
      out += decoded;
    }
    if (j !== body.length) {
      throw new SyntaxError(
        `Partial ${MNEMONIC_WIDTH}-character mnemonic ${JSON.stringify(body.slice(j))} at index ${i + 1 + j}`,
      );
    }

    i = close + 1;
    if (mangled.charAt(i) === "'") {
      throw new SyntaxError(`Adjacent quoted sections at index ${i}: ${JSON.stringify(mangled)}`);
    }
  }
  return out;
}

//////////////////////////
// Prefix conventions   //
//////////////////////////

/**
 * The three prefixes `kompile` puts in front of an encoded name, and the six
 * wrappers below.
 *
 * The prefix is not part of the encoding — see "What this module is *not*" in
 * the header — which is why {@link mangleName} and {@link demangleName} neither
 * add nor strip one.  But every consumer needs the composition, and pyk's is
 * three hand-written slices scattered across a converter (`unmunge(symbol[3:])`,
 * `_kore_to_kast.py:101` and again `:107`; `sort.name[4:]`, `:166`;
 * `unmunge(name[3:])`, `:79`), so it is worth having in one place, spelled once,
 * and reversible.
 *
 * Each `demangle*` answers `undefined` in the two cases where the question has
 * no name for an answer — that is a question, not a malformation:
 *
 * - the name does not carry the prefix at all ("this is not one of those"), and
 * - the name is *nothing but* the prefix.  `demangleLabel("Lbl")` would
 *   otherwise be `""`, and no K label, sort or variable is the empty string:
 *   `mangleName("")` is `""`, so `"Lbl"` is a name `kompile` cannot emit.
 *   Answering `undefined` keeps the result usable with `??` and with a
 *   truthiness test, which `""` is not.
 *
 * Each still throws {@link SyntaxError} for a prefixed name whose *encoding* is
 * broken, exactly as {@link demangleName} does.
 */

/** `Lbl` — `ModuleToKORE.java:1986-2003`. */
const LBL_PREFIX = "Lbl";

/**
 * `Sort` — `ModuleToKORE.java:2042-2060`, `sb.append("Sort")` at `:2048`.
 *
 * The early return at `:2043-2046` is the other half of the sentence
 * {@link demangleSort} makes: a sort whose name is `SORTPARAM_NAME` is written
 * as its bare sort-variable name, with no `Sort` prefix and no encoding.
 */
const SORT_PREFIX = "Sort";

/** `Var` — the prefix on a KORE variable name (pyk `_kore_to_kast.py:79`). */
const VAR_PREFIX = "Var";

function demanglePrefixed(name: string, prefix: string): string | undefined {
  if (!name.startsWith(prefix)) return undefined;
  const rest = name.slice(prefix.length);
  if (rest.length === 0) return undefined;
  return demangleName(rest);
}

/**
 * `Lbl'Unds'List'Unds'` to `_List_`; `undefined` if `symbol` has no `Lbl` prefix,
 * or is exactly `"Lbl"`.
 */
export function demangleLabel(symbol: string): string | undefined {
  return demanglePrefixed(symbol, LBL_PREFIX);
}

/** `_List_` to `Lbl'Unds'List'Unds'`. */
export function mangleLabel(label: string): string {
  return LBL_PREFIX + mangleName(label);
}

/**
 * `SortFoo` to `Foo`; `undefined` if `name` has no `Sort` prefix, or is exactly
 * `"Sort"`.
 *
 * A sort name reaches KORE through the same encoder as a label, so
 * `Sort'Hash'Bool` is `#Bool`.  Sort *variables* are not prefixed and not
 * encoded (`ModuleToKORE.java:2043-2046` returns the bare name before reaching
 * `sb.append("Sort")` at `:2048`; they are `SortVar`s in this AST, and `R`, `S1`,
 * `From` are already legal identifiers), so do not run this over one.
 */
export function demangleSort(name: string): string | undefined {
  return demanglePrefixed(name, SORT_PREFIX);
}

/** `Foo` to `SortFoo`. */
export function mangleSort(name: string): string {
  return SORT_PREFIX + mangleName(name);
}

/**
 * `Var'Ques'X` to `?X`, and `@VarX` to `@X`; `undefined` if `name` carries no
 * `Var` prefix, or is nothing but one.
 *
 * Every KORE variable a `kompile`d definition contains is prefixed this way,
 * including the ones `kompile` invents: `Var'Unds'Gen0`, `VarK'Unds'CONFIG`.
 *
 * # Set variables
 *
 * A KORE *set* variable is spelled `@` followed by an identifier
 * (`src/lexer.ts`'s `SET_VAR_ID`, pyk `is_set_var_id`), and this package keeps
 * the `@` inside `SVar.name` — so a set variable reaches here as `@VarX`, with
 * the sigil *outside* the prefix.  `prelude.kore:57-59` is where they actually
 * occur: the three reachability aliases all bind `@X:A`.
 *
 * The `@` is therefore stripped before the prefix and put back on the answer,
 * and {@link mangleVar} does the reverse, so `@X` ↔ `@VarX` round-trips like any
 * other name.  Mangling the `@` instead would give `Var'-AT-'X`, which is a
 * perfectly good *element*-variable name and not a set variable at all.
 */
export function demangleVar(name: string): string | undefined {
  const isSetVar = name.startsWith("@");
  const demangled = demanglePrefixed(isSetVar ? name.slice(1) : name, VAR_PREFIX);
  if (demangled === undefined) return undefined;
  return isSetVar ? `@${demangled}` : demangled;
}

/** `?X` to `Var'Ques'X`, and the set variable `@X` to `@VarX` — see {@link demangleVar}. */
export function mangleVar(name: string): string {
  if (name.startsWith("@")) return `@${VAR_PREFIX}${mangleName(name.slice(1))}`;
  return VAR_PREFIX + mangleName(name);
}
