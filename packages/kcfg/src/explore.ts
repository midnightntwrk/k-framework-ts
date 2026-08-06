/** Async, backend-injected KCFG exploration.  This module never starts a server. */

import { CTerm, ctermEq } from "@kframework-ts/cterm";
import {
  eq,
  flattenLabel,
  K_INNER_NODES,
  minimizeTerm,
  mlPredToBool,
  noCellRewriteToDots,
  PrettyPrinter,
  pushDownRewrites,
  replaceRewritesWithImplies,
  sentenceLabel,
  sentenceSource,
  type KDefinition,
  type KFlatModule,
  type KInner,
} from "@kframework-ts/kast";
import { isTop, mlAnd } from "@kframework-ts/kast/prelude/ml";

import { KCFGInvariantError } from "./errors.js";
import { KCFGExploration } from "./exploration.js";
import { KCFG } from "./kcfg.js";
import type { KCFGNode } from "./node.js";
import type { KCFGSemantics } from "./semantics.js";
import { DefaultKCFGSemantics } from "./semantics.js";
import type { NodeIdLike } from "./types.js";

export { KCFGExploration, KCFGExplorationNodeAttr } from "./exploration.js";
export { DefaultKCFGSemantics, DefaultSemantics } from "./semantics.js";
export type { Awaitable, KCFGSemantics } from "./semantics.js";

/** Execute options needed by exploration; compatible with CTermSymbolic's wider options type. */
export interface KCFGExecuteOptions {
  readonly maxDepth?: number;
  readonly cutPointRules?: readonly string[];
  readonly terminalRules?: readonly string[];
  readonly module?: string;
  readonly haskellLogging?: readonly string[];
}

export type KCFGExecuteReason =
  | "branching"
  | "stuck"
  | "vacuous"
  | "depth-bound"
  | "cut-point-rule"
  | "terminal-rule"
  | "aborted"
  | "timeout";

export interface KCFGSymbolicNextState {
  readonly cterm: CTerm;
  readonly rulePredicate?: KInner;
  readonly ruleId?: string;
}

/** The decoded subset of CTermSymbolic's execute response consumed by KCFG. */
export interface KCFGSymbolicExecuteResult {
  readonly state: CTerm;
  readonly nextStates: readonly KCFGSymbolicNextState[];
  readonly reason: KCFGExecuteReason;
  readonly depth: number;
  readonly logs?: readonly unknown[];
  readonly unknownPredicate?: KInner;
  readonly raw: { readonly reason: KCFGExecuteReason; readonly rule?: string };
}

export interface KCFGSymbolicSimplifyResult {
  readonly cterm: CTerm;
  readonly logs?: readonly unknown[];
}

/** The implication options {@link KCFGExplore.implicationFailureReason} needs (`cterm/symbolic.py:285-295`). */
export interface KCFGSymbolicImpliesOptions {
  /** Ask the backend adapter to compute per-cell failure information (`cterm/symbolic.py:290`). */
  readonly failureReason?: boolean;
  /** Assume the antecedent's configuration is defined (`cterm/symbolic.py:292`). */
  readonly assumeDefined?: boolean;
}

/**
 * The decoded subset of `CTermImplies` (`cterm/symbolic.py:76-80`) consumed here.
 *
 * `csubst` stays `unknown` on purpose: this package only ever asks whether the
 * implication held, and typing it would drag `CSubst` into the seam for no
 * gain.  `failingCells` and `remainingImplication` are optional so an adapter
 * that never computes failure information still satisfies the interface.
 */
export interface KCFGSymbolicImpliesResult {
  readonly csubst?: unknown;
  readonly failingCells?: readonly (readonly [string, KInner])[];
  readonly remainingImplication?: KInner;
}

/**
 * The decoded subset of `get-model` (`cterm/symbolic.py:258-283`) consumed by
 * callers that build counterexamples.
 *
 * `model` stays `unknown`: nothing in this package reads it, and typing it
 * would drag `Subst` into a seam that exists only so a proof-level failure
 * report can ask the backend for a witness.
 */
export interface KCFGSymbolicModelResult {
  readonly satisfiable: "Sat" | "Unsat" | "Unknown";
  readonly model?: unknown;
}

