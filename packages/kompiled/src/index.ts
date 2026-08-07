/**
 * `@kframework-ts/kompiled` — a reader for K Framework's `*-kompiled/`
 * directories.
 *
 * A kompiled directory is the output of `kompile`: roughly twenty files
 * produced by three different toolchains, with no overall specification.  The
 * closest thing to one is the `README.md` that `kompile` copies into every such
 * directory, and it ends by saying the layout is *"subject to change without
 * warning"*.  That disclaimer is the honest framing for this package; the same
 * file recommends using PYK, and this is the TypeScript answer to that
 * sentence.  See `README.md` for what that means for you, and
 * `THIRD-PARTY-NOTICES.md` for the BSD-3-Clause notices that travel with a port
 * of K's sources.
 *
 * The package is three layers that do not touch each other, exactly as pyk's
 * are:
 *
 * - **metadata** — `layout.ts`, pyk's `DefinitionInfo`.  No term algebra at all.
 * - **KAST** — `compiled.json` → `KDefinition`, pretty printing.  `kast` only.
 * - **KORE** — `definition.kore` → sorts, symbols, axioms.  `kore` only.
 *
 * and `konvert` is a **sibling**, never a dependency: the one edge that needs it
 * is an injected function (`KompiledDefinitionOptions.koreToKast`).
 *
 * `layout.ts` and `kompiled.ts` are pure — they take strings somebody else
 * read.  `fs.ts` is the whole of the I/O, and it is the only module in this
 * monorepo that opens a file.  `cli.ts` and `bin.ts` (the `kompiled`
 * executable) are deliberately not part of the library API.
 *
 * This entry point exports `fs.ts` too, which means importing it pulls
 * `node:fs` into the module graph even for a caller that never reads a
 * directory.  Where that is unwanted — a browser bundle, a runtime with no
 * `node:fs`, anything supplying its own `KompiledSource` — import
 * `@kframework-ts/kompiled/core` instead: the same modules, minus `fs.ts`.
 */

export * from "./errors.js";
export * from "./fs.js";
export * from "./kompiled.js";
export * from "./ksources.js";
export * from "./layout.js";
export * from "./parser-artifacts.js";
export * from "./version.js";
