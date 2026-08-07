/**
 * Structural user-list recognition, transcribed from K's `UserList.getLists`.
 *
 * K persists the two source halves, not its generated labels.  Consequently
 * this module groups by the declared list sort and classifies by production
 * shape; a `symbol(...)` or `terminator-symbol(...)` override cannot affect
 * the result.
 */

import { Atts, isUserListType, type UserListType } from "./att.js";
import { eqSort } from "./eq.js";
import { type KSort } from "./inner.js";
import { sortKey, type KProduction } from "./outer.js";

/** The direction encoded by the cons production's items. */
export type UserListOrientation = "left" | "right";

/** One complete source-level `List` or `NeList` declaration. */
export interface UserList {
  readonly listSort: KSort;
  readonly elementSort: KSort;
  readonly separator: string;
  readonly type: UserListType;
  readonly orientation: UserListOrientation;
  readonly cons: KProduction;
  readonly terminator: KProduction;
}

/** A refusal emitted for an unsupported persisted user-list shape. */
export type UserListFailure =
  | { readonly kind: "invalid-user-list"; readonly production: KProduction; readonly value: unknown }
  | { readonly kind: "incomplete-user-list"; readonly sort: KSort; readonly productions: readonly KProduction[] }
  | { readonly kind: "malformed-user-list"; readonly production: KProduction; readonly reason: string }
  | { readonly kind: "circular-user-list"; readonly production: KProduction; readonly sort: KSort }
  | {
      readonly kind: "inline-user-list";
      readonly production: KProduction;
      readonly sort: KSort;
      readonly elementSort: KSort;
    };

/** A complete classification, grouped logically by each returned `listSort`. */
export interface UserListClassification {
  readonly lists: readonly UserList[];
}

/**
 * Classify source user-list halves without consulting generated labels.
 *
 * K throws an unadorned assertion for malformed groups.  This extension keeps
 * the same accepted shapes but returns a value that identifies the declaration
 * K could not interpret.
 */
export function classifyUserLists(productions: readonly KProduction[]): UserListClassification | UserListFailure {
  const groups = new Map<string, KProduction[]>();
  for (const production of productions) {
    if (!production.att.has(Atts.USER_LIST)) continue;
    const value: unknown = production.att.get(Atts.USER_LIST);
    if (typeof value !== "string" || !isUserListType(value)) {
      return { kind: "invalid-user-list", production, value };
    }
    const key = sortKey(production.sort);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [production]);
    else group.push(production);
  }

  const lists: UserList[] = [];
  for (const group of groups.values()) {
    const first = group[0];
    if (first === undefined) continue;
    if (group.length !== 2) {
      return Object.freeze({
        kind: "incomplete-user-list" as const,
        sort: first.sort,
        productions: Object.freeze([...group]),
      });
    }
    const [one, two] = group;
    if (one === undefined || two === undefined) continue;
    const oneIsCons = one.items.length === 3;
    const twoIsCons = two.items.length === 3;
    if (oneIsCons === twoIsCons) {
      return {
        kind: "malformed-user-list",
        production: one,
        reason: "a user-list group must contain one three-item cons production and one terminal terminator",
      };
    }
    const cons = oneIsCons ? one : two;
    const terminator = oneIsCons ? two : one;
    const classification = classifyGroup(cons, terminator);
    if ("kind" in classification) return classification;
    lists.push(classification);
  }

  const listSorts = new Set(lists.map((list) => sortKey(list.listSort)));
  for (const list of lists) {
    if (eqSort(list.listSort, list.elementSort)) {
      return { kind: "circular-user-list", production: list.cons, sort: list.listSort };
    }
    if (listSorts.has(sortKey(list.elementSort))) {
      return {
        kind: "inline-user-list",
        production: list.cons,
        sort: list.listSort,
        elementSort: list.elementSort,
      };
    }
  }

  return Object.freeze({ lists: Object.freeze(lists) });
}

function classifyGroup(cons: KProduction, terminator: KProduction): UserList | UserListFailure {
  const consValue: unknown = cons.att.get(Atts.USER_LIST);
  const terminatorValue: unknown = terminator.att.get(Atts.USER_LIST);
  if (typeof consValue !== "string" || !isUserListType(consValue)) {
    return { kind: "invalid-user-list", production: cons, value: consValue };
  }
  if (typeof terminatorValue !== "string" || !isUserListType(terminatorValue)) {
    return { kind: "invalid-user-list", production: terminator, value: terminatorValue };
  }
  if (consValue !== terminatorValue) {
    return {
      kind: "malformed-user-list",
      production: terminator,
      reason: "the two user-list halves disagree on multiplicity",
    };
  }
  if (terminator.items.length !== 1 || terminator.items[0]?.node !== "KTerminal") {
    return { kind: "malformed-user-list", production: terminator, reason: "the terminator must contain one terminal" };
  }
  const [first, separator, third] = cons.items;
  if (first?.node !== "KNonTerminal" || separator?.node !== "KTerminal" || third?.node !== "KNonTerminal") {
    return {
      kind: "malformed-user-list",
      production: cons,
      reason: "the cons must be nonterminal, terminal separator, nonterminal",
    };
  }

  const firstIsList = eqSort(first.sort, cons.sort);
  const thirdIsList = eqSort(third.sort, cons.sort);
  if (firstIsList && thirdIsList) {
    return { kind: "circular-user-list", production: cons, sort: cons.sort };
  }
  if (firstIsList === thirdIsList) {
    return {
      kind: "malformed-user-list",
      production: cons,
      reason: "exactly one cons child must have the list sort",
    };
  }
  const type = consValue;
  return Object.freeze({
    listSort: cons.sort,
    elementSort: firstIsList ? third.sort : first.sort,
    separator: separator.value,
    type,
    orientation: firstIsList ? "left" : "right",
    cons,
    terminator,
  });
}
