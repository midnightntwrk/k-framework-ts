# Fixture provenance

Every `.kast` and `.kast.out` file under `kast-text/` is **byte-for-byte what is
checked into the `k` repository** at tag `v7.1.337` — the tag this package
transcribes. None of it is hand-authored, none of it has been reformatted or
trimmed, and every file was verified against `git show v7.1.337:<path>` after
copying. That is the whole point: `src/lexer.ts` and `src/parser.ts` are a
hand-transcription of two Python files, and a hand-transcription is not
self-verifying. These are the evidence.

One file here is not upstream material: `kast-text/parse-expected.json` is
**pyk's own output**, produced by the checked-in generator beside it. It is
called out separately below.

`.oxfmtrc.json` and `.oxlintrc.json` both exclude `fixtures/`, so no tool can
reformat these bytes.

## What this directory is for

`packages/kast-json/fixtures/` answers "does this package read what K wrote" for
the **JSON** format. This directory answers the same question for the **textual**
format — what `kast --output kast` and `krun --output kast` print, produced by
the Scala unparser `ToKast` (`k-frontend/src/main/scala/org/kframework/unparser/Unparse.scala`)
and read by `src/parser.ts`.

It answers a second question too, which turns out to be the more interesting
one: **where the format the reader accepts stops.** 13 of the 19 vendored files
are rejected — by pyk and by us, at the same character, with the same message —
and that is not a defect in the fixtures. See the table.

## Source

|                        |                                                                              |
| ---------------------- | ---------------------------------------------------------------------------- |
| Repository             | `runtimeverification/k`                                                      |
| Tag                    | `v7.1.337`                                                                   |
| Commit                 | `4a46d1231473b599c699160132fd6e76a5c46406` (2026-06-18)                      |
| Upstream directory     | `k-distribution/tests/regression-new/`                                       |
| Files vendored         | 19 (4 subdirectories, preserved)                                             |
| License                | BSD-3-Clause — see `../THIRD-PARTY-NOTICES.md`                               |
| Vendored               | 2026-08-05                                                                   |

The two Python files these fixtures exercise, at the same tag:

```
$ git show v7.1.337:pyk/src/pyk/kast/lexer.py | sha256sum
1b3041ee2ca8f792dc341c81479f8666a4d1525283688eaa70192b04e5872282   (265 lines)

$ git show v7.1.337:pyk/src/pyk/kast/parser.py | sha256sum
ff9b1b019c6ff91f421e3077b6aaca317ee533d92de21b83d2e4f42cb389cca5   (126 lines)
```

## The files, and what each one actually is

Upstream, each of these directories is a `ktest` case: a `Makefile` sets
`KAST_FLAGS`, the `.kast` file is the **input** to `kast`, and the `.kast.out`
file is the expected **output**. Which of the two is textual KAST therefore
depends entirely on the flags, and it is not the same one in every directory —
this is the trap the fixture set is built to record.

| directory              | `KAST_FLAGS`               | the `.kast` input is | the `.kast.out` output is |
| ---------------------- | -------------------------- | -------------------- | ------------------------- |
| `kast-input/`          | `--input kast --output pretty` | **textual KAST**  | pretty-printed K (not vendored) |
| `kast-kore-input/`     | `--input kore --output pretty` | textual KORE      | pretty-printed K (not vendored) |
| `kast-rule/`           | `--input rule`             | K rule syntax        | **textual KAST**          |
| `kast-default-output/` | (defaults)                 | K program syntax     | **textual KAST**          |

So the textual-KAST material is 9 files: the 2 inputs of `kast-input/` and the 7
outputs of `kast-rule/` and `kast-default-output/`. The other 10 are vendored
anyway, as negative goldens — they are exactly the inputs a caller will
mistakenly hand this parser, and pinning the message it gives them is worth as
much as pinning a successful parse.

File by file, with what pyk's `KAstParser(text).k()` does:

