# Fixture provenance

Every JSON file in this directory is **byte-for-byte what K actually wrote**.
None of it is hand-authored, and none of it has been reformatted, pretty-printed
or trimmed. That is the whole point: this package is a hand-transcription of a
Java file, and a hand-transcription is not self-verifying. These fixtures are
the evidence.

(Two qualifications. The first, spelled out in the `upstream/` section below:
six files there — three per KAST version — were written by **pyk**, the other
producer of KAST JSON, driven by a checked-in generator script, because K's
Java toolchain never emits those node types, and in one case *cannot*. Their
term bytes are pyk's own serializer's, unedited. The second: `src/` holds two
files that are K's **input**, not its output — the definition and program the
`mint-width` fixtures were compiled from, kept so those fixtures can be
reproduced.)

That sentence was briefly false, and how it was made true again is worth
recording. The first `.oxfmtrc.json` used biome's key names rather than oxfmt's,
and it had no `ignorePatterns`; oxfmt ignores keys it does not recognise, so the
formatter ran over `fixtures/` and pretty-printed all thirteen files before they
were first committed — half the bytes in this directory were indentation the
formatter had added. The structure was never touched, but the claim above was.

Restoring it needed no regeneration. `krun --output json` emits exactly the
canonical form `JSON.stringify` produces — verified byte-for-byte against a
fresh `krun` on this toolchain — so parsing each fixture and re-serialising it
compactly reproduces K's own output exactly. `.oxfmtrc.json` now names oxfmt's
real keys and excludes this directory, so the formatter cannot reach it again.

## Toolchains

Two, one per KAST version. The v3 fixtures were generated first; the `v4/`
subdirectories were generated later by re-running **the same definitions and
the same programs** through the v4 toolchain.

```
$ kompile --version                      $ kompile --version   # v4 toolchain
K version:    v7.1.191                   K version:    v7.1.337
Build date:   Mon Jan 13 07:59:03 JST 2025    Build date:   Wed Aug 05 08:59:03 JST 2026
```

|                             | v3 fixtures                                               | `v4/` fixtures                                            |
| --------------------------- | --------------------------------------------------------- | --------------------------------------------------------- |
| K release                   | `v7.1.191`                                                | `v7.1.337`                                                |
| K commit for that tag       | `06a03e825b9ca8ef030e4b9014c2a0767cccdf5a`                | `4a46d1231473b599c699160132fd6e76a5c46406`                |
| KAST format version emitted | `3` (`ToJson.version`)                                    | `4` (`ToJson.version`)                                    |
| K install path              | `/nix/store/4lhclc1zw38sq795ck310yni2jb3ggdg-k-7.1.191-…` | `/nix/store/y63xkr8pk2bqd5lh4889rlwldw26v9f4-k-7.1.337-…` |
| Generated                   | 2026-08-03                                                | 2026-08-05                                                |

## The files this package is transcribed from

The package transcribes every byte-distinct revision of the two authority
files since KAST v3; the full manifest, with per-revision hashes and release
ranges, is exported as `TRANSCRIBED_FROM` in `src/version.ts`. The two
revisions the fixtures here exercise:

```
$ git show v7.1.191:k-frontend/src/main/java/org/kframework/unparser/ToJson.java | sha256sum
8756c9d8bb1fd9dab3d1e0b6ff7bd9ba019596afb1e04b4c09ad11bf7c1e2c7b   (493 lines)

$ git show v7.1.191:k-frontend/src/main/java/org/kframework/parser/json/JsonParser.java | sha256sum
288e39a57fc0bba901d37738ff5d067c94181ae289c2f2868ff223f2a3d1d1fd   (468 lines)

$ git show v7.1.337:k-frontend/src/main/java/org/kframework/unparser/ToJson.java | sha256sum
1003e8c003abad22cdbdcd14dc64471246e7a5fa39760471297613de7def1c65   (493 lines)

$ git show v7.1.337:k-frontend/src/main/java/org/kframework/parser/json/JsonParser.java | sha256sum
ee7152871ff838531bc8fb670c95071f5295bcf9c918a1d7aaffe183ef8ee416   (474 lines)

$ git show v7.1.337:k-frontend/src/main/scala/org/kframework/kore/ADT.scala | sha256sum
369b9cd8591d02ff2f07db4fdbec0fd26c18a505b041d4f0519e962c944b5ec2   (125 lines; byte-identical at v7.1.191)
```

