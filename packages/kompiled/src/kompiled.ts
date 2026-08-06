/**
 * `KompiledDefinition` — the expensive half of a `*-kompiled/` directory, and
 * still no filesystem in sight.
 *
 * The class takes a {@link KompiledSource}: a {@link KompiledLayout} plus a
 * function that hands over one artifact's text on demand.  `fs.ts` supplies a
 * source backed by `node:fs`; a test supplies one backed by a `Map`; a build
 * tool supplies one backed by whatever it already has in memory.  Nothing here
 * knows the difference.
 *
 * # Why every artifact is lazy
 *
 * Not tidiness — arithmetic.  A real `definition.kore` is 0.55 MB for IMP
 * (the haskell fixture here; 0.48 MB for llvm), 15 MB for KEVM and 71 MB for
 * Foundry, and a materialised KORE AST retains roughly **55×** the file's own
 * size (measured).
 * A `load()` that eagerly parsed everything would need ~4 GB for a definition
 * that ships today.  So:
 *
 * - nothing is read until the getter that needs it is touched;
 * - `definition.kore` is parsed with `@kframework-ts/kore`'s `lazyAxioms` mode,
 *   which records each axiom body as a source span instead of a tree.  That is
 *   what the mode was built for.  Attributes stay eager, so the subsort table,
 *   the symbol table and every attribute view are fully correct without a
 *   single body being parsed; {@link KompiledDefinition.forceKoreAxiom} parses
 *   one when you actually need it.
 * - `syntaxDefinition.kore` (0.11 MB for IMP, ~4.7× smaller than
 *   `definition.kore`) and `macros.kore` are parsed **eagerly**: they are the
 *   syntax slice, they have no rule bodies to speak of, and laziness would buy
 *   nothing.
 *
 * # The three layers do not touch
 *
 * `KPrint` never uses `KompiledKore` upstream, and neither does this: the KAST
 * side ({@link KompiledDefinition.definition}, {@link KompiledDefinition.prettyPrint})
 * and the KORE side ({@link KompiledDefinition.koreDefinition}) are independent,
 * and each fails on its own if its file is missing.  Loading a directory that
 * has no `compiled.json` still gives you the KORE side, and vice versa.
 *
 * The one edge between them — KORE `Pattern` → KAST `KInner` — is an
 * **injected function** ({@link KompiledDefinitionOptions.koreToKast}), never an
 * import.  `konvert` depends on `kast` + `kore` exactly as this package does,
 * so it is a sibling; making it a dependency would invert that for no gain.
 */

import { Formatter, type FormatterOptions, type KDefinition, type KInner } from "@kframework-ts/kast";
import { readKastDefinition, sortAcCollections, undoAliases } from "@kframework-ts/kast";
import {
  forceAxiom,
  indexDefinition,
  parseDefinition,
  type Axiom,
  type KoreDefinitionIndex,
  type LazyAxiom,
  type LazyKoreDefinitionIndex,
  type Pattern,
} from "@kframework-ts/kore";
import {
  InvalidKompiledFileError,
  MissingCompiledJsonError,
  MissingKompiledFileError,
  UnsupportedKastVersionError,
} from "./errors.js";
import { deriveConfigVars, type ConfigVars, type KompiledLayout } from "./layout.js";
import { KAST_VERSION } from "./version.js";

//////////////////////////////
// The source abstraction   //
//////////////////////////////

/**
 * The artifacts {@link KompiledDefinition} will ever ask a source for.
 *
 * Closed on purpose.  `compiled.bin`, `cache.bin`, `haskellDefinition.bin`,
 * `interpreter`, `scanner` and `dt/` are **refused**, not unimplemented:
 * the first two are Java `ObjectOutputStream` streams of `CompiledDefinition`
 * and `HashMap<String,ParseCache>` (`BinaryLoader.java:83-87`), dragging in
 * Scala collections and Guice beans; the third is a GHC `COMPACT` heap image
 * locked to a GHC ABI; the rest are native binaries.  Everything in
 * `compiled.bin` is also in `compiled.json`, and half-supporting a Java object
 * graph would be worse than not supporting it.
 *
 * `parsed.json` is absent for a different and softer reason.  It is *readable* —
 * a KAST v4 `KDefinition` like `compiled.json`, which `readKastDefinition` would
 * take — but it is the **pre-compilation** KAST: the outer-parsed definition
 * before any compilation pass has run, so it carries no `<generatedTop>`, no
 * generated cell productions and no `UNIQUE'Unds'ID`s, and nothing this class
 * derives (`configVars`, `allRules` joins, `emptyConfig`) would be correct
 * against it.  It is written only under `--emit-json`, pyk never reads it (no
 * module under `pyk/src/pyk` names the file), and the generated fixtures here do
 * not contain it.  It is readable in principle; this enumeration is the set of
 * files something in this package *reads*, and `parsed.json` is re-addable the
 * day a consumer appears.
 */
