# Fixture provenance

Unlike every sibling package, **almost none of this could be vendored from
upstream**, because upstream has none of it. There is no golden Cobertura XML
in the `k` repository, no sample `allRules.txt`, no hit log, no kore-exec debug
log — and no test that would consume one. `kcovr.py`, `coverage.py` and
`kprint.all_rules` have no test at all; the six `--coverage` `Makefile`s in
`regression-new/` assert only that `kompile --coverage` exits 0, and since none
of those directories contains a `.test` program, `krun` never runs and no
coverage output is ever produced. See `generators/README.md`.

So this corpus is **made**, from four sources, each with a different warrant:

1. **A real `kompile --coverage` build made in this workspace** — `cov-build/`
   and `compiled/`. The only genuine coverage artifacts that exist anywhere.
   Sanitized; see "Path sanitization".
2. **A second real build, of upstream's own IMP, run to produce a large hit
   log** — `imp-build/`. Made here for the same reason: upstream's
   `--coverage` directories contain no program, so upstream can produce no log
   at all. See "The large hit log — `imp-build/`".
3. **Hand transcription from the one upstream test** — `pyk-unit/`. Verified
   mechanically against upstream's AST, not eyeballed.
4. **pyk's own renderer, run over (1)** — `synthetic/golden.cobertura.xml`. A
   differential golden: passing it means agreeing with the implementation this
   package transcribes, not restating our own output.

`.oxfmtrc.json` and `.oxlintrc.json` both exclude `fixtures/`, so no tool can
reformat these bytes.

**Every numeric claim below is machine-checked.** `test/fixtures.test.ts` was
phase 1's whole test surface — joined by `test/imp-build.test.ts` for the
`imp-build/` numbers — and it exists because a claim in prose that
nothing checks is a claim that rots: the 168 entries, the absent trailing
newline, 362 lines / 31 unique, the 105 `<generatedTop>` rules, the empty
`coverage.txt`, the `"version":4` envelope with `params` on all 2 942 `KSort`
nodes, the sorted `<line>` order in the golden, and the byte-preserved
escaped-space paths are all assertions there as well as sentences here.

## Source table

|                          |                                                                  |
| ------------------------ | ---------------------------------------------------------------- |
| `cov-build/`, `compiled/` | `panopticon` @ `29e756921f90b6dfd42c54d3602b4ffff9e4ea83` (2026-08-06), directory `K/.build/cov-semantics/` |
| built with               | K **v7.1.337** (`/nix/store/18pfm4wc…-k-7.1.337-4a46d123`), llvm backend |
| `imp-build/`, `generators/imp.k` | `runtimeverification/k` @ `v7.1.337`, `pyk/regression-new/imp-llvm/imp.k`, kompiled and run in this workspace |
| built with               | the same K **v7.1.337**, llvm backend — same nix store path, so the prelude sanitizes to the same `/fix/k/` root |
| `pyk-unit/`              | `runtimeverification/k` @ `v7.1.337` = `4a46d1231473b599c699160132fd6e76a5c46406` (2026-06-18) |
| `generators/*.k`         | same tag, `pyk/regression-new/{coverage,bytes-coverage,issue-1388}/test.k` |
| `synthetic/golden.cobertura.xml` | pyk's `render_coverage_xml` at the same tag, over `cov-build/` |
| `synthetic/allrules-*.txt` | hand-constructed by `generators/make-synthetic.py`; no upstream origin |
| License                  | K material: BSD-3-Clause — see `../THIRD-PARTY-NOTICES.md`. panopticon material: this workspace's own output. |
| Vendored                 | 2026-08-06; regenerated in full at K v7.1.337 the same day — see "Regenerated at v7.1.337" |

## Generation lineage — where `cov-build/` really came from

`panopticon/K/.build/cov-semantics/` is not a hand-made directory. It is
produced by panopticon's own coverage harness, and the step that matters for
these fixtures is `panopticon/K/harness/commands/coverage.ts:99-118`:

- **`:99-107`** deletes every stale `*_coverage.txt` before the run. This is
  not hygiene, it is *required*: the LLVM runtime opens each log with
  `fopen(..., "a+")` (`io.cpp:552`) and flushes at `atexit` (`:566`), so
  without the delete a second run doubles every count. `src/fs.ts` carries the
  same warning as `HIT_LOGS_ARE_APPEND_ONLY`.
- **`:108-118`** runs the corpus, one `krun` per case, in a process pool. One
  process that parses successfully leaves exactly one `<pid>_coverage.txt`;
  one that the parser refuses leaves none. That is why the directory holds 63
  hit logs of wildly different sizes rather than one large one, and it is what
  makes a multi-file `create_cover_map` merge a *real* scenario here rather
  than a hypothetical.

The three vendored logs are therefore three real `krun` invocations from one
corpus scan, not slices of a single file.

Which three is decided by `sanitize-cov-build.py`'s `pick_hit_logs`, from the
sizes on disk, and **not** by a list of filenames: the names are pids, so they
change on every scan and carry no information. The rationale that function
implements is the one in "`cov-build/` — a real `--coverage` build" below.

## Path sanitization

Every artifact a `--coverage` build produces embeds absolute paths. A census of
the `cov-semantics` source directory found exactly **five** distinct absolute
paths across `allRules.txt` and `compiled.json`, and no others anywhere
(`imp-build/`'s own two-entry census is in its section below, and shares the
prelude row):

| real prefix                                          | occurrences | fake prefix                  |
| ---------------------------------------------------- | ----------: | ---------------------------- |
| `…/panopticon/K/spec/`                               |  211 | `/fix/sem/`                  |
| `…/panopticon/K/.build/cov-semantics/`               |  168 | `/fix/build/cov-semantics/`  |
| `/nix/store/18pfm4wc…-k-7.1.337-…/include/kframework/` | 240 | `/fix/k/include/kframework/` |

**No real prefix is written down in the generator.** All three are read out of
the build: the prelude root is whichever source `allRules.txt` names under an
`include/kframework/` directory, the semantics root is the directory of the
remaining sources, and the build root is the `coverage.txt` path
`GenerateCoverage.java:72-74` bakes into every instrumented rule. A store path
hardcoded in the script would name one K install forever and be wrong the day
after an upgrade — which is exactly what happened to the v7.1.191 version of
these scripts.

