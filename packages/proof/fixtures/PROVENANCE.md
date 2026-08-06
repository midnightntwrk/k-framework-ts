# Proof fixture provenance

Two fixtures, two different jobs. `pinned-pyk-proof.json` is a generated
oracle for this package's serializers, key order included. `upstream/kontrol/`
is unmodified real-world data: two complete proof directories a released
Kontrol wrote, plus the golden its `foundry list` prints for them.

Neither format carries a version field, so runtime identity is recorded here
and enforced by checksum rather than inferred from the documents.

## Pinned pyk proof documents

`pinned-pyk-proof.json` bundles, for each of seven cases, the exact JSON *text*
pyk produced: `proof.json` (the proof-data schema), `.dict` (the embedded-KCFG
schema), the `kcfg/` store index and node files where applicable, plus rendered
summaries, `formatted_exec_time` vectors, and the observable results of two
upstream quirks (`from_dict`'s refutation guard and `RefutationProof`'s
antecedent re-wrapping). Storing the text, not a re-parsed object, is what lets
the test suite pin pyk's key order without depending on Python's `json.dumps`
separators.

| field             | value                                                       |
| ----------------- | ----------------------------------------------------------- |
| repository        | `runtimeverification/k`                                     |
| tag               | `v7.1.337`                                                  |
| K commit          | `4a46d1231473b599c699160132fd6e76a5c46406`                  |
| pyk sources       | `pyk/src/pyk/proof/{proof,reachability,implies}.py`         |
| fixture generator | `generators/generate-pinned-pyk-proof.py`                   |
| generated         | 2026-08-06                                                  |
| fixture SHA-256   | `234f1a5bda099d81cf0717a7fd99592cbd307eb9ea7aeda3caf2e2539a642ecf` |

The generator uses pyk's public `APRProof`/`EqualityProof`/`RefutationProof`
API and writes what pyk writes; it is not a TypeScript serializer producing a
lookalike.

### Pinned source hashes

Run against `v7.1.337`:

```text
$ git show v7.1.337:pyk/src/pyk/proof/proof.py | sha256sum
98d9d61a40ff1d2e0f948cdf305c7f7f590c240bc9b50b6863101bca50ab62fb  -  (638 lines)

$ git show v7.1.337:pyk/src/pyk/proof/reachability.py | sha256sum
dfc1f86ef0e8cae44c5833efd4b0d613ee90ff4d7747e0663d3c575b0191fd30  -  (1079 lines)

$ git show v7.1.337:pyk/src/pyk/proof/implies.py | sha256sum
41e9a5c4f0428bd59ff1eaad88b4e6eea0b7e43943f90f277bcc11a591059b0d  -  (478 lines)

$ git show v7.1.337:pyk/src/tests/unit/test_proof.py | sha256sum
7f136d7f168dff9c13104e8e724ab0f7b66821ab44e1092347b1ddc120e35447  -  (500 lines)
```

### Reproduction

Use the virtual environment of a K source checkout at the exact commit above.
From this repository's root:

```sh
/path/to/k/pyk/.venv/bin/python \
  packages/proof/fixtures/generators/generate-pinned-pyk-proof.py
```

The generator prints the SHA-256 it wrote; it must match the table.

## Vendored Kontrol proof directories

`upstream/kontrol/` holds two complete, unmodified proof directories from
Kontrol's own unit test data — one that passes and one that fails — together
with the `foundry list` golden covering all five proofs in that data set. They
are the only cross-implementation oracle available for the proof-data format:
real bytes, written by a released tool, that this package must read and
classify identically.

| field             | value                                                        |
| ----------------- | ------------------------------------------------------------ |
| source repository | `https://github.com/runtimeverification/kontrol`             |
| source commit     | `0fe0cc40da2cd2dbd8675ccde68db10f3f6631be`                    |
| copied            | 2026-08-06                                                    |
| source directory  | `src/tests/unit/test-data/foundry-list/`                     |
| vendored directory| `upstream/kontrol/`                                           |
| omitted           | the three remaining `apr_proofs/` entries (~1.2 MB, no new shapes) |

Directory names are **renamed**, contents are not. Kontrol's proof ids are
claim labels used verbatim as directory names — `test%AssertTest.setUp():0` —
and `:` cannot appear in a path on Windows, so a checkout would fail. The
same rename is applied in `packages/kcfg/fixtures/upstream/kontrol/`.

| source proof id                            | vendored directory                 |
| ------------------------------------------ | ---------------------------------- |
| `test%AssertTest.setUp():0`                | `assert-test-setup`                |
| `test%AssertTest.test_assert_false():0`    | `assert-test-test-assert-false`    |

