# KFuzz roadmap

`@kframework-ts/kfuzz` provides concrete KORE-template fuzzing through the LLVM
interpreter. The additions below require a concrete semantics consumer so their
arbitrary distributions and configuration layout can be tested meaningfully.

## Collection arbitraries

Add `Map`, `Set`, and `List` domain-value arbitraries when a consumer needs
them. Build them on `@kframework-ts/kore`'s `mapPattern`, `setPattern`, and
`listPattern` helpers, and define shrink behavior alongside generation.

Exit criterion: a live semantics property exercises generation, shrinking,
seed replay, and KORE encoding for each requested collection type.

## Direct top-cell template builder

Add a documented helper around `topCellInitializer` when a consumer prefers a
no-JVM template construction path over `krun --depth 0`.

Exit criterion: the directly constructed template and K-assembled template
produce equivalent initial configurations for the adopting semantics.