/** `add-module`'s options, restated structurally so this package needs no kore-rpc dependency. */
export interface KCFGSymbolicAddModuleOptions {
  /** File the module under its own name instead of the digest of its text. */
  readonly nameAsId?: boolean;
}

/** Narrow injected adapter; `CTermSymbolic` satisfies this interface directly. */
export interface KCFGSymbolic {
  execute(cterm: CTerm, options?: KCFGExecuteOptions): Promise<KCFGSymbolicExecuteResult>;
  simplify(cterm: CTerm): Promise<KCFGSymbolicSimplifyResult>;
  /**
   * Optional: `APRFailureInfo.from_proof`'s `counterexample_info` branch
   * (`proof/reachability.py:1034-1040`) is the only caller, and it lives in
   * `@kframework-ts/proof`.  Declared here so that consumer needs no cast to
   * reach it through {@link KCFGExplore.symbolic}.
   */
  getModel?(cterm: CTerm): Promise<KCFGSymbolicModelResult>;
  /**
   * Optional: `APRProver.init_proof` files the proof's `-DEPENDS-MODULE` and
   * `-CIRCULARITIES-MODULE` with the backend this way
   * (`proof/reachability.py:781-798`).  Like {@link KCFGSymbolic.getModel},
   * declared here only so `@kframework-ts/proof` can reach it through
   * {@link KCFGExplore.symbolic} without a cast; nothing in this package calls
   * it.
   */
  addModule?(module: KFlatModule, options?: KCFGSymbolicAddModuleOptions): Promise<string>;
  /**
   * Optional: needed only by {@link KCFGExplore.implicationFailureReason}
   * (`explore.py:98-100`).
   */
  implies?(
    antecedent: CTerm,
    consequent: CTerm,
    options?: KCFGSymbolicImpliesOptions,
  ): Promise<KCFGSymbolicImpliesResult>;
  /**
   * Optional: the definition {@link KCFGExplore.prettyPrint} prints against
   * (`explore.py:55-57` reads `cterm_symbolic._definition`).  Supply
   * {@link KCFGExploreOptions.prettyPrint} instead when the adapter has none.
   */
  readonly definition?: KDefinition;
  interrupt?(): void;
}

/** Logs are deliberately opaque to this artifact package and retained verbatim. */
export type KCFGNodeLogs = Map<number, readonly unknown[]>;

export type KCFGExtendResult =
  | {
      readonly kind: "step";
      readonly cterm: CTerm;
      readonly depth: number;
      readonly rules: readonly string[];
      readonly logs: readonly unknown[];
      readonly halt?: "depth-bound" | "terminal-rule" | "cut-point-rule" | "stuck" | "vacuous";
    }
  | {
      readonly kind: "branch";
      readonly constraints: readonly KInner[];
      readonly heuristic: boolean;
    }
  | {
      readonly kind: "ndbranch";
      readonly cterms: readonly CTerm[];
      readonly rules: readonly string[];
      readonly logs: readonly unknown[];
    }
  | { readonly kind: "abstract"; readonly cterm: CTerm }
  | { readonly kind: "vacuous" }
  | { readonly kind: "stuck" }
  | { readonly kind: "aborted"; readonly predicate?: KInner }
  | { readonly kind: "timeout" };

export interface ExtendCtermOptions {
  readonly executeDepth?: number;
  readonly cutPointRules?: Iterable<string>;
  readonly terminalRules?: Iterable<string>;
  readonly module?: string;
  readonly haskellLogging?: readonly string[];
}

export interface KCFGExploreOptions {
  readonly semantics?: KCFGSemantics;
  readonly id?: string;
  /**
   * Print terms with this instead of a {@link PrettyPrinter} over
   * {@link KCFGSymbolic.definition}.  pyk has no such hook — it always builds
   * the printer from `cterm_symbolic._definition` (`explore.py:55-57`) — but
   * the seam here is narrower than `CTermSymbolic`, so a fake or a
   * definition-less adapter needs a way in.
   */
  readonly prettyPrint?: (term: KInner) => string;
}

function frozen<T>(values: Iterable<T>): readonly T[] {
  return Object.freeze([...values]);
}