The `id` field *inside* each `proof.json` still carries Kontrol's original
label. pyk keys a proof by its directory name and ignores that field when
reading an `APRProof` (`reachability.py:577-616`), so reads succeed and
`proof.id` is the vendored directory name. The tests account for exactly this.

| vendored path                                     | SHA-256                                                            |
| -------------------------------------------------- | ------------------------------------------------------------------ |
| `assert-test-setup/proof.json`                     | `329896b3f4c61b2046fa23fa411428923d2bcf169b90931240fd55e25b60e896` |
| `assert-test-setup/kcfg/kcfg.json`                 | `e52af7869c2a624d40209c217a83d58cf87a7881b084da7b2edd4da9eb8d6e9b` |
| `assert-test-setup/kcfg/nodes/1.json`              | `5a05a732f83ecd3bd284426163dea56d8422765b4163396299349dfa8c5c3b2d` |
| `assert-test-setup/kcfg/nodes/2.json`              | `9222bea2754a354d401b1e9fe1d6da753dd85e2911f84b45cea83ba6f98c4482` |
| `assert-test-setup/kcfg/nodes/3.json`              | `c57b0dfeaab99dce9d08509d6d419ea54e342a3fec26adf9993fbf5b2127b5b5` |
| `assert-test-test-assert-false/proof.json`         | `b5bb59434cb3a5c6dd4f44c853b0837c3285c76742ee0a703d20f1a25e255877` |
| `assert-test-test-assert-false/kcfg/kcfg.json`     | `7a83aa0ac00a000fd0eb15e009fb936a16ac022431af4778c782da801811e839` |
| `assert-test-test-assert-false/kcfg/nodes/1.json`  | `5a05a732f83ecd3bd284426163dea56d8422765b4163396299349dfa8c5c3b2d` |
| `assert-test-test-assert-false/kcfg/nodes/3.json`  | `b841c8cc6d02d76363a21d1a0b636bef03ddf71950aec2d75fb5732c35a594d1` |
| `assert-test-test-assert-false/kcfg/nodes/4.json`  | `2a51d1fec4601a9589881ed2cbab832fc8d6ad1ef44945f2d323d45cf6fddf6c` |
| `assert-test-test-assert-false/kcfg/nodes/5.json`  | `98602b1992f94776ee1c621f0e0c50c8cba8b0089d1f7349985396a7579df218` |
| `assert-test-test-assert-false/kcfg/nodes/6.json`  | `791c30102d197942de0ee139b02b6277a8a692340d7570e07eff8a4fdbd82449` |
| `foundry-list.expected`                            | `667a5b8ca1e1da1e8ec2f135fc9edc26d2216d1fd08dff8077513f6c4d8faec9` |

The tests verify every hash before reading, so a fixture cannot quietly become
a hand-normalized lookalike. Round-trip output is written under the operating
system temporary directory; nothing writes into `fixtures/`.

### What a round trip does and does not preserve

Reading either directory and writing it back reproduces the same *documents* —
same keys, same values, same order — but not the same bytes. Three differences,
all understood, all pinned by tests:

1. **JSON separators.** Python's `json.dumps` writes `", "` and `": "`;
   `JSON.stringify` writes `","` and `":"`. This accounts for the entire
   difference in every `nodes/<n>.json` file.
2. **Two keys Kontrol's writer predates.** `execution_time` and `loops_cache`
   are unconditional in pyk at `v7.1.337` and absent from these files. Writing
   them back adds both, exactly as current pyk would.
3. **Falsy keys in `kcfg.json`.** `to_dict_no_nodes` (`kcfg.py:622`) drops
   empty collections at `v7.1.337`; these files still carry `covers`, `splits`,
   `ndbranches`, and `aliases` as empty. Again, current pyk would also drop them.

### Golden fixtures

`golden/` holds documents this package generated and froze, so a change in what
it writes shows up as a diff rather than as silence. They are ours, not
upstream's, and carry no third-party provenance.

`golden/written-bytes.json` pins the store's output. `golden/show/` pins the
display layer, and deserves the warning spelled out: **pyk has no show
goldens at all.** `exec_show` prints and nothing asserts, so there is no
upstream oracle for any of these files — they record what `src/show.ts`
produces today, after a line-by-line review against
`pyk/src/pyk/proof/show.py` at `v7.1.337`
(`b31675dc6714137dedb100d4e7efef7d4e5799c7f04d50657e21ca864a8f655b`).

