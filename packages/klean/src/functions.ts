/**
 * `Func.lean`: Option-valued K functions, one Lean `def` per equation —
 * pyk `klean/k2lean4.py:553-627` and `:901-916`, at K `v7.1.337`
 * (`737f5d6295f9f69ffd4ff41ef22f22557387988314b17eacfc5f3ee4cb062dc4`).
 *
 * A K function becomes `A → B → Option R`: one `def` per equation, tried in
 * priority order by a dispatcher `f x0 x1 := (rule1 x0 x1) <|> (rule2 x0 x1)`
 * (`k2lean4.py:580-608`).  Everything hard lives in the equation bodies:
 *
 * - matching-logic left-hand sides that Lean's `match` cannot express go
 *   through the matcher hierarchy in `./matchers.ts`
 *   (`k2lean4.py:610-627, 644-742`);
 * - nested Option-valued calls in `requires`/`rhs` are hoisted into an
 *   `Option`-monad `do` block, which is how a partial function calls another
 *   (`_elim_fun_apps` + `_func_rule_rhs`, `k2lean4.py:629-642, 744-754`);
 * - declarations are emitted in dependency-first SCC order over functions
 *   *and* equations, and a component with more than one member becomes a Lean
 *   `mutual` block (`k2lean4.py:553-568`), because Lean has no forward
 *   references;
 * - anything that transitively uses an `axiom` is marked `noncomputable`
 *   (`k2lean4.py:334-349, 606, 619`), which Lean requires and never infers.
 *
 * Deviations from pyk, all deliberate:
 *
 * - pyk asserts on anything it cannot lower; this package's contract is that
 *   an unsupported construct becomes a typed diagnostic and the containing
 *   function degrades to an explicit, manifest-listed `axiom`.  Since an
 *   axiomatized function is an unchecked assumption, every use of the fallback
 *   is reported rather than silently taken.
 * - pyk will emit a rule whose right-hand side mentions a variable no pattern
 *   binds, and the result does not elaborate.  {@link unboundRuleVariables}
 *   refuses such a rule, so a missing matcher shape surfaces as an audited
 *   axiom instead of a broken Lean file.
 * - pyk asserts a multi-equation function is not nullary (`k2lean4.py:598`);
 *   a nullary one is dispatched as `(r1) <|> (r2)` here.
 * - pyk's signature path reads `sort.name` off any `Sort`, silently dropping
 *   the arguments of a parametric `SortApp` (`k2lean4.py:613, 908`).
 *   {@link functionSignature} accepts a `SortVar` or a parameterless
 *   `SortApp` and reports anything else rather than mistyping a declaration.
 */

import {
  bottomUp,
  eliminateAliases,
  freeOccurrences,
  inferSort,
  type App,
  type Pattern,
  type SymbolDecl,
} from "@kframework-ts/kore";

import {
  compareText,
  functionRuleDependencyGraph,
  functionRuleNode,
  propagateNoncomputable,
  stableTopologicalSccs,
  structurallyAxiomaticFunctions,
} from "./analysis.js";
import {
  indentLean,
  leanIdentifier,
  renderLeanModule,
  type LeanBinder,
  type LeanCommand,
  type LeanDeclaration,
  type LeanDeclarationValue,
} from "./lean.js";
import { lowerKoreArgument, lowerKorePattern, type LoweringDiagnostic, type LoweringResult } from "./lower.js";
import {
  functionRuleMatchers,
  isExhaustive,
  matcherOutputs,
  matcherTerms,
  plainSortName,
  type KleanMatcher,
  type MatcherDefinition,
  type MatcherTerms,
} from "./matchers.js";
import { leanRuleIdentifier, leanSymbolIdentifier, leanVariableIdentifier } from "./names.js";
import { PRELUDE_FUNCTIONS } from "./prelude.js";
import type { KleanDiagnostic, KleanEquation, KleanProjection } from "./projection.js";
import { structureFields, structureSymbols } from "./sorts.js";

