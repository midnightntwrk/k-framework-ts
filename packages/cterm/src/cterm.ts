/**
 * Immutable constrained states — a focused transcription of pyk's
 * `cterm/cterm.py`.  A CTerm is intentionally not a KAST node: it is the
 * client-side pairing of one configuration cell and matching-logic side
 * conditions that symbolic tools manipulate.
 */

import {
  Subst,
  eq,
  flattenLabel,
  freeVars,
  fromDict,
  hashOf,
  isCell,
  match as matchKast,
  normalizeConstraints,
  reprKInner,
  removeUselessConstraints,
  splitConfigAndConstraints,
  splitConfigFrom,
  toDict,
  type JsonObject,
  type KInner,
} from "@kframework-ts/kast";
import { GENERATED_TOP_CELL } from "@kframework-ts/kast/prelude/k";
import { isBottom, isTop, mlAnd, mlBottom, mlTop } from "@kframework-ts/kast/prelude/ml";
import { ctermAntiUnify, type AntiUnifyOptions, type CTermAntiUnifyResult } from "./anti-unify.js";
import { CSubst } from "./csubst.js";

/** pyk's stable persistence shape; it is not a KAST-JSON document. */
export interface CTermDict {
  readonly config: JsonObject;
  readonly constraints: readonly JsonObject[];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, where: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw new SyntaxError(`Expected an object for CTerm ${where}`);
  }
  return value;
}

function required(record: Readonly<Record<string, unknown>>, field: string, where: string): unknown {
  if (!Object.hasOwn(record, field)) throw new SyntaxError(`CTerm ${where} is missing ${JSON.stringify(field)}`);
  return record[field];
}

function array(value: unknown, where: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new SyntaxError(`Expected an array for CTerm ${where}`);
  return value;
}

/** CPython's string ordering is by code point, not JS UTF-16 code unit. */
function compareText(a: string, b: string): -1 | 0 | 1 {
  if (a === b) return 0;
  let ai = 0;
  let bi = 0;
  while (ai < a.length && bi < b.length) {
    const ac = a.codePointAt(ai) ?? 0;
    const bc = b.codePointAt(bi) ?? 0;
    if (ac !== bc) return ac < bc ? -1 : 1;
    ai += ac > 0xffff ? 2 : 1;
    bi += bc > 0xffff ? 2 : 1;
  }
  return ai === a.length ? -1 : 1;
}

/** Python's `len(str)` counts Unicode code points; JavaScript counts UTF-16 code units. */
function codePointLength(text: string): number {
  let length = 0;
  for (let index = 0; index < text.length; length++) {
    const codePoint = text.codePointAt(index) ?? 0;
    index += codePoint > 0xffff ? 2 : 1;
  }
  return length;
}

function normalizeForCTerm(constraints: Iterable<KInner>): readonly KInner[] {
  const normalized = [...normalizeConstraints(constraints)];
  normalized.sort((left, right) => {
    const l = reprKInner(left);
    const r = reprKInner(right);
    const lLength = codePointLength(l);
    const rLength = codePointLength(r);
    if (lLength !== rLength) return lLength < rLength ? -1 : 1;
    return compareText(l, r);
  });
  return Object.freeze(normalized);
}

/** Structural equality in lieu of JavaScript's identity-only object equality. */
export function ctermEq(left: CTerm, right: CTerm): boolean {
  return (
    eq(left.config, right.config) &&
    left.constraints.length === right.constraints.length &&
    left.constraints.every((constraint, index) => {
      const other = right.constraints[index];
      return other !== undefined && eq(constraint, other);
    })
  );
}

export class CTerm {
  readonly config: KInner;
  readonly constraints: readonly KInner[];
  readonly #kast: KInner;
  readonly #constraint: KInner;
  readonly #freeVars: ReadonlySet<string>;
  readonly #cells: Subst;

