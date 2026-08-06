/**
 * Rendering a {@link KCFG} as text, as a K module, and as DOT — a
 * transcription of pyk's `kcfg/show.py` (479 L) at K **v7.1.337**.
 *
 * This is the `./show` subpath, not the browser-safe main entry point: it
 * needs `@kframework-ts/kast`'s `PrettyPrinter` (and therefore a
 * `KDefinition`) and `@kframework-ts/cterm`'s `CTermShow`.  {@link KCFGShow.dump}
 * additionally touches the filesystem, which is why the main entry point does
 * not re-export any of this.
 *
 * # Four divergences worth stating up front
 *
 * 1. **The printer is a seam.**  Upstream `KCFGShow.__init__` takes a
 *    `KDefinition` and builds `PrettyPrinter(defn)` itself.  Here the
 *    constructor takes an options object with either a `definition` (a
 *    `PrettyPrinter` is built from it, as upstream) or a `prettyPrint`
 *    callable, mirroring `KCFGExplore`'s existing seam in `explore.ts`.  A
 *    hand-written stub printer is then enough to unit-test every text shape,
 *    which is the only way to golden this layer without a kompiled definition.
 * 2. **`dot` returns DOT text, not a `graphviz.Digraph`.**  pyk delegates
 *    layout to the `graphviz` package; this package will not take a rendering
 *    dependency.  {@link KCFGShow.dot} emits the same graph — one node per
 *    KCFG node labelled with its short info, one edge per successor with
 *    pyk's exact label strings — as a DOT document.  See {@link dotDocument}
 *    for the emitter's quoting rules.  (Upstream's `dot` passes `int` node
 *    ids straight to `graphviz`, which quotes `str`; this transcription
 *    formats ids as text, which is what a working DOT file needs.)
 * 3. **Segments are objects.**  pyk's `pretty_segments` yields
 *    `tuple[str, Iterable[str]]`; here it is `{ id, lines }`
 *    ({@link KCFGSegment}).  The ids are byte-for-byte pyk's — `node_7`,
 *    `edge_3_7`, `split_3_7`, `ndbranch_3_7`, `cover_3_7`,
 *    `merged_edge_3_7`, `unknown` — because they are the handles pyk's TUI
 *    (which this repository does not port) addresses regions by, and they are
 *    the only stable names this output has.
 * 4. **`showRules` prints rule labels, and is beyond pyk.**  Upstream renders
 *    an edge as `(N steps)` and never names the rules that fired
 *    (`show.py:160-171`), even though `KCFG.Edge` has carried `rules` since it
 *    was introduced.  Opt into `{ showRules: true }` and every successor that
 *    carries rule ids — `Edge`, `MergedEdge`, `NDBranch`; a `Cover` and a
 *    `Split` have none — grows a `rules:` block under its label.  See
 *    {@link printRules} for what the ids are and why this exists.  It defaults
 *    to `false`, so the transcribed output is unchanged and the frozen goldens
 *    still hold.
 *
 * # The summary module lives next door
 *
 * `KCFG.to_rules` / `KCFG.to_module` (`kcfg.py:713-735`) are graph-level, need
 * no printer, and are useful without one, so they are transcribed in
 * `./rules.ts` on the browser-safe main entry point.  {@link KCFGShow.toModule}
 * is `show.py`'s presentation-side wrapper over them, and that whole surface is
 * re-exported here so a `./show` consumer rendering a summary needs one
 * import.  The two `kast/manip.py` helpers that surface leans on —
 * `inline_cell_maps` and `minimize_rule_like`, both implemented in
 * `@kframework-ts/kast` — are forwarded through `./rules` for the same reason.
 */

import { CTermShow, CSubst, type TermPrinter } from "@kframework-ts/cterm";
import {
  PrettyPrinter,
  flattenLabel,
  krewrite,
  letKFlatModule,
  letKRule,
  minimizeTerm,
  mlPredToBool,
  pushDownRewrites,
  removeGeneratedCells,
  sortAcCollections,
  topDown,
  type KAst,
  type KDefinition,
  type KFlatModule,
  type KImport,
  type KInner,
  type KSentence,
} from "@kframework-ts/kast";
import { DOTS } from "@kframework-ts/kast/prelude/k";
import { mlAnd } from "@kframework-ts/kast/prelude/ml";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { KCFG } from "./kcfg.js";
import type { KCFGNode } from "./node.js";
import { inlineCellMaps, kcfgToModule, minimizeRuleLike } from "./rules.js";
import type { Cover, Edge, MergedEdge, NDBranch, Split } from "./successor.js";
import type { NodeIdLike } from "./types.js";

//////////////////////////////
// Small shared helpers     //
//////////////////////////////