/**
 * Re-exported for compatibility: the set moved to `./prelude.js`, whose asset
 * is what actually defines these functions, so the dependency analysis can
 * read it without importing this module.
 */
export { PRELUDE_FUNCTIONS } from "./prelude.js";

/** The prefix pyk gives the `do` block's own hoisted bindings (`k2lean4.py:637`). */
const HOISTED_VARIABLE_PREFIX = "Var'Unds'Val";

export interface FunctionsModule {
  readonly text: string;
  readonly diagnostics: readonly KleanDiagnostic[];
  readonly axiomaticFunctions: readonly string[];
}

/** A function signature split the way both pyk emitters need it. */
interface FunctionSignature {
  /** Sort parameters of a parametric symbol, rendered as `{S : Type}`. */
  readonly sortParams: readonly string[];
  readonly paramSorts: readonly string[];
  readonly sort: string;
}

/** One hoisted Option-valued call: `let <identifier> <- <application>`. */
interface HoistedCall {
  readonly identifier: string;
  readonly application: Pattern;
}

/** A single equation compiled to a Lean declaration, or the reason it was not. */
interface LoweredEquation {
  readonly node: string;
  readonly name: string;
  readonly priority: number;
  readonly declaration: LeanDeclaration | undefined;
  readonly diagnostics: readonly KleanDiagnostic[];
}

/**
 * pyk `_func_signature` (`k2lean4.py:906-916`) plus the sort-parameter
 * handling `_func_rule_def` needs (`k2lean4.py:612-618`).
 */
function functionSignature(declaration: SymbolDecl): FunctionSignature | undefined {
  const sortParams = declaration.symbol.vars.map((variable) => variable.name);
  const paramSorts = declaration.paramSorts.map(plainSortName);
  const sort = plainSortName(declaration.sort);
  if (sort === undefined || !paramSorts.every((name): name is string => name !== undefined)) return undefined;
  return { sortParams, paramSorts, sort };
}

/** The `{S : Type}` binder a parametric symbol carries — pyk `k2lean4.py:617, 912-913`. */
function sortParamBinders(signature: FunctionSignature): readonly LeanBinder[] {
  return signature.sortParams.length === 0
    ? []
    : [{ tag: "implicit", identifiers: signature.sortParams, type: "Type" }];
}

function ruleName(equation: KleanEquation, index: number): string {
  return leanRuleIdentifier(equation.rule.label, equation.rule.uid ?? `equation${index}`);
}

function diagnosticsFromLowering(
  items: readonly LoweringDiagnostic[],
  symbol: string,
  severity: KleanDiagnostic["severity"],
): KleanDiagnostic[] {
  return items.map((item) => ({ severity, code: item.code, message: item.message, symbol }));
}

/** pyk `_extract_func_rule` step 1 (`k2lean4.py:630-634`). */
function normalizeEquation(
  equation: KleanEquation,
): { readonly requires: Pattern | undefined; readonly lhs: App; readonly rhs: Pattern } | undefined {
  const top: Pattern = { tag: "Top", sort: equation.rule.sort };
  // pyk bundles `requires`, `lhs` and `rhs` into one conjunction so an alias
  // found in any of them is substituted through all three. The ternary arity
  // also keeps `eliminateAliases` from reading the bundle itself as an alias,
  // which it would for a binary `(term, variable)` conjunction.
  const bundled = eliminateAliases({
    tag: "And",
    sort: equation.rule.sort,
    patterns: [equation.rule.requires ?? top, equation.rule.lhs, equation.rule.rhs],
  });
  if (bundled.tag !== "And") return undefined;
  const [requires, lhs, rhs] = bundled.patterns;
  if (lhs?.tag !== "App" || rhs === undefined) return undefined;
  return { requires: equation.rule.requires === undefined ? undefined : requires, lhs, rhs };
}