| file                                    | what it is                          | pyk           |
| --------------------------------------- | ----------------------------------- | ------------- |
| `kast-input/kast-in1.kast`              | textual KAST: `#Equals` of two `#token`s | **parses** |
| `kast-input/kast-in2.kast`              | the same with equal operands        | **parses**    |
| `kast-default-output/kast-out1.kast.out`| textual KAST, `kast`'s own output   | **parses**    |
| `kast-default-output/kast-out2.kast.out`| ditto                               | **parses**    |
| `kast-rule/kast-in3.kast.out`           | textual KAST: `` `<k>`(.K) `` — a backtick klabel and `.K` | **parses** |
| `kast-rule/kast-in5.kast.out`           | textual KAST: a two-cell `<generatedTop>` configuration | **parses** |
| `kast-rule/kast-in1.kast.out`           | textual KAST **containing `=>`**    | `Unexpected character: '='` |
| `kast-rule/kast-in2.kast.out`           | ditto                               | `Unexpected character: '='` |
| `kast-rule/kast-in4.kast.out`           | ditto                               | `Unexpected character: '='` |
| `kast-kore-input/kast-in1.kast`         | textual KORE                        | `Unexpected character: '\'` |
| `kast-kore-input/kast-in2.kast`         | textual KORE with a variable        | `Unexpected character: '\'` |
| `kast-kore-input/kast-in3.kast`         | textual KORE with a set variable    | `Unexpected character: '\'` |
| `kast-rule/kast-in1.kast`               | K rule syntax `A:Int => 1`          | `Unexpected character: '='` |
| `kast-rule/kast-in2.kast`               | K rule syntax with cells            | `Unexpected character: '<'` |
| `kast-rule/kast-in3.kast`               | K rule syntax with cells            | `Unexpected character: '<'` |
| `kast-rule/kast-in4.kast`               | K rule syntax `A +Int B => 3`       | `Unexpected character: '+'` |
| `kast-rule/kast-in5.kast`               | K rule syntax with cells            | `Unexpected character: '<'` |
| `kast-default-output/kast-out1.kast`    | a K program, `init(0)`              | `Unexpected character: '0'` |
| `kast-default-output/kast-out2.kast`    | a K program, `init(1)`              | `Unexpected character: '1'` |

The three `=>` rows are the ones worth staring at. Those files **are** textual
KAST — `kast --input rule` wrote them — and pyk's reader still rejects them,
because `parser.py` has no production for `KRewrite` and `lexer.py` no token for
`=`. `src/lexer.ts`'s header has the full table of which of `ToKast`'s six
constructs the reader covers (four) and which it does not (`KRewrite`, `KAs`,
plus `InjectedKLabel` and label sort parameters, which have no token at all).
We transcribe pyk, so we reject them too, and `test/parser.test.ts` pins that.

## `parse-expected.json` — pyk-derived, not upstream-vendored

This one file is **not** from the `k` repository's test data. It is what pyk
itself does with each of the 19 files, recorded so that `test/parser.test.ts`
can compare against it without a Python interpreter:

```json
"kast-input/kast-in1.kast": { "parses": true,  "term": { … } }
"kast-rule/kast-in1.kast":  { "parses": false, "error": "Unexpected character: '='" }
```

- the `term` values are pyk's `KInner.to_dict()` verbatim, so a passing test is
  a **differential** result against pyk's parser and not a restatement of our
  own;
