/** KORE pattern lowering shared by the generated Lean modules. */

import type { App, Pattern, Sort, SymbolDecl } from "@kframework-ts/kore";

import { leanSymbolIdentifier, leanVariableIdentifier, renderDomainValue } from "./names.js";

/** A diagnostic which describes a semantic omission rather than hiding it in generated Lean. */
export interface LoweringDiagnostic {
  readonly code: "unsupported-pattern" | "unsupported-domain-value" | "unknown-symbol" | "unsupported-alias";
  readonly message: string;
  readonly path: readonly string[];
}

export interface LoweringResult {
  readonly term: string | undefined;
  readonly diagnostics: readonly LoweringDiagnostic[];
}

/** The portion of a projected definition that the local lowering needs. */
export interface LoweringDefinition {
  readonly symbols: ReadonlyMap<string, SymbolDecl>;
  /** constructor symbol names indexed by result sort name. */
  readonly constructors: ReadonlyMap<string, readonly string[]>;
  /** structure constructor symbol names indexed by result sort name. */
  readonly structureSymbols?: ReadonlyMap<string, readonly string[]>;
  /** field names and types indexed by a structure sort. */
  readonly structures?: ReadonlyMap<string, readonly LoweringField[]>;
}

export interface LoweringField {
  readonly name: string;
  readonly type: string;
}

export interface LoweringOptions {
  /** Select concrete constructors rather than typeclass-mediated injections. */
  readonly concreteInjections?: boolean;
}

function sortName(sort: Sort): string | undefined {
  return sort.tag === "SortApp" && sort.sorts.length === 0 ? sort.name : undefined;
}

function childResult(results: readonly LoweringResult[]): LoweringDiagnostic[] {
  return results.flatMap((result) => result.diagnostics);
}

function diagnostic(code: LoweringDiagnostic["code"], message: string, path: readonly string[]): LoweringResult {
  return { term: undefined, diagnostics: [{ code, message, path }] };
}

function parenthesize(term: string, pattern: Pattern): string {
  return pattern.tag === "App" && pattern.args.length > 0 ? `(${term})` : term;
}

function lowerApplication(
  definition: LoweringDefinition,
  pattern: App,
  options: LoweringOptions,
  path: readonly string[],
): LoweringResult {
  if (pattern.symbol === "inj") {
    if (pattern.sorts.length !== 2 || pattern.args.length !== 1) {
      return diagnostic("unsupported-pattern", "inj must have two sorts and one argument", path);
    }
    const [from, to] = pattern.sorts;
    const [argument] = pattern.args;
    const fromName = from === undefined ? undefined : sortName(from);
    const toName = to === undefined ? undefined : sortName(to);
    if (fromName === undefined || toName === undefined || argument === undefined) {
      return diagnostic("unsupported-pattern", "parametric injection sorts are not supported", path);
    }
    const lowered = lowerKorePattern(definition, argument, options, [...path, "inj"]);
    if (lowered.term === undefined) return lowered;
    const argumentTerm = parenthesize(lowered.term, argument);
    const head = options.concreteInjections === true ? `${toName}.inj_${fromName}` : `(@inj ${fromName} ${toName})`;
    return { term: `${head} ${argumentTerm}`, diagnostics: lowered.diagnostics };
  }

  const declaration = definition.symbols.get(pattern.symbol);
  if (declaration === undefined) {
    return diagnostic("unknown-symbol", `KORE symbol is not in projected definition: ${pattern.symbol}`, path);
  }
  const loweredArgs = pattern.args.map((arg, index) =>
    lowerKorePattern(definition, arg, options, [...path, `${pattern.symbol}[${index}]`]),
  );
  const diagnostics = childResult(loweredArgs);
  if (loweredArgs.some((arg) => arg.term === undefined)) return { term: undefined, diagnostics };

  const resultSort = sortName(declaration.sort);
  const constructors = resultSort === undefined ? undefined : definition.constructors.get(resultSort);
  const structureSymbols = resultSort === undefined ? undefined : definition.structureSymbols?.get(resultSort);
  const fields = resultSort === undefined ? undefined : definition.structures?.get(resultSort);
  if (structureSymbols?.includes(pattern.symbol) === true && fields !== undefined) {
    if (fields.length !== loweredArgs.length) {
      return diagnostic("unsupported-pattern", `structure ${resultSort} has an unexpected arity`, path);
    }
    const assignments = fields.map((field, index) => `${field.name} := ${loweredArgs[index]?.term ?? "_"}`);
    return { term: `{ ${assignments.join(", ")} }`, diagnostics };
  }
  const name =
    constructors?.includes(pattern.symbol) && resultSort !== undefined
      ? `${resultSort}.${leanSymbolIdentifier(pattern.symbol)}`
      : leanSymbolIdentifier(pattern.symbol);
  const renderedArgs = pattern.args.map((argument, index) => {
    const lowered = loweredArgs[index];
    if (lowered?.term === undefined) throw new Error("Lowered KORE application argument unexpectedly disappeared");
    return parenthesize(lowered.term, argument);
  });
  return { term: [name, ...renderedArgs].join(" "), diagnostics };
}

