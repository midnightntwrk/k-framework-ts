/** Generation of the priority-agnostic `Rewrites` relation. */

import { collect, eliminateAliases, type App, type EVar, type Pattern, type Sort } from "@kframework-ts/kore";

import { leanIdentifier, renderLeanModule, type LeanConstructor } from "./lean.js";
import { lowerKorePattern, type LoweringDiagnostic } from "./lower.js";
import { leanRuleIdentifier, leanVariableIdentifier } from "./names.js";
import type { KleanDiagnostic, KleanProjection, KleanRewrite } from "./projection.js";
import { structureFields, structureSymbols } from "./sorts.js";

export interface RewritesModule {
  readonly text: string;
  readonly diagnostics: readonly KleanDiagnostic[];
}

interface FunctionWitness {
  readonly variable: EVar;
  readonly application: App;
}

function sortName(sort: Sort): string | undefined {
  return sort.tag === "SortApp" && sort.sorts.length === 0 ? sort.name : undefined;
}

function hasFunction(definition: KleanProjection, symbol: string): boolean {
  return definition.equations.has(symbol);
}

/** Bottom-up abstraction of Option-valued function calls into equality witnesses. */
function abstractFunctions(definition: KleanProjection, pattern: Pattern, witnesses: FunctionWitness[]): Pattern {
  if (pattern.tag !== "App") return pattern;
  const args = pattern.args.map((argument) => abstractFunctions(definition, argument, witnesses));
  const application: App = args.every((argument, index) => argument === pattern.args[index])
    ? pattern
    : { ...pattern, args };
  if (!hasFunction(definition, application.symbol)) return application;
  const declaration = definition.symbols.get(application.symbol);
  if (declaration === undefined) return application;
  const variable: EVar = { tag: "EVar", name: `Var'Unds'Val${witnesses.length}`, sort: declaration.sort };
  witnesses.push({ variable, application });
  return variable;
}

function freeVariables(patterns: readonly Pattern[]): readonly EVar[] {
  const found = new Map<string, EVar>();
  for (const pattern of patterns)
    collect(pattern, (node) => {
      if (node.tag === "EVar") found.set(`${node.name}:${JSON.stringify(node.sort)}`, node);
    });
  return [...found.values()].toSorted((left, right) =>
    leanVariableIdentifier(left.name).localeCompare(leanVariableIdentifier(right.name)),
  );
}

function loweringDiagnostics(items: readonly LoweringDiagnostic[], rule: KleanRewrite): KleanDiagnostic[] {
  return items.map((item) => ({
    severity: "error",
    code: item.code,
    message: item.message,
    ...(rule.rule.label === undefined ? {} : { label: rule.rule.label }),
    ...(rule.rule.uid === undefined ? {} : { uid: rule.rule.uid }),
  }));
}