/**
 * Hoist every Option-valued call out of a pattern — pyk `_elim_fun_apps`
 * (`k2lean4.py:975-988`).
 *
 * `foo(bar(x))` becomes the variable `_Val1` plus the bindings
 * `{_Val0: bar(x), _Val1: foo(_Val0)}`; the bottom-up order is what puts the
 * inner call's binding before the outer one's, so the `do` block type-checks.
 */
function hoistFunctionCalls(
  definition: MatcherDefinition,
  pattern: Pattern,
): { readonly pattern: Pattern; readonly calls: readonly HoistedCall[] } {
  const calls: HoistedCall[] = [];
  const rewritten = bottomUp(pattern, (node) => {
    if (node.tag !== "App" || !definition.equations.has(node.symbol)) return node;
    const sort = inferSort(definition.symbols, node);
    if (sort === undefined) return node;
    const name = `${HOISTED_VARIABLE_PREFIX}${calls.length}`;
    calls.push({ identifier: leanVariableIdentifier(name), application: node });
    return { tag: "EVar", name, sort };
  });
  return { pattern: rewritten, calls };
}

/** Compile one function equation — pyk `_func_rule_def` (`k2lean4.py:610-627`). */
function lowerEquation(
  definition: MatcherDefinition,
  signature: FunctionSignature,
  symbol: string,
  equation: KleanEquation,
  index: number,
): LoweredEquation {
  const node = functionRuleNode(symbol, equation, index);
  const name = ruleName(equation, index);
  const base = { node, name, priority: equation.rule.priority, declaration: undefined } as const;

  const normalized = normalizeEquation(equation);
  if (normalized === undefined)
    return {
      ...base,
      diagnostics: [
        {
          severity: "error",
          code: "unsupported-alias",
          message: `Could not normalize equation ${name} of ${symbol}`,
          symbol,
        },
      ],
    };

  // pyk `_extract_func_rule` step 2 (`k2lean4.py:637-640`): only `requires`
  // and `rhs` are abstracted; the left-hand side is matched, not evaluated.
  const top: Pattern = { tag: "Top", sort: equation.rule.sort };
  const hoisted = hoistFunctionCalls(definition, {
    tag: "And",
    sort: equation.rule.sort,
    patterns: [normalized.requires ?? top, normalized.rhs],
  });
  const [hoistedRequires = top, hoistedRhs] = hoisted.pattern.tag === "And" ? hoisted.pattern.patterns : [];
  if (hoistedRhs === undefined)
    return {
      ...base,
      diagnostics: [
        {
          severity: "error",
          code: "unsupported-pattern",
          message: `Could not hoist nested function applications out of equation ${name} of ${symbol}`,
          symbol,
        },
      ],
    };

  const matchers = functionRuleMatchers(definition, normalized.lhs);
  if (matchers.diagnostics.length > 0)
    return { ...base, diagnostics: diagnosticsFromLowering(matchers.diagnostics, symbol, "warning") };

  const unbound = unboundRuleVariables(matchers.args, matchers.generations, [
    hoistedRequires,
    hoistedRhs,
    ...hoisted.calls.map((call) => call.application),
  ]);
  if (unbound.length > 0)
    return {
      ...base,
      diagnostics: [
        {
          severity: "warning",
          code: "axiomatic-function-equation",
          message: `Equation ${name} of ${symbol} uses ${unbound.join(", ")} without a left-hand-side binding; no implemented matcher covers this shape, so the containing function is emitted as an axiom.`,
          symbol,
        },
      ],
    };

  const lowered: LoweringDiagnostic[] = [];
  const take = (result: LoweringResult): string | undefined => {
    lowered.push(...result.diagnostics);
    return result.term;
  };

  const argumentPatterns = matchers.args.map((argument, argumentIndex) =>
    take(lowerKorePattern(definition, argument, { concreteInjections: true }, [`lhs[${argumentIndex}]`])),
  );
  const body = ruleBody(definition, hoistedRequires, hoistedRhs, hoisted.calls, take);
  const generations = matchers.generations.map((generation) =>
    generation.map((matcher) => {
      const result = matcherTerms(definition, matcher, ["lhs"]);
      lowered.push(...result.diagnostics);
      return result.terms;
    }),
  );

  const patterns = argumentPatterns.filter((pattern): pattern is string => pattern !== undefined);
  const terms = generations.map((generation) =>
    generation.filter((entry): entry is MatcherTerms => entry !== undefined),
  );
  if (
    patterns.length !== argumentPatterns.length ||
    body === undefined ||
    terms.some((generation, generationIndex) => generation.length !== generations[generationIndex]?.length)
  )
    return { ...base, diagnostics: diagnosticsFromLowering(lowered, symbol, "error") };

  const binders = sortParamBinders(signature);
  return {
    node,
    name,
    priority: equation.rule.priority,
    declaration: {
      tag: "definition",
      identifier: leanIdentifier(name),
      signature: {
        ...(binders.length === 0 ? {} : { binders }),
        type: [...signature.paramSorts, `Option ${signature.sort}`].join(" → "),
      },
      value: ruleValue(definition, matchers.args, patterns, nestGenerations(terms, body)),
    },
    diagnostics: diagnosticsFromLowering(lowered, symbol, "warning"),
  };
}