/**
 * The literal a backend substitutes for a rule id it could not determine —
 * `Kore/JsonRpc.hs:205` (`fromMaybe "UNKNOWN" $ getUniqueId ruleId`).
 *
 * pyk singles it out for a `WARNING` (`explore.py:73-74`) before falling into
 * the same `:UNKNOWN` suffix every unresolved id gets.  This package has no
 * logger; the resulting label, `UNKNOWN:UNKNOWN`, is as distinctive.
 */
const UNKNOWN_RULE_ID = "UNKNOWN";

/**
 * `KCFGExplore._extract_rule_labels` (`explore.py:66-77`).
 *
 * Reads each `rewrite`/`success` log entry's rule id and resolves it through
 * `KDefinition.sentenceByUniqueId` into `LABEL:source:(line, col, line, col)`
 * — `sentenceLabel` and `sentenceSource` are the two halves upstream
 * interpolates (`f'{sent.label}:{sent.source}'`).  An id the definition does
 * not know becomes `<id>:UNKNOWN`, exactly as upstream, so a label is always
 * produced and is always traceable back to something.
 *
 * **One deviation.** `KSentence.source` is `str | None` upstream, and the
 * f-string interpolates `None` as the four characters `None` — a sentence with
 * a `label` but no `Source`/`Location` attribute pair gets `LABEL:None` in pyk.
 * Here it gets `LABEL:UNKNOWN`, reusing the marker the *other* miss already
 * uses, because a Python `repr` leaking into a machine-read label serves no
 * one.  `kompile` output always carries both attributes, so this differs only
 * on hand-built definitions.
 *
 * Without a definition — the seam allows an adapter that carries none, see
 * {@link KCFGSymbolic.definition} — the raw ids are used unresolved.  That is
 * this package's previous behaviour, kept as the degenerate case rather than
 * as an error: a fake-driven graph test has no definition and does not need
 * one, and an edge labelled with hashes is still an edge.
 *
 * `logs` stays `unknown[]`: this package treats backend logs as opaque
 * (see {@link KCFGNodeLogs}) and structurally recognizes the one shape it
 * needs, rather than taking a `@kframework-ts/kore-rpc` dependency for a type.
 * The full attributed projection of the same entries — location, module,
 * substitution, per-rule fire counts — is `@kframework-ts/cterm/trace`.
 */
function ruleIds(logs: readonly unknown[], definition?: KDefinition, extra?: string): readonly string[] {
  const result: string[] = [];
  for (const log of logs) {
    if (typeof log !== "object" || log === null) continue;
    const entry = log as {
      tag?: unknown;
      result?: { tag?: unknown; ruleId?: unknown };
    };
    if (entry.tag === "rewrite" && entry.result?.tag === "success" && typeof entry.result.ruleId === "string")
      result.push(resolveRuleId(entry.result.ruleId, definition));
  }
  // Upstream appends the halting rule outside `_extract_rule_labels`, and
  // unresolved: `Step(..., rules=[response.rule])` (`explore.py:249-262`) uses
  // the `rule` field of the response, which is a *label* the request named in
  // `terminal-rules`/`cut-point-rules`, not a unique id.  Resolving it would be
  // resolving the wrong namespace, so it is passed through.
  if (extra !== undefined && !result.includes(extra)) result.push(extra);
  return frozen(result);
}

/** One id, resolved — the body of the loop above; see its doc comment. */
function resolveRuleId(ruleId: string, definition?: KDefinition): string {
  const sentence = definition?.sentenceByUniqueId.get(ruleId);
  if (sentence === undefined) return `${ruleId}:${UNKNOWN_RULE_ID}`;
  return `${sentenceLabel(sentence)}:${sentenceSource(sentence) ?? UNKNOWN_RULE_ID}`;
}

function branchConstraints(result: KCFGSymbolicExecuteResult): readonly KInner[] | undefined {
  if (result.reason !== "branching" || result.nextStates.some((state) => state.rulePredicate === undefined))
    return undefined;
  const predicates = result.nextStates.map((state) => flattenLabel("#And", state.rulePredicate!));
  const common = predicates[0]!.filter((predicate) =>
    predicates.every((branch) => branch.some((item) => eq(item, predicate))),
  );
  return frozen(
    predicates.map((branch) => mlAnd(branch.filter((predicate) => !common.some((item) => eq(item, predicate))))),
  );
}