`ADT.scala` is the third authority: its `Sort.toString` (`ADT.scala:73-80`)
defines the flat sort spelling `flattenSort` transcribes, which is how v4
structure is read through the v3-shaped `KTerm`.

## Source material

The K definition compiled here is the `panopticon` language, a small imperative
language used for formal-verification research. Its sources were **copied out**
to a temporary directory before compiling; nothing was ever written back to the
originating tree. One further definition, `mint-width`, was written for this
package and is stored in `src/`; it has its own section below.

|                    |                                                                                               |
| ------------------ | --------------------------------------------------------------------------------------------- |
| Definition sources | `panopticon/K/spec/panopticon-{syntax,types,semantics}.md`                                    |
| Test programs      | `panopticon/K/tests/corpus/**/*.panop`, plus one program written for this package (see below) |

## How the definition fixtures were made

```
kompile <tmp>/spec/panopticon-semantics.md \
  --main-module PANOPTICON-SEMANTICS --syntax-module PANOPTICON-SYNTAX \
  --warnings-to-errors --emit-json -o <tmp>/build/panop-semantics

kompile <tmp>/spec/panopticon-types.md \
  --main-module PANOPTICON-TYPES --syntax-module PANOPTICON-SYNTAX \
  --warnings-to-errors --emit-json -o <tmp>/build/panop-types
```

`--emit-json` writes both `parsed.json` and `compiled.json` into the output
directory; both are kept, for both definitions, because they differ in ways this
package's tests depend on:

- **`parsed.json`** is the definition as written. It carries the grammar the
  parser actually accepts, and **no `UNIQUE_ID` attributes at all** — rule
  identity is assigned during compilation.
- **`compiled.json`** is the definition after compilation. It has acquired
  projection and predicate productions, injections, and a `UNIQUE_ID` on every
  rule. It spells an empty user list in its _semantic_ form, which the parser
  would not accept.

Reading grammar out of `compiled.json`, or rule identity out of `parsed.json`,
means reading the wrong artifact. `test/conformance.test.ts` pins both facts.

| file                                       | node count / notes                                             |
| ------------------------------------------ | -------------------------------------------------------------- |
| `definition/panop-semantics.parsed.json`   | 59 modules, 122 rules (0 with `UNIQUE_ID`)                     |
| `definition/panop-semantics.compiled.json` | 59 modules, 449 rules (449 with `UNIQUE_ID`, **362 distinct**) |
| `definition/panop-types.parsed.json`       | 59 modules, 151 rules                                          |
| `definition/panop-types.compiled.json`     | 59 modules, 472 rules                                          |

## How the term fixtures were made

```
krun --definition <tmp>/build/<definition> <program>.panop --output json
```

| file                                  | definition | shape it covers                                                                                     |
| ------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------- |
| `term-semantics-value-int.json`       | semantics  | a value result (`returned 7`); **empty** builtin `List` in `<out>`; empty `Map`s                    |
| `term-semantics-value-unit.json`      | semantics  | a unit value result                                                                                 |
| `term-semantics-trap-divzero.json`    | semantics  | a trap outcome                                                                                      |
| `term-semantics-output-effects.json`  | semantics  | output effects; non-empty `<out>`; **non-empty AC `Map`** with 3 entries; single-element user list  |
| `term-semantics-output-gcd.json`      | semantics  | a longer program with output                                                                        |
| `term-semantics-user-list-multi.json` | semantics  | **3-element user list** and a 2-element builtin `List` (`_List_` of two `ListItem`s)                |
| `term-types-accepted.json`            | types      | an acceptance verdict                                                                               |
| `term-types-accepted-unit.json`       | types      | acceptance of a larger program                                                                      |
| `term-types-rejected.json`            | types      | a rejection verdict with an error code; a **`Set`** in `<scope>`; a single-entry `Map` emitted bare |