- the `error` values are pyk's `ValueError` message verbatim. Our errors carry a
  `<line>:<col>: ` prefix pyk has no notion of (`src/lexer.ts`, "The one
  deliberate improvement"), so the test compares `KastSyntaxError.description`,
  which is the message without that prefix.

Regenerate it with the checked-in generator, against a **source checkout** of
`k` at `v7.1.337` — not an installed `pyk`, which is usually a different
version:

```
cd kast-text
PYTHONPATH=<k-checkout>/pyk/src python3 generate-expected.py
```

The script refuses to run against a pyk that does not emit KAST v4, and
regenerating reproduces the committed file byte-for-byte.

## Checksums

```
1bccf156272f9dfd2ca1fafac70622f1e2760574b7a92058e049c118d81cdc57  kast-text/kast-default-output/kast-out1.kast
c5087e4fa39ae544eaffbe46311a60dd3a5e7ec9ae5592ea4f935bf140740e02  kast-text/kast-default-output/kast-out1.kast.out
36cbf275b2d62ca34561e519bbf3201dbc9cd1ff91df88b13e1cb59f75316417  kast-text/kast-default-output/kast-out2.kast
bbd2d65a844c761e8c790f0481273a5091107d509174b847763c605ae0983770  kast-text/kast-default-output/kast-out2.kast.out
6ee276f86855f1bb485d0108b8f49e2b64d053816ff1ca5e935f41fc5f893fb1  kast-text/kast-input/kast-in1.kast
a11bd62b84a5c57cecf88f6a67decb6f254d1b1510d5a9afd44f65bfe2efc841  kast-text/kast-input/kast-in2.kast
1480267cbee794ce6be24286dfb7696d20681f1a075b289b08bbe1bb0e29e979  kast-text/kast-kore-input/kast-in1.kast
69f63c5bb11a8eebbd85f9027f2e1df4c4b9b1fca5ebe358ba66b65b162b239a  kast-text/kast-kore-input/kast-in2.kast
61c75ae98456dd98d4ee0f18ed1e7ac9901acdca06053fa7d2ba8307d9e77b2d  kast-text/kast-kore-input/kast-in3.kast
c808453e9e9abaf3b2199afb048519bf89445ad58bbb41ac08b1b62eab4faac2  kast-text/kast-rule/kast-in1.kast
9fbfe062e0c9daefdbb3f2c459e71ca2e90dd36e47ca0373c9e70e3c21229ca0  kast-text/kast-rule/kast-in1.kast.out
dfaebefa4e9f6aa22997d09653f527d6499ecac91824178b6c3000b1b08c1af6  kast-text/kast-rule/kast-in2.kast
118e0b42f1dfcb2d00923011b67248b70ebcbee316fda4aec87fadc244f31708  kast-text/kast-rule/kast-in2.kast.out
6398e19bba6a6fded7b6dc90da1e5613dcb3bc6006ff02c4355f5a3b7d96ce94  kast-text/kast-rule/kast-in3.kast
65f97f03ddcd563c319b45401f319fa88f8d01f371216cff06e8c3756bbc01db  kast-text/kast-rule/kast-in3.kast.out
fb05707c660860248661c2195491283e1ed07dc498c0d1e2f3968c9efa59b36e  kast-text/kast-rule/kast-in4.kast
0f8fa791624f0d3237555bebf2027df5fafc616305962298db6bc81289e99c99  kast-text/kast-rule/kast-in4.kast.out
da3eb0405c00ad9338632366e7ac6b9cf9d02fed5b08c24f9829353e423ec028  kast-text/kast-rule/kast-in5.kast
f646e96e2b4d900f85d1857a50c647aeee07f69b4e0e06416c2f8e5d1ad95a15  kast-text/kast-rule/kast-in5.kast.out
```

`parse-expected.json` is deliberately absent from that list: it is regenerated
material, and its checksum would be one more thing to update by hand every time
the generator is re-run. Its authority is the generator plus the pyk tag above.

## Deliberately not vendored, and why

- **`kast-input/*.kast.out` and `kast-kore-input/*.kast.out`** — those runs use
  `--output pretty`, so the outputs are pretty-printed K (`{ 3 #Equals 4 }`),
  not KAST in any form. They would test the pretty-printer, which is phase 3.
- **The `Makefile` and `kast-in.k` / `kast-out.k` in each directory** — the
  K definitions and the `ktest` harness. Regenerating any `.kast.out` needs a
  K install (`kompile` then `kast`), which is exactly why the outputs are
  vendored rather than reproduced.
- **The other pyk-parseable `.kast` material in `regression-new/`** —
  `issue-1088/1.kast.expected` and `issue-1682-korePrettyPrint/2.kast.out` also
  parse, but they are single applications with nothing the six files above do
  not already cover, and they sit outside the four `kast-*` directories this
  corpus is drawn from.

## What these fixtures do not cover

Honest gaps, so nobody mistakes silence for evidence:

- **No `KRewrite`, `KAs`, `InjectedKLabel` or parameterised label** appears in
  any *accepted* fixture, because no such text is accepted. The three `=>`
  files pin the rejection; there is nothing upstream that would pin an
  acceptance, since no reader in this package accepts them.
- **No sorted variable, no non-ASCII, no escape beyond `` \` `` and `\\`**
  appears in the corpus at all. `test/lexer.test.ts` and `test/parser.test.ts`
  carry those as hand-written cases, each confirmed against pyk directly.
- **Every accepted fixture is one line and under 70 bytes.** Depth and length
  are covered by the two generated 100k-node cases in `test/parser.test.ts`,
  not by upstream data.

# Fixture provenance — `parse-outer/`

The six `*.expected.json` files under `parse-outer/` are **byte-for-byte what
is checked into the `k` repository** at tag `v7.1.337`, copied without
reformatting and verified against `git show v7.1.337:<path>` after copying.
They are pyk's own expected outputs for `tests/unit/kast/test_utils.py`, which
parses six small `.k`/`.md` sources with pyk's pure-Python outer parser and
compares `KDefinition.to_dict()` against these files.

## What this directory is for

`src/outer.ts` is a hand-transcription of `pyk/src/pyk/kast/outer.py`, and a
hand-transcription is not self-verifying. These six files are the only
`KDefinition`-shaped JSON in the upstream tree that is small enough to vendor
and stable enough to pin — every other definition JSON upstream is a
multi-megabyte `compiled.json` produced by `kompile`.

`test/outer.test.ts` reads each one strictly, writes it back with
`KDefinition.toDict()`, and compares **canonical JSON** (`json.dumps(...,
sort_keys=True)`, which `src/eq.ts`'s `canonicalJson` reproduces byte for
byte). Key order may therefore differ; nothing else may.

Note what these files do **not** exercise: the parser that produced them is
`_ast_to_kast.py`, which upstream cannot use to convert sentences,
so **every module in all six files has an empty `localSentences`**. They pin
`KDefinition`, `KFlatModule`, `KImport` and the `Location` attribute codec, and
nothing else. Sentence-level fidelity is pinned differentially instead, in
`test/outer-parity.test.ts`, against values generated from pyk directly.

## Source

|                    |                                                            |
| ------------------ | ---------------------------------------------------------- |
| Repository         | `runtimeverification/k`                                    |
| Tag                | `v7.1.337`                                                 |
| Commit             | `4a46d1231473b599c699160132fd6e76a5c46406` (2026-06-18)    |
| Upstream directory | `pyk/src/tests/unit/test-data/parse-outer/`                |
| Files vendored     | 6 (the `*.expected.json` only)                             |
| License            | BSD-3-Clause — see `../THIRD-PARTY-NOTICES.md`             |
| Vendored           | 2026-08-05                                                 |

The two Python files this phase transcribes, at the same tag:

```
$ git show v7.1.337:pyk/src/pyk/kast/outer.py | sha256sum
3d8c18735863795b189c83056ccc015b1baaf61fe86ddce924c090831c6f101c   (1679 lines)

$ git show v7.1.337:pyk/src/pyk/kast/rewrite.py | sha256sum
35c59660d266da5ba2e40d6c015e28c823b729aa6c3ca97f5abcda14504883e1   (57 lines)
```

## The files

| file                         | main module | modules | what it pins                                        |
| ---------------------------- | ----------- | ------- | --------------------------------------------------- |
| `a.k.expected.json`          | `A`         | 2       | the minimal definition: one import, `Location` atts |
| `b.k.expected.json`          | `B`         | 4       | a `requires`d file's modules inlined                |
| `c.k.expected.json`          | `C`         | 4       | the same shape from a different source              |
| `d.k.expected.json`          | `D`         | 8       | a diamond — `B` and `C` both import `A`             |
| `include.k.expected.json`    | `INCLUDE`   | 2       | a module reached through an include path            |
| `markdown.md.expected.json`  | `MARKDOWN`  | 1       | a definition extracted from a Markdown source       |

`d.k` is the interesting one: `module_names` visits all eight modules but in a
breadth-first order that differs from the declaration order, which is what
`KDefinition.moduleNames` has to reproduce.

## Deliberately not vendored, and why

- **`*.k`, `*.md` and `include/`** — the *inputs*. Reading them needs the outer
  parser (`outer_lexer`/`outer_parser`/`markdown`), which is out of scope
  *here*: that is `@kframework-ts/k-parser`, which vendors its own complete
  copy of this directory (inputs included) under `packages/k-parser/fixtures/`.
- **`a.k.out.json` and `b.k.out.json`** — they belong to the parser this
  package does not have; `k-parser`'s PROVENANCE records what they actually
  are (`KDefinition` dicts with empty module atts, unread by anything in the
  K tree — not `outer_syntax` ASTs as this file once claimed).

## Checksums

```
91a2399301dac80dd54118f80e9715d5b29735b71e55a38fab27e0537efe5637  parse-outer/a.k.expected.json
2f85bed0730b199ac341f029df7b873b35d531d5651dc4241305eda5346fe18b  parse-outer/b.k.expected.json
2f301b8ac7116872198f31e15dcba85080f15ea32b0e4e614fe03c7fcce892f7  parse-outer/c.k.expected.json
bb3875b8fef5fbcd5d4e0dfd0dd10886595479c28c89b84963ab203817df68f0  parse-outer/d.k.expected.json
69354b7c1f56ea8beae2879fcf85f16978bd9751010e5a8aa3db0bd3cda526a3  parse-outer/include.k.expected.json
793d5d5e5a0c35edc2a4b936533e5a9b1077f2bca08f52802811479ce634dbcd  parse-outer/markdown.md.expected.json
```
