/**
 * `KPrint` — a loaded definition plus the four things you can only get by
 * asking a K binary.
 *
 * A transcription of `pyk/ktool/kprint.py:171-353` at K `v7.1.337`.
 *
 * # What is new here, and what is not
 *
 * `@kframework-ts/kompiled` already is the data half of pyk's `KPrint`:
 * `definition`, `all_rules`, `definition_hash` and a pretty printer, all
 * in-process.  So this class adds exactly the parts that need a subprocess or a
 * policy decision:
 *
 * 1. {@link KPrint.parseToken} — parsing *program* text at a sort.  There is no
 *    in-process equivalent and there will not be one soon: `@kframework-ts/k-parser`
 *    parses K's **outer** syntax (modules, productions), while this needs the
 *    scanner and parser `kompile` generated for the definition's own grammar.
 * 2. {@link KPrint.kastToKore} / {@link KPrint.koreToKast} — `konvert` does both
 *    in-process, and pyk still falls back to the binary when it raises
 *    (`kprint.py:262-290`).  That fallback is a *policy*, so it is
 *    {@link ConversionStrategy} here rather than a silent `try/except`.
 * 3. {@link KPrint.koreToPretty} — KORE straight to text, no KAST in between.
 * 4. the temp-file discipline, which lives in `kast-cli.ts`.
 *
 * # Composition, not inheritance
 *
 * Downstream pyk consumers write `class KEVM(KProve, KRun)` and reach `KPrint`
 * through the diamond.  TypeScript has no multiple inheritance and does not
 * need it: `KRun` **holds** a `KPrint`, `KPrint` **holds** a
 * `KompiledDefinition`, and the `patch_symbol_table` constructor hook that the
 * whole hierarchy exists to thread becomes an ordinary option.
 *
 * # Why `KPrint.load` and not `new KPrint(dir)`
 *
 * pyk reads `mainModule.txt` and `backend.txt` in `__init__` (`kprint.py:198-200`)
 * — a blocking read in a constructor.  Reading a directory here is `async`, and
 * a constructor cannot be.  The choice is between a constructor that takes a
 * path and *lazily* reads (losing the eager `mainModule`/`backend` fields pyk
 * guarantees) and an async factory.  This takes the factory:
 * {@link KPrint.load} is the entry point, and the constructor takes an
 * already-loaded {@link KompiledDefinition} for a caller that has one.
 *
 * # Two pretty printers, and only one of them takes the hooks
 *
 * K has **two** `format` languages and this repo implements both:
 *
 * - {@link KPrint.prettyPrint} is pyk's `KPrint.pretty_print`
 *   (`kprint.py:301-312`) — `@kframework-ts/kast`'s `PrettyPrinter`, driven by a
 *   `SymbolTable`.  It is the one that accepts
 *   {@link KPrintOptions.patchSymbolTable} and
 *   {@link KPrintOptions.extraUnparsingModules}, because a symbol table is the
 *   only thing those two hooks can patch.  KEVM installs ~20 custom unparsers
 *   through them, so this is the pyk-compatible route and the default.
 * - {@link KPrint.formatPrint} is `@kframework-ts/kompiled`'s `prettyPrint` —
 *   `Formatter`, which reads the definition's own `format` and `bracket`
 *   attributes and produces better output.  **It has no symbol table at all**,
 *   so the two hooks are structurally inapplicable, not merely unimplemented:
 *   `Formatter` resolves a `KApply` to a *production* and renders its `format`
 *   string, never consulting a `label → unparser` map.  Rather than accept the
 *   hooks and ignore them — which would silently produce output missing every
 *   custom unparser — {@link KPrint.formatPrint} throws when either is
 *   configured.  Construct a second `KPrint` without them if you want both.
 *
 * Both of them are **in-process**: unparsing a term to text starts nothing.
 * That is worth saying plainly, because pyk's `KPrint` cannot do it — pyk's
 * `pretty_print` is in-process too, but its `kore_to_pretty` shells out
 * (`kprint.py:252-260`) and its downstream consumers reach for `kore-print`
 * habitually.  Here `koreToKast` + `prettyPrint`/`formatPrint` covers
 * KORE-to-text with no child at all under `conversionStrategy: 'pure'`, and
 * {@link KPrint.koreToPretty}'s `pykPrint: true` is that composition under one
 * name.  `korePrint` and `koreToPretty()` remain for the cases where K's own
 * unparser is the oracle you want rather than the thing you are checking.
 *
 * # The two throughput seams, and why they are on by default
 *
 * 1. {@link KPrint.load} goes through `definition-cache.ts`, so N printers over
 *    one kompiled directory parse `compiled.json` and `definition.kore` once
 *    between them.  {@link KPrintOptions.cacheDefinition} turns it off.
 * 2. {@link KPrint.parseToken} uses the definition's native
 *    `parser_<Sort>_<Module>` binary when `kompile` generated one — three
 *    orders of magnitude faster than the `kast` it replaces, and byte-identical
 *    (see `kparse.ts`).  {@link ParseTokenOptions.native} turns it off.
 *
 * Neither is pyk behaviour, because pyk has neither.  Both default to *on*
 * because that is what the K distribution's own `kparse` and `checkJava` do:
 * the fast path is the normal path there, and a port that made it opt-in would
 * be slower than the shell scripts it transcribes.
 */

