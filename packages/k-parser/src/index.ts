/**
 * `@kframework-ts/k-parser` — K's **outer** parser: the reader for `.k` and
 * literate `.md` definition files.
 *
 * "Outer" means modules, imports, `syntax` declarations and `require`s, with
 * rule bodies kept as opaque bubbles — the same split K's own frontend makes,
 * and the reason this is not `@kframework-ts/kast`'s `parser.ts` (that one
 * reads *textual KAST terms*, a different language with the same nickname).
 *
 * A hand-transcription of pyk's six outer-parser files at K `v7.1.337` — see
 * `version.ts` for the manifest and `THIRD-PARTY-NOTICES.md` for the BSD-3
 * notices that travel with a port of K's sources.
 *
 * The whole pipeline is here: markdown selection (`markdown.ts`), the outer
 * lexer (`lexer.ts`), the parser (`parser.ts`) over the surface AST
 * (`syntax.ts`), that AST's JSON encoding (`astJson.ts`), and the conversion to
 * `KDefinition` (`astToKast.ts`) — including the `Sentence → KSentence` layer
 * pyk never implemented, which is why this package can parse definitions pyk's
 * own `parse_outer` throws on.  The README's "What is deliberately not here"
 * records what is out of scope (inner parsing of bubbles, the frontend's
 * post-parse validation passes).
 *
 * The package root exports the core modules flat — their names are disjoint by
 * construction (tsc rejects this barrel if that ever stops being true).
 * `cli.ts` and `bin.ts` (the `k-parser` executable) are deliberately not part
 * of the library API, and `slurp.ts` — the one filesystem-touching module — is
 * its own `@kframework-ts/k-parser/slurp` subpath rather than part of this
 * barrel, so the default import stays a pure function of strings.
 */

export * from "./astJson.js";
export * from "./astToKast.js";
export * from "./ksources.js";
export * from "./lexer.js";
export * from "./markdown.js";
export * from "./parser.js";
export * from "./programLists.js";
export * from "./strictness.js";
export * from "./syntax.js";
export * from "./version.js";
