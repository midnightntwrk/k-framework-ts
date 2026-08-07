/**
 * Term-manipulation helpers over {@link Pattern} — pyk `kore/manip.py`
 * (95 lines, K v7.1.337), complete: `conjuncts`, `free_occs`,
 * `collect_symbols`, `substitute_vars` and `elim_aliases`.
 *
 * Two structural deviations, both stated at the function that carries them:
 *
 * - Every walk here is **iterative**, where pyk recurses.  A hostile or merely
 *   enormous term must exhaust memory, not the call stack — the discipline
 *   `syntax.ts` and the parser already follow.
 * - {@link substituteVariables} takes `(variable, replacement)` **pairs**
 *   rather than a map keyed by variable name.  pyk keys by `EVar`, whose frozen
 *   dataclass equality includes the sort; a JS `Map` cannot, so the structural
 *   key is spelled out in {@link variableKey}.  A `Map<EVar, Pattern>` still
 *   passes straight in.
 */

import { bottomUp, collect, koreText, patterns } from "./syntax.js";
import type { EVar, Pattern } from "./syntax.js";

function disjunctionSortText(pattern: Pattern): string | undefined {
  return pattern.tag === "Or" || pattern.tag === "MultiOr" ? koreText(pattern.sort) : undefined;
}

/**
 * Flatten a conjunction into its non-`\top` conjuncts — pyk `conjuncts`
 * (`manip.py:13-18`).
 *
 * `\top` vanishes (it is `\and`'s unit), `\and` recurses through **any**
 * arity — this package preserves KORE-JSON's n-ary `\and` rather than
 * binarising, so one level here may fan out to many conjuncts — and every
 * other pattern is its own sole conjunct. kore-rpc responses encode
 * substitutions as right-nested `\and` chains of `\equals`; this is the walk
 * that takes such a chain apart.
 *
 * Iterative with an explicit stack where pyk recurses: a hostile or merely
 * enormous conjunction must exhaust memory, not the call stack, which is the
 * discipline this package's parser already follows.
 */
export function conjuncts(pattern: Pattern): readonly Pattern[] {
  const out: Pattern[] = [];
  const stack: Pattern[] = [pattern];
  for (let p = stack.pop(); p !== undefined; p = stack.pop()) {
    if (p.tag === "Top") {
      continue;
    }
    if (p.tag === "And") {
      // Reversed, so popping visits the conjuncts left to right.
      for (let i = p.patterns.length - 1; i >= 0; i -= 1) {
        const q = p.patterns[i];
        if (q !== undefined) {
          stack.push(q);
        }
      }
      continue;
    }
    out.push(p);
  }
  return out;
}

/**
 * Flatten a disjunction into its non-`\bottom` disjuncts.
 *
 * Like {@link conjuncts}, this preserves left-to-right document order and
 * accepts unary, flat n-ary, and arbitrarily nested forms.  A nested `\or` is
 * flattened only when it has the same sort as its enclosing disjunction:
 * `\or{S}(p, \or{T}(q, r))` keeps the inner term whole when `S !== T`.
 * `MultiOr` receives the same treatment because KORE-JSON can encode that
 * sugar even though textual KORE cannot.  The walk is iterative.
 */
export function disjuncts(pattern: Pattern): readonly Pattern[] {
  const out: Pattern[] = [];
  const stack: Pattern[] = [pattern];
  const rootSort = disjunctionSortText(pattern);

  for (let p = stack.pop(); p !== undefined; p = stack.pop()) {
    if (p.tag === "Bottom") continue;
    const nestedSort = disjunctionSortText(p);
    if (rootSort !== undefined && nestedSort === rootSort && (p.tag === "Or" || p.tag === "MultiOr")) {
      const children = p.patterns;
      for (let i = children.length - 1; i >= 0; i -= 1) {
        const child = children[i];
        if (child !== undefined) stack.push(child);
      }
      continue;
    }
    out.push(p);
  }
  return out;
}

/**
 * All application symbols occurring in a pattern, in no particular semantic
 * order.  The returned set is insertion ordered (pre-order, left to right),
 * which makes it useful to consumers that want a deterministic diagnostic.
 *
 * This is pyk's `collect_symbols`.  `\left-assoc` and `\right-assoc` are
 * application sugar, so their head symbols count too.
 */
export function collectSymbols(pattern: Pattern): ReadonlySet<string> {
  const result = new Set<string>();
  collect(pattern, (node) => {
    switch (node.tag) {
      case "App":
      case "LeftAssoc":
      case "RightAssoc":
        result.add(node.symbol);
        break;
    }
  });
  return result;
}

/** An element variable occurrence not captured by a KORE quantifier. */
export type FreeOccurrences = ReadonlyMap<string, readonly EVar[]>;

/**
 * Free element-variable occurrences grouped by name — pyk's `free_occs`.
 *
 * KORE binders bind by variable name.  This walk deliberately tracks only
 * element quantifiers: `\mu`/`\nu` bind set variables and cannot capture an
 * {@link EVar}.  It is iterative so it shares the depth-safety contract of
 * the syntax traversals.
 */