The substitution is a plain prefix replacement, applied identically to every
byte that is vendored — `allRules.txt`, the hit logs (which contain no paths,
but are run through it anyway so the invariant has no exception), and every
string in `compiled.json`, keys included. The same real path always becomes the
same fake path, so the cross-references between the three artifacts survive
intact. Rule hashes, line numbers, column numbers and term structure are copied
verbatim.

Two details are deliberate:

- **The `include/kframework/builtin/` tail is preserved** on the prelude path.
  `renderCoverageXml` roots relative filenames at `commonprefix(sources)`
  (`kcovr.py:79`), so the *shape* of the paths decides the output. A deep
  prelude path beside two shallow spec paths is what makes the common prefix
  short and the `<class filename=…>` values non-trivial. Flattening it would
  have made the golden easier than reality.
- **`/fix/build/cov-semantics/coverage.txt`** appears 168 times in
  `compiled/compiled.json` because `GenerateCoverage.java:72-74` bakes the
  absolute path of the macro log into every instrumented rule. Sanitizing it is
  what stops the fixture from being machine-specific.

Reproduce with `generators/sanitize-cov-build.py <build-dir> <fixtures-dir>`.
Verified after running: zero occurrences of `sebdev20` or `/nix/store` remain in
any vendored file.

## The files

### `cov-build/` — a real `--coverage` build, 49 KB

| file                     | bytes  | what it pins                                                     |
| ------------------------ | -----: | ---------------------------------------------------------------- |
| `allRules.txt`           | 18 139 | 168 entries over 3 source files; 125 distinct `file:line`         |
| `coverage.txt`           |      0 | the macro-free edge case — empty, not missing                     |
| `pid-small_coverage.txt` |     65 | one line, one hit — the degenerate log                            |
| `pid-mid_coverage.txt`   |  7 995 | 123 lines / 32 unique — a typical run with heavy duplication      |
| `pid-large_coverage.txt` | 23 530 | **362 lines / 31 unique** — the Counter semantics of §4 item 1    |

Three facts about `allRules.txt` that a reader will otherwise get wrong:

- **168 entries, 167 newlines.** `Kompile.java:381` ends with
  `String.join("\n", ruleLocs)`, so there is **no trailing newline** — the last
  byte of the file is `8`. `wc -l` therefore says 167. A reader that splits on
  `\n` and drops empty lines gets 168, which is the right answer.
- **Order is arbitrary.** `ruleSourceMap` iterates
  `def.mainModule().sentences()` (`Kompile.java:365`), a scala `Set`. Nothing
  may depend on entry order — see "What the golden cannot pin" below, where
  this bites pyk itself.
- **Not all rules.** 168 of the definition's 559 `KRule`s appear; the filter is
  `Kompile.java:371`, which requires Source, Location *and* `UNIQUE_ID`.

- **125 distinct `basename:line:col` keys, for 168 rules** — the key
  `translateCoverage` matches on (`coverage.py:67,74`). 21 of those keys are
  claimed by more than one rule, because rules K generates from one production
  (heating/cooling pairs) carry their source rule's line *and* column. This is
  what makes plan §5's "self-to-self translation must be the identity on
  `<generatedTop>` rules" false on real input: 13 of the 39 `<generatedTop>`
  rules these logs hit translate to a *different* rule at the same location, and
  only 19 are alone at their location. `test/translate.test.ts` pins all four
  numbers; `src/translate.ts`' header explains why the collision is kept.

The three logs are chosen from the 63 in the source directory as the extremes
plus a middle: the smallest that exists (65 B — five files tie at one line, and
four of those five carry the same id, so there are really two candidates), the
largest (23 530 B), and, for the middle, the two logs bracketing the plan's
`~4 KB` target. **No 4 KB file exists in the corpus** — the sizes jump from
2 210 B to 7 995 B — and the larger is taken because it raises the union of
distinct rules hit across the three files from 34 to 40, which is what the
golden's covered-line count is made of. `pick_hit_logs` in
`generators/sanitize-cov-build.py` is that paragraph as code; ties left over
break on filename, so the choice is deterministic and survives a regeneration
that renumbers every pid.

Together they cover 40 of the 168 rules (23.8%), which is why the golden's
`branch-rate` is `0.23809523809523808`.

### `compiled/compiled.json` — 538 KB, the instrumented definition

`compiled/compiled.json` is a reduced real `GenerateCoverage` output. A
hand-built definition would omit the real instrumentation shape that
`strip_coverage_logger` must handle.

The only edits are the path substitution above and the reduction below. Nothing
about the envelope is touched: `kompile --emit-json` at `v7.1.337` writes
`{"format":"KAST","version":4,…}` and that is what is vendored.
`@kframework-ts/kast` and `generators/sanitize-cov-build.py` reject v3
`compiled.json` rather than rewriting it. K `v7.1.191` emits version 3, so use
a version-4-producing K release when regenerating; every accepted fixture then
remains toolchain output.

So the file is the real one, reduced:

- **Reduced** to the 168 rules that `allRules.txt` names. That is not a curated
  selection — it is exactly the set of rules a coverage artifact can ever refer
  to, since hit-log ids and `allRules.txt` ids are the same set. All other
  sentences (productions, syntax sorts, claims, the other 391 rules) are
  dropped.
- **Import paths preserved.** `KDefinition.modules` is the transitive closure
  of `imports` from the main module (`outer.py:1216-1218`, `kast`'s
  `outer.ts:1701-1703`), and `getRuleById` scans that closure. A first cut that
  kept only rule-bearing modules left three of them (`BOOL-COMMON`,
  `STRING-COMMON`, `SET`) unreachable and 46 rules silently invisible to the
  very function this fixture exists to test. Every module on a shortest import
  path from the main module is therefore retained, emptied of sentences if it
  contributes none: **11 modules, 168 rules, all reachable** — verified by
  loading it through `kast`'s reader.
- **Nothing else.** All 2 942 `KSort` nodes in the vendored file carry `params`
  because `kompile` wrote them that way; the envelope reads `"version": 4` for
  the same reason. Rule hashes, attributes, line and column numbers and term
  structure are byte-copied.

