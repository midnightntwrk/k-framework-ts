/**
 * Names and expected paths for the optional Bison parsers a `kompile` run can
 * put beside its ordinary artifacts.
 *
 * This is deliberately a model of files, not of runnable programs.  K writes
 * these names in `Kompile.java:255-331`; whether a particular native file can
 * be executed belongs to `@kframework-ts/ktool`.
 */

import type { KompiledLayout } from "./layout.js";

/** The sort `kompile` uses when a parser attribute names no declared config variable. */
export const DEFAULT_BISON_PARSER_SORT = "K" as const;

/** The configuration variable whose alias is always written when a parser is generated. */
export const PGM_CONFIG_VAR = "PGM" as const;

/** Options that select the library spelling of a generated parser. */
export interface BisonParserNameOptions {
  /** `true` selects K's `--bison-parser-library` spelling. */
  readonly library?: boolean;
  /** Platform whose shared-library suffix is wanted; defaults to the current platform. */
  readonly platform?: string;
}

/** K's shared-library suffix on the requested platform. */
export function bisonParserLibrarySuffix(platform: string = process.platform): ".dll" | ".dylib" | ".so" {
  return platform === "darwin" ? ".dylib" : platform === "win32" ? ".dll" : ".so";
}

/**
 * The concrete filename `kompile` writes for a generated Bison parser.
 *
 * `parser_<Sort>_<Module>` is the executable form.  The hidden official
 * `--bison-parser-library` option instead writes
 * `libparser_<Sort>_<Module>.so` (or `.dylib` on macOS).  This function does
 * not validate, stat, or execute the resulting name.
 */
export function bisonParserName(sort: string, module: string, options: BisonParserNameOptions = {}): string {
  const base = `parser_${sort}_${module}`;
  return options.library ? `lib${base}${bisonParserLibrarySuffix(options.platform)}` : base;
}

/** One concrete parser that a layout says a `kompile` run may have generated. */
export interface ExpectedBisonParser {
  readonly kind: "concrete";
  readonly sort: string;
  readonly module: string;
  /** The ordinary executable-form filename. */
  readonly executable: string;
  /** The library-form filename for the selected platform. */
  readonly library: string;
}

/** A symlink `kompile` may have made as a convenience alias. */
export interface ExpectedBisonParserAlias {
  readonly kind: "alias";
  /** The config-variable spelling without `$`; `PGM` is always included. */
  readonly configVar: string;
  readonly file: string;
  readonly sort: string;
  readonly module: string;
  /** Either concrete spelling is valid: both modes create the aliases. */
  readonly expectedTargets: readonly [string, string];
}

/** An expected concrete parser or convenience alias, derived without I/O. */
export type ExpectedBisonParserArtifact = ExpectedBisonParser | ExpectedBisonParserAlias;

/**
 * Derive the optional Bison parser artifacts from a loaded layout.
 *
 * A layout does not record which generation mode was selected, so each
 * concrete descriptor names both possible spellings and each alias accepts
 * either target.  Missing files are therefore normal and are left for the
 * passive filesystem inspector to report.
 */
export function expectedBisonParserArtifacts(
  layout: KompiledLayout,
  options: Pick<BisonParserNameOptions, "platform"> = {},
): readonly ExpectedBisonParserArtifact[] {
  const targets = new Map<string, { readonly sort: string; readonly module: string }>([
    [
      PGM_CONFIG_VAR,
      {
        sort: layout.configVarSorts.get(PGM_CONFIG_VAR) ?? DEFAULT_BISON_PARSER_SORT,
        module: layout.mainSyntaxModule,
      },
    ],
  ]);
  for (const [configVar, module] of layout.configVarModules) {
    targets.set(configVar, {
      sort: layout.configVarSorts.get(configVar) ?? DEFAULT_BISON_PARSER_SORT,
      module,
    });
  }

  const artifacts: ExpectedBisonParserArtifact[] = [];
  const concrete = new Set<string>();
  for (const { sort, module } of targets.values()) {
    const executable = bisonParserName(sort, module);
    if (concrete.has(executable)) continue;
    concrete.add(executable);
    artifacts.push(
      Object.freeze({
        kind: "concrete",
        sort,
        module,
        executable,
        library: bisonParserName(sort, module, { library: true, ...options }),
      }),
    );
  }
  for (const [configVar, { sort, module }] of targets) {
    const executable = bisonParserName(sort, module);
    const library = bisonParserName(sort, module, {
      library: true,
      ...options,
    });
    const expectedTargets: readonly [string, string] = Object.freeze([executable, library]);
    artifacts.push(
      Object.freeze({
        kind: "alias",
        configVar,
        file: `parser_${configVar}`,
        sort,
        module,
        expectedTargets,
      }),
    );
  }
  return Object.freeze(artifacts);
}
