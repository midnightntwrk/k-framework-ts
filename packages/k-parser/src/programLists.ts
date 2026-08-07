/**
 * The `PROGRAM-LISTS` rewrite used by K's generated program grammar.
 *
 * `parser.y` is a debug-only by-product, not an input artifact. This module
 * instead transcribes `RuleGrammarGenerator` over the structural
 * {@link UserListClassification} supplied by `@kframework-ts/kast`.
 *
 * The Java implementation stores an `originalPrd` attribute containing a
 * Java `Production`. That value has no serializable KAST representation, so
 * this API returns the original production beside each generated one. The
 * bison-only marker attributes are intentionally omitted: their `userList`
 * value is a label, outside the closed persisted-artifact value space.
 */

import {
  Atts,
  EMPTY_ATT,
  NONE_TYPE,
  attEntry,
  attKey,
  knonterminal,
  kproduction,
  ksort,
  ksyntaxsort,
  kterminal,
  type KProduction,
  type KSentence,
  type KSyntaxSort,
  type UserList,
  type UserListClassification,
} from "@kframework-ts/kast";

/** A generated production paired with its persisted source declaration. */
export interface ProgramListProduction {
  readonly production: KProduction;
  readonly original: KProduction;
}

/** The generated grammar additions for every classified source user list. */
export interface ProgramListGrammar {
  readonly productions: readonly ProgramListProduction[];
  readonly syntaxSorts: readonly KSyntaxSort[];
}

const NOT_INJECTION = attKey("notInjection", NONE_TYPE);

/**
 * Expand K's persisted user-list halves into its in-memory `PROGRAM-LISTS`
 * grammar. The closed classifier result is required so malformed artifacts
 * are refused at the boundary rather than guessed from labels.
 */
export function programListGrammar(classification: UserListClassification): ProgramListGrammar {
  const productions: ProgramListProduction[] = [];
  const syntaxSorts: KSyntaxSort[] = [];
  for (const list of classification.lists) {
    const expansion = expandList(list);
    productions.push(...expansion.productions);
    syntaxSorts.push(...expansion.syntaxSorts);
  }
  return Object.freeze({ productions: Object.freeze(productions), syntaxSorts: Object.freeze(syntaxSorts) });
}

function expandList(list: UserList): ProgramListGrammar {
  const att = list.cons.att.discard([Atts.USER_LIST]);
  const params = list.cons.params;
  const label = list.cons.klabel;
  const terminatorLabel = list.terminator.klabel;
  if (label === undefined || terminatorLabel === undefined) {
    throw new TypeError("A classified user list must carry labels on both source productions");
  }

  if (list.orientation === "left") {
    if (list.type === "*") throw new TypeError("Cannot use List with --bison-lists");
    const recursive = generated(
      kproduction(list.listSort, {
        items: [knonterminal(list.listSort), kterminal(list.separator), knonterminal(list.elementSort)],
        params,
        klabel: label,
        att,
      }),
      list.cons,
    );
    const base = generated(
      kproduction(list.listSort, { items: [knonterminal(list.elementSort)], params, klabel: label, att }),
      list.cons,
    );
    const terminator = generated(
      kproduction(terminatorSort(list), {
        items: [kterminal("")],
        params,
        klabel: terminatorLabel,
        att: att.discard([Atts.FORMAT]),
      }),
      list.terminator,
    );
    return Object.freeze({ productions: Object.freeze([recursive, base, terminator]), syntaxSorts: Object.freeze([]) });
  }

  const nonEmptySort = ksort(`Ne#${list.listSort.name}`, list.listSort.params);
  const terminator = generated(
    kproduction(terminatorSort(list), {
      items: [kterminal("")],
      params,
      klabel: terminatorLabel,
      att: att.discard([Atts.FORMAT]),
    }),
    list.terminator,
  );
  const recursive = generated(
    kproduction(nonEmptySort, {
      items: [knonterminal(list.elementSort), kterminal(list.separator), knonterminal(nonEmptySort)],
      params,
      klabel: label,
      att,
    }),
    list.cons,
  );
  const finalElement = generated(
    kproduction(nonEmptySort, {
      items: [knonterminal(list.elementSort), kterminal(""), knonterminal(terminatorSort(list))],
      params,
      klabel: label,
      att,
    }),
    list.cons,
  );
  const nonEmptySubsort = generated(
    kproduction(list.listSort, {
      items: [knonterminal(nonEmptySort)],
      att: EMPTY_ATT.update([attEntry(NOT_INJECTION, null)]),
    }),
    list.cons,
  );
  const productions = [terminator, recursive, finalElement, nonEmptySubsort];
  if (list.type === "*") {
    productions.push(
      generated(
        kproduction(list.listSort, {
          items: [knonterminal(terminatorSort(list))],
          att: EMPTY_ATT.update([attEntry(NOT_INJECTION, null)]),
        }),
        list.terminator,
      ),
    );
  }
  return Object.freeze({
    productions: Object.freeze(productions),
    syntaxSorts: Object.freeze([ksyntaxsort(terminatorSort(list), { params }), ksyntaxsort(nonEmptySort, { params })]),
  });
}

function generated(production: KProduction, original: KProduction): ProgramListProduction {
  return Object.freeze({ production, original });
}

function terminatorSort(list: UserList) {
  return ksort(`${list.listSort.name}#Terminator`, list.listSort.params);
}

/** The generated production sentences, for callers that do not need origins. */
export function programListSentences(classification: UserListClassification): readonly KSentence[] {
  const grammar = programListGrammar(classification);
  return Object.freeze([...grammar.productions.map(({ production }) => production), ...grammar.syntaxSorts]);
}