/** pyk `_func_rule_val` (`k2lean4.py:644-667`). */
function ruleValue(
  definition: MatcherDefinition,
  args: readonly Pattern[],
  patterns: readonly string[],
  term: string,
): LeanDeclarationValue {
  if (args.length === 0) return { tag: "simple", term };
  const alternatives = [{ patterns, rhs: term }];
  // Only a non-exhaustive head needs pyk's catch-all; adding one to an
  // exhaustive match makes Lean reject the alternative as unreachable.
  if (!args.every((argument) => isExhaustive(definition, argument)))
    alternatives.push({ patterns: args.map(() => "_"), rhs: "none" });
  return { tag: "alternatives", alternatives };
}

/** pyk `_func_rule_rhs` (`k2lean4.py:744-754`). */
function ruleBody(
  definition: MatcherDefinition,
  requires: Pattern,
  rhs: Pattern,
  calls: readonly HoistedCall[],
  take: (result: LoweringResult) => string | undefined,
): string | undefined {
  const conditional = requires.tag !== "Top";
  if (calls.length === 0 && !conditional) {
    const term = take(lowerKoreArgument(definition, rhs, {}, ["rhs"]));
    return term === undefined ? undefined : `some ${term}`;
  }
  const lines: string[] = [];
  for (const call of calls) {
    const term = take(lowerKorePattern(definition, call.application, {}, ["let"]));
    if (term === undefined) return undefined;
    lines.push(`let ${call.identifier} <- ${term}`);
  }
  if (conditional) {
    const term = take(lowerKoreArgument(definition, requires, {}, ["requires"]));
    if (term === undefined) return undefined;
    lines.push(`guard ${term}`);
  }
  const result = take(lowerKoreArgument(definition, rhs, {}, ["rhs"]));
  if (result === undefined) return undefined;
  lines.push(`return ${result}`);
  return `do\n${lines.map((line) => `  ${line}`).join("\n")}`;
}

/** pyk `_func_rule_term` (`k2lean4.py:669-687`): one nested `match` per generation. */
function nestGenerations(generations: readonly (readonly MatcherTerms[])[], body: string): string {
  let result = body;
  for (let index = generations.length - 1; index >= 0; index -= 1) {
    const generation = generations[index];
    if (generation === undefined || generation.length === 0) continue;
    result = [
      `match ${generation.map((terms) => terms.scrutinee).join(", ")} with`,
      `  | ${generation.map((terms) => terms.pattern).join(", ")} => ${indentAfterFirstLine(result, 2)}`,
      `  | ${generation.map(() => "_").join(", ")} => none`,
    ].join("\n");
  }
  return result;
}

