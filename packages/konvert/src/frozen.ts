/**
 * A `ReadonlyMap` that is read-only at **run time**, not merely in the type
 * system.
 *
 * Internal: deliberately not re-exported from `index.ts`.  Every module-level
 * or cached table in this package goes through {@link frozenMap}.
 */

/**
 * The wrapper {@link frozenMap} returns.
 *
 * `Object.freeze(new Map(…))` — the obvious spelling — freezes the *object* and
 * not the map's contents: `Map.prototype.set` writes to an internal slot that
 * `[[IsExtensible]] === false` does not guard, so a consumer holding a
 * `ReadonlyMap` need only cast it back to `Map` to poison a shared table for
 * the whole process.  A wrapper is the only way to actually deny the write, so
 * the mutators are present and throw.
 *
 * They are absent from `ReadonlyMap`, so this costs nothing in the types; they
 * exist purely so that the cast that gets past the compiler does not get past
 * the run time.
 */
class FrozenMap<K, V> implements ReadonlyMap<K, V> {
  readonly #entries: Map<K, V>;

  constructor(entries: Iterable<readonly [K, V]>) {
    this.#entries = new Map(entries);
    Object.freeze(this);
  }

  get size(): number {
    return this.#entries.size;
  }

  get(key: K): V | undefined {
    return this.#entries.get(key);
  }

  has(key: K): boolean {
    return this.#entries.has(key);
  }

  forEach(callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    // The underlying map is never handed to the callback: that would be a
    // mutable reference to the very thing this class exists to protect.
    for (const [key, value] of this.#entries) callback.call(thisArg, value, key, this);
  }

  keys(): MapIterator<K> {
    return this.#entries.keys();
  }

  values(): MapIterator<V> {
    return this.#entries.values();
  }

  entries(): MapIterator<[K, V]> {
    return this.#entries.entries();
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.#entries[Symbol.iterator]();
  }

  get [Symbol.toStringTag](): string {
    return "FrozenMap";
  }

  set(): never {
    throw new TypeError("Cannot mutate a frozen map");
  }

  delete(): never {
    throw new TypeError("Cannot mutate a frozen map");
  }

  clear(): never {
    throw new TypeError("Cannot mutate a frozen map");
  }
}

/**
 * A genuinely immutable `ReadonlyMap` — see {@link FrozenMap}.
 *
 * There are two reasons every shared table in this package goes through it.
 * The obvious one is that a table nobody can write to is a table nobody can
 * poison.  The less obvious one is that a `Map` has **no prototype chain to
 * inherit string keys from**, where a plain object literal does: with `pure.ts`'s
 * label tables spelled as object literals, `ML_PATTERN_LABELS['toString']`
 * answered `Object.prototype.toString`, and a `KApply` labelled `toString` was
 * routed to the quantifier branch and rejected when it is an ordinary K label
 * that must convert to `LbltoString{}(…)`.  `constructor`, `valueOf`,
 * `hasOwnProperty` and `__proto__` failed the same way.  pyk's tables are
 * `dict`s and have no such inheritance, so this was a transcription artefact
 * and nothing more.
 */
export function frozenMap<K, V>(entries: Iterable<readonly [K, V]>): ReadonlyMap<K, V> {
  return new FrozenMap(entries);
}
