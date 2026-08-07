/**
 * The explicit boundary from `kast-json`'s total document term model to
 * `kast`'s pyk-parity `KInner` algebra.
 *
 * `InjectedKLabel` and `KOther` have no `KInner` representation. They return
 * typed refusal values instead of throwing, so a consumer can decide whether
 * to reject one result or degrade a batch. This is deliberately a local,
 * iterative conversion rather than a generic cross-domain walker.
 */

import { unflattenSort, type KTerm, type StructuredSort } from "@kframework-ts/kast-json";
import {
  kas,
  kapply,
  klabel,
  krewrite,
  ksequence,
  ksort,
  ktoken,
  kvariable,
  type KInner,
  type KSort,
} from "@kframework-ts/kast";

export interface InjectedKLabelRefusal {
  readonly kind: "injected-k-label";
  readonly label: string;
  readonly params: readonly string[];
  /** Location in the source `KTerm`, rooted at `term`. */
  readonly path: string;
}

export interface OtherKTermRefusal {
  readonly kind: "other";
  readonly args: number;
  readonly items: number;
  /** Location in the source `KTerm`, rooted at `term`. */
  readonly path: string;
}

export type KTermToKInnerRefusal = InjectedKLabelRefusal | OtherKTermRefusal;
export type KTermToKInnerResult = KInner | KTermToKInnerRefusal;

type UnsupportedKTerm = Extract<KTerm, { readonly node: "InjectedKLabel" | "KOther" }>;
type SupportedKTerm = Exclude<KTerm, UnsupportedKTerm>;

interface Frame {
  readonly term: SupportedKTerm;
  readonly path: string;
  readonly children: readonly KTerm[];
  readonly childPaths: readonly string[];
  readonly done: KInner[];
}

/** Convert a total JSON term into `KInner`, or return its first unsupported node. */
export function toKInner(root: KTerm): KTermToKInnerResult {
  if (!isSupported(root)) return refusal(root, "term");
  const stack: Frame[] = [enter(root, "term")];
  for (;;) {
    const top = stack.pop();
    if (top === undefined) throw new RangeError("toKInner: empty work stack");
    const index = top.done.length;
    const child = top.children[index];
    if (child !== undefined) {
      stack.push(top);
      const path = top.childPaths[index] ?? top.path;
      if (!isSupported(child)) return refusal(child, path);
      stack.push(enter(child, path));
      continue;
    }
    const built = build(top);
    const parent = stack.pop();
    if (parent === undefined) return built;
    parent.done.push(built);
    stack.push(parent);
  }
}

function isSupported(term: KTerm): term is SupportedKTerm {
  return term.node !== "InjectedKLabel" && term.node !== "KOther";
}

function refusal(term: UnsupportedKTerm, path: string): KTermToKInnerRefusal {
  if (term.node === "InjectedKLabel") {
    return Object.freeze({
      kind: "injected-k-label" as const,
      label: term.label,
      params: Object.freeze([...term.params]),
      path,
    });
  }
  return Object.freeze({ kind: "other" as const, args: term.args.length, items: term.items.length, path });
}

function enter(term: Frame["term"], path: string): Frame {
  switch (term.node) {
    case "KApply":
      return { term, path, children: term.args, childPaths: term.args.map((_, i) => `${path}.args[${i}]`), done: [] };
    case "KSequence":
      return {
        term,
        path,
        children: term.items,
        childPaths: term.items.map((_, i) => `${path}.items[${i}]`),
        done: [],
      };
    case "KRewrite":
      return { term, path, children: [term.lhs, term.rhs], childPaths: [`${path}.lhs`, `${path}.rhs`], done: [] };
    case "KAs":
      return {
        term,
        path,
        children: [term.pattern, term.alias],
        childPaths: [`${path}.pattern`, `${path}.alias`],
        done: [],
      };
    case "KToken":
    case "KVariable":
      return { term, path, children: [], childPaths: [], done: [] };
  }
  throw new TypeError("toKInner: unsupported source node");
}

function build(frame: Frame): KInner {
  const { term, done } = frame;
  switch (term.node) {
    case "KApply":
      return kapply(klabel(term.label, term.params.map(toKSort)), done);
    case "KToken":
      return ktoken(term.token, toKSort(term.sort));
    case "KSequence":
      return ksequence(done);
    case "KVariable":
      return kvariable(term.name, term.sort === undefined ? undefined : toKSort(term.sort));
    case "KRewrite":
      return krewrite(required(done, 0), required(done, 1));
    case "KAs":
      return kas(required(done, 0), required(done, 1));
  }
  throw new TypeError("toKInner: unsupported conversion frame");
}

function required(terms: readonly KInner[], index: number): KInner {
  const term = terms[index];
  if (term === undefined) throw new RangeError(`toKInner: missing child ${index}`);
  return term;
}

/** Recover structural sort parameters lost by the JSON term model, without recursion. */
function toKSort(text: string): KSort {
  const structured = unflattenSort(text);
  if (structured === undefined) return ksort(text);
  const stack: { readonly sort: StructuredSort; readonly done: KSort[] }[] = [{ sort: structured, done: [] }];
  for (;;) {
    const top = stack.pop();
    if (top === undefined) throw new RangeError("toKInner: empty sort stack");
    const child = top.sort.params[top.done.length];
    if (child !== undefined) {
      stack.push(top, { sort: child, done: [] });
      continue;
    }
    const built = ksort(top.sort.name, top.done);
    const parent = stack.pop();
    if (parent === undefined) return built;
    parent.done.push(built);
    stack.push(parent);
  }
}