/** `utils.add_indent` (`utils.py:362-363`). */
function addIndent(indent: string, lines: Iterable<string>): string[] {
  return [...lines].map((line) => `${indent}${line}`);
}

//////////////////////////////
// DOT emission             //
//////////////////////////////

/**
 * A DOT attribute list, `label` first and the rest sorted by name.
 *
 * The ordering is `graphviz`'s: `a_list` emits `label` first, then
 * `tools.mapping_items`, which sorts a plain `dict`.
 */
function dotAttributes(label: string | undefined, attributes: Readonly<Record<string, string>> = {}): string {
  const parts = label === undefined ? [] : [`label=${dotQuote(label)}`];
  for (const key of Object.keys(attributes).toSorted()) {
    const value = attributes[key];
    if (value !== undefined) parts.push(`${key}=${dotQuote(value)}`);
  }
  return parts.length === 0 ? "" : ` [${parts.join(" ")}]`;
}

/**
 * Quote a DOT identifier or label.
 *
 * `graphviz` leaves bare identifiers unquoted and embeds real newlines inside
 * quoted strings.  Both are legal DOT and both are hostile to a golden file,
 * so this emitter always quotes and always escapes: `\` and `"` are
 * backslash-escaped and a newline becomes the two characters `\n`, which is
 * DOT's own "break the label here" escape and renders identically.
 */
function dotQuote(value: string): string {
  const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n").replaceAll("\r", "\\r");
  return `"${escaped}"`;
}

/** One statement of a DOT document, already rendered. */
export type DotStatement = string;

/** Wrap DOT statements in `graphviz`'s default `digraph { … }`, one tab per line. */
export function dotDocument(statements: Iterable<DotStatement>): string {
  return ["digraph {", ...[...statements].map((statement) => `\t${statement}`), "}"].join("\n");
}

/** `_multi_line_print` (`show.py:127-134`). */
function multiLinePrint(label: string, lines: readonly string[], fallback = "None", indent = 4): string[] {
  if (lines.length === 0) return [`${label}: ${fallback}`];
  return [`${label}:`, ...lines.map((line) => `${" ".repeat(indent)}${line}`)];
}

/**
 * The rule ids a successor fired — **not** in pyk.
 *
 * # Why this exists
 *
 * pyk prints `(N steps)` for an edge and nothing else; the `rules` tuple
 * `KCFG.Edge` carries is written to `kcfg.json` and never rendered.  That is
 * tolerable for a passing proof and useless for a failing one, where the first
 * question is always *which rule fired on the edge before the failure*.  With
 * `showRules` the answer is in the graph the reader is already looking at,
 * instead of in a separate `--log-rules` trace they have to re-align by hand.
 *
 * # What the ids are
 *
 * Whatever `Edge.rules` holds.  When the edge was built by
 * `@kframework-ts/kcfg/explore` against a `KDefinition` these are resolved
 * `LABEL:file:line` triples (`explore.ts`'s `resolveRuleId`); an edge read back
 * from a `kcfg.json` pyk wrote holds the backend's raw ids, and an edge built
 * by hand or restored from an older document holds none — hence the `unknown`
 * fallback rather than a silently missing line.
 *
 * The block is `_multi_line_print`'s shape (`show.py:127-134`), the same one
 * `constraint:` and `subst:` already use, so it nests inside the box drawing
 * without a new layout rule.
 */
function printRules(rules: readonly string[]): string[] {
  return multiLinePrint("rules", rules, "unknown");
}

/** `_print_edge` (`show.py:160-164`), plus {@link printRules} under `showRules`. */
function printEdge(edge: Edge, showRules: boolean): string[] {
  const lines = [`(${edge.depth} step${edge.depth === 1 ? "" : "s"})`];
  if (showRules) lines.push(...printRules(edge.rules));
  return lines;
}

/**
 * `_print_merged_edge` (`show.py:166-171`), plus {@link printRules} under
 * `showRules`.
 *
 * The rule ids are every member edge's, concatenated in member order — the
 * same order the `3|5 steps` depths are printed in, so the two lists line up.
 * They are deliberately not deduplicated: a rule that fired twice fired twice.
 */
function printMergedEdge(merged: MergedEdge, showRules: boolean): string[] {
  const res = `(${merged.edges.map((member) => member.depth).join("|")} steps)`;
  const lines = res.length < 78 ? [res] : ["(merged edge)"];
  if (showRules) lines.push(...printRules(merged.edges.flatMap((member) => [...member.rules])));
  return lines;
}

/** `_short_label` (`show.py:373-379`): clip every line of a DOT label at 100 characters. */
function shortLabel(label: string): string {
  return label
    .split("\n")
    .map((line) => (line.length < 100 ? line : `${line.slice(0, 100)} ...`))
    .join("\n");
}