What it is worth having: the instrumented shape, verified against the fixture
rather than assumed. All 168 rules carry it, all at **arity 2**, across 8
distinct sorts:

```
sideEffect:<Sort>( #logToFile("/fix/build/cov-semantics/coverage.txt", "<uid>\n"), <rhs> )

  sideEffect:GeneratedTopCell 105   sideEffect:String 7   sideEffect:IOInt 1
  sideEffect:Bool              35   sideEffect:K      2   sideEffect:Set   1
  sideEffect:Int               16                         sideEffect:List  1
```

This is `GenerateCoverage.java:66-78` exactly, and it is **not** what pyk's
`strip_coverage_logger` matches (`coverage.py:34-43` looks for a `project:`
label wrapping a 2-item `KSequence`). The plan's §4 deviation — strip both
shapes — is now backed by data rather than by reading the Java.

105 of the 168 are `<generatedTop>`-rooted and 63 are not, which is the
population `translateCoverage`'s filter (`coverage.py:80-89`) has to split.

### The large hit log — `imp-build/`, 456 KB

`imp-build/` supplies the package's large-scale hit log. It is produced from
the smallest runnable semantics upstream ships rather than from the opt-in
coverage corpus.

**Why IMP.** The six `--coverage` directories in the K repository contain no
program, so `krun` never runs in them and no hit log can exist
(`generators/README.md`). `pyk/regression-new/imp-llvm/` is not a `--coverage`
directory, but it *does* have programs — it is the one place in K's test suite
where "a semantics you can run" and "a semantics that kompiles in seconds" meet.
Adding `--coverage` to its `kompile` is the whole trick.

#### Exact commands

```sh
# K v7.1.337, /home/sebdev20/.nix-profile/bin/{kompile,krun}
cp k/pyk/regression-new/imp-llvm/imp.k "$S/imp/"          # BSD-3, v7.1.337, unmodified
kompile --coverage --backend llvm "$S/imp/imp.k" --output-definition "$S/imp-cov"
                                                          # 6.6 s wall, exit 0

rm -f "$S"/imp-cov/*_coverage.txt                         # mandatory: the log APPENDS
krun --definition "$S/imp-cov" "$S/imp/loops.imp"         # 1.6 s wall
                                                          # leaves 533868_coverage.txt

python3 generators/sanitize-imp-build.py "$S/imp-cov" "$S/imp/loops.imp" .
```

No flag beyond `--coverage --backend llvm` was needed. **`imp.k` kompiled
first try** — no fallback to a `k-distribution` tutorial variant was required,
and nothing in the file was edited.

#### `loops.imp` — a program written to hit a size

`sum.imp` / `collatz.imp` / `primes.imp` were all run first and all fall short
of the 300 KB floor (the table is in `generators/README.md`); `collatz.imp`, the
longest, reaches 291 KB. `loops.imp` is nested `while` loops around an
`if`/`else`/`if`/`else` with an empty block, division, `&&` on both a `true` and
a `false` left operand, unary minus, and four variables — chosen so the log is
*wide* as well as long. The outer bound is `30`, and lines scale at roughly
230 per outer iteration, so any size in the range is one edit away.

#### What came out

| file                     | bytes   | what it pins                                              |
| ------------------------ | ------: | --------------------------------------------------------- |
| `allRules.txt`           |  10 650 | 101 entries: 37 in `imp.k`, 64 in the prelude              |
| `coverage.txt`           |       0 | empty again — IMP declares no macro                        |
| `pid-large_coverage.txt` | 451 815 | **6 951 lines / 34 unique** — duplication factor 204       |
| `loops.imp`              |     368 | the program, so the run is reproducible                    |

Plus `generators/imp.k` (2 385 B), byte-identical to
`git show v7.1.337:pyk/regression-new/imp-llvm/imp.k` (sha256 `fe5ca3d0…`).

Verified on the raw log before sanitization: **every one of the 6 951 lines
matches `^[0-9a-f]{64}$`**, and **every one of the 34 distinct ids appears in
the build's `allRules.txt`** — zero unknown ids. The most-applied rule fires
781 times.

Two facts worth stating because they are the opposite of `cov-build/`'s:

- **All 34 hit rules are IMP's own.** Not one prelude rule fires, because
  `+Int`, `/Int` and `<=Int` are LLVM *hooks*, not rewrite rules. So
  `domains.md` contributes 64 of the 101 rules and 0 of the 6 951 hits, and the
  report's two `<class>` elements are a fully-exercised one beside an untouched
  one.
- **The log is newline-terminated**, unlike `allRules.txt`: `io.cpp` writes
  `"<uid>\n"` per application, so the final line carries its own newline. The
  two files disagree about their last byte and both are correct.

Derived numbers the tests pin: 88 distinct `source:line` pairs (24 in `imp.k`,
64 in the prelude), which is the `<line>` element count of a report over both
sources — the quantity a `lines-valid` attribute would carry if Cobertura 1.9
as pyk writes it had one, which it does not.

#### Sanitization applied

The same total prefix substitution, two entries, and the **prelude row is
character-for-character the one in the table above** — both builds were made by
the same K v7.1.337 install, so `/fix/k/include/kframework/builtin/domains.md`
means one file across the whole corpus. Neither script asserts that; both
*discover* the prelude root from their own `allRules.txt`, so the two rows agree
when — and only when — the two builds really did come from one install, which is
a property to be checked rather than a constant to be copied:

| real prefix                                             | occurrences | fake prefix                  |
| ------------------------------------------------------- | ----------: | ---------------------------- |
| `<scratchpad>/imp/`                                     |  37 | `/fix/imp/`                  |
| `/nix/store/18pfm4wc…-k-7.1.337-…/include/kframework/`  |  64 | `/fix/k/include/kframework/` |

`/fix/imp/` is a fresh root rather than `cov-build/`'s `/fix/sem/` so that a
test loading both trees can still tell which build a path came from. The hit log
contains no path and is run through the mapping anyway, so the invariant "every
vendored byte went through it" has no exception. Rule hashes, counts and **line
order** are byte-for-byte: the log is a chronological record and reordering it
would destroy the only thing it has to say.

