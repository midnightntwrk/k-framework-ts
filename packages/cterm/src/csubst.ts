/** Constrained substitutions, the companion value type to {@link CTerm}. */

import {
  Subst,
  eq,
  extractSubst,
  flattenLabel,
  fromDict,
  normalizeConstraints,
  toDict,
  kvariable,
  type JsonObject,
  type KDefinition,
  type KInner,
} from "@kframework-ts/kast";
import { K } from "@kframework-ts/kast/prelude/k";
import { mlAnd, mlEquals } from "@kframework-ts/kast/prelude/ml";
import { CTerm } from "./cterm.js";

export interface CSubstDict {
  readonly subst: Readonly<Record<string, JsonObject>>;
  readonly constraints: readonly JsonObject[];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, where: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw new SyntaxError(`Expected an object for CSubst ${where}`);
  }
  return value;
}

function required(record: Readonly<Record<string, unknown>>, field: string, where: string): unknown {
  if (!Object.hasOwn(record, field)) throw new SyntaxError(`CSubst ${where} is missing ${JSON.stringify(field)}`);
  return record[field];
}

function array(value: unknown, where: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new SyntaxError(`Expected an array for CSubst ${where}`);
  return value;
}

function normalize(constraints: Iterable<KInner>): readonly KInner[] {
  return Object.freeze([...normalizeConstraints(constraints)]);
}

function substEq(left: Subst, right: Subst): boolean {
  if (left.size !== right.size) return false;
  for (const [name, value] of left) {
    const other = right.get(name);
    if (other === undefined || !eq(value, other)) return false;
  }
  return true;
}

export function csubstEq(left: CSubst, right: CSubst): boolean {
  return (
    substEq(left.subst, right.subst) &&
    left.constraints.length === right.constraints.length &&
    left.constraints.every((constraint, index) => {
      const other = right.constraints[index];
      return other !== undefined && eq(constraint, other);
    })
  );
}

export interface CSubstPredOptions {
  /** Infer each equality's argument sort from its right-hand side, when known. */
  readonly sortWith?: KDefinition;
  readonly subst?: boolean;
  readonly constraints?: boolean;
}

export class CSubst {
  readonly subst: Subst;
  readonly constraints: readonly KInner[];
  readonly #constraint: KInner;

  constructor(subst: Subst = new Subst(), constraints: Iterable<KInner> = []) {
    this.subst = subst;
    // Unlike CTerm, pyk intentionally does not sort this tuple: its order is
    // inherited from a match/predicate and is observable in `pred()`.
    this.constraints = normalize(constraints);
    this.#constraint = mlAnd(this.constraints);
    Object.freeze(this);
  }

  static fromDict(value: unknown): CSubst {
    const record = asRecord(value, "dictionary");
    const rawSubst = asRecord(required(record, "subst", "dictionary"), "dictionary.subst");
    const bindings = new Map<string, KInner>();
    for (const [name, term] of Object.entries(rawSubst)) bindings.set(name, fromDict(term));
    return new CSubst(
      new Subst(bindings),
      array(required(record, "constraints", "dictionary"), "dictionary.constraints").map((constraint) =>
        fromDict(constraint),
      ),
    );
  }

  static fromPred(pred: KInner): CSubst {
    const [subst, remainder] = extractSubst(pred);
    return new CSubst(subst, flattenLabel("#And", remainder));
  }

  toDict(): CSubstDict {
    const subst: Record<string, JsonObject> = {};
    for (const [name, term] of this.subst) subst[name] = toDict(term);
    return Object.freeze({ subst: Object.freeze(subst), constraints: Object.freeze(this.constraints.map(toDict)) });
  }

  pred({ sortWith, subst = true, constraints = true }: CSubstPredOptions = {}): KInner {
    const predicates: KInner[] = [];
    if (subst) {
      for (const [name, value] of this.subst.minimize()) {
        const sort = sortWith?.sortOf(value) ?? K;
        predicates.push(mlEquals(kvariable(name, sort), value, sort));
      }
    }
    if (constraints) predicates.push(...this.constraints);
    return mlAnd(predicates);
  }

  get constraint(): KInner {
    return this.#constraint;
  }

  addConstraint(constraint: KInner): CSubst {
    return new CSubst(this.subst, [...this.constraints, constraint]);
  }

  apply(cterm: CTerm): CTerm {
    return new CTerm(this.subst.apply(cterm.config), [
      ...cterm.constraints.map((constraint) => this.subst.apply(constraint)),
      ...this.constraints,
    ]);
  }
}