/** `Digraph.node(name, label=…, **attrs)`. */
export function dotNode(name: string, label: string, attributes: Readonly<Record<string, string>> = {}): DotStatement {
  return `${dotQuote(name)}${dotAttributes(label, attributes)}`;
}

/** `Digraph.edge(tail_name=…, head_name=…, label=…, **attrs)`. */
export function dotEdge(
  tail: string,
  head: string,
  label: string,
  attributes: Readonly<Record<string, string>> = {},
): DotStatement {
  return `${dotQuote(tail)} -> ${dotQuote(head)}${dotAttributes(label, attributes)}`;
}

//////////////////////////////
// NodePrinter              //
//////////////////////////////

/** `NodePrinter.__init__`'s one keyword argument (`show.py:45`). */
export interface NodePrinterOptions {
  /** `full_printer` (default `false`): print each node's whole CTerm under its header. */
  readonly fullPrinter?: boolean | undefined;
}

/**
 * `NodePrinter` (`show.py:40-70`): a node's one-line header, plus optionally
 * its constrained term.
 *
 * Subclass it and override {@link NodePrinter.nodeAttrs} to add
 * domain-specific markers; `@kframework-ts/proof`'s `APRProofNodePrinter` is
 * the upstream-sanctioned example.
 *
 * pyk declares a third field, `minimize: bool` (`show.py:43`), that
 * `__init__` never assigns and nothing reads. It is not transcribed.
 */
export class NodePrinter {
  readonly ctermShow: CTermShow;
  readonly fullPrinter: boolean;

  constructor(ctermShow: CTermShow, options: NodePrinterOptions = {}) {
    this.ctermShow = ctermShow;
    this.fullPrinter = options.fullPrinter ?? false;
  }

  /** `print_node` (`show.py:49-55`). */
  printNode(kcfg: KCFG, node: KCFGNode): readonly string[] {
    const attrs = this.nodeAttrs(kcfg, node);
    const attrString = attrs.length > 0 ? ` (${attrs.join(", ")})` : "";
    const lines = [`${node.id}${attrString}`];
    if (this.fullPrinter) {
      for (const line of this.ctermShow.show(node.cterm)) lines.push(`  ${line}`);
    }
    return lines;
  }

  /** `node_attrs` (`show.py:57-70`): `root`, `stuck`, `vacuous`, `leaf`, `split`, then sorted `@alias`es. */
  nodeAttrs(kcfg: KCFG, node: KCFGNode): string[] {
    const attrs: string[] = [];
    if (kcfg.isRoot(node.id)) attrs.push("root");
    if (kcfg.isStuck(node.id)) attrs.push("stuck");
    if (kcfg.isVacuous(node.id)) attrs.push("vacuous");
    if (kcfg.isLeaf(node.id)) attrs.push("leaf");
    if (kcfg.isSplit(node.id)) attrs.push("split");
    for (const alias of [...kcfg.aliases(node.id)].toSorted()) attrs.push(`@${alias}`);
    return attrs;
  }
}

//////////////////////////////
// KCFGShow                 //
//////////////////////////////

/**
 * One addressable region of {@link KCFGShow.prettySegments}' output.
 *
 * `id` is pyk's segment id — `node_<id>`, `edge_<src>_<tgt>`,
 * `merged_edge_<src>_<tgt>`, `cover_<src>_<tgt>`, `split_<src>_<tgt>`,
 * `ndbranch_<src>_<tgt>`, or the literal `unknown` for pure spacing — with
 * `make_unique_segments`' `_0`, `_1`, … disambiguating suffix already applied.
 */
export interface KCFGSegment {
  readonly id: string;
  readonly lines: readonly string[];
}

/** How a {@link KCFGShow} obtains its printer and its definition. */
export interface KCFGShowOptions {
  /**
   * The definition to build a `PrettyPrinter` from — pyk's positional `defn`.
   * Required by {@link KCFGShow.dump}, which needs it to sort cover
   * substitution predicates.
   */
  readonly definition?: KDefinition | undefined;
  /**
   * Print with this instead of `new PrettyPrinter(definition).print`. Supplying
   * it is what lets the text shapes be tested without a kompiled definition.
   */
  readonly prettyPrint?: ((kast: KAst) => string) | undefined;
  /** `node_printer` (`show.py:77`); defaults to `NodePrinter(CTermShow(prettyPrint))`. */
  readonly nodePrinter?: NodePrinter | undefined;
}