export type KompiledArtifact = "compiled.json" | "definition.kore" | "syntaxDefinition.kore" | "macros.kore";

/**
 * A kompiled directory, read lazily and by name.
 *
 * `read` is called **at most once per artifact** — {@link KompiledDefinition}
 * caches both the text and everything parsed from it — and must return
 * `undefined`, not throw, when the artifact is absent.  It is synchronous
 * because the getters that call it are: `definition` cannot be a `Promise` and
 * still read like pyk's `KPrint.definition`.  `fs.ts` explains how that squares
 * with an async `load`.
 */
export interface KompiledSource {
  /** The directory this came from.  Used only in error messages. */
  readonly path: string;
  readonly layout: KompiledLayout;
  readonly read: (artifact: KompiledArtifact) => string | undefined;
}

/** Options for {@link KompiledDefinition}. */
export interface KompiledDefinitionOptions {
  /**
   * KORE `Pattern` → KAST `KInner`, if you have a converter.
   *
   * This is the `konvert` edge, kept as a function so the dependency does not
   * exist.  Supply `@kframework-ts/konvert`'s `koreToKast` bound to
   * `this.definition`, or anything else with that shape;
   * {@link KompiledDefinition.koreToKast} throws a clear error when it is
   * absent rather than silently producing nothing.
   */
  readonly koreToKast?: (pattern: Pattern) => KInner;
}

/** Options for {@link KompiledDefinition.prettyPrint}. */
export interface PrettyPrintOptions extends FormatterOptions {
  /**
   * Print as though this module were the main one — pyk's
   * `KPrint.pretty_print(in_module=...)` (`ktool/kprint.py:304`), which does
   * `definition.let(main_module_name=in_module)`.
   *
   * It changes which modules are in scope, and therefore which symbols the
   * formatter can find.
   */
  readonly inModule?: string;

  /**
   * Fold the term back into the definition's `alias` rules before printing —
   * `@kframework-ts/kast`'s `undoAliases` (`manip.py:627-639`).
   *
   * **Defaults to `true`**, which is pyk's default
   * (`KPrint.pretty_print(unalias=True)`, `ktool/kprint.py:301-312`) *and* the
   * Java unparser's behaviour: `KPrint.unparseInternal` builds
   * `ExpandMacros.forNonSentences(mod, files, kompileOptions, true)` — the
   * trailing `true` is `reverse`, `ExpandMacros.java:73-74,102` — and applies it
   * as the **first** stage, before `AddBrackets` and before `Formatter.format`
   * (`KPrint.java:203-212`).  Both routes fold aliases first, so this does too,
   * and in the same position.
   *
   * Set it to `false` to see the expanded term — a definition's aliases are its
   * *surface* spelling, and a debugger frequently wants the other one.
   */
  readonly unalias?: boolean;

  /**
   * Put every associative-commutative collection into the KAst total order
   * before printing — `sortAcCollections` (`manip.py:86-94`).
   *
   * **Defaults to `false`**, matching pyk's `pretty_print(sort_collections=False)`.
   * `pyk rpc-print` passes `True` (`__main__.py:149,163,168,195`), and so must
   * anything comparing against a `.pretty.golden` from that command: a `Map` or
   * `Set` has no intrinsic argument order, so without this the output is stable
   * only up to the term's own accidental spelling.
   */
  readonly sortCollections?: boolean;
}

//////////////////////////////
// The class                //
//////////////////////////////

