import { KCFG } from "./kcfg.js";
import { NodeAttr, type KCFGNode } from "./node.js";
import type { NodeIdLike } from "./types.js";

/** Attribute owned by the exploration wrapper, rather than core KCFG. */
export class KCFGExplorationNodeAttr extends NodeAttr {
  static readonly TERMINAL = new KCFGExplorationNodeAttr("terminal");
}

/**
 * Terminal/explorable view over a KCFG.
 *
 * Terminal state is graph data so node replacement and persistence users can
 * carry it explicitly, while recognition remains separate from backend halt
 * reasons such as `terminal-rule`.
 */
export class KCFGExploration {
  readonly kcfg: KCFG;

  constructor(kcfg: KCFG, terminal: Iterable<NodeIdLike> = []) {
    this.kcfg = kcfg;
    for (const id of terminal) this.addTerminal(id);
  }

  get terminalIds(): ReadonlySet<number> {
    return new Set(this.terminal.map((node) => node.id));
  }
  get terminal(): readonly KCFGNode[] {
    return Object.freeze(this.kcfg.nodes.filter((node) => this.isTerminal(node.id)));
  }
  get explorable(): readonly KCFGNode[] {
    return Object.freeze(this.kcfg.leaves.filter((node) => this.isExplorable(node.id)));
  }
  isTerminal(id: NodeIdLike): boolean {
    return this.kcfg.node(id).hasAttr(KCFGExplorationNodeAttr.TERMINAL);
  }
  isExplorable(id: NodeIdLike): boolean {
    return this.kcfg.isLeaf(id) && !this.isTerminal(id) && !this.kcfg.isStuck(id) && !this.kcfg.isVacuous(id);
  }
  addTerminal(id: NodeIdLike): void {
    if (!this.isTerminal(id)) this.kcfg.addAttr(id, KCFGExplorationNodeAttr.TERMINAL);
  }
  removeTerminal(id: NodeIdLike): void {
    this.kcfg.removeAttr(id, KCFGExplorationNodeAttr.TERMINAL);
  }
  removeNode(id: NodeIdLike): void {
    this.kcfg.removeNode(id);
  }
  prune(id: NodeIdLike, keepNodes: Iterable<NodeIdLike> = []): readonly number[] {
    return this.kcfg.prune(id, keepNodes);
  }
  toDict(): Readonly<{
    kcfg: ReturnType<KCFG["toDict"]>;
    terminal: readonly number[];
  }> {
    return Object.freeze({
      kcfg: this.kcfg.toDict(),
      terminal: Object.freeze([...this.terminalIds].toSorted((a, b) => a - b)),
    });
  }
  static fromDict(value: unknown): KCFGExploration {
    if (!isDictionary(value)) throw new TypeError("KCFGExploration dictionary must be an object");
    const dictionary = value;
    if (!("kcfg" in dictionary)) throw new TypeError("KCFGExploration dictionary is missing kcfg");
    if (dictionary.terminal !== undefined && !Array.isArray(dictionary.terminal))
      throw new TypeError("KCFGExploration dictionary terminal must be an array");
    const terminal = dictionary.terminal;
    if (Array.isArray(terminal) && !terminal.every((id) => typeof id === "number"))
      throw new TypeError("KCFGExploration dictionary terminal IDs must be numbers");
    return new KCFGExploration(KCFG.fromDict(dictionary.kcfg), terminal);
  }
}

function isDictionary(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