/** {@link KCFGShow.prettySegments} / {@link KCFGShow.pretty}'s keyword arguments. */
export interface KCFGPrettyOptions {
  /** `minimize` (default `true`): print `subst: ...` instead of a non-empty substitution. */
  readonly minimize?: boolean | undefined;
  /**
   * **Beyond pyk** (default `false`): print each successor's rule ids under
   * its label — see divergence 4 in the module header and {@link printRules}.
   * Off by default so the rendered text stays pyk's.
   */
  readonly showRules?: boolean | undefined;
}

/** {@link KCFGShow.toModule}'s keyword arguments (`show.py:299-307`). */
export interface KCFGToModuleOptions {
  readonly moduleName?: string | undefined;
  readonly omitCells?: Iterable<string> | undefined;
  /** `parseable_output` (default `true`): drop generated cells and minimize each rule. */
  readonly parseableOutput?: boolean | undefined;
  readonly defuncWith?: KDefinition | undefined;
  readonly imports?: Iterable<KImport> | undefined;
}

/** {@link KCFGShow.show}'s keyword arguments (`show.py:319-328`). */
export interface KCFGShowRequest {
  /** Print each of these nodes' full term under the graph. */
  readonly nodes?: Iterable<NodeIdLike> | undefined;
  /** Print the pushed-down rewrite between each pair's configurations. */
  readonly nodeDeltas?: Iterable<readonly [NodeIdLike, NodeIdLike]> | undefined;
  /** Append the summary module (`to_module`). */
  readonly toModule?: boolean | undefined;
  readonly minimize?: boolean | undefined;
  readonly omitCells?: Iterable<string> | undefined;
  readonly moduleName?: string | undefined;
  /** **Beyond pyk** (default `false`): forwarded to {@link KCFGShow.pretty}. */
  readonly showRules?: boolean | undefined;
}

/** {@link KCFGShow.dump}'s one keyword argument. */
export interface KCFGDumpOptions {
  /** Also write `<cfgid>.dot`. */
  readonly dot?: boolean | undefined;
}

/** `KCFGShow` (`show.py:73-479`). */
export class KCFGShow {
  readonly nodePrinter: NodePrinter;
  readonly #definition: KDefinition | undefined;
  #prettyPrinter: PrettyPrinter | undefined;
  readonly #prettyPrint: ((kast: KAst) => string) | undefined;

  constructor(options: KCFGShowOptions = {}) {
    this.#definition = options.definition;
    this.#prettyPrint = options.prettyPrint;
    if (this.#definition === undefined && this.#prettyPrint === undefined) {
      throw new TypeError("KCFGShow needs either a definition or a prettyPrint function");
    }
    this.nodePrinter =
      options.nodePrinter ?? new NodePrinter(new CTermShow((term: KInner): string => this.print(term)));
  }

  /**
   * `self.pretty_printer.definition`.
   *
   * @throws {TypeError} when this `KCFGShow` was built from a bare printer.
   *   {@link KCFGShow.dump} uses {@link KCFGShow.maybeDefinition} instead, so
   *   a printer-only instance can still dump.
   */
  get definition(): KDefinition {
    if (this.#definition === undefined) {
      throw new TypeError("This KCFGShow was built from a prettyPrint function and carries no definition");
    }
    return this.#definition;
  }

  /** The definition if there is one, without throwing. */
  get maybeDefinition(): KDefinition | undefined {
    return this.#definition;
  }