/** pyk's `indent_rest` (`k2lean4.py:670-672`): the first line is already placed. */
function indentAfterFirstLine(text: string, spaces: number): string {
  const [first = "", ...rest] = text.split("\n");
  return rest.length === 0 ? first : `${first}\n${indentLean(rest.join("\n"), spaces)}`;
}

/**
 * Variables a rule body reads that nothing on its left-hand side binds.
 *
 * No pyk counterpart: upstream emits the rule anyway and the generated Lean
 * fails to elaborate.  Here it means the left-hand side needed a matcher shape
 * that is not implemented, so the honest output is a reported axiom.
 */
function unboundRuleVariables(
  args: readonly Pattern[],
  generations: readonly (readonly KleanMatcher[])[],
  used: readonly Pattern[],
): readonly string[] {
  const bound = new Set<string>();
  for (const argument of args)
    for (const name of freeOccurrences(argument).keys()) bound.add(leanVariableIdentifier(name));
  for (const generation of generations)
    for (const matcher of generation)
      for (const variable of matcherOutputs(matcher)) bound.add(leanVariableIdentifier(variable.name));

  const missing = new Set<string>();
  for (const pattern of used)
    for (const name of freeOccurrences(pattern).keys()) {
      // `Var'Unds'Val…` are the `do` block's own bindings, not KORE variables.
      if (name.startsWith(HOISTED_VARIABLE_PREFIX)) continue;
      const identifier = leanVariableIdentifier(name);
      if (!bound.has(identifier)) missing.add(identifier);
    }
  return [...missing].toSorted(compareText);
}

/**
 * Generate `Func.lean`, retaining every unsupported function as an explicit axiom.
 *
 * pyk `func_module` (`k2lean4.py:553-578`), with one extra step: which
 * functions actually lower is decided *before* the module is laid out, because
 * that decision feeds both the axiom set and the `noncomputable` propagation.
 */
export function generateFunctions(definition: KleanProjection, injImport = "Inj"): FunctionsModule {
  const lowering: MatcherDefinition = {
    symbols: definition.symbols,
    constructors: definition.constructors,
    structureSymbols: structureSymbols(definition),
    structures: structureFields(definition),
    subsorts: definition.subsorts,
    collections: definition.collections,
    equations: definition.equations,
  };

  const diagnostics: KleanDiagnostic[] = [];
  const axiomatic = new Set<string>();
  const signatures = new Map<string, FunctionSignature>();
  const loweredByFunction = new Map<string, readonly LoweredEquation[]>();
  const declarationByNode = new Map<string, LeanDeclaration>();

  for (const [symbol, equations] of [...definition.equations.entries()].toSorted(([left], [right]) =>
    compareText(left, right),
  )) {
    if (PRELUDE_FUNCTIONS.has(symbol)) continue;
    const declaration = definition.symbols.get(symbol);
    const signature = declaration === undefined ? undefined : functionSignature(declaration);
    if (signature === undefined) {
      diagnostics.push({
        severity: "error",
        code: "unsupported-function-signature",
        message: `Cannot emit function ${symbol}: its declaration is missing, or a parameter or result sort is a parametric sort application`,
        symbol,
      });
      continue;
    }
    signatures.set(symbol, signature);

    const lowered = equations.map((equation, index) => lowerEquation(lowering, signature, symbol, equation, index));
    loweredByFunction.set(symbol, lowered);
    for (const item of lowered) diagnostics.push(...item.diagnostics);

    if (equations.length === 0 || lowered.some((item) => item.declaration === undefined)) {
      if (equations.length > 0)
        diagnostics.push({
          severity: "warning",
          code: "axiomatic-function",
          message: `Function ${symbol} has ${equations.length} equation(s) but at least one did not lower; it is emitted as an axiom rather than a partial definition`,
          symbol,
        });
      axiomatic.add(symbol);
      continue;
    }
    for (const item of lowered) if (item.declaration !== undefined) declarationByNode.set(item.node, item.declaration);
  }

  const graph = functionRuleDependencyGraph(definition);
  const sccs = stableTopologicalSccs(graph, compareText);
  const noncomputable = propagateNoncomputable(
    graph,
    sccs,
    new Set<string>([...structurallyAxiomaticFunctions(definition), ...axiomatic]),
  );

  const commands: LeanCommand[] = [];
  for (const scc of sccs) {
    const block: LeanDeclaration[] = [];
    for (const node of scc) {
      const command = commandFor(definition, node, {
        signatures,
        loweredByFunction,
        declarationByNode,
        axiomatic,
        noncomputable,
      });
      if (command !== undefined) block.push(command);
    }
    if (block.length === 1) {
      const [only] = block;
      if (only === undefined) throw new Error("Single-declaration function block is missing its declaration");
      commands.push(only);
    } else if (block.length > 1) commands.push({ tag: "mutual", commands: block });
  }

  return {
    text: renderLeanModule({ imports: [injImport], commands }),
    diagnostics,
    axiomaticFunctions: [...axiomatic].toSorted(compareText),
  };
}