| file | proof underneath | printer | written by |
| --- | --- | --- | --- |
| `show/kontrol-pretty.txt` | vendored `upstream/kontrol/assert-test-test-assert-false` | structural stub | `test/show.test.ts` |
| `show/kontrol-show.txt` | same, with the `SUMMARY-…` module | structural stub | `test/show.test.ts` |
| `show/kontrol-graph.dot` | same, as DOT | structural stub | `test/show.test.ts` |
| `show/live-imp-addition-1-pretty.txt` | `IMP-SIMPLE-SPEC.addition-1`, proved here | real `KPrint` | `test/live-show.test.ts` |
| `show/live-imp-addition-1-show.txt` | same, with the `SUMMARY-…` module | real `KPrint` | `test/live-show.test.ts` |
| `show/live-imp-addition-1.dot` | same, as DOT | real `KPrint` | `test/live-show.test.ts` |
| `show/chain-pretty-rules.txt` | the hand-built `chain()` proof, `{ showRules: true }` | structural stub | `test/show.test.ts` |

`chain-pretty-rules.txt` has no upstream counterpart in a second sense:
`showRules` is `@kframework-ts/kcfg`'s own addition and pyk's `KCFGShow` never
names a rule, so there is no pyk rendering it *could* agree with. It exists to
keep the `rules:` blocks stable; that the option costs parity nothing when it
is off is pinned separately, by the same test file.

The three `kontrol-*` files are hermetic: the *proof* is real third-party data
(see the Kontrol section above), only the rendering is ours. The three
`live-imp-*` files need `KFRAMEWORK_TS_K_BIN` and are regenerated with
`KFRAMEWORK_TS_SHOW_GOLDEN=update`; they were last verified byte-stable across
two independent proving runs at K `v7.1.337`.

## Live-K definitions and specs (`live-k/`)

The K sources the opt-in real-K suite (`test/live-k.test.ts`) kompiles and
proves. They exist only so the ladder can run hermetically once K is present;
nothing here is read by the offline tests.

| field             | value                                                        |
| ----------------- | ------------------------------------------------------------ |
| source repository | `https://github.com/runtimeverification/k`                   |
| tag               | `v7.1.337`                                                    |
| K commit          | `4a46d1231473b599c699160132fd6e76a5c46406`                    |
| copied            | 2026-08-06                                                    |

| vendored path             | upstream path                                                        | SHA-256                                                            |
| ------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `live-k/test.k`           | `k-distribution/tests/regression-new/profile/test.k`                 | `2cbf3d8cabbe86fadf9d92dbe0cad6e5019b867c165f68c7e3314c7733e3d5d7` |
| `live-k/test-spec.k`      | `k-distribution/tests/regression-new/profile/test-spec.k`            | `3b1586e95145bb5b4fbc64722257f440cd3361f107a43e1587a7aebf158b71c1` |
| `live-k/simple-proofs-spec.k` | `pyk/src/tests/integration/test-data/k-files/simple-proofs-spec.k` | `b935eaaa613c7d26a5ccf65dd25591dda77b4510532542c271be91167184a0f1` |
| `live-k/non-det-spec.k`   | `pyk/src/tests/integration/test-data/k-files/non-det-spec.k`         | `1b332fba86d60d846e7900923e906b72064eb417e35cf245f261306291d04fdf` |
| `live-k/refute-node.k`    | `pyk/src/tests/integration/test-data/k-files/refute-node.k`          | `7b0bc51a9e83ba55a9d1a66d5d42f1794197ccf0587bd259df023b04c6fdf6c3` |
| `live-k/refute-node-spec.k` | `pyk/src/tests/integration/test-data/k-files/refute-node-spec.k`    | `893baaa038989782d37f0fa4dd2072943a884f53df13656ebbc5fe1b6106571f` |
| `live-k/imp-verification.k` | `pyk/src/tests/integration/test-data/k-files/imp-verification.k`   | `3773eacf471f1aad5412988c0871f73f9ba0d791bcbeeef10e6a4dba77dd6536` |
| `live-k/imp-simple-spec.k` | `pyk/src/tests/integration/test-data/k-files/imp-simple-spec.k`     | `1d7d108435135a0777b82f1e44d6bddf21f9af9767902e0be6bd4504c4a273d6` |
| `live-k/goto.k`           | `pyk/src/tests/integration/test-data/k-files/goto.k`                 | `b227da81374a4cc97fad1ef627f43a7d1a071f4ed2d964b63945122fddec5b21` |
| `live-k/cell-map-spec.k`  | `pyk/src/tests/integration/test-data/k-files/cell-map-spec.k`        | `de1ef9c398e97c1d9650c94c3f06c65064a6e5cda8ea672b0b931231f36ff6f4` |

Those ten are byte-for-byte upstream. One file is **not**:

| vendored path      | derived from                                                  | upstream file SHA-256                                              |
| ------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------ |
| `live-k/non-det.k` | `pyk/src/tests/integration/proof/test_non_det.py:35-62`       | `4e698c945ee0aaed064095d2347d15eeb6ba42133c54e9ce5bd4bfe830601d76` |