  /** `self.pretty_printer.print` (`show.py:78`), through the seam. */
  print(kast: KAst): string {
    if (this.#prettyPrint !== undefined) return this.#prettyPrint(kast);
    this.#prettyPrinter ??= new PrettyPrinter(this.definition);
    return this.#prettyPrinter.print(kast);
  }

  /** The printer as a `CTermShow`-shaped callable, for composing node printers. */
  get termPrinter(): TermPrinter {
    return (term: KInner): string => this.print(term);
  }

  /** `node_short_info` (`show.py:81-82`). */
  nodeShortInfo(kcfg: KCFG, node: KCFGNode): readonly string[] {
    return this.nodePrinter.printNode(kcfg, node);
  }

  /** `hide_cells` (`show.py:84-93`): replace every application named in `omitCells` with `...`. */
  static hideCells(term: KInner, omitCells: Iterable<string>): KInner {
    const hidden = new Set(omitCells);
    if (hidden.size === 0) return term;
    return topDown((k: KInner): KInner => (k.node === "KApply" && hidden.has(k.label.name) ? DOTS : k), term);
  }

  /** `simplify_config` (`show.py:95-100`). */
  static simplifyConfig(config: KInner, omitCells: Iterable<string>): KInner {
    return KCFGShow.hideCells(sortAcCollections(inlineCellMaps(config)), omitCells);
  }

  /**
   * `make_unique_segments` (`show.py:102-115`).
   *
   * Two things happen here, and downstream depends on both: repeated segment
   * ids gain a `_0`, `_1`, … suffix, and every line is right-stripped.
   */
  static makeUniqueSegments(segments: Iterable<KCFGSegment>): readonly KCFGSegment[] {
    const out: KCFGSegment[] = [];
    const usedIds: string[] = [];
    for (const segment of segments) {
      let suffix = "";
      let counter = 0;
      while (usedIds.includes(`${segment.id}${suffix}`)) {
        suffix = `_${counter}`;
        counter += 1;
      }
      const newId = `${segment.id}${suffix}`;
      usedIds.push(newId);
      out.push({ id: newId, lines: segment.lines.map((line) => line.replace(/\s+$/u, "")) });
    }
    return out;
  }

  /**
   * `pretty_segments` (`show.py:117-290`): the KCFG as box-drawing text, in
   * addressable segments.
   *
   * The walk starts at every unprocessed root — non-leaf roots first, then
   * leaf roots (`_sorted_init_nodes`, `show.py:263-276`) — and re-derives that
   * list after each subgraph, so a graph with several components prints each
   * in turn.  Anything still unvisited lands under `Remaining Nodes:`.
   */
  prettySegments(kcfg: KCFG, options: KCFGPrettyOptions = {}): readonly KCFGSegment[] {
    const minimize = options.minimize ?? true;
    const showRules = options.showRules ?? false;
    // pyk compares `KCFG.Node` values (`order=True` dataclass); within one
    // KCFG an id identifies a node, so the id is the comparison here.
    const processedNodes: number[] = [];
    const retLines: KCFGSegment[] = [];

    /** `_print_csubst` (`show.py:136-155`). */
    const printCsubst = (csubst: CSubst, substFirst: boolean): string[] => {
      const constraintStrs = multiLinePrint(
        "constraint",
        csubst.constraints.map((constraint) => this.print(mlPredToBool(constraint, { abstractUnsafe: true }))),
        "true",
      );
      const minimized = [...csubst.subst.minimize()];
      let substStrs: string[];
      if (minimized.length > 0 && minimize) {
        substStrs = ["subst: ..."];
      } else {
        const flat: string[] = [];
        for (const [key, value] of minimized) {
          for (const line of `${key} <- ${this.print(value)}`.split("\n")) flat.push(line);
        }
        substStrs = multiLinePrint("subst", flat, ".Subst");
      }
      return substFirst ? [...substStrs, ...constraintStrs] : [...constraintStrs, ...substStrs];
    };

    const printCover = (cover: Cover): string[] => printCsubst(cover.csubst, false);
    const printSplitEdge = (split: Split, targetId: number): string[] => {
      const csubst = split.splits.get(targetId);
      if (csubst === undefined) throw new Error(`Split from ${split.source.id} has no target ${targetId}`);
      return printCsubst(csubst, true);
    };

    /** `_print_subgraph` (`show.py:179-261`). */
    const printSubgraph = (indent: string, currNode: KCFGNode, priorOnTrace: readonly number[]): void => {
      const processed = processedNodes.includes(currNode.id);
      processedNodes.push(currNode.id);
      const successors = kcfg.successors(currNode.id);

      const currNodeStrs = this.nodeShortInfo(kcfg, currNode);

      const retNodeLines: string[] = [];
      let suffix: string[] = [];
      let elbow = "├─";
      let nodeIndent = "│   ";
      if (kcfg.isRoot(currNode.id)) {
        elbow = "┌─";
      } else if (processed || successors.length === 0) {
        elbow = "└─";
        nodeIndent = "    ";
        if (priorOnTrace.includes(currNode.id)) suffix = ["(looped back)", ""];
        else if (processed && !kcfg.isLeaf(currNode.id)) suffix = ["(continues as previously)", ""];
        else suffix = [""];
      }
      retNodeLines.push(`${indent}${elbow} ${currNodeStrs[0] ?? ""}`);
      retNodeLines.push(...addIndent(indent + nodeIndent, currNodeStrs.slice(1)));
      retNodeLines.push(...addIndent(`${indent}   `, suffix));
      retLines.push({ id: `node_${currNode.id}`, lines: retNodeLines });

      if (processed || successors.length === 0) return;
      const [successor] = successors;
      if (successor === undefined) return;

      if (successor.kind === "split" || successor.kind === "ndbranch") {
        retLines.push({ id: "unknown", lines: [`${indent}┃`] });
        const multiedgeLabel = successor.kind === "ndbranch" ? "1 step" : "branch";
        const multiedgeId = successor.kind === "ndbranch" ? "ndbranch" : "split";
        // Beyond pyk: an NDBranch carries rule ids, a Split does not.  The
        // lines join the label's own segment rather than pushing a new one,
        // so `makeUniqueSegments`' `unknown_<n>` numbering is unaffected.
        const multiedgeLines = [`${indent}┃ (${multiedgeLabel})`];
        if (showRules && successor.kind === "ndbranch") {
          multiedgeLines.push(...addIndent(`${indent}┃ `, printRules(successor.rules)));
        }
        retLines.push({ id: "unknown", lines: multiedgeLines });

        const targets: readonly KCFGNode[] =
          successor.kind === "split" ? successor.targets.map((target) => target.node) : successor.targets;
        for (const target of targets.slice(0, -1)) {
          let retEdgeLines: string[];
          if (successor.kind === "split") {
            const printed = printSplitEdge(successor, target.id);
            retEdgeLines = [`${indent}┣━━┓ ${printed[0] ?? ""}`, ...addIndent(`${indent}┃  ┃ `, printed.slice(1))];
          } else {
            retEdgeLines = [`${indent}┣━━┓ `];
          }
          retEdgeLines.push(`${indent}┃  │`);
          retLines.push({ id: `${multiedgeId}_${currNode.id}_${target.id}`, lines: retEdgeLines });
          printSubgraph(`${indent}┃  `, target, [...priorOnTrace, currNode.id]);
        }
        const last = targets[targets.length - 1];
        if (last === undefined) return;
        let retEdgeLines: string[];
        if (successor.kind === "split") {
          const printed = printSplitEdge(successor, last.id);
          retEdgeLines = [`${indent}┗━━┓ ${printed[0] ?? ""}`, ...addIndent(`${indent}   ┃ `, printed.slice(1))];
        } else {
          retEdgeLines = [`${indent}┗━━┓ `];
        }
        retEdgeLines.push(`${indent}   │`);
        retLines.push({ id: `${multiedgeId}_${currNode.id}_${last.id}`, lines: retEdgeLines });
        printSubgraph(`${indent}   `, last, [...priorOnTrace, currNode.id]);
        return;
      }

      // `KCFG.EdgeLike`: Edge, MergedEdge, Cover.
      retLines.push({ id: "unknown", lines: [`${indent}│`] });
      if (successor.kind === "edge") {
        retLines.push({
          id: `edge_${successor.source.id}_${successor.target.id}`,
          lines: addIndent(`${indent}│  `, printEdge(successor, showRules)),
        });
      } else if (successor.kind === "merged-edge") {
        retLines.push({
          id: `merged_edge_${successor.source.id}_${successor.target.id}`,
          lines: addIndent(`${indent}│  `, printMergedEdge(successor, showRules)),
        });
      } else {
        retLines.push({
          id: `cover_${successor.source.id}_${successor.target.id}`,
          lines: addIndent(`${indent}┊  `, printCover(successor)),
        });
      }
      printSubgraph(indent, successor.target, [...priorOnTrace, currNode.id]);
    };

    /** `_sorted_init_nodes` (`show.py:263-276`). */
    const sortedInitNodes = (): readonly [readonly KCFGNode[], readonly KCFGNode[]] => {
      const unprocessed = kcfg.nodes
        .filter((node) => !processedNodes.includes(node.id))
        .toSorted((left, right) => left.id - right.id);
      const initNodes: KCFGNode[] = [];
      const initLeafNodes: KCFGNode[] = [];
      const remainingNodes: KCFGNode[] = [];
      for (const node of unprocessed) {
        if (!kcfg.isRoot(node.id)) remainingNodes.push(node);
        else if (kcfg.isLeaf(node.id)) initLeafNodes.push(node);
        else initNodes.push(node);
      }
      return [[...initNodes, ...initLeafNodes], remainingNodes];
    };

    for (let [init] = sortedInitNodes(); init.length > 0; [init] = sortedInitNodes()) {
      const [first] = init;
      if (first === undefined) break;
      retLines.push({ id: "unknown", lines: [""] });
      printSubgraph("", first, []);
    }
    const [, remaining] = sortedInitNodes();
    if (remaining.length > 0) {
      retLines.push({ id: "unknown", lines: ["", "Remaining Nodes:"] });
      for (const node of remaining) {
        retLines.push({ id: `node_${node.id}`, lines: ["", ...this.nodeShortInfo(kcfg, node)] });
      }
    }

    return KCFGShow.makeUniqueSegments(retLines);
  }

  /** `pretty` (`show.py:292-297`): every segment's lines, concatenated. */
  pretty(kcfg: KCFG, options: KCFGPrettyOptions = {}): readonly string[] {
    return this.prettySegments(kcfg, options).flatMap((segment) => [...segment.lines]);
  }

  /**
   * `to_module` (`show.py:299-317`): one `KRule` per edge and merged edge,
   * with cells hidden and — under `parseableOutput` — generated cells removed
   * and each rule minimized.
   */
  toModule(cfg: KCFG, options: KCFGToModuleOptions = {}): KFlatModule {
    const omitCells = [...(options.omitCells ?? [])];
    const parseableOutput = options.parseableOutput ?? true;

    const processSentence = (sentence: KSentence): KSentence => {
      if (sentence.node !== "KRule") return sentence;
      let rule = letKRule(sentence, { body: KCFGShow.hideCells(sentence.body, omitCells) });
      if (parseableOutput) {
        rule = letKRule(rule, { body: removeGeneratedCells(rule.body) });
        rule = minimizeRuleLike(rule);
      }
      return rule;
    };

    const module = kcfgToModule(cfg, {
      ...(options.moduleName === undefined ? {} : { moduleName: options.moduleName }),
      ...(options.defuncWith === undefined ? {} : { defuncWith: options.defuncWith }),
      ...(options.imports === undefined ? {} : { imports: options.imports }),
    });
    return letKFlatModule(module, { sentences: module.sentences.map(processSentence) });
  }

  /**
   * `show` (`show.py:319-370`): the pretty graph, then each requested node,
   * then each requested delta, then — when asked — the summary module.
   *
   * The trailing blank lines are pyk's, verbatim: two when at least one node
   * or delta was printed, three otherwise (`show.py:361-364`).
   */
  show(cfg: KCFG, request: KCFGShowRequest = {}): readonly string[] {
    const minimize = request.minimize ?? true;
    const omitCells = [...(request.omitCells ?? [])];
    const resLines: string[] = [...this.pretty(cfg, { minimize, showRules: request.showRules ?? false })];

    let nodesPrinted = false;

    for (const nodeId of request.nodes ?? []) {
      nodesPrinted = true;
      let kast = KCFGShow.hideCells(cfg.node(nodeId).cterm.kast, omitCells);
      if (minimize) kast = minimizeTerm(kast);
      resLines.push("", "", `Node ${nodeId}:`, "", this.print(kast), "");
    }

    for (const [firstId, secondId] of request.nodeDeltas ?? []) {
      nodesPrinted = true;
      const config1 = KCFGShow.simplifyConfig(cfg.node(firstId).cterm.config, omitCells);
      const config2 = KCFGShow.simplifyConfig(cfg.node(secondId).cterm.config, omitCells);
      let configDelta = pushDownRewrites(krewrite(config1, config2));
      if (minimize) configDelta = minimizeTerm(configDelta);
      resLines.push("", "", `State Delta ${firstId} => ${secondId}:`, "", this.print(configDelta), "");
    }

    if (!nodesPrinted) resLines.push("");
    resLines.push("", "");

    if (request.toModule === true) {
      resLines.push(
        this.print(
          this.toModule(cfg, {
            ...(request.moduleName === undefined ? {} : { moduleName: request.moduleName }),
            omitCells,
          }),
        ),
      );
    }

    return resLines;
  }

  /**
   * `dot` (`show.py:372-414`), as DOT statements.
   *
   * Returned as statements rather than a finished document so
   * `@kframework-ts/proof`'s `APRProofShow.dot` can append its own edges the
   * way pyk appends them to the `Digraph` this returns.  {@link dotDocument}
   * wraps them.
   */
  dotStatements(kcfg: KCFG): readonly DotStatement[] {
    const statements: DotStatement[] = [];

    for (const node of kcfg.nodes) {
      const label = this.nodeShortInfo(kcfg, node).join("\n");
      const classAttrs = this.nodePrinter.nodeAttrs(kcfg, node).join(" ");
      statements.push(dotNode(String(node.id), label, classAttrs === "" ? {} : { class: classAttrs }));
    }

    for (const edge of kcfg.edges()) {
      statements.push(dotEdge(String(edge.source.id), String(edge.target.id), `  ${edge.depth} steps        `));
    }

    for (const cover of kcfg.covers()) {
      const label = shortLabel(
        [...cover.csubst.subst.minimize()].map(([key, value]) => `${key} |-> ${this.print(value)}`).join(", "),
      );
      statements.push(
        dotEdge(String(cover.source.id), String(cover.target.id), `  ${label}        `, {
          class: "abstraction",
          style: "dashed",
        }),
      );
    }

    for (const split of kcfg.splits()) {
      for (const [targetId, csubst] of split.splits) {
        const label = [...split.source.cterm.constraints, ...csubst.constraints]
          .map((constraint) => this.print(constraint))
          .join("\n#And");
        statements.push(dotEdge(String(split.source.id), String(targetId), `  ${label}        `));
      }
    }

    for (const ndbranch of kcfg.ndbranches()) {
      for (const targetId of ndbranch.targetIds) {
        statements.push(dotEdge(String(ndbranch.source.id), String(targetId), "  1 step        "));
      }
    }

    return statements;
  }

  /** {@link KCFGShow.dotStatements} as a complete DOT document. */
  dot(kcfg: KCFG): string {
    return dotDocument(this.dotStatements(kcfg));
  }

  /**
   * `dump` (`show.py:416-479`): the graph JSON, optionally its DOT, and one
   * text file per node, edge and cover.
   *
   * Every per-artifact file is written **only when it does not already
   * exist**, exactly as upstream — a dump directory is append-only, so a
   * re-dump after further exploration never rewrites what an earlier one
   * produced.  `<cfgid>.json` and `<cfgid>.dot` are the exceptions: those are
   * always overwritten.
   */
  async dump(cfgid: string, cfg: KCFG, dumpDir: string, options: KCFGDumpOptions = {}): Promise<void> {
    await mkdir(dumpDir, { recursive: true });

    await writeFile(join(dumpDir, `${cfgid}.json`), cfg.toJson());

    if (options.dot === true) {
      await writeFile(join(dumpDir, `${cfgid}.dot`), this.dot(cfg));
    }

    const nodesDir = join(dumpDir, "nodes");
    await mkdir(nodesDir, { recursive: true });
    for (const node of cfg.nodes) {
      await writeIfAbsent(join(nodesDir, `config_${node.id}.txt`), () => this.print(node.cterm.config));
      await writeIfAbsent(join(nodesDir, `config_minimized_${node.id}.txt`), () =>
        this.print(minimizeTerm(node.cterm.config)),
      );
      await writeIfAbsent(join(nodesDir, `constraint_${node.id}.txt`), () => this.print(mlAnd(node.cterm.constraints)));
    }

    const edgesDir = join(dumpDir, "edges");
    await mkdir(edgesDir, { recursive: true });
    for (const edge of cfg.edges()) {
      const config = pushDownRewrites(krewrite(edge.source.cterm.config, edge.target.cterm.config));
      await writeIfAbsent(join(edgesDir, `config_${edge.source.id}_${edge.target.id}.txt`), () => this.print(config));
      await writeIfAbsent(join(edgesDir, `config_minimized_${edge.source.id}_${edge.target.id}.txt`), () =>
        this.print(minimizeTerm(config)),
      );
    }

    const coversDir = join(dumpDir, "covers");
    await mkdir(coversDir, { recursive: true });
    for (const cover of cfg.covers()) {
      // `sort_with=self.pretty_printer.definition` (`show.py:471`); a
      // printer-only instance has no definition, and `CSubst.pred` then leaves
      // the generated `#Equals` unsorted rather than refusing to dump.
      const definition = this.maybeDefinition;
      const substEqualities = flattenLabel(
        "#And",
        cover.csubst.pred({ ...(definition === undefined ? {} : { sortWith: definition }), constraints: false }),
      );
      await writeIfAbsent(join(coversDir, `config_${cover.source.id}_${cover.target.id}.txt`), () =>
        substEqualities.map((equality) => this.print(equality)).join("\n"),
      );
      await writeIfAbsent(join(coversDir, `constraint_${cover.source.id}_${cover.target.id}.txt`), () =>
        this.print(cover.csubst.constraint),
      );
    }
  }
}

/** Narrow an unknown throw to Node's `EEXIST`. */
function isAlreadyThere(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

/** `Path.write_text` guarded by `if not path.exists()`, as `dump` does throughout. */
async function writeIfAbsent(path: string, content: () => string): Promise<void> {
  try {
    await writeFile(path, content(), { flag: "wx" });
  } catch (error) {
    // `wx` is the atomic form of pyk's `if not node_file.exists()` check.
    if (!isAlreadyThere(error)) throw error;
  }
}

//////////////////////////////
// KCFG -> K module         //
//////////////////////////////

/**
 * The graph-level summary module, re-exported.
 *
 * `KCFG.to_rules` / `KCFG.to_module` are `kcfg.py`'s, not `show.py`'s, and
 * need neither a printer nor a definition; they are transcribed in `./rules.ts`
 * and exported from the main entry point.  A `./show` consumer that renders a
 * summary usually wants both halves, so the whole surface is visible from here
 * too.
 */
export {
  edgeToClaim,
  edgeToRule,
  inlineCellMaps,
  kcfgToModule,
  kcfgToRules,
  minimizeRuleLike,
  sentenceId,
  simplifyConfig,
  type EdgeLike,
  type EdgeToRuleOptions,
  type KCFGToModuleArguments,
  type KCFGToRulesOptions,
} from "./rules.js";

export type { Cover, Edge, MergedEdge, NDBranch, Split };