/**
 * A loaded kompiled directory.
 *
 * ```ts
 * const kompiled = await loadKompiledDefinition("imp-kompiled");
 * kompiled.layout.mainModule;            // "IMP"          — already read
 * kompiled.definition;                   // compiled.json  — parsed on first touch
 * kompiled.prettyPrint(term);            // Route A, pyk's Formatter
 * kompiled.koreDefinition.sorts.size;    // definition.kore, axiom bodies untouched
 * ```
 *
 * Every getter memoises, including the negative case: an artifact that is
 * absent stays absent, and the same error is raised each time.
 */
export class KompiledDefinition {
  /** The directory this was loaded from. */
  readonly path: string;
  /** The marker files, `allRules.txt` and `configVars.sh` — read at load time. */
  readonly layout: KompiledLayout;

  readonly #read: (artifact: KompiledArtifact) => string | undefined;
  readonly #koreToKast: ((pattern: Pattern) => KInner) | undefined;
  readonly #texts = new Map<KompiledArtifact, string | undefined>();

  #definition: KDefinition | undefined;
  #koreDefinition: LazyKoreDefinitionIndex | undefined;
  #syntaxKore: KoreDefinitionIndex | undefined;
  #macrosKore: KoreDefinitionIndex | undefined;
  #derivedConfigVars: ConfigVars | undefined;

  constructor(source: KompiledSource, options: KompiledDefinitionOptions = {}) {
    this.path = source.path;
    this.layout = source.layout;
    this.#read = source.read;
    this.#koreToKast = options.koreToKast;
  }

  /**
   * One artifact's raw text, or `undefined` if it is not there.
   *
   * Cached, so the underlying reader sees each artifact once.  Exposed because
   * a caller that wants to re-parse with different options — or hash the bytes,
   * or diff two directories — should not have to read the file a second time.
   */
  text(artifact: KompiledArtifact): string | undefined {
    if (this.#texts.has(artifact)) return this.#texts.get(artifact);
    const text = this.#read(artifact);
    this.#texts.set(artifact, text);
    return text;
  }

  /**
   * The KAST definition — `compiled.json` (`ktool/kprint.py:218-220`).
   *
   * @throws {MissingCompiledJsonError} the file is absent, which is the
   *   *default* for a CLI `kompile`; the message says to pass `--emit-json`.
   * @throws {UnsupportedKastVersionError} it is a KAST document of a version
   *   other than {@link KAST_VERSION}.
   * @throws {InvalidKompiledFileError} it is not JSON, or not a KAST document.
   */
  get definition(): KDefinition {
    if (this.#definition !== undefined) return this.#definition;
    const text = this.text("compiled.json");
    if (text === undefined) throw new MissingCompiledJsonError(this.path);

    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch (error) {
      throw new InvalidKompiledFileError(this.path, "compiled.json", `Not JSON: ${describeError(error)}`);
    }
    this.#checkKastEnvelope(doc);

    try {
      this.#definition = readKastDefinition(doc);
    } catch (error) {
      throw new InvalidKompiledFileError(this.path, "compiled.json", describeError(error));
    }
    return this.#definition;
  }

  /**
   * The version check that produces {@link UnsupportedKastVersionError} instead
   * of the generic "invalid version" that `kastTerm` would raise.
   *
   * This shares a code path with the `--emit-json` diagnostic, because both
   * are "your directory was built wrong"; the shared path is
   * {@link KompiledError}, and this is the branch that keeps the version
   * number in the message.
   */
  #checkKastEnvelope(doc: unknown): void {
    if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
      throw new InvalidKompiledFileError(this.path, "compiled.json", "Not a KAST document: expected a JSON object.");
    }
    // The guard above establishes it is a non-array object; TypeScript has no
    // way to say "an object, indexed by string" without an assertion, and the
    // two fields read from it are immediately compared against literals.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const record = doc as Record<string, unknown>;
    if (record["format"] !== "KAST") {
      throw new InvalidKompiledFileError(
        this.path,
        "compiled.json",
        `Not a KAST document: expected "format": "KAST", got ${JSON.stringify(record["format"])}.`,
      );
    }
    const version = record["version"];
    if (version !== KAST_VERSION) {
      throw new UnsupportedKastVersionError(this.path, typeof version === "number" ? version : undefined);
    }
  }