function constructorFor(
  definition: KleanProjection,
  rewrite: KleanRewrite,
  index: number,
): { readonly leanConstructor?: LeanConstructor; readonly diagnostics: readonly KleanDiagnostic[] } {
  const normalized = normalizeRewrite(rewrite);
  if (normalized === undefined)
    return {
      diagnostics: [
        {
          severity: "error",
          code: "unsupported-alias",
          message: `Could not normalize rewrite ${rewrite.rule.label ?? rewrite.rule.uid ?? index}`,
          ...(rewrite.rule.label === undefined ? {} : { label: rewrite.rule.label }),
          ...(rewrite.rule.uid === undefined ? {} : { uid: rewrite.rule.uid }),
        },
      ],
    };
  const witnesses: FunctionWitness[] = [];
  const requirement =
    normalized.requires === undefined ? undefined : abstractFunctions(definition, normalized.requires, witnesses);
  const lhs = abstractFunctions(definition, normalized.lhs, witnesses);
  const rhs = abstractFunctions(definition, normalized.rhs, witnesses);
  const lowering = {
    symbols: definition.symbols,
    constructors: definition.constructors,
    structureSymbols: structureSymbols(definition),
    structures: structureFields(definition),
  };
  const loweredRequirement =
    requirement === undefined ? undefined : lowerKorePattern(lowering, requirement, {}, ["requires"]);
  const loweredLhs = lowerKorePattern(lowering, lhs, {}, ["lhs"]);
  const loweredRhs = lowerKorePattern(lowering, rhs, {}, ["rhs"]);
  const witnessTerms = witnesses.map(({ application }) => lowerKorePattern(lowering, application, {}, ["function"]));
  const errors = [
    ...(loweredRequirement?.diagnostics ?? []),
    ...loweredLhs.diagnostics,
    ...loweredRhs.diagnostics,
    ...witnessTerms.flatMap((entry) => entry.diagnostics),
  ];
  if (
    loweredLhs.term === undefined ||
    loweredRhs.term === undefined ||
    (loweredRequirement !== undefined && loweredRequirement.term === undefined) ||
    witnessTerms.some((term) => term.term === undefined)
  )
    return { diagnostics: loweringDiagnostics(errors, rewrite) };
  const binders = freeVariables(
    [...witnesses.map((witness) => witness.application), requirement, lhs, rhs].filter(
      (item): item is Pattern => item !== undefined,
    ),
  ).reduce<{ readonly sort: string; readonly names: string[] }[]>((groups, variable) => {
    const sort = sortName(variable.sort);
    if (sort === undefined) return groups;
    const existing = groups.find((group) => group.sort === sort);
    if (existing === undefined) groups.push({ sort, names: [leanVariableIdentifier(variable.name)] });
    else existing.names.push(leanVariableIdentifier(variable.name));
    return groups;
  }, []);
  const signatures = [
    ...binders.map((group) => ({ tag: "implicit" as const, identifiers: group.names.toSorted(), type: group.sort })),
    ...witnesses.map((witness, witnessIndex) => ({
      tag: "explicit" as const,
      identifiers: [`defn${leanVariableIdentifier(witness.variable.name)}`],
      type: `${witnessTerms[witnessIndex]?.term} = some ${leanVariableIdentifier(witness.variable.name)}`,
    })),
    ...(loweredRequirement === undefined
      ? []
      : [{ tag: "explicit" as const, identifiers: ["req"], type: `${loweredRequirement.term} = true` }]),
  ];
  const identifier = leanRuleIdentifier(rewrite.rule.label, rewrite.rule.uid ?? `rewrite${index}`);
  return {
    leanConstructor: {
      identifier,
      signature: { binders: signatures, type: `Rewrites ${loweredLhs.term} ${loweredRhs.term}` },
    },
    diagnostics: [],
  };
}

/** Apply compiler-alias elimination jointly so configuration frame variables are substituted everywhere. */
function normalizeRewrite(
  rewrite: KleanRewrite,
): { readonly lhs: Pattern; readonly rhs: Pattern; readonly requires: Pattern | undefined } | undefined {
  const patterns = [
    rewrite.rule.lhs,
    rewrite.rule.rhs,
    rewrite.rule.requires ?? { tag: "Top" as const, sort: rewrite.rule.sort },
  ];
  const bundled = eliminateAliases({ tag: "And", sort: rewrite.rule.sort, patterns });
  if (bundled.tag !== "And") return undefined;
  const [lhs, rhs, requires] = bundled.patterns;
  return lhs === undefined || rhs === undefined
    ? undefined
    : { lhs, rhs, requires: rewrite.rule.requires === undefined ? undefined : requires };
}

/** Generate `Rewrite.lean`. K priorities are intentionally not represented by this relation. */
export function generateRewrites(definition: KleanProjection, funcImport = "Func"): RewritesModule {
  const diagnostics: KleanDiagnostic[] = [];
  const constructors: LeanConstructor[] = [
    {
      identifier: "tran",
      signature: {
        binders: [
          { tag: "implicit", identifiers: ["s1", "s2", "s3"], type: "SortGeneratedTopCell" },
          { tag: "explicit", identifiers: ["t1"], type: "Rewrites s1 s2" },
          { tag: "explicit", identifiers: ["t2"], type: "Rewrites s2 s3" },
        ],
        type: "Rewrites s1 s3",
      },
    },
  ];
  for (const [index, rewrite] of definition.rewrites
    .toSorted((left, right) =>
      leanRuleIdentifier(left.rule.label, left.rule.uid ?? "").localeCompare(
        leanRuleIdentifier(right.rule.label, right.rule.uid ?? ""),
      ),
    )
    .entries()) {
    const generated = constructorFor(definition, rewrite, index);
    diagnostics.push(...generated.diagnostics);
    if (generated.leanConstructor !== undefined) constructors.push(generated.leanConstructor);
  }
  return {
    text: renderLeanModule({
      imports: [funcImport],
      commands: [
        {
          tag: "inductive",
          identifier: leanIdentifier("Rewrites"),
          signature: { type: "SortGeneratedTopCell → SortGeneratedTopCell → Prop" },
          constructors,
        },
      ],
    }),
    diagnostics,
  };
}

export function generateRewritesModule(definition: KleanProjection, funcImport = "Func"): string {
  return generateRewrites(definition, funcImport).text;
}