import {
  fromDict,
  kastTerm,
  kastTermToDict,
  PrettyPrinter,
  type KAst,
  type KDefinition,
  type KFlatModule,
  type KInner,
  type KSort,
  type KToken,
  type SymbolTable,
} from "@kframework-ts/kast";
import { loadKompiledDefinition, type KompiledDefinition, type PrettyPrintOptions } from "@kframework-ts/kompiled";
import { kastToKore as konvertKastToKore, koreToKast as konvertKoreToKast } from "@kframework-ts/konvert";
import { koreText, KoreParser, type Pattern } from "@kframework-ts/kore";

import { loadKompiledDefinitionCached } from "./definition-cache.js";
import { expressionKast, type KastTempOptions, type RunKastOptions } from "./kast-cli.js";
import { korePrint, type ProcessRunner } from "./kore-print.js";
import { findBisonParser, kparse, type BisonParser, type KparseResult, type KparseTargetQuery } from "./kparse.js";
import { checkDirPath, type ProcessControlOptions, type ProcessLogger } from "./proc.js";

//////////////////////////////
// Options                  //
//////////////////////////////

/**
 * How `KAST ⇄ KORE` is performed — pyk's implicit `try konvert / except / fall
 * back to the binary` (`ktool/kprint.py:262-290`), made explicit.
 *
 * - `pure` — `@kframework-ts/konvert` only.  No process, so it is the only
 *   strategy that works with no K installed, and a conversion `konvert` cannot
 *   do throws instead of being papered over.
 * - `binary` — `kast`/`kore-print` only.  What you want when you are
 *   *checking* `konvert` against K, or when a definition uses something
 *   `konvert` gets wrong.
 * - `pure-then-binary` — try `konvert`, and on any failure re-do it through the
 *   binary.  pyk's behaviour, and the default, because it is the one that
 *   always produces an answer if an answer exists.
 *
 * pyk catches `ValueError` specifically; this catches everything, because
 * `konvert`'s failure modes are `TypeError` and `Error` as well and the point
 * of a fallback is not to be picky about why the first attempt failed.
 */
export const CONVERSION_STRATEGIES = ["pure", "binary", "pure-then-binary"] as const;
export type ConversionStrategy = (typeof CONVERSION_STRATEGIES)[number];

