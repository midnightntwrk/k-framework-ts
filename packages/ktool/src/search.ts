/** Pure, explicit-mode decoders for `krun --search-final` output.
 *
 * K does not promise this wire shape.  These functions model the forms measured
 * at K v7.1.337 and deliberately return the offending term for anything else;
 * they never infer whether `--no-pattern` was present from a result.
 */

import type { KApply, KInner } from "@kframework-ts/kast";
import { disjuncts, koreText, type Pattern } from "@kframework-ts/kore";

export interface SearchSolution {
  readonly bindings: ReadonlyMap<string, KInner>;
}

export interface KoreSearchSolution {
  readonly bindings: ReadonlyMap<string, Pattern>;
}

export type SearchDecodeError<T> =
  | { readonly tag: "trivial"; readonly at: T }
  | { readonly tag: "unrecognised"; readonly at: T };

export type SearchDecoded<T, U = unknown> =
  | { readonly tag: "solutions"; readonly solutions: readonly T[] }
  | { readonly tag: "error"; readonly error: SearchDecodeError<U> };

export type SearchConfigurations<T> =
  | { readonly tag: "configurations"; readonly configurations: readonly T[] }
  | { readonly tag: "error"; readonly error: SearchDecodeError<T> };

/** Decode the pattern-matched KAST result (`--no-pattern` is false). */
export function decodeSearchResult(term: KInner): SearchDecoded<SearchSolution, KInner> {
  if (isMlNullary(term, "#Top")) return { tag: "error", error: { tag: "trivial", at: term } };
  const solutions: SearchSolution[] = [];
  for (const leaf of kastDisjuncts(term)) {
    const bindings = decodeKastBindings(leaf);
    if (bindings === undefined) return { tag: "error", error: { tag: "unrecognised", at: leaf } };
    solutions.push({ bindings });
  }
  return { tag: "solutions", solutions: dedupKastSolutions(solutions) };
}

/** Decode the KAST result when the caller used `--no-pattern`. */
export function decodeSearchConfigurations(term: KInner): SearchConfigurations<KInner> {
  if (isMlNullary(term, "#Top")) return { tag: "error", error: { tag: "trivial", at: term } };
  return { tag: "configurations", configurations: kastDisjuncts(term) };
}

/** KORE-side twin of {@link decodeSearchResult}. */
export function decodeSearchResultKore(pattern: Pattern): SearchDecoded<KoreSearchSolution, Pattern> {
  if (pattern.tag === "Top") return { tag: "error", error: { tag: "trivial", at: pattern } };
  const solutions: KoreSearchSolution[] = [];
  for (const leaf of disjuncts(pattern)) {
    const bindings = decodeKoreBindings(leaf);
    if (bindings === undefined) return { tag: "error", error: { tag: "unrecognised", at: leaf } };
    solutions.push({ bindings });
  }
  return { tag: "solutions", solutions: dedupKoreSolutions(solutions) };
}

/** KORE-side twin for the explicit `--no-pattern` mode. */
export function decodeSearchConfigurationsKore(pattern: Pattern): SearchConfigurations<Pattern> {
  if (pattern.tag === "Top") return { tag: "error", error: { tag: "trivial", at: pattern } };
  return { tag: "configurations", configurations: disjuncts(pattern) };
}

function isLabel(term: KInner, label: string): term is KApply {
  return term.node === "KApply" && term.label.name === label;
}

function isMlNullary(term: KInner, label: "#Top" | "#Bottom"): boolean {
  // Hand-built KAST terms historically omit ML sort parameters; accept that
  // representation while still refusing malformed multi-parameter nullaries.
  return isLabel(term, label) && term.args.length === 0 && term.label.params.length <= 1;
}

function kastDisjuncts(term: KInner): readonly KInner[] {
  if (isMlNullary(term, "#Bottom")) return [];
  const result: KInner[] = [];
  const stack: KInner[] = [term];
  let rootSort: string | undefined;
  let rootSortKnown = false;
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    if (isMlNullary(item, "#Bottom")) continue;
    if (item.node === "KApply" && item.label.name === "#Or") {
      const parameter = item.label.params[0]?.name;
      if (item.label.params.length <= 1 && item.args.length > 0) {
        if (!rootSortKnown) {
          rootSort = parameter;
          rootSortKnown = true;
        }
        if (rootSort !== parameter) {
          result.push(item);
          continue;
        }
        for (let i = item.args.length - 1; i >= 0; i -= 1) {
          const child = item.args[i];
          if (child !== undefined) stack.push(child);
        }
        continue;
      }
    }
    result.push(item);
  }
  return result;
}

function decodeKastBindings(term: KInner): ReadonlyMap<string, KInner> | undefined {
  const terms: KInner[] = [];
  const stack = [term];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    if (isLabel(item, "#And")) {
      for (let i = item.args.length - 1; i >= 0; i -= 1) {
        const child = item.args[i];
        if (child !== undefined) stack.push(child);
      }
    } else terms.push(item);
  }
  const bindings = new Map<string, KInner>();
  for (const item of terms) {
    if (!isLabel(item, "#Equals") || item.args.length !== 2) return undefined;
    const [left, right] = item.args;
    if (left?.node !== "KVariable" || right === undefined || bindings.has(left.name)) return undefined;
    bindings.set(left.name, right);
  }
  return bindings;
}

function decodeKoreBindings(pattern: Pattern): ReadonlyMap<string, Pattern> | undefined {
  const bindings = new Map<string, Pattern>();
  const stack: Pattern[] = [pattern];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    if (item.tag === "And") {
      for (let i = item.patterns.length - 1; i >= 0; i -= 1) {
        const child = item.patterns[i];
        if (child !== undefined) stack.push(child);
      }
      continue;
    }
    if (item.tag !== "Equals" || item.left.tag !== "EVar" || bindings.has(item.left.name)) return undefined;
    bindings.set(item.left.name, item.right);
  }
  return bindings;
}

// K normally deduplicates search states before rendering. Retain that observed
// semantic when a synthetic/nonnormal output repeats a complete substitution;
// this is structural serialization, not a kast-json equality dependency.
function dedupKastSolutions(solutions: readonly SearchSolution[]): readonly SearchSolution[] {
  const seen = new Set<string>();
  return solutions.filter((solution) => {
    const key = JSON.stringify([...solution.bindings.entries()]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupKoreSolutions(solutions: readonly KoreSearchSolution[]): readonly KoreSearchSolution[] {
  const seen = new Set<string>();
  return solutions.filter((solution) => {
    const key = [...solution.bindings.entries()].map(([name, value]) => `${name}=${koreText(value)}`).join("\u0000");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