All programs come from `panopticon/K/tests/corpus/` except
`term-semantics-user-list-multi.json`, which was compiled from a program written
for this package specifically to produce a user list longer than one element
(the corpus had none):

```
event Trio(a: int, b: int, c: int);
event Solo(v: int);
emit Trio(1, 2, 3);
emit Solo(9);
```

## The instantiated parametric sort (`mint-width`, and `src/`)

The panopticon definitions never mention a parametric sort of their own, so
`MInt{Width}` reaches their fixtures only through K's builtins, where it is
always *uninstantiated*. `mint-width` exists to close that: it is a K
definition written for this package whose whole job is to put an
**instantiated** `MInt{64}` into a compiled definition and into a final
configuration, at both KAST versions.

Its two input files are stored byte-for-byte under `src/`. Alone among the data
files here they are not a producer's **output** — they are what K was given:

| file               | what it is                                              |
| ------------------ | --------------------------------------------------------- |
| `src/mint-width.k` | the definition; `syntax MInt{64}` plus a two-cell configuration |
| `src/value.mint`   | the program, one line: `mk`                              |

```
kompile <src>/mint-width.k \
  --main-module MINT-WIDTH --syntax-module MINT-WIDTH-SYNTAX \
  --warnings-to-errors --emit-json -o <build>

krun --definition <build> <src>/value.mint --output json
```

run once per toolchain, unchanged between them.

| file                                  | from                                                     |
| ------------------------------------- | ---------------------------------------------------------- |
| `definition/mint-width.compiled.json` | `<build>/compiled.json`, `v7.1.191`                      |
| `definition/v4/mint-width.compiled.json` | `<build>/compiled.json`, `v7.1.337`                    |
| `term/term-mint-width-value.json`     | the `krun` above, `v7.1.191`                             |
| `term/v4/term-mint-width-value.json`  | the `krun` above, `v7.1.337`                             |

`parsed.json` is **not** vendored for this definition, unlike the panopticon
pair. Its set of node types is exactly `compiled.json`'s here, it carries no
sort shape the compiled artifact does not, and the one difference between the
two that this package's tests turn on — `UNIQUE_ID` presence — is already
pinned, at both K versions, on the panopticon fixtures.

Two things about the definition are deliberate, and both are recorded in its
header comment:

- `MInt{64}` is the deepest parametric sort obtainable from the Java frontend
  at all. K rejects a user-defined parametric sort outright, with
  "User-defined parametric sorts are currently unsupported"
  (`k-distribution/tests/regression-new/checks/checkParametricSort.k` at
  `v7.1.337`); instantiating the builtin `MInt` is legal, nesting is not.
- The `7p64` literal lives in a rule, not in the program. At `v7.1.191` an
  `MInt` literal parsed out of a *program* reaches the final configuration with
  its value replaced by the literal's character count — `mk(7p64)` yields
  `4p64`, `mk(42p64)` yields `5p64` — which `v7.1.337` does not do. Written
  the other way the two toolchains would disagree about the final
  configuration, and the term fixtures' whole point is that they do not.

Both compiled definitions carry exactly one `KProduction` whose own sort is
`MInt{64}` and two `KNonTerminal`s of that sort; `test/conformance.test.ts`
pins that census, together with the sort arriving flat at v3 and structured at
v4.

## Checksums

