/** Pure in-memory KORE-to-Lean project generation. */

import { analyzeKleanDefinition, type KleanDefinition } from "./analysis.js";
import { generateFunctions } from "./functions.js";
import { generateInjectionsModule } from "./injections.js";
import { KLEAN_PRELUDE } from "./prelude.js";
import type { KleanDiagnostic } from "./projection.js";
import type { KleanSource } from "./source.js";
import { generateRewrites } from "./rewrites.js";
import { generateSortsModule } from "./sorts.js";
import { K_COMMIT, K_RELEASE } from "./version.js";

export interface KleanOptions {
  /** Lake package name, conventionally lowercase/kebab-case. */
  readonly packageName: string;
  /** Lean library name. Defaults to a PascalCase rendering of packageName. */
  readonly libraryName?: string;
  readonly ruleLabels?: readonly string[];
  readonly deriveBeq?: boolean;
  readonly deriveDecidableEq?: boolean;
}

export interface GenerationManifest {
  readonly kRelease: string;
  readonly kCommit: string;
  readonly leanToolchain: string;
  readonly packageName: string;
  readonly libraryName: string;
  readonly selectedRewriteLabels: readonly string[];
  readonly selectedRewriteUids: readonly string[];
  readonly emittedSorts: readonly string[];
  readonly emittedSymbols: readonly string[];
  readonly emittedFunctionEquations: readonly string[];
  readonly emittedRewrites: readonly string[];
  readonly axiomaticFunctions: readonly string[];
  readonly semanticMode: {
    readonly rewritePriorities: "ignored";
    readonly functions: "option-with-axiomatic-fallback";
    readonly collections: "shallow-hook-structures";
  };
}

export interface GeneratedProject {
  readonly files: ReadonlyMap<string, string>;
  readonly manifest: GenerationManifest;
  readonly diagnostics: readonly KleanDiagnostic[];
}

function defaultLibraryName(packageName: string): string {
  const name = packageName.replace(/^@[^/]+\//u, "");
  const words = name.split(/[^A-Za-z0-9]+/u).filter((word) => word.length > 0);
  const result = words.map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`).join("");
  if (!/^[A-Za-z_]/u.test(result))
    throw new TypeError(`Cannot derive a Lean library name from package name ${JSON.stringify(packageName)}`);
  return result;
}

function lakefile(packageName: string, libraryName: string): string {
  return `name = ${JSON.stringify(packageName)}\nversion = "0.1.0"\ndefaultTargets = [${JSON.stringify(libraryName)}]\nweakLeanArgs = [\n    "-D", "maxHeartbeats=10000000",\n]\n\n[[lean_lib]]\nname = ${JSON.stringify(libraryName)}\n`;
}

function manifest(
  definition: KleanDefinition,
  options: KleanOptions,
  libraryName: string,
  axiomaticFunctions: readonly string[],
): GenerationManifest {
  return {
    kRelease: K_RELEASE,
    kCommit: K_COMMIT,
    leanToolchain: "leanprover/lean4:v4.30.0",
    packageName: options.packageName,
    libraryName,
    selectedRewriteLabels: definition.selection.labels,
    selectedRewriteUids: definition.selection.uids,
    emittedSorts: [...definition.sorts.keys()].toSorted(),
    emittedSymbols: [...definition.symbols.keys()].toSorted(),
    emittedFunctionEquations: [...definition.equations.entries()]
      .flatMap(([symbol, equations]) =>
        equations.map((equation) => equation.rule.uid ?? `${symbol}:${equation.rule.label ?? "unlabelled"}`),
      )
      .toSorted(),
    emittedRewrites: definition.rewrites
      .map((rewrite) => rewrite.rule.uid ?? rewrite.rule.label ?? "unlabelled")
      .toSorted(),
    axiomaticFunctions: [...axiomaticFunctions].toSorted(),
    semanticMode: {
      rewritePriorities: "ignored",
      functions: "option-with-axiomatic-fallback",
      collections: "shallow-hook-structures",
    },
  };
}

/**
 * Produce a complete Lake project without writing to disk.
 *
 * Errors are reported in `diagnostics` and only prevent their affected
 * declarations from being emitted; this lets callers inspect the generated
 * manifest before deciding whether incomplete output is acceptable.
 */
export function generateKleanProject(source: KleanSource, options: KleanOptions): GeneratedProject {
  if (!/^[a-z][a-z0-9-]*$/u.test(options.packageName))
    throw new TypeError("Klean packageName must be a bare lowercase kebab-case Lake package name");
  const libraryName = options.libraryName ?? defaultLibraryName(options.packageName);
  const definition = analyzeKleanDefinition(
    source,
    options.ruleLabels === undefined ? {} : { ruleLabels: options.ruleLabels },
  );
  const sorts = generateSortsModule(
    definition,
    {
      ...(options.deriveBeq === undefined ? {} : { deriveBeq: options.deriveBeq }),
      ...(options.deriveDecidableEq === undefined ? {} : { deriveDecidableEq: options.deriveDecidableEq }),
    },
    `${libraryName}.Prelude`,
  );
  const injections = generateInjectionsModule(definition, `${libraryName}.Sorts`);
  const functions = generateFunctions(definition, `${libraryName}.Inj`);
  const rewrites = generateRewrites(definition, `${libraryName}.Func`);
  const files = new Map<string, string>([
    [`${libraryName}.lean`, `import ${libraryName}.Rewrite\n`],
    [`${libraryName}/Prelude.lean`, KLEAN_PRELUDE.endsWith("\n") ? KLEAN_PRELUDE : `${KLEAN_PRELUDE}\n`],
    [`${libraryName}/Sorts.lean`, sorts],
    [`${libraryName}/Inj.lean`, injections],
    [`${libraryName}/Func.lean`, functions.text],
    [`${libraryName}/Rewrite.lean`, rewrites.text],
    ["lakefile.toml", lakefile(options.packageName, libraryName)],
    ["lean-toolchain", "leanprover/lean4:v4.30.0\n"],
  ]);
  return {
    files,
    manifest: manifest(definition, options, libraryName, functions.axiomaticFunctions),
    diagnostics: [...definition.diagnostics, ...functions.diagnostics, ...rewrites.diagnostics],
  };
}