`test_non_det.py` carries its K definition inline, as the `KOMPILE_DEFINITION`
class attribute of a Python string — pyk's own harness writes it to a temporary
file before kompiling. Extracting it into a real `.k` file is the only change:
the surrounding quotes and the uniform four-space Python indentation are gone,
every module, sentence and comment is upstream's, and a header comment in the
file says so. The hash above is of the Python file it came from.

`imp-simple-spec.k` is upstream's central spec asset: `IMP-FUNCTIONAL-SPEC`'s
twelve equality claims, `IMP-SIMPLE-SPEC-DEPENDENCIES`, and the ~24 APR claims
of `IMP-SIMPLE-SPEC`. Both `live-k.test.ts` (the twelve equality rows) and
`live-imp.test.ts` (the APR rows) read this complete specification.

Three definitions are **not** vendored here at all, and are reached through K's
include path instead — the same cross-package fixture reference
`packages/kcfg/test/live-k.test.ts` makes into `packages/cterm`:

| needed by                      | resolved from                                    |
| ------------------------------ | ------------------------------------------------ |
| `live-k/simple-proofs-spec.k`  | `packages/konvert/fixtures/src/simple-proofs.k`  |
| `live-k/imp-verification.k`    | `packages/kompiled/fixtures/src/imp.k`           |
| `live-k/cell-map-spec.k`       | `packages/konvert/fixtures/src/cell-map.k`       |

`packages/konvert/fixtures/src/cell-map.k` is byte-identical to
`pyk/src/tests/integration/test-data/k-files/cell-map.k` at this release
(`f4742172487a5436178daba47d29474ce8668a623fddb32fc29d554ec74e46de`).

`packages/kompiled/fixtures/src/imp.k` is byte-identical to
`pyk/src/tests/integration/test-data/k-files/imp.k` at this release
(`c2fe46e2ad72d1cc181321e1b9b70318b3103c271ab34e2e06ccd890e06fec11`), and
carries its own provenance entry in that package.

The upstream integration tests the live suites port are, with their hashes at
this release:

| upstream test                                   | lines | ported by                | SHA-256                                                            |
| ----------------------------------------------- | ----- | ------------------------ | ------------------------------------------------------------------ |
| `proof/test_simple.py`                          | 78    | `live-k.test.ts`         | `1daeabbf6d1024affefeaa0faf2cb0e18850d49936ca9308e9741ab0351a2c1e` |
| `proof/test_non_det.py`                         | 135   | `live-k.test.ts`         | `4e698c945ee0aaed064095d2347d15eeb6ba42133c54e9ce5bd4bfe830601d76` |
| `proof/test_refute_node.py`                     | 340   | `live-k.test.ts`         | `eea06c22a5f189e039eb58e883ba94f5562a6730d777f457b476e29315c4cdd8` |
| `proof/test_implies_proof.py`                   | 221   | `live-k.test.ts`         | `3d8c90157c05193c34bd723495e8829c737225e7b66fb95c97041a83a7fca040` |
| `proof/test_imp.py`                             | 1615  | `live-imp.test.ts`       | `bfd3baafada2ace565f8f612a87f2276b1d4cf73b37f1cf7eaecec02030e2c6f` |
| `proof/test_goto.py`                            | 128   | `live-goto.test.ts` (skipped) | `fa4e77c8d0dad273854c5b1012fd3dfdb054fdabff3474e90745af219ec2fdc9` |
| `proof/test_cell_map.py`                        | 154   | `live-cell-map.test.ts`  | `e4a61cb8c7e5e55164089e93859b0e8aabc317aeac2c7aac1d3ae480ecccf43e` |
| `proof/test_prove_rpc.py`                       | 211   | `live-facade.test.ts`    | `9b1fa7fd27df601d8ff58bd1fa266cd2f1c4dad15af107be18fc3579c37ed9e6` |

`test_goto.py`'s row is transcribed but skipped: its first subsumption check
asks Z3 whether `0 <=Int N` implies `?S ==Int (N *Int (N +Int 1)) /Int 2`, and
on this K install the solver is canceled instead of answering, which `kore-rpc`
reports as an SMT error. Upstream pyk fails at exactly the same query on the
same install, so `goto.k` stays vendored and the suite stays one `.skip` away
from running; `test_imp.py`'s BMC rows cover `bmc_depth` in the meantime.

The hello-world rung has no pyk counterpart — it is `k-distribution`'s smallest
proving regression test. `test_prove_rpc.py` is a *behavioural* oracle only:
this package does not port `ProveRpc`, and `live-facade.test.ts` runs the same
spec file through `proveClaims` instead.