function positiveDepth(value: number, where: string): void {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new KCFGInvariantError(`${where} must be a positive safe integer`);
}

function isKInner(value: unknown): value is KInner {
  if (!isNodeRecord(value)) return false;
  return typeof value.node === "string" && (K_INNER_NODES as readonly string[]).includes(value.node);
}

function isNodeRecord(value: unknown): value is { readonly node: unknown } {
  return typeof value === "object" && value !== null && "node" in value;
}

/** `_is_cell_subst` (`explore.py:81-87`). */
function isCellSubst(term: KInner): boolean {
  if (term.node === "KApply" && term.label.name === "_==K_") {
    const argument = term.args[0];
    if (argument?.node === "KVariable" && argument.name.endsWith("_CELL")) return true;
  }
  return false;
}

/** `_is_negative_cell_subst` (`explore.py:89-97`). */
function isNegativeCellSubst(constraint: KInner): boolean {
  const asBool = mlPredToBool(constraint);
  if (asBool.node === "KApply" && asBool.label.name === "notBool_") {
    const negated = asBool.args[0];
    if (negated?.node === "KApply" && negated.label.name === "_andBool_") {
      return flattenLabel("_andBool_", negated).some(isCellSubst);
    }
  }
  return false;
}

function isExtendResultList(
  value: KCFGExtendResult | readonly KCFGExtendResult[],
): value is readonly KCFGExtendResult[] {
  return Array.isArray(value);
}

/** Classifies symbolic execute responses and applies validated graph edits. */
export class KCFGExplore {
  readonly symbolic: KCFGSymbolic;
  readonly semantics: KCFGSemantics;
  readonly id: string;
  readonly #prettyPrint: ((term: KInner) => string) | undefined;
  // Written after `Object.freeze(this)`, which is legal: a private field is an
  // internal slot, not a property, so freezing does not seal it.  This is the
  // `cached_property` of `explore.py:55-57`.
  #prettyPrinter: PrettyPrinter | undefined;

  constructor(symbolic: KCFGSymbolic, options: KCFGExploreOptions = {}) {
    this.symbolic = symbolic;
    this.semantics = options.semantics ?? new DefaultKCFGSemantics();
    this.id = options.id ?? "NO ID";
    this.#prettyPrint = options.prettyPrint;
    Object.freeze(this);
  }

  interrupt(): void {
    this.symbolic.interrupt?.();
  }