  constructor(config: KInner, constraints: Iterable<KInner> = []) {
    if (isTop(config, { weak: true })) {
      this.config = mlTop();
      this.constraints = Object.freeze([]);
    } else if (isBottom(config, { weak: true })) {
      this.config = mlBottom();
      this.constraints = Object.freeze([]);
    } else {
      if (!isCell(config)) throw new TypeError(`Expected cell label, found: ${reprKInner(config)}`);
      this.config = config;
      this.constraints = normalizeForCTerm(constraints);
    }
    this.#kast = mlAnd([this.config, ...this.constraints], GENERATED_TOP_CELL);
    this.#constraint = mlAnd(this.constraints, GENERATED_TOP_CELL);
    this.#freeVars = new Set(freeVars(this.#kast));
    this.#cells = new Subst(splitConfigFrom(this.config)[1]);
    Object.freeze(this);
  }

  static fromKast(kast: KInner): CTerm {
    if (isTop(kast, { weak: true })) return CTerm.top();
    if (isBottom(kast, { weak: true })) return CTerm.bottom();
    const [config, constraint] = splitConfigAndConstraints(kast);
    return new CTerm(config, flattenLabel("#And", constraint));
  }

  static fromDict(value: unknown): CTerm {
    const record = asRecord(value, "dictionary");
    return new CTerm(
      fromDict(required(record, "config", "dictionary")),
      array(required(record, "constraints", "dictionary"), "dictionary.constraints").map((constraint) =>
        fromDict(constraint),
      ),
    );
  }

  static top(): CTerm {
    return new CTerm(mlTop());
  }

  static bottom(): CTerm {
    return new CTerm(mlBottom());
  }

  toDict(): CTermDict {
    return Object.freeze({ config: toDict(this.config), constraints: Object.freeze(this.constraints.map(toDict)) });
  }

  get kast(): KInner {
    return this.#kast;
  }

  get constraint(): KInner {
    return this.#constraint;
  }

  get isBottom(): boolean {
    return (
      isBottom(this.config, { weak: true }) ||
      this.constraints.some((constraint) => isBottom(constraint, { weak: true }))
    );
  }

  get freeVars(): ReadonlySet<string> {
    // A `Set` remains mutable after `Object.freeze` (its entries are internal
    // slots), so never expose the cached instance used by this immutable value.
    return new Set(this.#freeVars);
  }

  get hash(): string {
    return hashOf(this.#kast);
  }

  get cells(): Subst {
    return this.#cells;
  }

  cell(name: string): KInner {
    const found = this.tryCell(name);
    if (found === undefined) throw new RangeError(`No cell named ${JSON.stringify(name)}`);
    return found;
  }

  tryCell(name: string): KInner | undefined {
    return this.#cells.get(name);
  }

  match(other: CTerm): Subst | null {
    const csubst = this.matchWithConstraint(other);
    return csubst === null || !isTop(csubst.constraint) ? null : csubst.subst;
  }

  matchWithConstraint(other: CTerm): CSubst | null {
    const subst = matchKast(this.config, other.config);
    if (subst === null) return null;
    const sourceConstraints = this.constraints.map((constraint) => subst.apply(constraint));
    const residual = other.constraints.filter(
      (constraint) => !sourceConstraints.some((sourceConstraint) => eq(sourceConstraint, constraint)),
    );
    return new CSubst(subst, residual);
  }

  addConstraint(constraint: KInner): CTerm {
    return new CTerm(this.config, [constraint, ...this.constraints]);
  }

  antiUnify(other: CTerm, options: AntiUnifyOptions = {}): CTermAntiUnifyResult {
    return ctermAntiUnify(this, other, options);
  }

  /** Retain constraints reachable from configuration variables (pyk `remove_useless_constraints`). */
  removeUselessConstraints(keepVars: Iterable<string> = []): CTerm {
    return new CTerm(this.config, removeUselessConstraints(this.constraints, [...freeVars(this.config), ...keepVars]));
  }
}
