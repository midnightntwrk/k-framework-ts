/**
 * Input boundary for KLean.
 *
 * A definition can be fully parsed in memory or indexed with lazy axiom
 * bodies.  Projection only needs the declaration index until it deliberately
 * inspects an axiom, so this small structural interface keeps a KEVM-sized
 * source from being materialised accidentally.
 */

import {
  forceAxiom,
  indexDefinition,
  parseDefinition,
  type Axiom,
  type Definition,
  type KoreDefinitionIndex,
  type LazyAxiom,
  type LazyDefinition,
  type LazyKoreDefinitionIndex,
} from "@kframework-ts/kore";

/** An axiom as it is stored by a KLean input index. */
export type SourceAxiom = Axiom | LazyAxiom;

/**
 * KORE input suitable for KLean's pure compiler core.
 *
 * `forceAxiom` is intentionally an operation of the source rather than a
 * cast: a `LazyAxiom`'s offsets only make sense with the original text.  The
 * interface is structural so `KompiledDefinition` can be adapted without
 * adding `@kframework-ts/kompiled` as a generator dependency.
 */
export interface KleanSource {
  readonly index: LazyKoreDefinitionIndex;
  forceAxiom(axiom: SourceAxiom): Axiom;
}

/** A `KompiledDefinition`-shaped object accepted without an import dependency. */
export interface KompiledKleanSourceLike {
  readonly koreDefinition: LazyKoreDefinitionIndex;
  forceKoreAxiom(axiom: SourceAxiom): Axiom;
}

/** Return a lazy source over KORE text.  Lazy bodies are the default. */
export function sourceFromKoreText(text: string, options: { readonly lazyAxioms?: boolean } = {}): KleanSource {
  const lazyAxioms = options.lazyAxioms ?? true;
  if (!lazyAxioms) return sourceFromDefinition(parseDefinition(text));
  const index = indexDefinition(parseDefinition(text, { lazyAxioms: true }));
  return memoizedSource(index, (axiom) => (axiom.tag === "Axiom" ? axiom : forceAxiom(text, axiom)));
}

/** Alias with the input-first naming used by the other KORE helpers. */
export const koreTextSource = sourceFromKoreText;

/** Wrap an eagerly parsed KORE definition. */
export function sourceFromDefinition(definition: Definition): KleanSource {
  return sourceFromIndex(indexDefinition(definition));
}

/** Wrap an eager index.  Rejects lazy axioms rather than guessing their text. */
export function sourceFromIndex(index: KoreDefinitionIndex): KleanSource {
  return memoizedSource(index, (axiom) => {
    if (axiom.tag === "Axiom") return axiom;
    throw new TypeError(
      "A lazy KORE axiom requires its source text; use sourceFromKoreText or a KompiledDefinition adapter",
    );
  });
}

/** Adapt a `KompiledDefinition`-shaped source while preserving lazy forcing. */
export function sourceFromKompiled(source: KompiledKleanSourceLike): KleanSource {
  return memoizedSource(source.koreDefinition, (axiom) => source.forceKoreAxiom(axiom));
}

/** Alias that reads naturally at call sites. */
export const kompiledSource = sourceFromKompiled;

/**
 * Force one source axiom.  This exists mainly for consumers that only need a
 * classified axiom and do not otherwise care about the source implementation.
 */
export function forceSourceAxiom(source: KleanSource, axiom: SourceAxiom): Axiom {
  return source.forceAxiom(axiom);
}

function memoizedSource(index: LazyKoreDefinitionIndex, force: (axiom: SourceAxiom) => Axiom): KleanSource {
  const forced = new WeakMap<object, Axiom>();
  return {
    index,
    forceAxiom(axiom): Axiom {
      if (axiom.tag === "Axiom") return axiom;
      const cached = forced.get(axiom);
      if (cached !== undefined) return cached;
      const result = force(axiom);
      forced.set(axiom, result);
      return result;
    },
  };
}

// Keep this type import visible in declaration output: callers commonly have a
// `LazyDefinition` after parsing a text artifact and should not need to import
// parser internals merely to describe their source.
export type { LazyDefinition };