One correction is itself part of the record: the thirteen panopticon values
first committed in this block did not match the files committed beside them —
true from the first commit on, so the hashes were evidently taken from some
earlier state of the files and never recomputed. The fixture bytes themselves
check out: each file is canonical compact JSON
(`JSON.stringify(JSON.parse(x)) === x`), and every conformance test reads them
successfully. Only the recorded evidence about them was wrong. Recomputed
2026-08-05 from the files as committed.

```
9ec3e3bd6d784b773bbdc59871d79ca9c09abd0a764805433106c7c8edf90aaf  definition/mint-width.compiled.json
50345d818fa7eb280651c8dd661661d64cddffde061fd96f6eb34f70a26092db  definition/panop-semantics.compiled.json
73ac7d7a6f2f57711486843c0c7f29fe9bf2f01b8417039680260983677f94e8  definition/panop-semantics.parsed.json
dbd0ad5200809fd5ee35e44c4d9a9a98d4b1cc1f287175c4239b2a5cab3ef7cc  definition/panop-types.compiled.json
f670689e425dc822271b60b191ab511567a80ec6d2b562fbaf37028775467758  definition/panop-types.parsed.json
89bff7178c55333796cb28c71cc1100587daa20d7882dbdff6718866569c981f  src/mint-width.k
2dc37e683bf382d688a542b4d214f74c2ccac71a9d7e99f1aadb8d8eb4133e97  src/value.mint
73c858a6e175a1369a35b675f28bc91d4b804181cd7eaf9c896c02f8586dbe8a  term/term-mint-width-value.json
19d3a3e0015c309394c445c380d9b3b8f4c21dd18178cfaa5408cb102be09de6  term/term-semantics-output-effects.json
9186fd3abf7ce392bb07629fa8c7c1a4a5cc610637ef91e1f91a12e128bd741b  term/term-semantics-output-gcd.json
7c26db8375c1d1b1e6217b04c9870fdc3d762388e79bf1ecb48f4e31c8deb2e6  term/term-semantics-trap-divzero.json
0e22759adfd1bdde749ce0ef1101b029ad8d3f543779a49fcb957743f66a2dc4  term/term-semantics-user-list-multi.json
572fae0efe0f6e5caaf6fec3e5fe88c80e80b705f6f036c50dd51f78cfa480aa  term/term-semantics-value-int.json
85b0219b1ddb8416ad037939a70ac219cb505913a7f37ceec8d1c60b92e8cca9  term/term-semantics-value-unit.json
280e6ca9244633d0f81d75ffa93aa1dbf13581c5a9358a0935feb9d58a1cb820  term/term-types-accepted-unit.json
4bdfe72c92167530f13466493ef5dc70d53dbbe6bb4dfb6f1f12d1970573c7a8  term/term-types-accepted.json
1ee77006b32ebce2e3945843a6608408716dcc819706b0e3118dd7db4c00ed44  term/term-types-rejected.json
```

## The v4 regeneration (`definition/v4/`, `term/v4/`)

The same panopticon definitions were re-kompiled, and the corresponding
programs re-krun, with the `v7.1.337` toolchain — identical commands, only the
K install differs. File names mirror the v3 fixtures exactly, so each `v4/`
file pairs with the fixture of the same name one directory up.

Two different pairing guarantees, and the tests enforce exactly the one each
can honestly give:

- **Terms pair exactly.** The same program through both toolchains produces
  the *identical final configuration* — `test/conformance.test.ts` asserts
  that each `term/v4/` fixture decodes to a `KTerm` deep-equal to its v3
  sibling's, with equal `canonicalKey`s. This is the package's cross-version
  contract measured on real end-to-end output.
- **Definitions do not pair byte-for-byte.** K's builtin modules changed
  between the releases, so `definition/v4/` is *not* flatten-identical to its
  v3 siblings (unlike the vendored `imp.json` pair under `upstream/`, which K
  itself checks in at both tags for identical content). The definition tests
  are structural: strict parse at v4, same module count, `UNIQUE_ID` presence,
  and a real structured `MInt{Width}`.