  /**
   * `KCFGExplore.pretty_print` (`explore.py:55-60`).
   *
   * Upstream this is `PrettyPrinter(self.cterm_symbolic._definition).print`,
   * built once per explorer.  Here the printer comes from
   * {@link KCFGExploreOptions.prettyPrint} when given, otherwise from
   * {@link KCFGSymbolic.definition}; an adapter carrying neither cannot print
   * and says so instead of degrading the message text.
   */
  prettyPrint(term: KInner): string {
    if (this.#prettyPrint !== undefined) return this.#prettyPrint(term);
    if (this.#prettyPrinter === undefined) {
      const definition = this.symbolic.definition;
      if (definition === undefined)
        throw new KCFGInvariantError(
          "Cannot pretty-print: the symbolic adapter carries no definition and no prettyPrint option was given",
        );
      this.#prettyPrinter = new PrettyPrinter(definition);
    }
    return this.#prettyPrinter.print(term);
  }

  /**
   * `KCFGExplore.implication_failure_reason` (`explore.py:79-130`).
   *
   * Returns `[true, '']` when the implication holds, and otherwise the exact
   * report pyk's callers golden-pin: `Matching failed.`, optionally followed by
   * the per-cell `antecedent #Implies consequent` block, the remaining
   * implication, and the negated-cell-substitution hint.
   *
   * The per-cell explanation itself is computed by the backend adapter
   * (`cterm/symbolic.py:330-359`) and arrives through
   * {@link KCFGSymbolicImpliesResult.failingCells}; this method only rewrites
   * and prints it.
   */
  async implicationFailureReason(
    antecedent: CTerm,
    consequent: CTerm,
    assumeDefined = false,
  ): Promise<readonly [boolean, string]> {
    const implies = this.symbolic.implies?.bind(this.symbolic);
    if (implies === undefined)
      throw new KCFGInvariantError("Cannot check implication: the symbolic adapter has no implies method");
    const result = await implies(antecedent, consequent, { failureReason: true, assumeDefined });
    const matched = result.csubst !== undefined;
    if (matched) return Object.freeze([true, ""] as const);

    const failingCellsStrs: string[] = [];
    for (const [name, cell] of result.failingCells ?? []) {
      let failingCell = pushDownRewrites(cell);
      failingCell = noCellRewriteToDots(failingCell);
      failingCell = replaceRewritesWithImplies(failingCell);
      failingCellsStrs.push(`${name}: ${this.prettyPrint(minimizeTerm(failingCell))}`);
    }

    let retStr = "Matching failed.";
    if (failingCellsStrs.length > 0) {
      const failingCellsStr = failingCellsStrs.join("\n");
      retStr = `${retStr}\nThe following cells failed matching individually (antecedent #Implies consequent):\n${failingCellsStr}`;
    }

    const remaining = result.remainingImplication;
    if (remaining !== undefined) {
      retStr = `${retStr}\nThe remaining implication is:\n${this.prettyPrint(remaining)}`;

      // Upstream re-tests `csubst is not None` here (`explore.py:129`), which
      // the early return above has already ruled out, so this hint is dead
      // code in pyk too.  It is kept verbatim rather than silently dropped.
      if (matched && !isTop(remaining)) {
        const negativeCellConstraints = antecedent.constraints.filter(isNegativeCellSubst);
        if (negativeCellConstraints.length > 0) {
          const negativeCellConstraintsStr = negativeCellConstraints
            .map((constraint) => this.prettyPrint(constraint))
            .join("\n");
          retStr = `${retStr}\nNegated cell substitutions found (consider using _ => ?_):\n${negativeCellConstraintsStr}`;
        }
      }
    }

    return Object.freeze([false, retStr] as const);
  }

  /**
   * `KCFGExplore.check_extendable` (`explore.py:205-214`).
   *
   * The same four preconditions {@link KCFGExplore.extendNode} enforces, made
   * callable on its own so a proof driver can classify a leaf before deciding
   * to advance it.  pyk raises `ValueError`; this package raises
   * {@link KCFGInvariantError} with the identical message text.
   */
  checkExtendable(exploration: KCFGExploration, node: KCFGNode): void {
    const graph = exploration.kcfg;
    if (!graph.isLeaf(node.id)) throw new KCFGInvariantError(`Cannot extend non-leaf node ${this.id}: ${node.id}`);
    if (graph.isStuck(node.id)) throw new KCFGInvariantError(`Cannot extend stuck node ${this.id}: ${node.id}`);
    if (graph.isVacuous(node.id)) throw new KCFGInvariantError(`Cannot extend vacuous node ${this.id}: ${node.id}`);
    if (exploration.isTerminal(node.id))
      throw new KCFGInvariantError(`Cannot extend terminal node ${this.id}: ${node.id}`);
  }

  async extendCterm(
    cterm: CTerm,
    nodeId: number,
    options: ExtendCtermOptions = {},
  ): Promise<readonly KCFGExtendResult[]> {
    const custom = await this.semantics.customStep(cterm, this.symbolic, nodeId);
    if (custom !== undefined) return frozen(isExtendResultList(custom) ? custom : [custom]);
    const abstract = this.semantics.abstractNode(cterm);
    if (!ctermEq(cterm, abstract)) return frozen([{ kind: "abstract", cterm: abstract }]);

    const response = await this.symbolic.execute(cterm, {
      ...(options.executeDepth === undefined ? {} : { maxDepth: options.executeDepth }),
      ...(options.cutPointRules === undefined ? {} : { cutPointRules: frozen(options.cutPointRules) }),
      ...(options.terminalRules === undefined ? {} : { terminalRules: frozen(options.terminalRules) }),
      ...(options.module === undefined ? {} : { module: options.module }),
      ...(options.haskellLogging === undefined ? {} : { haskellLogging: options.haskellLogging }),
    });
    const logs = frozen(response.logs ?? []);
    const results: KCFGExtendResult[] = [];
    const step = (halt?: Extract<KCFGExtendResult, { kind: "step" }>["halt"], rule?: string): void => {
      if (response.depth > 0)
        results.push({
          kind: "step",
          cterm: response.state,
          depth: response.depth,
          rules: ruleIds(logs, this.symbolic.definition, rule),
          logs,
          ...(halt === undefined ? {} : { halt }),
        });
    };

    switch (response.reason) {
      case "vacuous":
        step(response.depth > 0 ? "vacuous" : undefined);
        results.push({ kind: "vacuous" });
        break;
      case "stuck":
        step(response.depth > 0 ? "stuck" : undefined);
        if (response.depth === 0) results.push({ kind: "stuck" });
        break;
      case "depth-bound":
        step("depth-bound");
        break;
      case "terminal-rule":
        step("terminal-rule", response.raw.reason === "terminal-rule" ? response.raw.rule : undefined);
        break;
      case "cut-point-rule": {
        step(undefined);
        const cut = response.nextStates[0];
        if (cut === undefined || response.nextStates.length !== 1)
          throw new KCFGInvariantError("Cut-point response must have exactly one successor");
        const rawCut = response.raw;
        if (rawCut.reason !== "cut-point-rule") throw new KCFGInvariantError("Mismatched cut-point response");
        const rule = cut.ruleId ?? rawCut.rule;
        if (rule === undefined) throw new KCFGInvariantError("Cut-point response is missing its rule ID");
        if (!this.semantics.canMakeCustomStep(response.state)) {
          results.push({
            kind: "step",
            cterm: cut.cterm,
            depth: 1,
            rules: frozen([rule]),
            logs,
            halt: "cut-point-rule",
          });
        }
        break;
      }
      case "branching": {
        step();
        const constraints = branchConstraints(response);
        if (constraints !== undefined) results.push({ kind: "branch", constraints, heuristic: false });
        else
          results.push({
            kind: "ndbranch",
            cterms: frozen(response.nextStates.map((state) => state.cterm)),
            rules: ruleIds(logs, this.symbolic.definition),
            logs,
          });
        break;
      }
      case "aborted":
        step();
        results.push({
          kind: "aborted",
          ...(response.unknownPredicate === undefined ? {} : { predicate: response.unknownPredicate }),
        });
        break;
      case "timeout":
        step();
        results.push({ kind: "timeout" });
        break;
    }
    return frozen(results);
  }

  /**
   * Validate the whole extension before changing the graph, then apply it
   * synchronously.  Aborted and timeout outcomes are intentionally no-ops
   * after any preceding concrete step.
   */
  applyExtendResults(
    graph: KCFG,
    node: KCFGNode | NodeIdLike,
    results: Iterable<KCFGExtendResult>,
    logs?: KCFGNodeLogs,
    options: ExtendKcfgOptions = {},
  ): KCFGNode {
    return extendKcfg(graph, node, results, { ...(logs === undefined ? {} : { logs }), ...options });
  }

  async extendNode(
    exploration: KCFGExploration,
    node: NodeIdLike,
    options: ExtendCtermOptions = {},
    logs?: KCFGNodeLogs,
  ): Promise<readonly KCFGExtendResult[]> {
    const current = exploration.kcfg.node(node);
    if (this.semantics.isTerminal(current.cterm)) {
      exploration.addTerminal(current.id);
      return frozen([]);
    }
    if (!exploration.isExplorable(current.id))
      throw new KCFGInvariantError(`Cannot extend non-explorable node: ${current.id}`);
    const results = await this.extendCterm(current.cterm, current.id, options);
    // No graph operation occurs until the awaited response has classified and validated.
    extendKcfg(exploration.kcfg, current, results, logs === undefined ? {} : { logs });
    return results;
  }

  async simplify(graph: KCFG, logs?: KCFGNodeLogs): Promise<void> {
    for (const node of graph.nodes) {
      const result = await this.symbolic.simplify(node.cterm);
      if (!ctermEq(node.cterm, result.cterm)) graph.letNode(node.id, { cterm: result.cterm });
      if (logs !== undefined && result.logs !== undefined) logs.set(node.id, frozen(result.logs));
    }
  }

  async step(graph: KCFG, node: NodeIdLike, depth = 1, logs?: KCFGNodeLogs): Promise<KCFGNode> {
    positiveDepth(depth, "Step depth");
    const source = graph.node(node);
    const existing = graph.successor(source.id);
    if (existing !== undefined && existing.kind !== "edge")
      throw new KCFGInvariantError(`Cannot step non-edge node: ${source.id}`);
    if (existing?.kind === "edge" && depth >= existing.depth)
      throw new KCFGInvariantError(`Step depth must be less than existing edge depth: ${depth}`);
    const result = await this.symbolic.execute(source.cterm, {
      maxDepth: depth,
    });
    if (result.depth !== depth || result.nextStates.length !== 0)
      throw new KCFGInvariantError(`Unable to take ${depth} unbranched steps from node: ${source.id}`);
    const resultLogs = frozen(result.logs ?? []);
    const next = graph.createNode(result.state);
    if (existing === undefined)
      graph.createEdge(source.id, next.id, depth, ruleIds(resultLogs, this.symbolic.definition));
    else {
      graph.removeSuccessor(source.id);
      graph.createEdge(source.id, next.id, depth, ruleIds(resultLogs, this.symbolic.definition));
      graph.createEdge(next.id, existing.target.id, existing.depth - depth, existing.rules.slice(depth));
    }
    if (logs !== undefined) logs.set(next.id, resultLogs);
    return next;
  }

  async sectionEdge(
    graph: KCFG,
    source: NodeIdLike,
    target: NodeIdLike,
    sections = 2,
    logs?: KCFGNodeLogs,
  ): Promise<readonly KCFGNode[]> {
    if (!Number.isSafeInteger(sections) || sections <= 1) throw new KCFGInvariantError("Sections must be at least two");
    const edge = graph.edge(source, target);
    if (edge === undefined) throw new KCFGInvariantError("Can only section an existing edge");
    const sectionDepth = Math.floor(edge.depth / sections);
    if (sectionDepth === 0) throw new KCFGInvariantError("Too many sections for edge depth");
    const result: KCFGNode[] = [];
    let current = edge.source;
    for (let covered = sectionDepth; covered < edge.depth; covered += sectionDepth) {
      current = await this.step(graph, current.id, sectionDepth, logs);
      result.push(current);
    }
    return frozen(result);
  }
}

/** Options for {@link extendKcfg}. */
export interface ExtendKcfgOptions {
  /** Where per-node backend logs are recorded, as pyk's `logs` argument. */
  readonly logs?: KCFGNodeLogs;
  /**
   * `optimize_kcfg` (`kcfg/kcfg.py:556-603`).
   *
   * When a `step` lands on a node with exactly one incoming `Edge`, that edge
   * and the intermediate node are removed and the new edge is created from the
   * predecessor instead, with the depths added, the rule labels concatenated,
   * and the logs prepended.  Off by default, exactly as upstream's
   * keyword-only `optimize_kcfg` on `APRProver` is.
   */
  readonly optimizeKcfg?: boolean;
}

/**
 * `KCFG.extend` (`kcfg/kcfg.py:555-609`), generalised to a *sequence* of
 * results.
 *
 * pyk applies one `KCFGExtendResult` per call and lets `APRProof.commit` drive
 * it; `KCFGExplore.extend_cterm` can return two results, and pyk's proof layer
 * applies the first and caches the second.  This function accepts the whole
 * list because {@link KCFGExplore.extendNode} — which has no proof to hold a
 * cache — applies all of them in order.
 *
 * It is free-standing rather than a {@link KCFGExplore} method because the
 * mutation half needs neither a backend nor a semantics: `APRProof.commit` in
 * `@kframework-ts/proof` is a *pure* method and must be able to apply a
 * committed extension without owning an explorer.  {@link
 * KCFGExplore.applyExtendResults} forwards here.
 *
 * The entire sequence is validated before the graph is touched, so a rejected
 * extension leaves the graph exactly as it was.  Aborted and timeout outcomes
 * are intentionally no-ops after any preceding concrete step.
 */
export function extendKcfg(
  graph: KCFG,
  node: KCFGNode | NodeIdLike,
  results: Iterable<KCFGExtendResult>,
  options: ExtendKcfgOptions = {},
): KCFGNode {
  const logs = options.logs;
  const optimizeKcfg = options.optimizeKcfg ?? false;
  const source = typeof node === "object" && node !== null && "id" in node ? graph.node(node.id) : graph.node(node);
  const values = [...results];
  validateExtension(graph, source, values);
  let current = source;
  for (const result of values) {
    switch (result.kind) {
      case "step": {
        // `create_node` happens before the merge check upstream too
        // (`kcfg.py:585-587`), which is what fixes the new node's id.
        const next = graph.createNode(result.cterm);
        let sourceId = current.id;
        let depth = result.depth;
        let rules: readonly string[] = result.rules;
        let stepLogs: readonly unknown[] = result.logs;
        const predecessors = graph.predecessors(current.id);
        const incoming = predecessors[0];
        if (optimizeKcfg && predecessors.length === 1 && incoming !== undefined && incoming.kind === "edge") {
          graph.removeEdge(incoming.source.id, current.id);
          sourceId = incoming.source.id;
          depth += incoming.depth;
          rules = [...incoming.rules, ...rules];
          const existing = logs?.get(current.id);
          if (existing !== undefined) stepLogs = [...existing, ...stepLogs];
          graph.removeNode(current.id);
        }
        graph.createEdge(sourceId, next.id, depth, rules);
        if (logs !== undefined) logs.set(next.id, stepLogs);
        current = next;
        break;
      }
      case "branch":
        graph.splitOnConstraints(current.id, result.constraints);
        break;
      case "ndbranch": {
        const nodes = result.cterms.map((cterm) => graph.createNode(cterm));
        graph.createNDBranch(
          current.id,
          nodes.map((target) => target.id),
          result.rules,
        );
        if (logs !== undefined) for (const target of nodes) logs.set(target.id, result.logs);
        break;
      }
      case "abstract": {
        const target = graph.createNode(result.cterm);
        graph.createCover(current.id, target.id);
        current = target;
        break;
      }
      case "vacuous":
        graph.addVacuous(current.id);
        break;
      case "stuck":
        graph.addStuck(current.id);
        break;
      case "aborted":
      case "timeout":
        break;
    }
  }
  return current;
}

function validateExtension(graph: KCFG, source: KCFGNode, values: readonly KCFGExtendResult[]): void {
  if (!graph.isLeaf(source.id)) throw new KCFGInvariantError(`Cannot extend non-leaf node: ${source.id}`);
  if (graph.isStuck(source.id) || graph.isVacuous(source.id))
    throw new KCFGInvariantError(`Cannot extend terminal-status node: ${source.id}`);
  let canContinue = true;
  let currentCterm = source.cterm;
  for (let index = 0; index < values.length; index++) {
    const result = values[index]!;
    if (!canContinue) throw new KCFGInvariantError("An extension result follows a terminal graph edit");
    switch (result.kind) {
      case "step":
        if (!(result.cterm instanceof CTerm)) throw new KCFGInvariantError("Step requires a CTerm");
        positiveDepth(result.depth, "Step depth");
        currentCterm = result.cterm;
        break;
      case "abstract":
        if (!(result.cterm instanceof CTerm) || result.cterm.matchWithConstraint(currentCterm) === null)
          throw new KCFGInvariantError("Abstract target must cover its source");
        currentCterm = result.cterm;
        canContinue = false;
        break;
      case "branch":
        if (result.constraints.length < 2 || !result.constraints.every(isKInner))
          throw new KCFGInvariantError("Branch requires at least two KInner constraints");
        canContinue = false;
        break;
      case "ndbranch":
        if (result.cterms.length < 2 || !result.cterms.every((cterm) => cterm instanceof CTerm))
          throw new KCFGInvariantError("NDBranch requires at least two CTerms");
        canContinue = false;
        break;
      case "vacuous":
      case "stuck":
        canContinue = false;
        break;
      case "aborted":
      case "timeout":
        if (index !== values.length - 1)
          throw new KCFGInvariantError(`${result.kind} must be the final extension result`);
        break;
    }
  }
}