#### Reproducibility

Re-running `krun` on the same build, after the mandatory `rm -f`, produces a log
with the **same sha256** as the vendored one (`0fd57fb6…`). IMP is
deterministic and the LLVM runtime writes in application order, so this fixture
is regenerable rather than merely recorded — which is more than can be said for
the Cobertura golden (see "pyk's Cobertura output is not reproducible").

### `synthetic/` — hand-made inputs and the golden

`allrules-src.txt` / `allrules-dst.txt` are a **rename-only pair**: five
entries each, identical basenames at identical `line:col`, different directory
roots (`/fix/syn/v1` vs `/fix/syn/v2`) and different hashes. That is what a
recompile after moving a semantics looks like, and it is the input
`translateCoverage` (`coverage.py:46-105`) is built for — src hash → src
`file:line:col` → **basename**`:line:col` → dst hash.

Two entries exist to break parsers:

| entry                        | breaks                                                       |
| ---------------------------- | ------------------------------------------------------------ |
| `path with spaces.k:20:3`    | `coverage.py:66-67` — `line.split(' ')` then `[1]`; crashes   |
| `path:with:colons.k:30:7`    | any parser splitting the location off from the **left**       |

`nested/alpha.k:40:9` shares a basename with `alpha.k:10:5` but sits at a
different line, on purpose. Basename matching genuinely does collide across
directories — that is the documented behaviour, kept — but *which* entry wins a
real collision depends on `allRules.txt` iteration order, which is arbitrary
(above). A fixture cannot pin a nondeterministic winner, so this pair exercises
basename matching across directories without manufacturing an untestable race.
The hazard is documented rather than fixtured.

The hashes are `sha256("kcovr-synthetic:<side>:<relpath>")` — reproducible,
mutually distinct, and **not** real rule ids. A real `UNIQUE_ID` is SHA3-256 of
a normalized sentence (`NumberSentences.java:45` — pyk's docstring says SHA-256,
which is wrong); nothing downstream of the 64-hex shape cares.

Reproduce with `generators/make-synthetic.py <fixtures-dir>`.

### `pyk-unit/kore-exec-covr-cases.json` — the frozen legacy table

The 7 inline cases of `test_kore_exec_covr.py:13-42,58-77`, the only test
upstream has for any of this. It is transcribed rather than referenced because
it is not a sample of a live format — it **is** the format. Haskell-backend's
oneline mode prints `"applied N rewrite rules"` rather than source locations
(`DebugAppliedRewriteRules.hs:69-73`), so nothing can regenerate it and no
second authority exists.

Every literal is byte-preserved, including the backslash-escaped-space paths
(`/some/path\ with \ spaces/domains.md:1:2-3:4`), which upstream writes as
Python raw strings.

**The transcription was verified mechanically, not by eye.** A script parsed
`git show v7.1.337:pyk/src/tests/unit/test_kore_exec_covr.py` with Python's
`ast` module, substituted each `HaskellLogEntry.X` reference for its enum value
(`kore_exec_covr.py:24-26`), evaluated the `'\n'.join([...])` in the second
table, and compared the result to this JSON structurally. Both tables compared
**equal**: 5 oneline cases, 2 `parse_rule_applications` cases.

### `generators/` — see `generators/README.md`

## The Cobertura golden

`synthetic/golden.cobertura.xml`, 9 320 bytes, sha256
`4830364962555192b94f70e395544b2259ae7a68648fc1a37cc18d4804336aad`.

**Re-minted twice**, and the record is kept because it is what makes the
current bytes checkable. First after a defect in the canonicalization step was
found — see "A minting defect, found and fixed" below; that first file (8 840
bytes, `11b07355…`) was not well-formed XML. Then again when `cov-build/` was
regenerated at K v7.1.337, which superseded the intermediate file `ae4c1ccc…`.
The re-mint is byte-for-byte the same document apart from the `domains.md` line
numbers the prelude moved: same 9 320 bytes, same 125 `<line>` elements, same
21 branch lines, same five distinct `condition-coverage` values in the same
multiplicities, same `line-rate` and `branch-rate`.

Minted from **pyk's own `render_coverage_xml`** at `v7.1.337`, over
`cov-build/`, with these three source files in this order:

```
/fix/k/include/kframework/builtin/domains.md
/fix/sem/panopticon-semantics.md
/fix/sem/panopticon-syntax.md
```

Reproduce with `generators/mint-golden.py`; its docstring is the authoritative
invocation.

### Why the renderer and not the `pyk-covr` binary

`pyk-covr`'s `main()` is three lines — `parse_args()`, `render_coverage_xml()`,
`print` (`kcovr.py:52-55`). `parse_args` validates that every source file
exists on disk and `.resolve()`s it (`:70-71`). `render_coverage_xml` never
opens a source file: it uses only `str(path)` and `path.relative_to(...)`, and
line *counts* come from the rule map (`count_lines_file`, `:243-244`), not from
the files. Since the fixture paths are sanitized to `/fix/…` roots that by
construction cannot exist on any machine, that existence check is the one thing
that has to be bypassed.

**The bypass was verified, not assumed.** Run over the *unsanitized* build,
where the sources do exist, the script's output is byte-identical to
`pyk-covr`'s own (timestamp normalized). Same definition dir, same three
sources, same everything.

### Two normalizations, both of which are requirements on `cobertura.ts`

