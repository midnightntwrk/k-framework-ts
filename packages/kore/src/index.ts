/**
 * `@kframework-ts/kore` — a reader/writer for K Framework's KORE: the textual
 * format `kompile` emits as `definition.kore`, and KORE-JSON, the kore-rpc
 * wire format.
 *
 * The textual grammar's normative source is the haskell-backend's
 * `docs/kore-syntax.md`; KORE-JSON's is `Kore/Syntax/Json/Types.hs`.  This
 * package is a hand-transcription of pyk's KORE implementation (the K repo's
 * Python library) checked against those sources, at K `v7.1.337` /
 * haskell-backend `v0.1.155`, and its conformance fixtures — the reference
 * parser's own test corpus and the reference JSON codec's golden output —
 * are what make the transcription trustworthy.
 *
 * See `README.md` for the guarantees, and `THIRD-PARTY-NOTICES.md` for the
 * BSD-3-Clause notices that travel with a port of K's sources.
 *
 * Each module re-exported below is the whole of its public surface; `cli.ts`
 * and `bin.ts` (the `kore` executable) are deliberately not part of the
 * library API.
 *
 * `prelude.ts` is deliberately **not** in this barrel either.  Its `BOOL`,
 * `STRING`, `TRUE` and `inj` collide by name with `@kframework-ts/kast`'s
 * prelude, and a KAST↔KORE converter imports both; it is published as the
 * `@kframework-ts/kore/prelude` subpath instead, mirroring
 * `@kframework-ts/kast/prelude/*`.
 *
 * `match.ts` — the destructor half, which reads values back out of a KORE term
 * — *is* in the barrel: it imports `prelude.ts` internally for the collection
 * encoding's symbol names, but none of its own exported names collide.
 */

export * from "./definition.js";
export * from "./ambiguity.js";
export * from "./demangle.js";
export * from "./escape.js";
export * from "./inject.js";
export * from "./json.js";
export * from "./ksources.js";
export * from "./lexer.js";
export * from "./manip.js";
export * from "./match.js";
export * from "./parser.js";
export * from "./symbols.js";
export * from "./syntax.js";
export * from "./version.js";
