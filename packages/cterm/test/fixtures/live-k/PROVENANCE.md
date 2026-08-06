# Live-K CTerm fixture provenance

These small definitions are the inputs for `../live-k.test.ts`, an opt-in
conformance lane for the async `CTermSymbolic` adapter. The test re-compiles
them in a fresh temporary directory; no generated `*-kompiled` output is
checked in because it carries machine-specific source paths.

## Source

| fixture | upstream source | origin | fixture sha256 |
| --- | --- | --- | --- |
| `simple-proofs.k` | `pyk/src/tests/integration/test-data/k-files/simple-proofs.k` | byte-for-byte copy | `362ce22515b9270f33259753a4b8ecadcd5f25c0fde8e70d04c59085cf4a9dca` |
| `multiple-definitions.k` | `pyk/src/tests/integration/cterm/test_multiple_definitions.py` | the `KOMPILE_DEFINITION` literal, dedented without changing its K text | `b4239e680401df64f4c7929775ad380a7afeaa5a62bd9f0cf53df15e8043c80e` |

Both sources are from `runtimeverification/k` tag `v7.1.337`, commit
`4a46d1231473b599c699160132fd6e76a5c46406`. The scenario assertions come
from that tag's `pyk/src/tests/integration/cterm/test_simple.py`
(`d549a445def6c088c90eee96b2b8ffd2e5b6cf3e1f507f251cd9d429abae0bd6`)
and `test_multiple_definitions.py` (source hash below). They are BSD-3-Clause
material; the package's `THIRD-PARTY-NOTICES.md` carries the applicable notice.

The containing `test_multiple_definitions.py` source hashes to
`da80bbf026809092381002574ceb38090fc227b9d7a3bb7844a229f7f1e1359a`;
the fixture's distinct checksum is expected because Python's indented
triple-quoted literal becomes a standalone `.k` file for this harness.

## Reproduction

The lane is deliberately inert unless explicitly enabled:

```sh
KFRAMEWORK_TS_K_BIN=/path/to/k-7.1.337/bin \
bun test packages/cterm/test/live-k.test.ts
```

`KFRAMEWORK_TS_K_BIN` selects the pinned distribution. Omit it only when the
correct K tools are already first on `PATH`. Each run uses public
`@kframework-ts/ktool` and `@kframework-ts/kore-rpc/server` APIs to compile,
start a Haskell `kore-rpc` server, and remove its own temporary output.