**1. `timestamp="0"`.** `kcovr.py:92` calls `time.time()`. The plan already
makes the timestamp an injected parameter for this reason (§4, "Timestamp
injected").

**2. `<line>` elements sorted by line number within each `<class>`.** This one
is not cosmetic, and it is the most consequential thing phase 1 found:

> **pyk's Cobertura output is not reproducible.** `create_rule_map`
> accumulates `allRules.txt` into a Python `set[str]` (`kcovr.py:179-186`), so
> `rule_map`'s insertion order — and therefore `<line>` emission order — follows
> string-hash iteration order, which is randomized per process.

Measured on this fixture set: three consecutive unseeded runs produced three
distinct sha256s; runs at `PYTHONHASHSEED` 0/1/2 produced three more. After
sorting `<line>` by number, seeds 0/1/2/3/7/9 all agree byte-for-byte. So line
order is the *only* nondeterminism — every rate in the document is computed
from set cardinalities, and `<class>` order follows the source-file argument
order (`kcovr.py:115`), which is deterministic.

Sorting is lossless and total: there is exactly one `<line>` per line number in
a class (`kcovr.py:231-240` keys the map by line). **Phase 2's renderer must
emit `<line>` in ascending line-number order**, and should say in its module
header that this is a deliberate strengthening of pyk, not a match of it.

### A minting defect, found and fixed (phase 2)

The golden checked in by phase 1 was **not well-formed XML**: it carried 21
`<conditions>` open tags and one `</conditions>`, and `xml.etree` rejects it at
the first `</class>`. pyk did not produce that — `generators/mint-golden.py`'s
own `canonicalize` step did, through one regex:

```python
_LINE_BLOCK = re.compile(r'\n<line number="(\d+)".*?(?:/>|</line>)\n', re.S)
```

With `re.S` and a non-greedy `.*?`, the first `/>` inside a *branch* line block
is the self-closing `<condition number="0" type="jump" coverage="0%"/>` — not
the element's own end. Every branch block therefore matched two lines short, and
the reassembly `chunk[:start] + body + chunk[end:]` dropped the
`  </conditions>\n</line>\n` tail of all 21 of them, re-attaching just one (the
last block's, which survives inside `chunk[end:]`). Only branch lines were
affected; the 104 no-branch `<line …/>` blocks have no inner `/>` and were
copied intact, which is why the file looked right in a diff of line counts and
in every phase-1 assertion.

The fix spells the two element shapes as separate alternatives —
`(?:[^>]*/>|.*?</line>)` — and the golden was re-minted through **pyk itself**
at `v7.1.337` (`kcovr.py` sha256 `a981ca48…`, matching `src/version.ts`), same
invocation, same three sources. Four runs at `PYTHONHASHSEED` 0/1/2/7 produced
one sha256, `ae4c1ccc…`, which parses as XML and has 21 `</conditions>`. It is
480 bytes larger than the defective file — exactly the 20 dropped tails. The
v7.1.337 re-mint repeated the four-seed check and again produced a single
sha256, `48303649…`, which is the file checked in now.

`src/cobertura.ts` reproduces the re-minted file byte-for-byte
(`test/cobertura.test.ts`, "reproduces the pyk-minted golden byte-for-byte").

### What the golden covers

| property                                | value in the golden                                  |
| --------------------------------------- | ----------------------------------------------------- |
| `<source>`                              | `/fix` — `commonprefix` of the three sanitized paths   |
| `<class>` elements                      | 3, filenames relative to that prefix                   |
| `<line>` elements                       | 125                                                    |
| branch lines (`num_rules_line > 1`)     | 21 — both templates exercised                          |
| `condition-coverage` values             | `0% (0/2)` ×7, `0% (0/4)` ×6, `100% (2/2)` ×3, `100% (4/4)` ×2, `50% (2/4)` ×3 |
| `line-rate` / `branch-rate` formatting  | `0.224`, `0.23809523809523808`, `0.015873015873015872` — Python `repr(float)`, the shortest round-trip; §4 item 4's "verify on the golden, don't assume" is verifiable here |

### What the golden cannot pin

- **`int(rate*100)` truncation.** Plan §4 item 4 wants a rate like 2/3 to prove
  the truncation is not rounding. Every branch line in this fixture has 2 or 4
  rules, so every rate is exact (`0%`, `50%`, `100%`) and truncation is
  invisible. **Phase 2 needs a synthetic 3-rules-on-one-line case.**
- **The two float formats where `String(x)` is not `repr(x)`.** Phase 2's
  verdict on §4 item 4's "verify on the golden, don't assume": all six distinct
  rate strings in the golden round-trip through JS `String` unchanged, so the
  golden alone would have licensed `String(x)`. It is still not enough. Python
  writes `1.0` and `0.0` where JS writes `1` and `0` — reachable the moment a
  file is fully covered or wholly uncovered, and by the zero-denominator
  deviation below — and switches to exponential notation below `1e-4` where JS
  waits until `1e-6`, so a rate of 1 rule in 20 000 is `5e-05` in Python and
  `0.00005` in JS. `formatPythonFloat` handles both; `test/cobertura.test.ts`
  pins them against values `python3 -c 'print(repr(x))'` produced.
- **Zero-denominator rates.** pyk crashes (`kcovr.py:86,90,125,129,161` are
  unguarded); a golden of a crash is not a golden. Phase 2's `1.0` behaviour is
  a deviation with no upstream counterpart to diff against.
- **A non-empty `coverage.txt`.** This build's macro log is empty. A macro-ful
  build produces one (the failed KWasm build below left a 130-byte one, two
  entries), but merging it is the same code path as merging a hit log, so the
  gap is cheap to close synthetically if phase 2 wants it.

## `pyk-covr` vs `bin/kcovr` — the one-off differential

Run once, per plan §5, and **not vendored**. The legacy script is
`k-distribution/src/main/scripts/bin/kcovr` at `v7.1.337`.

On the fixture inputs the two agree **byte-for-byte** (after the same two
normalizations). The plan predicted a `dirname(commonprefix)` divergence here;
it does not appear, because `commonprefix` of the real paths is `/` and
`os.path.dirname("/")` is also `/`.

Two divergences were reproduced on inputs constructed to expose them:

**1. `commonprefix` bare vs `dirname(commonprefix)` — pyk crashes.**
With two sources in one directory whose names share a prefix (`foo.md`,
`foobar.md`), `commonprefix` is `…/pfx/foo`, which is not a directory:

```
bin/kcovr   <source>…/pfx</source>, filenames "foo.md" / "foobar.md"      — works
pyk-covr    ValueError: '…/pfx/foo.md' is not in the subpath of '…/pfx/foo'  — crashes
```

`bin/kcovr:82` uses `dirname(commonprefix(...))`; `kcovr.py:79` uses
`commonprefix(...)` bare and then `relative_to` (`:134`), which raises. Plan
§1.5 says pyk wins where the two disagree — but pyk does not *win* here, it
dies, so §4 item 4's "pyk wins, divergence documented" cannot be followed
literally. **Phase 2 must decide**, and the honest options are: reproduce the
throw with a diagnosable `KcovrError`, or adopt `bin/kcovr`'s `dirname` and
document the single deliberate departure from pyk-parity. Nothing in the golden
constrains the choice — the fixture's prefix is a clean directory boundary.

**2. The `--` separator.** `pyk-covr` implements only `++` (`kcovr.py:65`)
while its own usage string says `--` (`:60`) and `bin/kcovr` implements `--`
(`:20`). Passing `--` to `pyk-covr` gives
`ValueError: Directory does not exist: …/--`, because `--` is taken for a
definition directory. Confirms plan §4's "`++` and `--` both accepted".

## KWasm generation attempt

Attempted per plan §5, tier 1 ("vendored, if generation succeeds"). **It does
not succeed, and the reason is not the version skew the plan expected.**
Nothing from it is vendored.

The plan's recipe, with the `llvm` target's flags from
`pykwasm/src/pykwasm/kdist/plugin.py:49-51` and the local K v7.1.191:

```sh
kompile --coverage --backend llvm \
  --main-module WASM-TEST --syntax-module WASM-TEST-SYNTAX \
  -I "$SRC" --md-selector k --emit-json \
  -o kwasm-cov "$SRC/wasm-semantics/test.md"
```

(A first attempt without `--main-module` failed immediately with
`Could not find main module with name TEST`; the flags above are the ones
`packages/kompiled/fixtures/PROVENANCE.md:199-207` records for its own KWasm
build, with the backend swapped and `--coverage` added.)

The frontend gets a long way — it writes `allRules.txt` (877 entries),
`compiled.json`, `parsed.json`, `coverage.txt` and the scanner — and then the
sort-injection pass fails:

```
[Error] Compiler: Could not find productions for KApply with label
sideEffect:#SortParam{Q0} in module WASM-TEST
  while executing phase "Add sort injections" on sentence at
	Source(…/wasm-semantics/wasm-data/tools.k)
	Location(17,10,17,89)
```

The sentence at `tools.k:17` is a sort-**parametric** simplification rule:

```k
rule #Ceil(setExtend(_L:ListInt, I:Int, _V:Int, _D:Int)) => {true #Equals 0 <=Int I}
    [simplification]
```

`GenerateCoverage.gen` computes the rule's top sort with
`AddSortInjections.topSort(body)` and builds a `sideEffect:` label from
`s.toString()` (`GenerateCoverage.java:62-68`). For this rule that sort is the
sort *parameter* `#SortParam{Q0}`, and no `sideEffect:#SortParam{Q0}` production
is generated, so injection fails.

**This is not version drift.** The plan anticipated the 7.1.191-vs-7.1.329 skew
as the likely blocker; it is not the cause. `GenerateCoverage.java:49-79` at
`v7.1.337` — the release this package pins, later than the 7.1.329 that
wasm-semantics pins — still calls `inj.topSort(body)` with no guard for sort
parameters and no skip for `simplification` rules. The defect is present in the
newer toolchain too, so a KWasm coverage build would fail there as well. It is a
limitation of `kompile --coverage` on any definition containing a
sort-parametric rule, not of this machine's K.

**Confirmed by execution at v7.1.337, not only by reading.** The paragraph above
was an inference from the Java. This machine's ambient `kompile` was then
upgraded to `v7.1.337` (build date Thu Aug 06 05:58:35 JST 2026), and the recipe
above was re-run verbatim — same flags, same `wasm-semantics` checkout
(`git status --porcelain` empty before and after), output redirected to a scratch
directory. It fails identically:

```
[Error] Compiler: Could not find productions for KApply with label
sideEffect:#SortParam{Q0} in module WASM-TEST
  while executing phase "Add sort injections" on sentence at
	Source(…/wasm-semantics/pykwasm/src/pykwasm/kdist/wasm-semantics/wasm-data/tools.k)
	Location(17,10,17,89)
```

Exit **113** in **15.0 s**, with the same partial-frontend signature:
`allRules.txt` (877 newline-terminated lines plus an unterminated 878th — the
count recorded above), `compiled.json`, `parsed.json`, `coverage.txt` and the
scanner all written, no `definition.kore`. Same sentence, same label, same
phase, same byte offsets. Note this run is *doubly* off-pin — wasm-semantics
pins 7.1.329 — which is deliberate: the question is about the K frontend, not
about KWasm's supported configuration. The prediction from reading
`GenerateCoverage.java` is now a measurement at both ends of the range.

**Consequence, per the plan's own fallback:** the KWasm tier falls back to the
opt-in corpus (`generators/build-corpus.sh`), there is no `fixtures/kwasm-build/`
directory, and no NCSA-licensed artifact is redistributed — so
`../THIRD-PARTY-NOTICES.md` carries no wasm-semantics section.

Two consolations, so the loss is smaller than it looks:

- A 208 KB KWasm `allRules.txt` at 929 entries **already exists in this
  repository**, at
  `packages/wasm-fixtures/fixtures/wasm-haskell-kompiled/allRules.txt`
  (it was under `packages/kompiled/fixtures/generated/` when this was written;
  `packages/wasm-fixtures` is now the single owner of the KWasm artifact),
  and `kcovr` parses `allRules.txt` through `@kframework-ts/kompiled` rather
  than itself (plan §2, "must not grow a fifth parser"). The large-scale
  `allRules.txt` case is therefore already covered where the parser lives.
  Vendoring a second one here would duplicate 200 KB to test someone else's
  code.
- What is genuinely missing is a **large-scale hit log**. `cov-build/`'s
  largest is 362 lines. Nothing in this repository has more, and the opt-in
  corpus is the only route to one.

  **Closed, and not by the corpus.** `imp-build/pid-large_coverage.txt` is
  6 951 lines / 441 KB of real `krun` output, made by adding `--coverage` to
  upstream's own `imp-llvm` regression build — 8 seconds of toolchain time
  rather than the tens of minutes a KEVM or KMIR corpus build costs. See "The
  large hit log — `imp-build/`". The paragraph above is left standing because
  it was true when written and the reasoning that replaced it is worth seeing.

## KMIR generation attempt

Probed after `imp-build/` landed, to answer one question: is the
`sideEffect:#SortParam{Q0}` defect above specific to KWasm, or does it bite a
second, independently maintained semantics? **It bites KMIR too**, and nothing
is vendored.

Source: `mir-semantics` (BSD-3-Clause), treated as read-only; all build products
went to a scratch directory, and `git status --porcelain` on the checkout was
empty before and after. Flags are the `llvm` target's from
`kmir/src/kmir/kdist/plugin.py`:

```sh
kompile --coverage --backend llvm \
  --md-selector 'k & ! symbolic' -I "$SRC" \
  --syntax-module KMIR-AST -O2 \
  --output-definition "$OUT/kmir-cov" "$SRC/mir-semantics/kmir.md"
```

```
[Error] Compiler: Could not find productions for KApply with label
sideEffect:#SortParam{Q0} in module KMIR
  while executing phase "Add sort injections" on sentence at
	Source(…/mir-semantics/rt/data.md)
	Location(70,8,71,29)
```

Failed in **19.5 s**, after writing `allRules.txt` (852 entries), `coverage.txt`,
`compiled.txt/bin`, `parsed.txt` and the scanner but no `definition.kore` —
the same partial-frontend signature as KWasm. The offending sentence is
`rt/data.md:70-71`:

```k
  rule #Ceil({X}:>TypedLocal) => #Ceil(X)
    requires isTypedLocal(X)                         [simplification]
```

`#Ceil` is sort-parametric, so `AddSortInjections.topSort(body)` returns
`#SortParam{Q0}` and `GenerateCoverage.java:62-68` builds a label no production
exists for. There is a second identical rule at `:74-75`, so patching one would
only move the error. These sit in a plain ` ```k ` block, **not** a
`symbolic`-gated one, so the LLVM selector `k & ! symbolic` pulls them in;
KMIR's other 57 `simplification` rules are in the symbolic-only lemmas file.

Two controls, so the verdict is not confounded:

- **Without `--coverage`, the same command succeeds** — exit 0, full LLVM build
  with `definition.kore`, `dt/`, `macros.kore`, 848 rules. The failure is
  `--coverage`-specific, not a KMIR-vs-K incompatibility. Re-run alongside the
  v7.1.337 probe below and still exit 0, **26.2 s**, the same 848 rules, with
  `definition.kore`, `dt/`, `macros.kore`, `syntaxDefinition.kore` and the
  `interpreter` all present.
- **Version caveat, recorded rather than resolved — and since resolved.**
  `mir-semantics` pins K `v7.1.337` in `kmir/pyproject.toml`, but `uv sync`
  installs the pyk *python* package and **no `kompile` binary**, so
  `uv run -- kompile` resolved to this machine's then-ambient v7.1.191. As first
  run the probe therefore measured 7.1.191, not the pinned release. That was a
  weaker result than intended, and it was worth something only because the KWasm
  analysis had already established the defect is present in
  `GenerateCoverage.java` at `v7.1.337` too — the reading of the Java was what
  carried the claim across versions, and that run was a second data point under
  it.

  **The gap is now closed by running, not by reading.** After the machine's
  ambient `kompile` was upgraded to `v7.1.337`, the exact command above was
  re-run — same checkout, still read-only (`git status --porcelain` empty before
  and after), build products to a scratch directory. It fails the same way, and
  this time on the release `kmir/pyproject.toml` actually pins:

  ```
  [Error] Compiler: Could not find productions for KApply with label
  sideEffect:#SortParam{Q0} in module KMIR
    while executing phase "Add sort injections" on sentence at
  	Source(…/mir-semantics/kmir/src/kmir/kdist/mir-semantics/rt/data.md)
  	Location(74,8,75,24)
  ```

  Exit **113** in **13.3 s** (19.5 s at 7.1.191), with the same partial output:
  `allRules.txt` at the same **852** entries, `coverage.txt`, `compiled.txt/bin`,
  `parsed.txt`, the scanner, and no `definition.kore`.

  One detail moved, and it is the detail this section predicted would move. At
  7.1.191 the reported sentence was `rt/data.md:70-71`, the `:>TypedLocal` rule;
  at v7.1.337 it is `:74-75`, the `:>Value` rule — the *second* of the two
  identical `#Ceil` simplifications. Which of the two the pass reaches first is
  not stable across releases, which is exactly the "patching one would only move
  the error" point above, observed rather than argued. The defect, the label, the
  phase and the module are unchanged.

**Consequence for `generators/build-corpus.sh`:** its `kmir` target is now
**known non-viable** for a coverage build, the same as `wasm` — at 7.1.191 and,
after the re-runs above, at v7.1.337. `kevm` is the only one of its three still
untested; `evm-semantics` pins 7.1.337, so since the upgrade it is on-pin with
the ambient install for the first time, and the tens-of-minutes build cost — not
a version mismatch — is what still stands in the way. Nothing from
`mir-semantics` is vendored, so `../THIRD-PARTY-NOTICES.md` owes it no notice;
the section it carries is empty for the same reason KWasm's is.

## K release and format evidence

**There is no K version skew.** Every vendored byte here was produced by K
`v7.1.337`, the release `src/version.ts` pins and the release the pyk
transcription is taken from. Both real builds — `panopticon`'s
`cov-semantics` and this workspace's IMP — came from one install,
`/nix/store/18pfm4wc…-k-7.1.337-4a46d123…`, so the prelude sanitizes to a single
`/fix/k/` root across the whole corpus.

**Coverage formats are stable across the 146 patch releases between K
v7.1.191 and v7.1.337.** Builds against byte-identical semantics (`git diff
f9063ca9..29e7569 -- K/spec` is empty) have the same structural quantities:

| quantity                              | v7.1.191 | v7.1.337 |
| ------------------------------------- | -------: | -------: |
| `cov-build/allRules.txt` entries      |      168 |      168 |
| …distinct `file:line`                 |      125 |      125 |
| …distinct `basename:line:col`         |      125 |      125 |
| rules in the full build               |      559 |      559 |
| hit logs in the corpus scan           |       63 |       63 |
| vendored log sizes (B)                | 65 / 7 995 / 23 530 | 65 / 7 995 / 23 530 |
| …lines / unique                       | 1/1, 123/32, 362/31 | 1/1, 123/32, 362/31 |
| union of rules the three logs hit     |       40 |       40 |
| `compiled.json` modules / rules       |  11 / 168 |  11 / 168 |
| …`<generatedTop>`-rooted              |      105 |      105 |
| …`sideEffect:` sorts, all arity 2     |        8 |        8 |
| `imp-build/allRules.txt` entries      |      101 |      101 |
| …distinct `source:line`               |       88 |       88 |
| `imp-build` hit log lines / unique    | 6 951 / 34 | 6 951 / 34 |
| golden bytes / `<line>` / branch lines | 9 320 / 125 / 21 | 9 320 / 125 / 21 |

— and the `UNIQUE_ID`s are the same sets on both sides, in both builds. Three
things did move, all of them consequences of `domains.md` growing:

- **62 of the 63 prelude entries in `cov-build/allRules.txt`** and **63 of the
  64 in `imp-build/allRules.txt`** name a different line. `UNIQUE_ID` is a hash
  of a normalized sentence (`NumberSentences.java:45`), not of its location, so
  the ids are unchanged and only the `file:line:col` half moved.
- **The golden's `<line number=…>` values** follow those line numbers. Nothing
  else in the document changed.
- **`imp-build/pid-large_coverage.txt` is byte-identical** across the two
  releases, sha256 `0fd57fb6…`, which is the sharpest available evidence that
  the hit-log format has no version to drift.

Per `docs/versioning.md`: coverage artifacts carry no self-identifying version
header — `allRules.txt` and the hit logs are bare lines — so the package cannot
and does not assert anything about its input's K version at runtime. The
`compiled.json` envelope is the one exception, `kast` checks it, and
`generators/sanitize-cov-build.py` checks it too rather than papering over it.

## Checksums

```
700cbd69d8f0de067a70393c64ad5c02ae9426c3cd799e7dd6c9bd1df6eb85cb  cov-build/allRules.txt
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  cov-build/coverage.txt
7a8cc17cda0df8ac81badf9fc2729e3c50833d7094de973808486cc987cc3619  cov-build/pid-large_coverage.txt
8aee997849c1cacacefc75234890e7a2a8f52e2ec9da8d9f7e4f5bb26d3af00b  cov-build/pid-mid_coverage.txt
2a15550386d4f749eaeed12a60a81825856b0b5eefb9c1bd425e709f4af08453  cov-build/pid-small_coverage.txt
40b3d023cb49b4a253cc54c2afe125a8eb8e43af834a154a8e41bcf2cb835e8e  imp-build/allRules.txt
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  imp-build/coverage.txt
76ce3ae6d5dd27f4155a4c19b5081b0b6bcda9b6b15e0d2150ee829c5ca369b0  imp-build/loops.imp
0fd57fb6968eefbb6a6bc24279b1523b1f9a46371f5b392f9d408449ff478f04  imp-build/pid-large_coverage.txt
62ee3696a363435a3c8da42e02c391812a60d6ed5ed84e9176105f0087d68c06  compiled/compiled.json
b3829d89a68afe0b70ebf759e47a01c577510b0349460b66ec6f2ce38f100cd2  synthetic/allrules-dst.txt
9f65fd066e4d8a714c47114ab41a2c8da4e1dc3fba2dd0964f7be061da454f6f  synthetic/allrules-src.txt
4830364962555192b94f70e395544b2259ae7a68648fc1a37cc18d4804336aad  synthetic/golden.cobertura.xml
06cca48fc571970516370a4184b678ad2924fde9e57f614e2cb4795d48147175  pyk-unit/kore-exec-covr-cases.json
680eb5fe7493dc1a9b11e0dd9ae9d6cc864f5e6bd6f2ffb309685d92d9651eb5  generators/bytes-coverage-test.k
0243d4b88bff8e5190c79e9d95ce9ab1d5a4c2e6b9c1f3f1da0eb11a7a900d5a  generators/coverage-test.k
fe5ca3d0a7ac3f9424622a57496e1dc027bf7cf7065fe6d8057d1801672f42ec  generators/imp.k
63c960587686c23d68e53ec419947cd2dba562fdc093e329ab0f9b6d21cc6118  generators/issue-1388-test.k
```

`e3b0c442…` is the sha256 of the empty string, and it appears **twice**: both
real builds have a macro-free semantics, and that a `--coverage` build leaves a
zero-byte `coverage.txt` behind rather than no file at all is the thing those
two entries exist to pin.

The four `.k` files' hashes are also verifiable upstream:
`git show v7.1.337:pyk/regression-new/coverage/test.k | sha256sum`, and
likewise `imp-llvm/imp.k`. The `k-distribution/tests/regression-new/` copies of
the three `test.k` files are byte-identical (checked).

The generator scripts are deliberately absent from the list: they are the
things that would be edited, and a checksum of an input to the checksums is
noise. Their authority is the tag and build directory named at the top.

Total: 1.10 MB, of which `compiled/compiled.json` is 538 KB and
`imp-build/pid-large_coverage.txt` is 441 KB. Those two files are 89% of the
corpus and each buys something nothing else can: a real instrumented
definition, and a hit log big enough for an accidentally quadratic merge to
show up in wall time.

## Deliberately not vendored

- **`definition.kore` (1.4 MB), `parsed.json`, `interpreter` (15 MB), `dt/`** —
  the rest of the `cov-semantics` build. `kcovr` reads none of them;
  `@kframework-ts/kompiled` and `@kframework-ts/kore` own those formats and have
  their own fixtures.
- **The other 60 hit logs.** Three cover the shape space (1 line / 123 / 362);
  of the rest, 58 are more of the same at 65–2 210 bytes and two are mid-sized
  (10 530 B / 162 lines and 14 820 B / 228 lines) that add nothing the vendored
  three do not already exercise.
- **`bin/kcovr`'s output.** Recorded as notes above, per plan §9's table. It is
  a differential check run once, not a golden — pyk is the authority.
- **Anything from `imp-semantics`.** It has **no license file of any kind**, so
  no grant to redistribute. Same exclusion the `k-parser` and `kompiled`
  fixtures record.
