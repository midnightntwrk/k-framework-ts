/**
 * Pinned and definition-derived facts about K sorts.
 *
 * The named internal and builtin-token rosters are K v7.1.337 data, not a
 * claim that every builtin declaration is internal.  The definition facts are
 * deliberately separate: a consumer can distinguish K's scanner sorts from
 * token declarations made by the definition it is reading.
 */

import { Atts } from "./att.js";
import { type KSort } from "./inner.js";
import { moduleProductions, moduleSyntaxSorts, sortKey, type KDefinition } from "./outer.js";

/** Non-`#` sorts in K's reserved syntactic namespace at v7.1.337. */
export const INTERNAL_SORT_NAMES: readonly string[] = Object.freeze([
  "GeneratedTopCell",
  "K",
  "KBott",
  "KConfigVar",
  "KItem",
  "KLabel",
  "KList",
  "KResult",
  "KString",
]);

/** Sorts declared with `[token]` by K's builtin modules at v7.1.337. */
export const BUILTIN_TOKEN_SORT_NAMES: readonly string[] = Object.freeze([
  "#CellName",
  "#KVariable",
  "#LowerId",
  "#UpperId",
  "Bool",
  "Bytes",
  "Float",
  "Id",
  "Int",
  "KConfigVar",
  "KLabel",
  "KString",
  "KVar",
  "String",
]);

const INTERNAL_SORT_SET = new Set(INTERNAL_SORT_NAMES);
const BUILTIN_TOKEN_SORT_SET = new Set(BUILTIN_TOKEN_SORT_NAMES);

/** Whether a bare K sort name is reserved by K's grammar namespace. */
export function isInternalSort(sort: string): boolean {
  return sort.startsWith("#") || INTERNAL_SORT_SET.has(sort);
}

/** Whether a bare K sort name belongs to K's pinned builtin token roster. */
export function isBuiltinTokenSort(sort: string): boolean {
  return BUILTIN_TOKEN_SORT_SET.has(sort);
}

/** One token sort found in a definition and any literal members it pins. */
export interface DefinitionTokenFact {
  readonly sort: KSort;
  /** Literal members named by whole-terminal `[token]` productions, in declaration order. */
  readonly terminals: readonly string[];
}

/**
 * Token-sort facts over every module carried by `definition`.
 *
 * A `[token]` `KSyntaxSort` contributes its sort even when it has no matching
 * production.  A `[token]` production contributes its result sort and pins a
 * member only when its entire right-hand side is one literal terminal; regex
 * and compound productions intentionally expose no arbitrary representative.
 */
export function definitionTokenFacts(definition: KDefinition): readonly DefinitionTokenFact[] {
  const facts = new Map<string, { sort: KSort; terminals: Set<string> }>();
  const add = (sort: KSort): { sort: KSort; terminals: Set<string> } => {
    const key = sortKey(sort);
    const existing = facts.get(key);
    if (existing !== undefined) return existing;
    const fact = { sort, terminals: new Set<string>() };
    facts.set(key, fact);
    return fact;
  };

  for (const module of definition.allModules) {
    for (const syntaxSort of moduleSyntaxSorts(module)) {
      if (syntaxSort.att.has(Atts.TOKEN)) add(syntaxSort.sort);
    }
    for (const production of moduleProductions(module)) {
      if (!production.att.has(Atts.TOKEN)) continue;
      const fact = add(production.sort);
      const [item] = production.items;
      if (production.items.length === 1 && item?.node === "KTerminal") fact.terminals.add(item.value);
    }
  }

  return Object.freeze(
    [...facts.values()].map(({ sort, terminals }) => Object.freeze({ sort, terminals: Object.freeze([...terminals]) })),
  );
}