The v3 fixtures do not uniquely identify their source programs: several corpus
programs produce identical final configurations. The table records the program
used for each `v4/` fixture; each v4 output flatten-matches its corresponding
v3 fixture, as verified mechanically.

| `term/v4/` file                       | definition | program                                        |
| ------------------------------------- | ---------- | ---------------------------------------------- |
| `term-semantics-value-int.json`       | semantics  | `corpus/expr/add.panop`                        |
| `term-semantics-value-unit.json`      | semantics  | `corpus/expr/unit-literal.panop`               |
| `term-semantics-trap-divzero.json`    | semantics  | `corpus/expr/div-zero-add.panop`               |
| `term-semantics-output-effects.json`  | semantics  | `corpus/programs/sumto10.panop`                |
| `term-semantics-output-gcd.json`      | semantics  | `corpus/programs/gcd-while.panop`              |
| `term-semantics-user-list-multi.json` | semantics  | the bespoke program above, byte-identical      |
| `term-types-accepted.json`            | types      | `corpus/expr/add.panop`                        |
| `term-types-accepted-unit.json`       | types      | `corpus/programs/sumto10.panop`                |
| `term-types-rejected.json`            | types      | `corpus/types/assign-mismatch.panop`           |

| `definition/v4/` file          | modules / rules                                    |
| ------------------------------ | -------------------------------------------------- |
| `panop-semantics.parsed.json`  | 59 modules, 122 rules (0 with `UNIQUE_ID`)         |
| `panop-semantics.compiled.json`| 59 modules, 449 rules (449 with `UNIQUE_ID`, 362 distinct) |
| `panop-types.parsed.json`      | 59 modules, 151 rules                              |
| `panop-types.compiled.json`    | 59 modules, 472 rules                              |

The rule censuses are identical to the v3 table above — the two K releases
compile this definition to the same rule set.