export function freeOccurrences(pattern: Pattern, boundVariables: Iterable<string> = []): FreeOccurrences {
  const initial = new Set(boundVariables);
  const result = new Map<string, EVar[]>();
  const stack: { readonly node: Pattern; readonly bound: ReadonlySet<string> }[] = [{ node: pattern, bound: initial }];

  for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
    const { node, bound } = current;
    if (node.tag === "EVar") {
      if (!bound.has(node.name)) {
        const occurrences = result.get(node.name);
        if (occurrences === undefined) result.set(node.name, [node]);
        else occurrences.push(node);
      }
      continue;
    }

    let childBound = bound;
    if (node.tag === "Exists" || node.tag === "Forall") {
      childBound = new Set(bound).add(node.var.name);
    }
    const children = patterns(node);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child !== undefined) stack.push({ node: child, bound: childBound });
    }
  }
  return result;
}

/** pyk-compatible spelling for {@link freeOccurrences}. */
export const freeOccs = freeOccurrences;

/**
 * The identity an {@link EVar} substitution is keyed by: **name *and* sort**.
 *
 * pyk's substitutions are `Mapping[EVar, Pattern]` (`manip.py:60`), and its
 * `EVar` is a frozen dataclass, so a dict lookup compares `name` *and* `sort`.
 * A JS `Map` compares keys by identity, so that structural identity has to be
 * spelled out — the same argument `definition.ts`'s `sortKey` makes one level
 * up.  The NUL separator is what keeps the pair `("X\0", "SortInt{}")` from
 * colliding with `("X", "\0SortInt{}")`: neither a KORE identifier nor a KORE
 * sort text can contain a NUL, so the split point is unambiguous.
 *
 * Getting this wrong is not academic.  `X : SortInt{}` and `X : SortBool{}` are
 * two *different* variables that one KORE term may perfectly well contain at
 * once — `kompile` reuses `X0`, `X1`, `VarX` freely across sorts, and every
 * kore-rpc substitution comes back keyed that way — so a map keyed by the bare
 * name replaces both with whichever pattern was meant for one of them.
 */
export function variableKey(variable: EVar): string {
  return `${variable.name}\u0000${koreText(variable.sort)}`;
}

/** Re-key a caller's `(variable, replacement)` pairs by {@link variableKey}. */
function byVariableKey(substitutions: Iterable<readonly [EVar, Pattern]>): Map<string, Pattern> {
  const keyed = new Map<string, Pattern>();
  // Last pair wins, exactly as repeated assignment into pyk's dict does.
  for (const [variable, replacement] of substitutions) keyed.set(variableKey(variable), replacement);
  return keyed;
}

/**
 * Replace element-variable nodes bottom-up — pyk `substitute_vars`
 * (`manip.py:60-75`).
 *
 * The substitution arrives as `(variable, replacement)` **pairs**, not as a map
 * keyed by name.  A KORE variable is its name *together with* its sort (see
 * {@link variableKey}), and a `ReadonlyMap<string, Pattern>` keyed by the bare
 * name alone cannot say that: it would make
 * `X : SortInt{}` and `X : SortBool{}` one key and substituted both.  A
 * `Map<EVar, Pattern>` may still be passed straight in, since a `Map` *is* an
 * iterable of its entries; its useless identity keying is discarded here and
 * replaced by the structural one.
 *
 * pyk's substitution semantics are otherwise reproduced as they are, binder
 * blindness included: this does not alpha-rename, so substituting
 * `X : SortInt{}` into `\exists{S}(X : SortInt{}, X : SortInt{})` captures.  It
 * is primarily the second half of {@link eliminateAliases}, whose aliases are
 * compiler-introduced and do not cross user binders.
 */
export function substituteVariables(pattern: Pattern, substitutions: Iterable<readonly [EVar, Pattern]>): Pattern {
  const keyed = byVariableKey(substitutions);
  if (keyed.size === 0) return pattern;
  return bottomUp(pattern, (node) => (node.tag === "EVar" ? (keyed.get(variableKey(node)) ?? node) : node));
}

/** pyk-compatible spelling for {@link substituteVariables}. */
export const substituteVars = substituteVariables;

/**
 * Eliminate compiler-introduced aliases of the form `\and{S}(term, X:S)`.
 *
 * This is pyk's `elim_aliases` (`manip.py:78-95`): first fold every direct alias
 * bottom-up, then substitute the discovered variables through the whole result.
 * Restricting the match to exactly two conjuncts avoids treating ordinary
 * conjunctions as aliases in the n-ary AST this package preserves.
 *
 * The second half is {@link substituteVariables}, which is pyk's own
 * composition (`manip.py:93-94`) — and the reason its name+sort keying matters
 * twice over here: `\and{SortInt{}}(p, X : SortInt{})` and
 * `\and{SortBool{}}(q, X : SortBool{})` declare two unrelated aliases that a
 * name-keyed map would merge.
 */
export function eliminateAliases(pattern: Pattern): Pattern {
  const aliases: (readonly [EVar, Pattern])[] = [];
  const inlined = bottomUp(pattern, (node) => {
    if (node.tag !== "And" || node.patterns.length !== 2) return node;
    const [value, variable] = node.patterns;
    if (value === undefined || variable?.tag !== "EVar") return node;
    aliases.push([variable, value]);
    return value;
  });
  return substituteVariables(inlined, aliases);
}

/** pyk-compatible spelling for {@link eliminateAliases}. */
export const elimAliases = eliminateAliases;