/** {@link KPrint}'s constructor options — `KPrint.__init__` (`ktool/kprint.py:181-204`). */
export interface KPrintOptions extends KastTempOptions {
  /** Extra modules whose productions join the symbol table (`kprint.py:186`). */
  readonly extraUnparsingModules?: Iterable<KFlatModule>;
  /** Run against the freshly built symbol table, before first use (`kprint.py:187`). */
  readonly patchSymbolTable?: (symbolTable: SymbolTable) => void;
  /** Defaults to `pure-then-binary` — see {@link ConversionStrategy}. */
  readonly conversionStrategy?: ConversionStrategy;
  /** The `kast` command.  Defaults to `['kast']`. */
  readonly command?: readonly string[];
  /** The `kore-print` command.  Defaults to `['kore-print']`. */
  readonly korePrintCommand?: readonly string[];
  /**
   * Share the parsed `compiled.json`/`definition.kore` with every other
   * {@link KPrint.load} of the same directory — `definition-cache.ts`.
   * Defaults to `true`.
   *
   * `false` gives this instance its own {@link KompiledDefinition}, which is
   * what a caller who intends to hold onto and mutate the definition wants.
   * Not a pyk option: pyk has no cross-instance cache to opt out of.
   */
  readonly cacheDefinition?: boolean;
  /** The child's whole environment, replacing this process's. */
  readonly env?: Readonly<Record<string, string>>;
  readonly logger?: ProcessLogger;
  /** Test seam — see {@link ProcessRunner}. */
  readonly runner?: ProcessRunner;
}

/** {@link KPrint.prettyPrint}'s options — `KPrint.pretty_print` (`ktool/kprint.py:301-303`). */
export interface KPrintPrettyOptions {
  /** Print as though this module were the main one: `definition.let(main_module_name=…)` (`:304`). */
  readonly inModule?: string;
  /** Fold aliases back in first.  Defaults to `true`, as pyk's does. */
  readonly unalias?: boolean;
  /** Normalise AC collections first.  Defaults to `false`, as pyk's does. */
  readonly sortCollections?: boolean;
}

/** {@link KPrint.kastToKore}'s options — `KPrint.kast_to_kore` (`ktool/kprint.py:274`). */
export interface KastToKoreOptions extends ProcessControlOptions {
  /** The sort the whole term is injected to.  Defaults to `K`, as `konvert` does. */
  readonly sort?: KSort;
  /**
   * Skip the in-process attempt for this call — pyk's `force_kast=True`
   * (`:274,276`).
   *
   * Equivalent to {@link ConversionStrategy} `binary` for one conversion.
   * There is no `koreToKast` counterpart because pyk has none.
   */
  readonly forceKast?: boolean;
}

/** {@link KPrint.parseToken}'s options — `KPrint.parse_token` (`ktool/kprint.py:242`) plus one. */
export interface ParseTokenOptions extends ProcessControlOptions {
  /** `--input rule` instead of `--input program`, so variables parse.  Upstream's. */
  readonly asRule?: boolean;
  /**
   * Refuse the native `parser_<Sort>_<Module>` binary and always use `kast`.
   *
   * Not upstream — pyk has no fast path to refuse.  The reason to want it is
   * differential testing: proving the two routes agree over a corpus is the
   * check that licenses the fast path being the default.
   */
  readonly native?: boolean;
}

/** {@link KPrint.kparse}'s options. */
export interface KPrintKparseOptions extends KparseTargetQuery, ProcessControlOptions {
  /** See {@link ParseTokenOptions.native}. */
  readonly native?: boolean;
  /** The filename locations are reported against — `kparse.ts`'s `locationFile`. */
  readonly locationFile?: string;
  /** An already-resolved parser, from {@link KPrint.bisonParser}; skips the lookup. */
  readonly parser?: BisonParser;
}

//////////////////////////////
// The class                //
//////////////////////////////

/**
 * A kompiled definition, its pretty printers, and the `kast` invocations that
 * need the real toolchain.
 *
 * ```ts
 * const kprint = await KPrint.load("imp-kompiled");
 * kprint.mainModule;                              // "IMP"  — read at load
 * kprint.prettyPrint(kprint.definition.emptyConfig(ksort("TCell")));
 * await kprint.parseToken(ktoken("3 + 4", "AExp"));   // needs `kast`
 * ```
 */