`definition/v4/mint-width.compiled.json` and `term/v4/term-mint-width-value.json`
are in these directories too, and were made the same way — same commands, the
other toolchain — from the sources described under
[the instantiated parametric sort](#the-instantiated-parametric-sort-mint-width-and-src).

### v4 checksums

```
7c2e3926debc2931b08dabb45472e784c16d10b7f2b013453491779a8c47fa82  definition/v4/mint-width.compiled.json
52f97095125ccd8ad12b12974ba81d246d9f79f1bfca2efdf5b94f185429a99a  definition/v4/panop-semantics.compiled.json
24faf5818c08dd7fd86cf1692cadeb62b6e46506bd8cee0757bf03af90bec055  definition/v4/panop-semantics.parsed.json
699112e40b2e8107155086f932d92a3f644c396fb301f81eb4a57eabd8276e86  definition/v4/panop-types.compiled.json
b1bc37512fb6480b8c8edb72ef5e694b37c5824f1e5f9122d34bd2137243b1d4  definition/v4/panop-types.parsed.json
b590ef5be796ab1310b631353339555b81d076760430de9990efd053eca4667a  term/v4/term-mint-width-value.json
65375fc191e26ec26655075f562e98a8819866f3ec94ccc88518248800525996  term/v4/term-semantics-output-effects.json
10ab00c448655847a1b07f257d3499ec3d49d9b289dd73280c919080cae083ad  term/v4/term-semantics-output-gcd.json
eea5b891ae3f0e2c44a4bcbf17418bbe51ebc1ff477533e262f0975ead4139d4  term/v4/term-semantics-trap-divzero.json
09c2b573415684ea1790b68f97eac822012c716853bd7fd52feae226e6f8575c  term/v4/term-semantics-user-list-multi.json
f0eba41e819fd04935a945cc01a02f2fe7796cd758bbbce2cdcd86456ba9fe1b  term/v4/term-semantics-value-int.json
38c5180741b4d154615994356a2303bbab294bff1b1314e212575bfb3fed385a  term/v4/term-semantics-value-unit.json
89933e0c841898f8bed147fc0bcbff1985beea6307bf3f73f8e5adb5093e0abb  term/v4/term-types-accepted-unit.json
18cfe1cb18f0b0284462b1c1a5fa6f114de3877c145b8f5b3e000541051afb25  term/v4/term-types-accepted.json
cb1106f2465075ff626f6ef57c7b8e0fe4f78861fdf08c6387cddcb48bb77e9b  term/v4/term-types-rejected.json
```

## Upstream fixtures (`upstream/`)

These did not come from this package's toolchain runs at all: they are K's
_own_ test material, read out of a checkout of `runtimeverification/k` at tag
`v7.1.191` — the exact tag this package transcribes. They exist to answer a
different question than the panopticon fixtures: not "does this package read
what our toolchain wrote", but "does it read what **K's own test suite**
exercises".

From `k-distribution/tests/regression-new/` (Java-frontend test inputs,
copied byte-for-byte via `git show v7.1.191:<path>`):

| file                          | upstream path                        | why it matters                                                                                        |
| ----------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `k-dist-json-in1.term.json`   | `json-input/json-in1.json.kast`      | term document; KLabel with **sort parameters** (`#Equals{K,K}`)                                        |
| `k-dist-json-in2.term.json`   | `json-input/json-in2.json.kast`      | term document                                                                                          |
| `k-dist-json-in3.term.json`   | `json-input/json-in3.json.kast`      | term document with `KVariable`s                                                                        |
| `k-dist-imp.outer-parsed.json`| `imp-outer-json/imp.json`            | **outer-parsed** `KDefinition`: 89 modules, **218 `KBubble`s** — the sentence kompiled output never has |

Upstream, these are *inputs*: `kast --input json` and `kompile
--outer-parsed-json` consume them in K's regression suite, so they are
documents the Java frontend demonstrably accepts.

From `pyk` at the same tag — the *other* writer of KAST v3:

| file                            | provenance                                                                    | why it matters                                                          |
| ------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `pyk-kinner.bare-term.json`     | `pyk/src/tests/profiling/test-data/kast-to-kore/kinner.json`, byte-for-byte   | real pyk output (a KEVM configuration); 147 `KApply`s with `"variable"` |
| `pyk-term-kas.json`             | generated by `upstream/generate-pyk-fixtures.py` with pyk `v7.1.191`          | `KAs` in pyk emission                                                    |
| `pyk-spec-kflatmodulelist.json` | generated by `upstream/generate-pyk-fixtures.py` with pyk `v7.1.191`          | `KFlatModuleList` + `KClaim` + `KSortSynonym`, the `--emit-json-spec` shape |
| `pyk-term-nested-sorts.json`    | generated by `upstream/generate-pyk-fixtures.py` with pyk `v7.1.191`          | sorts nested **two levels deep**, `Outer{Inner{Int},Int}` — no K-produced document anywhere can carry one |

`pyk-term-nested-sorts.json` puts that depth-2 sort on each of the three node
kinds that can hold a sort — a `KToken`'s, a `KVariable`'s, and a `KLabel`'s
sort parameters. It is generated rather than vendored because pyk is the only
producer that *can* write one: K's Java frontend refuses a user-defined
parametric sort outright (see the `mint-width` section), so the deepest sort it
emits is an instantiated `MInt{64}`. The generator builds the sort through one
version-aware helper: under a v3 pyk, whose `KSort` holds only a flat `name`,
it inlines the parameters exactly as `ADT.Sort.toString` does; under a v4 pyk it
builds the real recursive `KSort` tree.

The three generated files' term bytes are pyk's own `to_dict()`; the script
(checked in beside them) refuses to run against any pyk that does not emit
KAST v3, and regenerating with it reproduces the committed files
byte-for-byte. `KSyntaxLexical` is absent **because pyk cannot write it**:
its serializer emits the misspelled node name `KSyntaxLexcial`
(`pyk/kast/outer.py:464`, unfixed as of `v7.1.337`), which neither the Java
`JsonParser` nor pyk's own `from_dict` accepts. `test/upstream.test.ts` pins
both the correct spelling and the rejection of the typo.

Deliberately **not** vendored, and why:

- `pyk/src/tests/integration/test-data/prelude-modules.json` (705 kB): its
  node coverage (including `KBubble`) is a strict subset of what
  `k-dist-imp.outer-parsed.json` already provides, it lacks the envelope, and
  it is pretty-printed rather than canonical.
- `pyk/src/tests/profiling/test-data/*.json` (up to 5.4 MB each): stress-scale
  KEVM documents; nothing in them is a node shape the smaller fixtures miss.
- The Java unit tests (`JsonSerializationTests.java`, `KPrintTest.java`) build
  their terms programmatically and check round-trips in memory; there is no
  golden JSON in them to copy, and every node type they exercise is already
  covered here.

### The v4 counterparts (`upstream/v4/`)

K checks in **both revisions of the same four test documents** — the exact
files above, regenerated by upstream for v4 at tag `v7.1.337`. That makes the
whole format change testable as one property, which
`test/upstream.test.ts` pins: *a v4 document with every `KSort` flattened back
to the v3 spelling is structurally identical to its v3 counterpart* — same
keys, same values, everywhere, across all seven pairs.

| file (same names as their v3 pairs)   | provenance at `v7.1.337`                                              |
| ------------------------------------- | ---------------------------------------------------------------------- |
| `v4/k-dist-json-in1.term.json`        | `git show v7.1.337:…/json-input/json-in1.json.kast`, byte-for-byte     |
| `v4/k-dist-json-in2.term.json`        | same, `json-in2.json.kast`                                             |
| `v4/k-dist-json-in3.term.json`        | same, `json-in3.json.kast`                                             |
| `v4/k-dist-imp.outer-parsed.json`     | `git show v7.1.337:…/imp-outer-json/imp.json`, byte-for-byte           |
| `v4/pyk-term-kas.json`                | `generate-pyk-fixtures.py` with pyk at `v7.1.337`                      |
| `v4/pyk-spec-kflatmodulelist.json`    | `generate-pyk-fixtures.py` with pyk at `v7.1.337`                      |
| `v4/pyk-term-nested-sorts.json`       | `generate-pyk-fixtures.py` with pyk at `v7.1.337`                      |

`v4/k-dist-imp.outer-parsed.json` (425,269 bytes) is the strongest single
fixture for the v4 sort shape: 83 structured parametric-sort occurrences
(`MInt{Width}` ×81, `MInt{Width1}`, `MInt{Width2}`). At `v7.1.337` the same
bytes are also checked in at `pyk/regression-new/imp-outer-json/imp.json` —
sha-identical, so it is vendored once. `pyk-kinner.bare-term.json` has no v4
counterpart to vendor: upstream's copy is **unchanged** at `v7.1.337`, still
carrying v3-shaped, `params`-free sorts — live evidence that pyk's v4
`from_dict` tolerates a missing `params` (`d.get('params', ())`) where the
Java v4 reader would die (`JsonParser.java:292`).

The generator script serves both versions: pointed at a v3 pyk it writes the
three files beside itself, pointed at a v4 pyk it writes `v4/`; it refuses any
other version, and regenerating reproduces the committed bytes exactly.

### Upstream checksums

```
aa5e701933f1750187ff7615b757ddef7b6192ec2daef7afbd8623d44542d833  upstream/k-dist-imp.outer-parsed.json
b8f55222d0dbda7e17941183dcbe885cd460a8ddf2b677e1731054b7a4239a39  upstream/k-dist-json-in1.term.json
d7d7f2e91afb28058b66c0e96805ca0df09e60a1977edc9829bfd0cce334b8b5  upstream/k-dist-json-in2.term.json
c32d0e147b2a2b2d01c14b350de84557d2b5ef816b2d0e1758a23dcee2993997  upstream/k-dist-json-in3.term.json
cc11592f5121360a90c67d4a8291de673fd953bd9042fb42f710b3687436b4cf  upstream/pyk-kinner.bare-term.json
f3cc40c893a585ed2cdc4e92016c41f9d283ab6c8db3f660dbd6d43da7d4ce6a  upstream/pyk-spec-kflatmodulelist.json
6b91c640b077f73848d69982149810ff4906914263759b8273f341e71087da76  upstream/pyk-term-kas.json
7d6ee83cd0578cd5972cf32d2241aaf1d609532cff0b50ddd72784776f87a412  upstream/pyk-term-nested-sorts.json
214137f0fa3a7f9dde19deccf142856d5805be8346c91028e796542392c7ccdf  upstream/v4/k-dist-imp.outer-parsed.json
8812c699e1ed409391c5b9a26f10844bf919705a7bd76757d310f7493321cfd1  upstream/v4/k-dist-json-in1.term.json
ace8e8bada06fa694ac5ccf14e44b29c73d525d8221903bc28f99e07960b0013  upstream/v4/k-dist-json-in2.term.json
452d13fb66ee70f8f4f223af10e3ebd3e81d5252ec3bcd00d618443b8b81d8b5  upstream/v4/k-dist-json-in3.term.json
891e4d2cc5a6848bca8d2337973c02049db4ebd05b59b4eacffd2d504dd8aa84  upstream/v4/pyk-spec-kflatmodulelist.json
44a7eef8e468f048c6b867d53c0bdb4cc727fcc1791db54280ca01f7da041972  upstream/v4/pyk-term-kas.json
b13c2735d4a11905dcc1be6b6ae8abd774385ab78737a9cf9d4194147d658d7f  upstream/v4/pyk-term-nested-sorts.json
```

## What these fixtures do not cover

Honest gaps, so nobody mistakes silence for evidence:

- **`KConfiguration`, `InjectedKLabel`, `KSyntaxLexical`** appear in no
  fixture. The first two, pyk does not model at all, and no checked-in JSON in
  the K repository contains them; producing one would take a bespoke K
  definition driven through the Java frontend. `KSyntaxLexical` has no test
  material anywhere upstream either, and pyk cannot write it (the
  `KSyntaxLexcial` typo above). All three are modelled from `ToJson.java` and
  covered by hand-written unit tests only.
- `KClaim`, `KBubble`, `KSortSynonym`, `KFlatModuleList`, `KAs` and `pyk`
  output **were** in this list; the `upstream/` fixtures closed them.
- **AC ordering divergence** between the two producers cannot be shown with
  single-producer fixtures. The unit tests instead prove that two different
  emission orders of the same `Map` decode identically, which is the property
  that matters.
- **Nested parametric sorts** were in this list; they are covered now, by real
  producer output at both versions: `upstream/pyk-term-nested-sorts.json` and
  its `v4/` counterpart carry `Outer{Inner{Int},Int}` — depth 2, on a
  `KToken`, a `KVariable` and a `KLabel`'s parameters — and the `mint-width`
  fixtures carry an **instantiated** `MInt{64}` from the Java frontend at both
  versions. What remains is not an omission but a limit of the producer: the
  Java frontend **cannot currently emit depth-≥2 nesting at all**, because K
  rejects a user-defined parametric sort with "User-defined parametric sorts
  are currently unsupported"
  (`k-distribution/tests/regression-new/checks/checkParametricSort.k`), and
  only the builtin `MInt` may be instantiated. Java-side nesting coverage is
  therefore impossible by construction, and pyk — the format's other real
  producer — is what provides it.
- **A v4 `KConfiguration` / `InjectedKLabel` / `KSyntaxLexical`** fixture does
  not exist for the same reasons as at v3, above.