/**
 * Lower the supported executable KORE fragment to a Lean term.  This is deliberately
 * total: unsupported matching-logic patterns become diagnostics, never fabricated terms.
 */
export function lowerKorePattern(
  definition: LoweringDefinition,
  pattern: Pattern,
  options: LoweringOptions = {},
  path: readonly string[] = [],
): LoweringResult {
  switch (pattern.tag) {
    case "EVar":
      return { term: leanVariableIdentifier(pattern.name), diagnostics: [] };
    case "DV": {
      const name = sortName(pattern.sort);
      if (name === undefined)
        return diagnostic("unsupported-domain-value", "parametric domain values are not supported", path);
      const rendered = renderDomainValue(name, pattern.value.value);
      return rendered === undefined
        ? diagnostic("unsupported-domain-value", `unsupported domain value sort: ${name}`, path)
        : { term: rendered, diagnostics: [] };
    }
    case "App":
      return lowerApplication(definition, pattern, options, path);
    case "And":
    case "Or": {
      if (sortName(pattern.sort) !== "SortBool")
        return diagnostic("unsupported-pattern", `${pattern.tag} is only supported at SortBool`, path);
      const operands = pattern.patterns.map((operand, index) =>
        lowerKoreArgument(definition, operand, options, [...path, `${pattern.tag}[${index}]`]),
      );
      const diagnostics = childResult(operands);
      if (operands.some((operand) => operand.term === undefined)) return { term: undefined, diagnostics };
      const operator = pattern.tag === "And" ? "&&" : "||";
      const identity = pattern.tag === "And" ? "true" : "false";
      const terms: string[] = [];
      for (const operand of operands) {
        if (operand.term === undefined) throw new Error("Lowered Boolean operand unexpectedly disappeared");
        terms.push(operand.term);
      }
      return { term: terms.length === 0 ? identity : terms.join(` ${operator} `), diagnostics };
    }
    case "Equals": {
      const left = lowerKoreArgument(definition, pattern.left, options, [...path, "equals.left"]);
      const right = lowerKoreArgument(definition, pattern.right, options, [...path, "equals.right"]);
      const diagnostics = [...left.diagnostics, ...right.diagnostics];
      return left.term === undefined || right.term === undefined
        ? { term: undefined, diagnostics }
        : { term: `${left.term} == ${right.term}`, diagnostics };
    }
    case "SVar":
      return diagnostic("unsupported-pattern", "set variables are not supported by KLean", path);
    case "String":
      return diagnostic("unsupported-pattern", "bare KORE strings are not executable terms", path);
    default:
      return diagnostic("unsupported-pattern", `unsupported KORE pattern: ${pattern.tag}`, path);
  }
}

/** Lower a term in an argument position, adding Lean parentheses where needed. */
export function lowerKoreArgument(
  definition: LoweringDefinition,
  pattern: Pattern,
  options: LoweringOptions = {},
  path: readonly string[] = [],
): LoweringResult {
  const result = lowerKorePattern(definition, pattern, options, path);
  return result.term === undefined ? result : { ...result, term: parenthesize(result.term, pattern) };
}