  /**
   * `KAst.hash` for the definition — pyk's `KPrint.definition_hash`
   * (`ktool/kprint.py:238-240`), the sha256 of its canonical JSON.
   *
   * The same number pyk computes for the same `compiled.json`, and the reason
   * `hashOfDict` exists in `@kframework-ts/kast`'s `eq.ts`.  It is a hash of
   * the *definition*, not of the file, so re-serialising through this library
   * does not change it.
   */
  get definitionHash(): string {
    return this.definition.hash;
  }

  /**
   * `definition.kore`, indexed, with **axiom bodies unparsed**.
   *
   * The index is complete: sorts, symbols, aliases, imports, and the closed
   * subsort table, all built from attributes alone
   * (`kore/src/definition.ts` — `subsortPairs` reads `[subsort{A,B}()]`, never
   * a body).  `axioms` holds `LazyAxiom`s;
   * {@link KompiledDefinition.forceKoreAxiom} turns one into an `Axiom`.
   *
   * Typed `LazyKoreDefinitionIndex` rather than `KoreDefinitionIndex` — the
   * whole point of the lazy mode is that the axioms are *not* `Axiom`s yet,
   * and a type that claimed otherwise would be a lie the compiler would then
   * enforce.
   *
   * @throws {MissingKompiledFileError} `definition.kore` is absent — which is
   *   normal for a `--backend kore` directory.
   */
  get koreDefinition(): LazyKoreDefinitionIndex {
    if (this.#koreDefinition !== undefined) return this.#koreDefinition;
    const text = this.#requireText("definition.kore");
    this.#koreDefinition = indexDefinition(parseDefinition(text, { lazyAxioms: true }));
    return this.#koreDefinition;
  }

  /**
   * Parse one of {@link koreDefinition}'s lazy axiom bodies.
   *
   * The offsets a `LazyAxiom` carries mean nothing against any string but the
   * one it was read from, so this method exists rather than a free function:
   * it is the only place that has both.  An already-forced `Axiom` passes
   * through unchanged, so a caller iterating a mixed array does not have to
   * check.
   */
  forceKoreAxiom(axiom: Axiom | LazyAxiom): Axiom {
    if (axiom.tag === "Axiom") return axiom;
    const text = this.#requireText("definition.kore");
    return forceAxiom(text, axiom);
  }

  /**
   * `syntaxDefinition.kore`, indexed — the syntax slice plus the KORE-level
   * printing attributes (`format`, `terminals`, `colors`, `priorities`,
   * `left`, `right`).
   *
   * Written by `KoreBackend.java:98` for **every** backend, and verified
   * byte-identical between the llvm and haskell fixtures here, so it is the
   * artifact to reach for when only sorts, symbols or printing tables are
   * wanted: 0.11 MB against `definition.kore`'s 0.55 MB for IMP — 4.7×, or
   * 4.1× against the llvm fixture's 0.48 MB — and the ratio grows with the
   * semantics.
   *
   * Parsed eagerly — see the module docstring.
   *
   * @throws {MissingKompiledFileError} the file is absent.
   */
  get syntaxKore(): KoreDefinitionIndex {
    return (this.#syntaxKore ??= indexDefinition(parseDefinition(this.#requireText("syntaxDefinition.kore"))));
  }

  /**
   * `macros.kore`, indexed (`KoreBackend.java:99`).
   *
   * **`macros.kore` is not a KORE definition.**  `ModuleToKORE.java:335-365`
   * seeds it with the line `// macros` and then appends, for every rule that
   * `ExpandMacros.isMacro` accepts, exactly the `axiom{…} … [atts]` text it
   * would otherwise have appended to the semantics — where that text sits
   * *inside* a module.  So what lands on disk is a bare **sentence list**: no
   * leading definition attributes, no `module`/`endmodule`, no `import`.
   * `parseDefinition` cannot accept it and never will, which is why the text is
   * wrapped in a synthetic module ({@link MACROS_MODULE_NAME}) before parsing.
   *
   * The wrapper is the whole of the difference.  Nothing else is rewritten, so
   * each axiom — and each of its attributes, `UNIQUE'Unds'ID` included — is
   * what `kompile` wrote.
   *
   * Two empty forms exist and both must parse: `kompile` writes literally
   * `// macros\n` when there are no macros, while the hand-written test inputs
   * in `llvm-backend/test/unparse/` use a zero-byte file.  A KORE definition
   * with no modules is not valid KORE, so an empty `macros.kore` indexes to an
   * index with **no modules** rather than throwing — and, in particular, not to
   * a synthetic module with no sentences, so `moduleNames` stays `[]` for the
   * empty case and is `[MACROS_MODULE_NAME]` only when there is something in
   * it.
   *
   * Parsed eagerly — see the module docstring.
   *
   * @throws {MissingKompiledFileError} the file is absent.
   */
  get macrosKore(): KoreDefinitionIndex {
    if (this.#macrosKore !== undefined) return this.#macrosKore;
    const text = this.#requireText("macros.kore");
    this.#macrosKore = isEffectivelyEmptyKore(text)
      ? indexDefinition({ tag: "Definition", modules: [], attrs: [] })
      : indexDefinition(parseDefinition(wrapMacroSentences(text)));
    return this.#macrosKore;
  }

  /**
   * The configuration variables, preferring `configVars.sh` and falling back to
   * `compiled.json`.
   *
   * `layout.configVars` is what the file said; this getter re-derives them from
   * the definition when there was **no file** ({@link deriveConfigVars}), which
   * is what `CompiledDefinition.java:82-139` computed them from in the first
   * place.  When the file *was* present it is returned untouched — the file is
   * the artifact, and second-guessing it would hide a real disagreement rather
   * than report one.
   *
   * The branch is on {@link KompiledLayout.hasConfigVarsFile} and not on
   * emptiness, and the difference is load-bearing in both directions.  A
   * present-but-empty `configVars.sh` is a real and correct artifact for a
   * definition with no configuration variables; branching on emptiness would
   * throw {@link MissingCompiledJsonError} on such a directory whenever it was
   * built without `--emit-json` (the CLI default), and would discard a file
   * that declared only `declaredConfigVarModule_*` lines — which leave
   * `configVars` and `configVarSorts` empty by construction.
   *
   * @throws {MissingCompiledJsonError} only on the derivation branch, i.e. when
   *   there was no `configVars.sh` *and* no `compiled.json` to fall back to.
   */
  get configVars(): ConfigVars {
    if (this.layout.hasConfigVarsFile) return this.layout;
    return (this.#derivedConfigVars ??= deriveConfigVars(this.definition));
  }

  /**
   * Pretty-print a term through the definition's own `format` attributes —
   * **Route A**, `@kframework-ts/kast`'s `Formatter`, a transcription of pyk's
   * `kast/formatter.py`.
   *
   * This matches **pyk's** output, not `krun`'s.  K has two independent
   * `format` languages and this is the KAST-level one; `krun -o pretty` runs
   * the KORE-level one in the LLVM backend's C++ printer, reading
   * `syntaxDefinition.kore`, where `%N` indexes the symbol's *arguments*
   * instead of the production's *items* and `%c`/`%r` are real colour escapes.
   * The two disagree visibly on real semantics.  See the README's fidelity
   * ladder.
   *
   * A fresh `Formatter` per call, so the indent counter starts where you asked
   * and cannot be left dirty by a previous term.
   *
   * # Parity with `KPrint.pretty_print`, exactly
   *
   * The **pre-passes are the same**: `in_module` → `definition.let(...)`,
   * then `undo_aliases` when `unalias` (default `true`), then
   * `sort_ac_collections` when `sort_collections` (default `false`) — pyk's
   * order and pyk's defaults (`ktool/kprint.py:301-312`, `pretty.py:96-102`).
   *
   * The **printer is not the same, on purpose**.  `KPrint.pretty_print`
   * delegates to `PrettyPrinter` (`pretty.py`), the symbol-table printer that
   * reads neither `format` nor `bracket`; this delegates to `Formatter`
   * (`kast/formatter.py`), which reads both.  Upstream never calls `Formatter`
   * from `KPrint` at all — nothing under `pyk/src/pyk` imports it outside
   * `kast/formatter.py` — so there is no pyk method this is byte-identical to.
   * `Formatter` is the strictly better printer of the two (it is the one whose
   * output has the definition's own layout in it), and it is the higher rung of
   * the README's fidelity ladder, which is why it is what `prettyPrint` means
   * here.  `@kframework-ts/kast` exports `PrettyPrinter` directly for anyone who
   * wants pyk's other one, and it takes the same two options.
   */
  prettyPrint(term: KInner, options: PrettyPrintOptions = {}): string {
    const { inModule, unalias = true, sortCollections = false, ...formatterOptions } = options;
    const definition = inModule === undefined ? this.definition : this.definition.let({ mainModuleName: inModule });
    // pyk's order, and against the *re-rooted* definition: `undo_aliases` reads
    // `definition.alias_rules`, so `in_module` narrows which aliases apply.
    let prepared = term;
    if (unalias) prepared = undoAliases(definition, prepared);
    if (sortCollections) prepared = sortAcCollections(prepared);
    return new Formatter(definition, formatterOptions).format(prepared);
  }

  /**
   * The injected KORE → KAST conversion.
   *
   * @throws {TypeError} when no `koreToKast` was supplied.  The error names the
   *   option, because the fix is to pass one, not to file a bug: this package
   *   deliberately does not depend on `@kframework-ts/konvert`.
   */
  koreToKast(pattern: Pattern): KInner {
    if (this.#koreToKast === undefined) {
      throw new TypeError(
        "No koreToKast was supplied: pass KompiledDefinitionOptions.koreToKast " +
          "(e.g. @kframework-ts/konvert's, bound to this.definition) to convert KORE patterns.",
      );
    }
    return this.#koreToKast(pattern);
  }

  /** Whether a converter was supplied — so a caller can branch without catching. */
  get hasKoreToKast(): boolean {
    return this.#koreToKast !== undefined;
  }

  #requireText(artifact: KompiledArtifact): string {
    const text = this.text(artifact);
    if (text === undefined) throw new MissingKompiledFileError(this.path, artifact);
    return text;
  }
}

/**
 * Whether a `macros.kore` has no sentences at all.
 *
 * `kompile` writes `// macros\n`; the llvm-backend's hand-written test inputs
 * are zero bytes.  Neither is a parseable KORE definition — a definition needs
 * at least `[]` and one module — so both are recognised here instead of being
 * pushed at the parser.  Anything with a non-comment character goes to the
 * parser, and its errors are the parser's to raise.
 *
 * Both KORE comment forms are skipped, not just `//`.  `kompile`'s own empty
 * form never uses `/* … *\/`, so this is not reachable from a kompiled
 * directory; it is here because a scan that recognised only half the comment
 * grammar would be a silently wrong answer rather than a narrow one, and the
 * other half is four lines.  Block comments do **not** nest in KORE
 * (`kore/src/lexer.ts`, pyk `lexer.py:127-151`), and an *unterminated* one is
 * not empty-looking — it is a lexical error — so it returns `false` and the
 * parser raises it.
 */
/**
 * The name given to the module {@link KompiledDefinition.macrosKore} synthesises
 * around `macros.kore`'s sentence list.
 *
 * `macros.kore` has no module of its own — see the getter — so this name is
 * ours, not K's, and it is named after the artifact so that a reader who finds
 * it in a `moduleNames` list can tell which file it came from.  Nothing keyed
 * on it survives outside this package: it exists only so the sentence list has
 * somewhere to live.
 */
export const MACROS_MODULE_NAME = "MACROS-KORE";

/**
 * `macros.kore`'s sentence list, wrapped into the smallest legal KORE
 * definition that contains it.
 *
 * The `[]` is the definition's (empty) attribute list and the `endmodule []`
 * the module's; both are required by the grammar and neither carries meaning
 * here.  The text is inserted verbatim, so the parser reports errors at the
 * offending sentence rather than at the wrapper.
 */
function wrapMacroSentences(text: string): string {
  return `[]\nmodule ${MACROS_MODULE_NAME}\n${text}\nendmodule []\n`;
}

function isEffectivelyEmptyKore(text: string): boolean {
  let pos = 0;
  while (pos < text.length) {
    // `charAt` is total; `[]` is not.
    const char = text.charAt(pos);
    if (char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f" || char === "\v") {
      pos += 1;
    } else if (text.startsWith("//", pos)) {
      const end = text.indexOf("\n", pos);
      // A `//` comment unterminated by a newline runs to end of input, which is
      // legal and still empty.
      pos = end === -1 ? text.length : end + 1;
    } else if (text.startsWith("/*", pos)) {
      const end = text.indexOf("*/", pos + 2);
      if (end === -1) return false;
      pos = end + 2;
    } else {
      return false;
    }
  }
  return true;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