interface EmissionState {
  readonly signatures: ReadonlyMap<string, FunctionSignature>;
  readonly loweredByFunction: ReadonlyMap<string, readonly LoweredEquation[]>;
  readonly declarationByNode: ReadonlyMap<string, LeanDeclaration>;
  readonly axiomatic: ReadonlySet<string>;
  readonly noncomputable: ReadonlySet<string>;
}

/** pyk `_func_command` (`k2lean4.py:570-578`): a node is a function or one of its equations. */
function commandFor(definition: KleanProjection, node: string, state: EmissionState): LeanDeclaration | undefined {
  if (!definition.equations.has(node)) {
    const declaration = state.declarationByNode.get(node);
    if (declaration === undefined) return undefined;
    return state.noncomputable.has(node) ? withNoncomputable(declaration) : declaration;
  }
  if (PRELUDE_FUNCTIONS.has(node)) return undefined;
  const signature = state.signatures.get(node);
  if (signature === undefined) return undefined;

  const identifier = leanIdentifier(leanSymbolIdentifier(node));
  const binders: LeanBinder[] = [
    ...sortParamBinders(signature),
    ...signature.paramSorts.map((type, index) => ({
      tag: "explicit" as const,
      identifiers: [`x${index}`],
      type,
    })),
  ];
  const type = `Option ${signature.sort}`;
  const names = dispatchOrder(state.loweredByFunction.get(node) ?? []);
  // pyk `_func_axiom` (`k2lean4.py:901-904`) carries no `noncomputable`: an
  // `axiom` has no body to compile.
  if (state.axiomatic.has(node) || names.length === 0)
    return { tag: "axiom", identifier, signature: { binders, type } };

  const argumentNames = signature.paramSorts.map((_, index) => `x${index}`);
  const call = (name: string): string => (argumentNames.length === 0 ? name : `${name} ${argumentNames.join(" ")}`);
  const [first] = names;
  const term =
    names.length === 1 && first !== undefined ? call(first) : names.map((name) => `(${call(name)})`).join(" <|> ");
  const declaration: LeanDeclaration = {
    tag: "definition",
    identifier,
    signature: { binders, type },
    value: { tag: "simple", term },
  };
  return state.noncomputable.has(node) ? withNoncomputable(declaration) : declaration;
}

/** pyk `sort_rules_by_priority` (`k2lean4.py:581-586`): by priority, then by name. */
function dispatchOrder(lowered: readonly LoweredEquation[]): readonly string[] {
  return lowered
    .toSorted((left, right) => left.priority - right.priority || compareText(left.name, right.name))
    .map((item) => item.name);
}

function withNoncomputable(declaration: LeanDeclaration): LeanDeclaration {
  return { ...declaration, modifiers: { ...declaration.modifiers, noncomputable: true } };
}

/** Convenience when only the generated Lean source is wanted. */
export function generateFunctionsModule(definition: KleanProjection, injImport = "Inj"): string {
  return generateFunctions(definition, injImport).text;
}
