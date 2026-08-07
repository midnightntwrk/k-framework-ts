/**
 * Projection of K frontend GLR ambiguity applications over ordinary KORE
 * {@link Pattern}s.  `Lblamb` is not a KORE grammar variant: it is a symbol
 * emitted by the bison GLR parser and declared by K's `K-AMBIGUITIES` module.
 *
 * There is no pyk equivalent.  The model is measured at K v7.1.337 against
 * `k-distribution/include/kframework/{builtin/kast.md,cparser/main.c}` and
 * therefore keeps malformed external output as a typed refusal rather than
 * guessing what it means.
 */

import { demangleLabel, demangleSort } from "./demangle.js";
import { LBL_AMB, INJ } from "./prelude.js";
import { patterns } from "./syntax.js";
import type { App, Pattern, Sort } from "./syntax.js";

/** A well-formed GLR ambiguity node, projected without changing its terms. */
export interface KoreAmbiguity {
  readonly tag: "ambiguity";
  /** The one raw KORE sort parameter carried by `Lblamb`. */
  readonly sort: Sort;
  /** The K spelling of {@link sort}, when it has KORE's `Sort` prefix. */
  readonly sortName: string | undefined;
  /** Competing parses, with directly nested valid ambiguity nodes flattened. */
  readonly alternatives: readonly Pattern[];
  /** Each alternative's application head after shallow injection unwrapping. */
  readonly heads: readonly KoreAmbiguityHead[];
}

/** Raw KORE and demangled K names for one ambiguity alternative's head. */
export interface KoreAmbiguityHead {
  /** The raw KORE application symbol, absent when the alternative is not an application. */
  readonly symbol: string | undefined;
  /** `demangleLabel(symbol)`, absent for non-label or non-application heads. */
  readonly label: string | undefined;
}

/** A version-sensitive `Lblamb` shape this library deliberately does not interpret. */
export interface KoreAmbiguityRefusal {
  readonly tag: "refusal";
  readonly reason: "wrong-sort-arity" | "too-few-alternatives";
  /** The unmodified external node that was refused. */
  readonly pattern: App;
}

/** One document-order result from {@link findAmbiguities}. */
export type KoreAmbiguityResult = KoreAmbiguity | KoreAmbiguityRefusal;

/**
 * Remove consecutive well-formed `inj{From, To}(term)` wrappers only.
 *
 * This is intentionally shallow: it never descends into an application's
 * arguments.  A non-injection or malformed injection is returned unchanged,
 * so an external artifact cannot be silently repaired.  The loop is iterative
 * to accept arbitrarily many wrappers without consuming the call stack.
 */
export function unwrapInjections(pattern: Pattern): Pattern {
  let current = pattern;
  while (current.tag === "App" && current.symbol === INJ && current.sorts.length === 2 && current.args.length === 1) {
    const [argument] = current.args;
    if (argument === undefined) break;
    current = argument;
  }
  return current;
}

type AmbiguityShape =
  | { readonly tag: "ok"; readonly sort: Sort; readonly alternatives: readonly Pattern[] }
  | KoreAmbiguityRefusal;

function ambiguityShape(pattern: App): AmbiguityShape {
  if (pattern.sorts.length !== 1) return { tag: "refusal", reason: "wrong-sort-arity", pattern };
  const [sort] = pattern.sorts;
  if (sort === undefined) return { tag: "refusal", reason: "wrong-sort-arity", pattern };
  if (pattern.args.length < 2) return { tag: "refusal", reason: "too-few-alternatives", pattern };
  return { tag: "ok", sort, alternatives: pattern.args };
}

/** Flatten direct, valid `Lblamb` children while preserving their source order. */
function flattenAlternatives(alternatives: readonly Pattern[]): readonly Pattern[] {
  const result: Pattern[] = [];
  const stack: Pattern[] = alternatives.toReversed();
  for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
    if (current.tag === "App" && current.symbol === LBL_AMB) {
      const shape = ambiguityShape(current);
      if (shape.tag === "ok") {
        for (let index = shape.alternatives.length - 1; index >= 0; index -= 1) {
          const child = shape.alternatives[index];
          if (child !== undefined) stack.push(child);
        }
        continue;
      }
    }
    result.push(current);
  }
  return result;
}

function headOf(pattern: Pattern): KoreAmbiguityHead {
  const unwrapped = unwrapInjections(pattern);
  if (unwrapped.tag !== "App") return { symbol: undefined, label: undefined };
  return { symbol: unwrapped.symbol, label: demangleLabel(unwrapped.symbol) };
}

function sortName(sort: Sort): string | undefined {
  return sort.tag === "SortApp" ? demangleSort(sort.name) : undefined;
}

/**
 * Find GLR ambiguity applications in document order.
 *
 * K v7.1.337 emits binary, nested `Lblamb` applications; directly nested valid
 * nodes form one ambiguity and are flattened.  N-ary input is accepted for
 * forward compatibility.  An ambiguity deeper inside a non-ambiguity
 * alternative is reported separately.  Malformed `Lblamb` applications appear
 * as {@link KoreAmbiguityRefusal}s with the raw node retained.  No traversal is
 * recursive.
 */
export function findAmbiguities(pattern: Pattern): readonly KoreAmbiguityResult[] {
  const result: KoreAmbiguityResult[] = [];
  const stack: { readonly pattern: Pattern; readonly suppressValidAmbiguity: boolean }[] = [
    { pattern, suppressValidAmbiguity: false },
  ];

  for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
    const current = frame.pattern;
    let suppressChildren = false;
    if (current.tag === "App" && current.symbol === LBL_AMB) {
      const shape = ambiguityShape(current);
      if (shape.tag === "refusal") result.push(shape);
      else {
        if (!frame.suppressValidAmbiguity) {
          const alternatives = flattenAlternatives(shape.alternatives);
          result.push({
            tag: "ambiguity",
            sort: shape.sort,
            sortName: sortName(shape.sort),
            alternatives,
            heads: alternatives.map((alternative) => headOf(alternative)),
          });
        }
        // A directly nested ambiguity is part of the nearest reported
        // ambiguity at every depth. Keep suppressing while the traversal stays
        // in that direct chain; crossing an ordinary alternative resets it.
        suppressChildren = true;
      }
    }

    const children = patterns(current);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child !== undefined) stack.push({ pattern: child, suppressValidAmbiguity: suppressChildren });
    }
  }
  return result;
}
