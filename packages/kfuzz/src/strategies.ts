/**
 * Arbitraries that produce KORE domain values — `kintegers`
 * (`pyk/ktool/kfuzz.py:112-135`) at K `v7.1.337`, plus two siblings built the
 * same way.
 *
 * # `hypothesis.strategies` → `fast-check`
 *
 * The one upstream helper is four lines of substance: take
 * `integers(min_value, max_value)`, `.map` each integer to
 * `DV(SortApp('SortInt'), String(str(value)))`, and optionally wrap the result
 * in an injection.  Every part of that has a direct `fast-check` spelling —
 * `Arbitrary` for `SearchStrategy`, `.map` for `.map`,
 * `fc.bigInt({min, max})` for `integers(min_value=…, max_value=…)` — so this
 * module is a transcription and not a redesign.  The full idiom-by-idiom table
 * is in `README.md`; the one row that shows up *here* is:
 *
 * **`integers()` is `fc.bigInt()`, not `fc.integer()`.**  A K `Int` is
 * arbitrary precision, and so is a Python `int`; `fc.integer()` is a 32-bit
 * signed range and would quietly stop generating the values that break
 * arithmetic semantics.  `number` is accepted at the boundary for convenience
 * and converted with `BigInt(...)`, which throws on a non-integral `number`
 * rather than truncating it.
 *
 * # Why there are three of these and pyk has one
 *
 * `kintegers` is a transcription; {@link kbools} and {@link kstrings} are
 * additions, and they are here because the shape upstream chose — "generate a
 * primitive, wrap it as a `\dv`, optionally inject it into a user sort" — is
 * not specific to `Int`, and a caller who needs a `Bool` should not have to
 * rediscover the `inj` argument order to get one.  Both are marked as
 * deviations in the README.  Nothing else is offered: {@link fromDomainValues}
 * is the general case, and a `Map`/`Set`/`List` generator is not blocked on
 * anything — `@kframework-ts/kore`'s prelude ships the collection builders
 * (`kore/src/prelude.ts:432,455,512,538` for `listPattern`, `setPattern`,
 * `mapPattern`, `rangemapPattern`), so each would be one arbitrary over one
 * builder.  They stay unwritten until a semantics asks for them.
 */

import { sortApp, type Pattern, type Sort } from "@kframework-ts/kore";
// The prelude is a subpath, not part of the barrel: its `INT`/`inj` collide by
// name with `@kframework-ts/kast`'s prelude.  See that module's header.
import { boolDv, inj, INT, intDv, strDv } from "@kframework-ts/kore/prelude";
import * as fc from "fast-check";
import type { Arbitrary } from "fast-check";

/**
 * Wrap a domain value in an injection into `Sort<withInj>` — pyk's `with_inj`
 * (`kfuzz.py:116,131-133`).
 *
 * The parameter is the sort's **bare name**: upstream writes
 * `with_inj='AExp'` and builds `SortApp(f'Sort{with_inj}')`, so `'SortAExp'`
 * would produce `SortSortAExp`.  That spelling is kept, wart and all, because
 * every existing call site upstream is written against it.
 */
function withInjection(from: Sort, withInj: string | undefined, pattern: Pattern): Pattern {
  return withInj === undefined ? pattern : inj(from, sortApp(`Sort${withInj}`), pattern);
}

/** Shared tail of every helper below: the optional injection wrapper. */
export interface DomainValueOptions {
  /**
   * Return the value as an injection into this sort, named **without** its
   * `Sort` prefix — `'AExp'`, not `'SortAExp'`.
   */
  readonly withInj?: string;
}

/** {@link kintegers}' options — pyk's three keyword arguments (`kfuzz.py:112-117`). */
export interface KIntegersOptions extends DomainValueOptions {
  /** Inclusive lower bound.  Unbounded when absent, as upstream's `None` is. */
  readonly minValue?: bigint | number;
  /** Inclusive upper bound.  Unbounded when absent. */
  readonly maxValue?: bigint | number;
}

/**
 * K integers — `kintegers` (`kfuzz.py:112-135`).
 *
 * ```ts
 * const X = kintegers({ minValue: 0, maxValue: 255, withInj: "AExp" });
 * ```
 *
 * @throws {RangeError} — via `BigInt()` — if a bound is a non-integral
 *   `number`.  Upstream cannot hit this case: Python has no float/int union at
 *   this parameter.
 */
export function kintegers(options: KIntegersOptions = {}): Arbitrary<Pattern> {
  const constraints = {
    ...(options.minValue === undefined ? {} : { min: BigInt(options.minValue) }),
    ...(options.maxValue === undefined ? {} : { max: BigInt(options.maxValue) }),
  };
  return fc.bigInt(constraints).map((value) => withInjection(INT, options.withInj, intDv(value)));
}

/**
 * K booleans — **not** in pyk.
 *
 * `fc.boolean()` shrinks towards `false`, which is `hypothesis.booleans()`'
 * behaviour too; nothing about the mapping is surprising here.
 */
export function kbools(options: DomainValueOptions = {}): Arbitrary<Pattern> {
  return fc.boolean().map((value) => withInjection(sortApp("SortBool"), options.withInj, boolDv(value)));
}

/** {@link kstrings}' options. */
export interface KStringsOptions extends DomainValueOptions {
  readonly minLength?: number;
  readonly maxLength?: number;
}

/**
 * K strings — **not** in pyk.
 *
 * `fc.string()` generates from the printable-ASCII unit by default, which is
 * deliberately narrower than K's `String` sort.  Widen it at the call site with
 * `fc.string({ unit: "binary" }).map(strDv)` if the semantics under test cares
 * about non-ASCII; escaping is `@kframework-ts/kore`'s job either way.
 */
export function kstrings(options: KStringsOptions = {}): Arbitrary<Pattern> {
  const constraints = {
    ...(options.minLength === undefined ? {} : { minLength: options.minLength }),
    ...(options.maxLength === undefined ? {} : { maxLength: options.maxLength }),
  };
  return fc.string(constraints).map((value) => withInjection(sortApp("SortString"), options.withInj, strDv(value)));
}

/**
 * The general case: an arbitrary over anything, mapped into a KORE pattern and
 * optionally injected.
 *
 * This is the escape hatch the three helpers above are special cases of, and
 * the thing to reach for when the value being generated is not a domain value
 * at all — a whole program term, say, built by an `fc.letrec` grammar.
 *
 * ```ts
 * const bytes = fromDomainValues(fc.uint8Array(), bytesDv, BYTES, { withInj: "Word" });
 * ```
 */
export function fromDomainValues<T>(
  arbitrary: Arbitrary<T>,
  toPattern: (value: T) => Pattern,
  from: Sort,
  options: DomainValueOptions = {},
): Arbitrary<Pattern> {
  return arbitrary.map((value) => withInjection(from, options.withInj, toPattern(value)));
}
