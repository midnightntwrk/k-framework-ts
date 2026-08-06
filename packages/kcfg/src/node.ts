import { CTerm } from "@kframework-ts/cterm";
import { KCFGDictionaryError, KCFGInvariantError } from "./errors.js";
import type { KCFGNodeDict, NodeId } from "./types.js";

function positiveId(value: number, where: string): void {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new KCFGInvariantError(`${where} must be a positive safe integer: ${value}`);
}
function object(value: unknown, where: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new KCFGDictionaryError(`Expected object for ${where}`);
  // The checks above establish the only structural guarantee needed by the
  // field-by-field decoder below.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as Readonly<Record<string, unknown>>;
}

/** A named node attribute.  Values are immutable; compare with {@link NodeAttr.equals}. */
export class NodeAttr {
  static readonly VACUOUS = new NodeAttr("vacuous");
  static readonly STUCK = new NodeAttr("stuck");
  readonly value: string;
  constructor(value: string) {
    if (typeof value !== "string" || value.length === 0)
      throw new KCFGInvariantError("Node attribute must be a non-empty string");
    this.value = value;
    Object.freeze(this);
  }
  equals(other: NodeAttr): boolean {
    return this.value === other.value;
  }
  toString(): string {
    return this.value;
  }
}

/** pyk-compatible namespace for the two standard node attributes. */
export class KCFGNodeAttr extends NodeAttr {
  static override readonly VACUOUS = NodeAttr.VACUOUS;
  static override readonly STUCK = NodeAttr.STUCK;
}

/** Immutable KCFG node. */
export class KCFGNode {
  readonly id: NodeId;
  readonly cterm: CTerm;
  readonly attrs: readonly NodeAttr[];
  constructor(id: NodeId, cterm: CTerm, attrs: Iterable<NodeAttr | string> = []) {
    positiveId(id, "Node id");
    if (!(cterm instanceof CTerm)) throw new KCFGInvariantError("Node cterm must be a CTerm");
    const distinct = new Map<string, NodeAttr>();
    for (const attr of attrs) {
      const value = typeof attr === "string" ? new NodeAttr(attr) : attr;
      if (!(value instanceof NodeAttr)) throw new KCFGInvariantError("Node attribute must be a NodeAttr or string");
      distinct.set(value.value, value);
    }
    this.id = id;
    this.cterm = cterm;
    this.attrs = Object.freeze(
      [...distinct.values()].toSorted((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0)),
    );
    Object.freeze(this);
  }
  static fromDict(value: unknown): KCFGNode {
    const d = object(value, "node dictionary");
    if (typeof d.id !== "number") throw new KCFGDictionaryError("Node dictionary is missing numeric id");
    if (!Array.isArray(d.attrs) || !d.attrs.every((x) => typeof x === "string"))
      throw new KCFGDictionaryError("Node dictionary attrs must be an array of strings");
    if (!("cterm" in d)) throw new KCFGDictionaryError("Node dictionary is missing cterm");
    return new KCFGNode(d.id, CTerm.fromDict(d.cterm), d.attrs);
  }
  toDict(): KCFGNodeDict {
    return Object.freeze({
      id: this.id,
      cterm: this.cterm.toDict(),
      attrs: Object.freeze(this.attrs.map((a) => a.value)),
    });
  }
  hasAttr(attr: NodeAttr | string): boolean {
    const value = typeof attr === "string" ? attr : attr.value;
    return this.attrs.some((a) => a.value === value);
  }
  addAttr(attr: NodeAttr | string): KCFGNode {
    return new KCFGNode(this.id, this.cterm, [...this.attrs, attr]);
  }
  removeAttr(attr: NodeAttr | string): KCFGNode {
    const value = typeof attr === "string" ? attr : attr.value;
    if (!this.hasAttr(value))
      throw new KCFGInvariantError(`Node ${this.id} does not have attribute ${JSON.stringify(value)}`);
    return this.discardAttr(value);
  }
  discardAttr(attr: NodeAttr | string): KCFGNode {
    const value = typeof attr === "string" ? attr : attr.value;
    return new KCFGNode(
      this.id,
      this.cterm,
      this.attrs.filter((a) => a.value !== value),
    );
  }
  let({
    cterm = this.cterm,
    attrs = this.attrs,
  }: { readonly cterm?: CTerm; readonly attrs?: Iterable<NodeAttr | string> } = {}): KCFGNode {
    return new KCFGNode(this.id, cterm, attrs);
  }
  get freeVars(): ReadonlySet<string> {
    return this.cterm.freeVars;
  }
}