export class KPrint {
  /** The `*-kompiled` directory this reads — pyk's `definition_dir`. */
  readonly definitionDir: string;
  /** Where temp files go, and whether they survive.  See {@link KastTempOptions.useDirectory}. */
  readonly useDirectory: string | undefined;
  /** `mainModule.txt`, read eagerly as pyk reads it (`kprint.py:198-199`). */
  readonly mainModule: string;
  /** `backend.txt`, read eagerly (`kprint.py:200`). */
  readonly backend: string;
  /** The loaded directory.  Everything in-process goes through it. */
  readonly kompiled: KompiledDefinition;
  /** The strategy {@link koreToKast} and {@link kastToKore} follow. */
  readonly conversionStrategy: ConversionStrategy;

  readonly #options: KPrintOptions;
  readonly #printers = new Map<string, PrettyPrinter>();
  readonly #parsers = new Map<string, Promise<BisonParser | undefined>>();

  constructor(kompiled: KompiledDefinition, options: KPrintOptions = {}) {
    this.definitionDir = kompiled.path;
    this.kompiled = kompiled;
    this.useDirectory = options.useDirectory;
    this.mainModule = kompiled.layout.mainModule;
    this.backend = kompiled.layout.backend;
    this.conversionStrategy = options.conversionStrategy ?? "pure-then-binary";
    this.#options = options;
  }

  /**
   * Load a `*-kompiled` directory and wrap it — pyk's `KPrint.__init__`
   * (`ktool/kprint.py:181-204`), which is not a constructor here; see the
   * module header.
   *
   * `useDirectory` is checked to be a directory up front, exactly as
   * `check_dir_path(use_directory)` does (`:191-192`): a temp directory that
   * does not exist should be an error now, not when the first 128 KiB term
   * arrives.
   *
   * @throws {import('@kframework-ts/kompiled').MissingKompiledFileError} when a
   *   marker file is absent.  The KAST and KORE artifacts are still lazy.
   */
  static async load(definitionDir: string, options: KPrintOptions = {}): Promise<KPrint> {
    await checkDirPath(definitionDir);
    if (options.useDirectory !== undefined) await checkDirPath(options.useDirectory);

    if (options.cacheDefinition !== false) {
      return new KPrint(await loadKompiledDefinitionCached(definitionDir), options);
    }

    // The `konvert` edge `kompiled` deliberately leaves injected.  The closure
    // reads `kompiled` only after `load` has returned it.
    const kompiled: KompiledDefinition = await loadKompiledDefinition(definitionDir, {
      koreToKast: (pattern) => konvertKoreToKast(kompiled.definition, pattern),
    });
    return new KPrint(kompiled, options);
  }

  /** The KAST definition — `compiled.json` (`ktool/kprint.py:218-220`). */
  get definition(): KDefinition {
    return this.kompiled.definition;
  }

  /** `KAst.hash` of the definition — `KPrint.definition_hash` (`:238-240`). */
  get definitionHash(): string {
    return this.kompiled.definitionHash;
  }

  /**
   * `allRules.txt`, keyed by the 12-character hash prefix — `KPrint.all_rules`
   * (`:222-236`).
   *
   * The values are `@kframework-ts/kompiled`'s parsed `RuleLocation`, not pyk's
   * raw `file:line:col` string: the same information, already split.
   */
  get allRules(): KompiledDefinition["layout"]["allRulesByPrefix"] {
    return this.kompiled.layout.allRulesByPrefix;
  }

  //////////////////////////////
  // Pretty printing          //
  //////////////////////////////

  /**
   * Pretty-print a term through the definition's symbol table — pyk's
   * `KPrint.pretty_print` (`ktool/kprint.py:301-312`), exactly.
   *
   * This is `@kframework-ts/kast`'s `PrettyPrinter`, the printer that
   * {@link KPrintOptions.patchSymbolTable} and
   * {@link KPrintOptions.extraUnparsingModules} apply to.  See the module header
   * for why the *other* printer, {@link formatPrint}, cannot take them.
   *
   * A `PrettyPrinter` is memoised per `inModule`, because its symbol table is
   * built by walking every production of every module in scope and upstream
   * gets that caching from `cached_property`.  A patch function that mutates
   * external state will therefore run **once per module**, not once per call —
   * which is also pyk's behaviour, and is why patch functions should be pure.
   */
  prettyPrint(kast: KAst, options: KPrintPrettyOptions = {}): string {
    const key = `${options.inModule ?? ""}\u0000${options.unalias !== false}\u0000${options.sortCollections === true}`;
    let printer = this.#printers.get(key);
    if (printer === undefined) {
      const definition =
        options.inModule === undefined ? this.definition : this.definition.let({ mainModuleName: options.inModule });
      printer = new PrettyPrinter(definition, {
        ...(this.#options.extraUnparsingModules === undefined
          ? {}
          : { extraUnparsingModules: this.#options.extraUnparsingModules }),
        ...(this.#options.patchSymbolTable === undefined ? {} : { patchSymbolTable: this.#options.patchSymbolTable }),
        unalias: options.unalias ?? true,
        sortCollections: options.sortCollections ?? false,
      });
      this.#printers.set(key, printer);
    }
    return printer.print(kast);
  }

  /**
   * Pretty-print a term through the definition's `format` attributes —
   * `@kframework-ts/kompiled`'s `prettyPrint`, i.e. `@kframework-ts/kast`'s
   * `Formatter`.
   *
   * No pyk method corresponds to this: nothing under `pyk/src/pyk` calls
   * `Formatter` from `KPrint` at all.  It is here because it is the better
   * printer — it reproduces the definition's own layout, which a symbol table
   * cannot — and because `krun -o pretty` output is closer to it than to
   * {@link prettyPrint}.
   *
   * @throws {TypeError} when this `KPrint` was constructed with
   *   `patchSymbolTable` or `extraUnparsingModules`.  `Formatter` has no symbol
   *   table to patch, and printing without the caller's unparsers would be
   *   silently wrong output rather than an error.
   */
  formatPrint(term: KInner, options: PrettyPrintOptions = {}): string {
    if (this.#options.patchSymbolTable !== undefined || this.#options.extraUnparsingModules !== undefined) {
      throw new TypeError(
        "formatPrint cannot honour patchSymbolTable or extraUnparsingModules: the Formatter renders each " +
          "production's own `format` attribute and has no symbol table to patch. Use prettyPrint, or build a " +
          "second KPrint without those options.",
      );
    }
    return this.kompiled.prettyPrint(term, options);
  }

  //////////////////////////////
  // The binary               //
  //////////////////////////////

  /**
   * Parse program text to KORE through the native parser when there is one —
   * `k-distribution/src/main/scripts/bin/kparse`, via {@link kparse}.
   *
   * No pyk method corresponds to this; pyk never execs a generated parser.  It
   * is the fastest way to get a term out of program text that this package has:
   * ~0.8 ms against `kast`'s ~1 250 ms cold and ~280 ms warm, for the same
   * bytes.  Sort and module default the way `kparse` defaults them —
   * `$PGM`'s declared sort (or `KItem`) and `mainSyntaxModule.txt`.
   *
   * ```ts
   * const { kore, parser } = await kprint.kparse("1 + 2 + 3");
   * parser !== undefined; // true ⇒ no JVM was involved
   * ```
   *
   * @throws {import('./proc.js').ProcessError} when the parser rejects the text.
   */
  async kparse(text: string, options: KPrintKparseOptions = {}): Promise<KparseResult> {
    const { native, locationFile, parser, ...target } = options;
    return kparse({
      ...target,
      definitionDir: this.definitionDir,
      layout: this.kompiled.layout,
      text,
      ...(native === undefined ? {} : { native }),
      ...(locationFile === undefined ? {} : { locationFile }),
      ...(parser === undefined ? {} : { parser }),
      ...this.#childOptions(this.#options.command ?? ["kast"]),
    });
  }

  /** The native parser this `KPrint` would use for a sort, or `undefined`.  Memoised per target. */
  async bisonParser(query: KparseTargetQuery = {}): Promise<BisonParser | undefined> {
    const key = `${query.sort ?? ""} ${query.module ?? ""}`;
    let lookup = this.#parsers.get(key);
    if (lookup === undefined) {
      lookup = findBisonParser(this.definitionDir, this.kompiled.layout, query);
      this.#parsers.set(key, lookup);
    }
    return lookup;
  }

  /**
   * Parse program (or rule) text at a sort — `KPrint.parse_token`
   * (`ktool/kprint.py:242-250`).
   *
   * `kast --input program|rule --output json --sort <S>`, then the KAST-JSON
   * envelope is opened and the term decoded.  `asRule` selects `rule` input,
   * which is what lets `3 +Int V` parse as a rule-side term with a variable in
   * it — program syntax has no variables.
   *
   * # The native fast path
   *
   * When all four of these hold, no JVM is started:
   *
   * 1. `asRule` is not set — `kparse` only fast-paths `--input program`
   *    (`kparse:192-200`), because a generated parser is built from the
   *    definition's *program* grammar and knows nothing about rule variables;
   * 2. `kompile` generated `parser_<Sort>_<mainSyntaxModule>`;
   * 3. {@link ParseTokenOptions.native} is not `false`;
   * 4. {@link ConversionStrategy} is not `binary`, since the KORE the parser
   *    produces has to become KAST somehow and `konvert` is the in-process way.
   *
   * If `konvert` cannot decode what the parser produced, this falls **through**
   * to the `kast` route rather than failing — the same shape as
   * {@link koreToKast}'s `pure-then-binary`, and for the same reason: a
   * fallback exists to produce an answer, not to be picky about why the first
   * attempt did not.  Under `conversionStrategy: 'pure'` there is no fallback
   * and the `konvert` error is raised, which is that strategy's whole contract.
   *
   * @throws {import('./proc.js').ProcessError} when `kast` — or the native
   *   parser — rejects the text.
   */
  async parseToken(token: KToken, options: ParseTokenOptions = {}): Promise<KInner> {
    if (options.asRule !== true && options.native !== false && this.conversionStrategy !== "binary") {
      const parser = await this.bisonParser({ sort: token.sort.name });
      if (parser !== undefined) {
        const { kore } = await this.kparse(token.token, {
          sort: token.sort.name,
          parser,
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs }),
        });
        try {
          return konvertKoreToKast(this.definition, new KoreParser(kore).pattern());
        } catch (error) {
          if (this.conversionStrategy === "pure") throw error;
        }
      }
    }

    const result = await this.#expression(token.token, {
      input: options.asRule === true ? "rule" : "program",
      output: "json",
      sort: token.sort.name,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs }),
    });
    return fromDict(kastTerm(JSON.parse(result.stdout)));
  }

  /**
   * KORE → pretty text — `KPrint.kore_to_pretty` (`ktool/kprint.py:252-260`).
   *
   * Two routes, and they do not produce the same string:
   *
   * - `pykPrint: false` (the default) runs `kast --input kore --output pretty`,
   *   which goes through K's own unparser;
   * - `pykPrint: true` converts to KAST first and runs {@link prettyPrint}.
   *
   * The child's stdout is returned **untrimmed**, as pyk returns it — note the
   * contrast with {@link korePrint}, which trims.  Both are upstream's.
   */
  async koreToPretty(
    pattern: Pattern,
    options: { readonly pykPrint?: boolean } & ProcessControlOptions = {},
  ): Promise<string> {
    if (options.pykPrint === true) return this.prettyPrint(await this.koreToKast(pattern, options));
    const result = await this.#expression(koreText(pattern), {
      input: "kore",
      output: "pretty",
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs }),
    });
    return result.stdout;
  }

  /**
   * KORE → KAST — `KPrint.kore_to_kast` (`ktool/kprint.py:262-272`), under the
   * configured {@link ConversionStrategy}.
   *
   * The binary route is `kore-print --output json`, not `kast`: that is
   * upstream's choice (`:271`) and it matters, because `kore-print` dispatches
   * to the LLVM backend's printer when `syntaxDefinition.kore` is present.
   *
   * @throws {Error} when the strategy is `pure` and `konvert` cannot do it, or
   *   when the binary route also fails.
   */
  async koreToKast(kore: Pattern, options: ProcessControlOptions = {}): Promise<KInner> {
    if (this.conversionStrategy !== "binary") {
      try {
        return konvertKoreToKast(this.definition, kore);
      } catch (error) {
        if (this.conversionStrategy === "pure") throw error;
      }
    }
    const json = await korePrint(kore, {
      definitionDir: this.definitionDir,
      output: "json",
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs }),
      ...this.#childOptions(this.#options.korePrintCommand ?? ["kore-print"]),
    });
    return fromDict(kastTerm(JSON.parse(json)));
  }

  /**
   * KAST → KORE — `KPrint.kast_to_kore` (`ktool/kprint.py:274-290`), under the
   * configured {@link ConversionStrategy}.
   *
   * The binary route wraps the term in a KAST v4 envelope, hands it to `kast
   * --input json --output kore` (through the 128 KiB switch — this is *the*
   * call that motivates it), and parses the result.
   *
   * @throws {Error} when the strategy is `pure` and `konvert` cannot do it.
   * @throws {import('@kframework-ts/kore').KoreSyntaxError} when the binary
   *   returned something that is not a KORE pattern.
   */
  async kastToKore(kast: KInner, options: KastToKoreOptions = {}): Promise<Pattern> {
    if (this.conversionStrategy !== "binary" && options.forceKast !== true) {
      try {
        return konvertKastToKore(this.definition, kast, options.sort === undefined ? {} : { sort: options.sort });
      } catch (error) {
        if (this.conversionStrategy === "pure") throw error;
      }
    }
    const result = await this.#expression(JSON.stringify(kastTermToDict(kast)), {
      input: "json",
      output: "kore",
      ...(options.sort === undefined ? {} : { sort: options.sort.name }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs }),
    });
    const parser = new KoreParser(result.stdout);
    const pattern = parser.pattern();
    parser.expectEof();
    return pattern;
  }

  /**
   * `KPrint._expression_kast` (`ktool/kprint.py:314-353`) with this instance's
   * definition directory, temp directory, command and logger already applied.
   */
  #expression(
    expression: string,
    args: Pick<RunKastOptions, "input" | "output" | "module" | "sort"> & ProcessControlOptions,
  ): ReturnType<typeof expressionKast> {
    return expressionKast(expression, {
      ...args,
      definitionDir: this.definitionDir,
      ...(this.useDirectory === undefined ? {} : { useDirectory: this.useDirectory }),
      ...this.#childOptions(this.#options.command ?? ["kast"]),
    });
  }

  /** The env/logger/runner triple every child of this `KPrint` inherits. */
  #childOptions(command: readonly string[]): {
    readonly command: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
    readonly logger?: ProcessLogger;
    readonly runner?: ProcessRunner;
  } {
    return {
      command,
      ...(this.#options.env === undefined ? {} : { env: this.#options.env }),
      ...(this.#options.logger === undefined ? {} : { logger: this.#options.logger }),
      ...(this.#options.runner === undefined ? {} : { runner: this.#options.runner }),
    };
  }
}
